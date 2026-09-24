# Slackbot v2 Guide

## Role

Slackbot v2 is the Slack transport and renderer for the durable session API.
`src/index.ts` wires Chat SDK callbacks and recovery, `src/session-api.ts` owns
the control-plane client, `src/conflate.ts` and display helpers shape output,
and `src/server.ts` owns runtime configuration and the HTTP server.

Keep this service thin: it may collect Slack context, persist messages, start
or interrupt executions, replay events, and deliver Slack output. Sandbox
lifecycle, harness formatting, and durable execution state belong in `api-rs`.

## Invariants

- Verify Slack signatures and policy gates before processing an event. Ignore
  bot/self events and unsupported event shapes without creating sessions.
- For user-input webhooks, wait only for the create/append handoff needed to
  make Slack retry a transient failure. Do not hold the webhook open for cold
  sandbox execution or rendering.
- Preserve the boundary between create/reuse, durable append, execute, SSE
  replay, and final Slack delivery. Each phase needs its own timeout, retry,
  metrics, and idempotency behavior.
- Use stable client message and execution idempotency keys so Slack redelivery
  cannot produce a second turn. Serialize work that targets the same session.
- Postgres-backed Chat SDK state and render obligations are crash-recovery
  state. A terminal execution without a delivered terminal render still needs
  recovery.
- Keep Slack API side effects bounded by the existing timeout helpers. Respect
  message, block, attachment, and rate limits, including fallback text.
- Avoid serializing raw webhook bodies on the hot path or in normal logs. Never
  log bot tokens, signing secrets, private file URLs, or user file contents.
- Preserve mentioned stop commands, harness/model overrides, late-file repair,
  initial thread context, and default mention-gated subscribed-message semantics when
  refactoring the main callback flow. Explicitly configured mentionless project
  channels are the opt-in exception. Elsewhere, unmentioned replies must not be appended
  to or interrupt an active execution; collect them when the next mention
  refreshes the Slack thread context.

## Validation

From the repository root:

```bash
pnpm --filter slackbotv2 run check:types
pnpm --filter slackbotv2 test
```

Use targeted tests while iterating, especially `test/session-api.test.ts`,
`test/chat-sdk-emulate.test.ts`, `test/conflate.test.ts`, and recovery/metrics
tests. For changes to acknowledgement, retry, or rendering, deploy locally and
exercise a signed emulated event through the HTTP route; prove the webhook
status, durable execution count, replayed terminal event, and final rendered
message.

## Optional project routing and dispatch

`SLACKBOTV2_CHANNEL_DEFAULTS` accepts `persona` and `mentionless` per channel.
A configured persona is pinned and must be available; unavailable or conflicting
personas fail closed. Mentionless execution applies only to configured channels.

An optional `SLACKBOTV2_TASK_DISPATCH_CONFIG` JSON object supplies `contextUrl`,
`ownerIds`, `userId`, `teamId`, `instanceId`, `model`, `reasoning`, `originChannels`
and `projects` (project name to `{channel, persona}`). Every destination must match
its channel default. Provision `SLACKBOTV2_TASK_DISPATCH_SECRET` and
`SLACKBOTV2_TASK_DISPATCH_CONTEXT_TOKEN` separately; an instance `runtimeSecretName`
can supply them without placing credentials in values. Leave the config unset to
disable the route and recovery worker.

`POST /api/tasks/dispatch` accepts only `task_id`, `origin_thread`, and a millisecond
`requested_at`, signed over the exact body using HMAC-SHA256 in
`X-Centaur-Dispatch-Signature: sha256=<hex>`. The service reads the canonical Context
Task (universal API 1.1.0), validates owner/readiness/dependencies, and selects the
configured destination from exactly one `Project: <name>` brief line. Task creation
alone does not dispatch. Calling integrations must require explicit user execution
intent. Worker sessions claim their task through the normal Context lifecycle.

Receipts and recovery use the existing durable Chat SDK state. Retries reconcile
Slack metadata before posting, reuse durable execution identity, and return one
source-thread notice after execution/render completion. An uncertain Slack write
with no discoverable receipt stays pending for operator reconciliation instead of
posting again. It is not evidence of task completion. No task schema, scheduler or
legacy-history migration is included.

Routine execution is opt-in: set `routineIngestUrl` in the dispatch config and
provide `SLACKBOTV2_TASK_DISPATCH_ROUTINE_TOKEN` separately. The trusted token
must stay in the transport; never add it to project tools or sandbox grants.
The existing recovery loop polls Context's `/api/v2/ingest/routines/claim`,
reuses the occurrence UUID across retries, checks the current definition and
project boundary, then starts a fresh configured execution session. Routine
runs never claim or complete the parent Task. A returned run defaults to Review
without overwriting the execution thread's explicit terminal result.

Run tests with the Bun version pinned in this service's Dockerfile. Older Bun
versions can hang streaming HTTP fixtures and produce misleading failures.
