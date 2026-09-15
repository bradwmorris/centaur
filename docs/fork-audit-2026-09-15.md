# Fork audit and upstream sync — 2026-09-15

This is the durable audit for [fork Issue #19](https://github.com/bradwmorris/centaur/issues/19)
and [sync PR #18](https://github.com/bradwmorris/centaur/pull/18). It records the
published fork history and the surviving delta after refreshing and merging
`paradigmxyz/centaur` `main`. Upstream was fetched read-only; no upstream branch,
issue, pull request, deployment, database, or credential was changed.

## Exact sync evidence

| Ref | SHA |
| --- | --- |
| Fork `origin/main` before the sync | `ba90df1c25b78b545799c83580c38b264f95f3eb` |
| Upstream `upstream/main` inspected and merged | `457243cc2cb55c754fae8ef95955dc27179f93cd` |
| Fork/upstream merge base | `535d08f79072cddb4fe6db2626ec696963847764` |
| Previous PR #18 merge | `e388b04a4eadbde5dfc557dcc2954d513a4fe783` |
| Refreshed upstream merge | `ef8d1608e722d9688e8d963f28de21547fccdc4c` |

At refresh time the published fork had 20 fork-only commits and upstream had 73
upstream-only commits. PR #18 had already merged upstream through `2c23d3ea` and
was 32 upstream commits behind. The refreshed merge was conflict-free at the
text level. One semantic API overlap was then found by Clippy: upstream added
`SandboxIoParts.instance_id`; the fork Curator runtime was adapted to ignore the
new runtime value and to provide `None` in its unit fixtures.

The inspected upstream releases were `centaur-0.1.139` and `centaur-0.1.140`.
Their published release note is the generic chart description. The 32 newly
merged commits add MCP v2 discovery/run/search and artifact retrieval, Slack
workflow/channel and markdown fixes, Okta support, tool output changes,
dependency/CI updates, and session-runtime reattachment behavior. None supplies
an equivalent interaction sink, Context Builder, canonical Context Chat
contract, Context Curator route, Context evidence export, multi-instance Slack
deployment, YouTube caption host declaration, or terminal proxy cleanup.

## What the fork contains

The 20 fork-only commits fall into five categories:

1. **Two Slack hooks and their required support — 13 commits.** The hooks are
   `slackbotv2.interactionSink` and `slackbotv2.contextBuilder`; the remaining
   commits preserve the canonical Chat/thread identity, participant refresh,
   triggering timestamp, normalized usage, completed Runs, and exact retrieval,
   instruction, tool, and evaluation evidence required by the current Context
   contract. Three of the 13 are merge records with no independent behavior.
2. **Multi-instance Slack and overlay support — 3 commits.** Named Slack apps
   receive isolated routes, state, credentials, personas, principals, Services,
   Deployments, and ingress paths. One of the three is a merge record.
3. **Separate subscription Curator inference — 2 commits.** A purpose-bound
   private API creates a temporary tool-free Codex sandbox using a
   Console-managed ChatGPT subscription and exposes the required chart ingress.
4. **Optional agent-tool/egress integration — 1 commit.** The YouTube tool
   declares the public caption host so iron-proxy can authorize transcript
   retrieval.
5. **Unrelated operational fork fix — 1 commit.** Terminal sandbox cleanup also
   removes iron-proxy resources and sweeps crash leftovers. This is useful to
   every fork deployment and is not required by the two Context hooks.

There are 17 substantive commits and 3 merge commits. After the sync, the
surviving fork delta is 47 files: 6 chart files, 7 harness files, 2 Centaur docs,
30 service implementation/test files, and 2 YouTube tool files. Every surviving
file is mapped below; there is no unexplained fork-only file.

## Commit-by-commit disposition

“Context” means required by the current Centaur Context proof of concept;
“support” means a dependency of that behavior rather than one of the two hooks.

| Commit | PR / Issue | Runtime behavior and important files/symbols | Classification and dependencies | Upstream interaction and final decision | Evidence / Context docs |
| --- | --- | --- | --- | --- | --- |
| `225a6104` | Direct commit | Adds `interaction-sink.ts`, `sendSlackInteraction`, sink options/env/chart wiring, and ordered Slack transcript snapshots. | Context: first Slack hook. Foundation for identity, usage, Runs, and Context Builder pre-ingest. | No upstream equivalent. **Keep and adapt** inside the current upstream callback flow. | Sink unit tests and Slack emulator; setup and integration docs must name the hook. |
| `d8a7dfc` | Direct commit | Uses the portable Slack fetch response type in `slack-user.ts`. | Context support for profile lookup portability; depends on sink participant capture. | No conflicting upstream behavior. **Keep.** | Type-check and Slack user/sink tests; no separate setup note. |
| `33e7cd5` | Direct commit | Adds `shared-context.ts`, `fetchSharedContext`, authenticated principal/thread headers, bounded packet rendering, `contextBuilder` config, and pre-execution injection. | Context: second Slack hook; depends on sink and session request assembly. | Upstream changed execution orchestration but has no Context retrieval equivalent. **Keep and adapt.** | Shared-context, session API, and emulator tests; setup/integration docs must name direction and timing. |
| `1cbe607f` | [PR #1](https://github.com/bradwmorris/centaur/pull/1) | Renames the injected heading to `# Centaur Context` and updates fixtures. | Context support; depends on Context Builder. | No upstream equivalent. **Keep.** | Focused snapshot tests; no additional compatibility requirement. |
| `78e0efa4` | [PR #2](https://github.com/bradwmorris/centaur/pull/2) | Adds `eval-usage.ts`, normalizes Codex token events, and adds provider/auth/billing/upstream attribution config. | Context support for evaluation and spend evidence; depends on sink execution/turn identifiers. | Upstream telemetry does not publish this Context ingestion contract. **Keep and adapt.** | Usage and sink tests; Context API docs cover usage ingestion. |
| `461ff9f6` | [PR #5](https://github.com/bradwmorris/centaur/pull/5), [Issue #3](https://github.com/bradwmorris/centaur/issues/3) | Pre-ingests the current snapshot, validates returned `chat_object_id`, and sends it on Context retrieval. | Context support for canonical Chat identity; depends on both hooks. | Upstream session identity is not the Context Object identity. **Keep and adapt.** | Sink/shared-context/emulator tests; compatibility docs must require canonical identity. |
| `161bcbd6` | [PR #5](https://github.com/bradwmorris/centaur/pull/5) | Derives the canonical Slack thread key from workspace/channel/root timestamp before binding Context. | Context support; fixes reply/root identity drift. | Upstream thread keys are compatible but do not perform the Context binding. **Keep.** | Emulator regression; setup docs must state exact thread binding. |
| `66edc463` | [PR #6](https://github.com/bradwmorris/centaur/pull/6), [Issue #4](https://github.com/bradwmorris/centaur/issues/4) | Adds named `slackbotv2.instances`, instance webhook routes, state prefixes, persona binding, credential selection, chart Deployments/Services/ingress, and instance-scoped principal foreign IDs. | Other fork need with Context isolation consequences; depends on both hooks being instance-aware. | Upstream added requester/persona behavior but not multiple Slack app deployments. **Keep and adapt.** | Named-instance emulator, iron-control, and Helm render tests; only multi-instance adopters need it. |
| `ff1cb25e` | [PR #6](https://github.com/bradwmorris/centaur/pull/6) | Makes `apirs.yaml` discover persona directories from overlay mounts. | Multi-instance/private-overlay support; depends on instance persona binding. | Upstream persona reconciliation does not discover these overlay directories. **Keep.** | Helm rendering; not a minimum Context requirement for a singleton bot. |
| `d58a5c07` | [PR #5](https://github.com/bradwmorris/centaur/pull/5) | Merge record for `461ff9f6` and `161bcbd6`; no unique patch beyond its parents. | Context support history. | **Keep published merge history;** disposition follows both parents. | Evidence is attached to PR #5. |
| `c95711a9` | [PR #6](https://github.com/bradwmorris/centaur/pull/6) | Merge record for `66edc463` and `ff1cb25e`; no unique patch beyond its parents. | Multi-instance history. | **Keep published merge history;** disposition follows both parents. | Evidence is attached to PR #6. |
| `72ceaaf0` | [PR #7](https://github.com/bradwmorris/centaur/pull/7) | Adds `POST /api/internal/context-curator/infer`, `CuratorInferenceRuntime`, `Capability::CuratorInference`, `CENTAUR_CONTEXT_API_KEY`, `CURATOR_INFERENCE_*`, a purpose-labelled principal/role, ephemeral Codex sandbox creation/stop, fixed `gpt-5.6-luna`, strict four-array output schema, tool rejection, bounded I/O, idempotency cache, usage attribution, and chart/docs wiring. | Separate Context Curator model transport; independent of both Slack hooks but used by the tested automatic curation loop. | Upstream sandbox I/O gained `instance_id`; adapt the Curator path to the new shape. No upstream inference equivalent. **Keep and adapt.** | Rust auth/route/runtime tests, harness tests, chart renders; Context setup must describe it separately and pin compatibility. |
| `4deec346` | [PR #8](https://github.com/bradwmorris/centaur/pull/8) | Moves `app.kubernetes.io/name=centaur-context` ingress to api-rs port 8080 rather than Postgres. | Curator deployment support; depends on `72ceaaf0`. | Upstream policies do not admit Context. **Keep.** | Rendered NetworkPolicy assertion; Context setup must name this network path. |
| `7fcc2d03` | [PR #9](https://github.com/bradwmorris/centaur/pull/9) | Adds the caption API host to the YouTube tool’s proxy host metadata. | Optional agent-tool/proxy integration; unrelated to automatic Context hooks. | No upstream equivalent in the inspected tool metadata. **Keep.** | `tools/research/youtube/test_client.py`; not required in minimum Context docs. |
| `77d32f97` | [PR #10](https://github.com/bradwmorris/centaur/pull/10) | Refreshes participant profiles with bounded TTL/stale fallback and supports bot/user canonical identity overrides. | Context support for stable participant attribution; depends on sink. | Upstream requester resolution complements but does not replace exported Context participants. **Keep and adapt.** | Sink/emulator tests and prior live evidence; setup only needs to mention identity support, not private overrides. |
| `5cb0c953` | [PR #11](https://github.com/bradwmorris/centaur/pull/11) | Adds `run-trace.ts`; opens and completes a Context Run for every Slack interaction and records model, tool, token, transcript, participant, status, and affected Object evidence. | Context support for reviewable Runs; depends on sink, usage, retrieval, and canonical Chat identity. | Upstream execution telemetry is not the Context Run ingestion contract. **Keep and adapt.** | Run-trace, sink, shared-context, and emulator tests; API/integration docs must describe completed Runs. |
| `c1d77819` | [PR #13](https://github.com/bradwmorris/centaur/pull/13) | Adds the exact triggering Slack message timestamp to the trusted Context packet and distinguishes it from the root timestamp. | Context support for mutation idempotency; depends on Context Builder. | Upstream message handling exposes the source timestamp but not this Context instruction. **Keep.** | Shared-context regression and prior live mutation evidence; compatibility docs must mention triggering timestamp. |
| `f2115458` | [PR #13](https://github.com/bradwmorris/centaur/pull/13) | Merge record for `c1d77819`; no unique patch beyond its parent. | Context support history. | **Keep published merge history;** disposition follows its parent. | Evidence is attached to PR #13. |
| `5f492dd0` | [PR #16](https://github.com/bradwmorris/centaur/pull/16), [Issue #15](https://github.com/bradwmorris/centaur/issues/15) | Stops terminal/non-reusable sandboxes before clearing assignments, persists proxy IDs on Services, deletes proxy pods/Services/policies, and sweeps orphaned proxy resources after a grace period. | Unrelated operational fix; no Context dependency. | Upstream later changed proxy restart/reattachment but does not provide this complete orphan cleanup. **Keep and adapt.** | Rust lifecycle/Kubernetes tests and prior local incident cleanup; not required in Context compatibility docs. |
| `ba90df1c` | [PR #14](https://github.com/bradwmorris/centaur/pull/14) | Captures exact ordered retrieval packets, sanitized/bounded tool inputs and outputs, affected Object IDs, application-controlled turn input, composed sandbox instructions, and application tool catalogue; explicitly marks provider-hidden instructions/tools unavailable. | Context support for explainable evaluation evidence; depends on both hooks and completed Runs. | Upstream changed Codex/harness telemetry and prompt composition; PR #18 preserves both upstream spans and the Context instruction manifest. **Keep and adapt.** | Harness, sandbox, Slack trace/session tests and prior local Run evidence; Context docs must state evidence availability limits. |

## Surviving file and behavior inventory

### The two Slack hooks and later support

- `services/slackbotv2/src/interaction-sink.ts`: snapshot normalization,
  canonical participant/profile handling, bearer delivery, `chat_object_id`, and
  completed interaction payloads.
- `services/slackbotv2/src/shared-context.ts`: authenticated retrieval using
  `X-Centaur-Principal-Id`, `X-Centaur-Thread-Key`, execution/chat identity,
  ordered Object packets, 12,000-character prompt bound, and triggering message
  timestamp.
- `services/slackbotv2/src/index.ts`: non-blocking pre-ingest and retrieval,
  upstream execution/steering integration, usage/trace capture, and completion or
  failure publication.
- `services/slackbotv2/src/session-api.ts`: injects the Context preamble and
  exact requester/instruction evidence into durable execution input.
- `services/slackbotv2/src/eval-usage.ts` and `run-trace.ts`: normalized model
  usage plus bounded/redacted retrieval, tool, instruction, status, and affected
  Object evidence.
- `services/slackbotv2/src/server.ts`, `types.ts`, and `slack-user.ts`: parse the
  two hook contracts, usage attribution, identity refresh/overrides, timeouts,
  and portable Slack profiles.
- `services/slackbotv2/test/chat-sdk-emulate.test.ts`, `eval-usage.test.ts`,
  `interaction-sink.test.ts`, `run-trace.test.ts`, `session-api.test.ts`, and
  `shared-context.test.ts`: producer/consumer and fail-open regressions.
- `contrib/chart/templates/slackbotv2.yaml`, `values.yaml`, and
  `values.schema.json`: `interactionSink` and `contextBuilder` values, dedicated
  Secret references, identity/usage settings, and named-instance overrides.

The hook environment contract consists of
`SLACKBOTV2_INTERACTION_SINK_{URL,TOKEN,TIMEOUT_MS,PROFILE_TTL_MS,BOT_IDENTITY,IDENTITY_OVERRIDES,USAGE_PROVIDER,USAGE_AUTH_MODE,USAGE_BILLING_MODE,USAGE_UPSTREAM_SERVICE}`
and `SLACKBOTV2_CONTEXT_BUILDER_{URL,TOKEN,TIMEOUT_MS,LIMIT}`. Both hooks catch
and log receiver failures so normal Centaur execution continues.

### Multi-instance Slack and persona isolation

- `contrib/chart/templates/slackbotv2.yaml`, `ingress.yaml`,
  `networkpolicy.yaml`, `values.yaml`, and `values.schema.json`: render one
  isolated workload/service/route per named Slack app while retaining singleton
  compatibility.
- `services/slackbotv2/src/index.ts`, `server.ts`, `session-api.ts`, and
  `types.ts`: carry instance ID through webhook route, state namespace, metrics,
  persona, and principal construction.
- `services/api-rs/crates/centaur-iron-control/src/session.rs`: keeps Slack
  principal identities instance-scoped.
- `contrib/chart/templates/apirs.yaml`: discovers persona directories supplied
  by overlay mounts.

This is not required for a single Slack app. It is required when two app
identities share a Centaur deployment and must not share state, persona, or
principal authorization.

### Separate Curator inference integration

- `services/api-rs/crates/centaur-api-server/src/curator_inference.rs`: validates
  bounded input/schema, prohibits command and MCP tool activity, runs one
  temporary sandbox, requires valid structured JSON, returns usage and billing
  attribution, and stops the sandbox on success, failure, or timeout.
- `services/api-rs/crates/centaur-api-server/src/{args,auth,lib,main,routes}.rs`
  and `Cargo.toml`: register the fixed-model runtime, isolated principal/role,
  purpose-bound token/capability, route, dependencies, and startup wiring.
- `crates/harness-server/{Cargo.toml,Cargo.lock}` and
  `src/{codex,hermes,otel,server,wire}.rs`: forward structured output schema,
  normalize Codex events/usage, and emit exact application instruction/tool
  evidence without inventing provider-hidden data.
- `services/sandbox/compose_system_prompt.py`, `entrypoint.sh`, and
  `test_compose_system_prompt.py`: materialize the final composed instruction
  snapshot and tool catalogue used by the harness.
- `contrib/chart/templates/{apirs,ingress,networkpolicy}.yaml`, `values.yaml`,
  and `values.schema.json`: `apiRs.curatorInference`,
  `CURATOR_INFERENCE_{ENABLED,TIMEOUT_SECS}`, `CENTAUR_CONTEXT_API_KEY`, private
  route ingress, Context-pod allowance, and sandbox egress.
- `docs/pages/deploying-in-production.mdx` and
  `docs/pages/reference/configuration.mdx`: fork-local operator reference for
  subscription mode and the added capability.

The route is private and capability-scoped. It does not expose session APIs to
the Context token, does not pass tools to the Curator, and does not place the
subscription identity in Context or the sandbox environment.

### Optional tool/proxy and unrelated operational changes

- `tools/research/youtube/pyproject.toml` and `test_client.py`: declare and test
  YouTube caption egress. Optional; not part of either automatic hook.
- `services/api-rs/crates/centaur-sandbox-agent-k8s/src/{iron_proxy,lib}.rs` and
  `services/api-rs/crates/centaur-session-runtime/src/{cleanup,lib}.rs`: proxy
  deletion, adoption, orphan sweeping, and terminal sandbox teardown. General
  operational fix; not part of Context.

## Minimum Centaur changes for the current Context proof of concept

| Need | Minimum Centaur modification | Required? |
| --- | --- | --- |
| Completed-interaction ingestion | Carry `interactionSink` through Slackbot options/chart; pre-ingest to obtain canonical `chat_object_id`; publish a bounded normalized snapshot at completion; keep failures non-blocking. | Yes |
| Pre-execution retrieval | Carry `contextBuilder`; request with principal, canonical Slack thread, execution, and `chat_object_id`; inject the bounded packet immediately before execution; keep failures non-blocking. | Yes |
| Canonical identity | Use workspace + channel + root Slack timestamp for the Context Chat, refresh the triggering participant, and separately expose the triggering message timestamp. | Yes for the current API |
| Reviewable Runs/evals | Normalize model usage and publish completed/failed Run trace entries with exact retrieval packet, application input, composed instructions, tool catalogue/calls, affected Objects, and explicit unavailable markers. | Yes for the current evaluation POC |
| Deployment wiring | Add the two Secret-backed hook value blocks and allow Slackbot to reach Context ports 8082 (ingestion) and 8081 (retrieval). | Yes |
| Curator subscription transport | Add the private `POST /api/internal/context-curator/infer` capability, temporary tool-free structured-output sandbox, purpose-bound token/principal/role, usage attribution, chart Secret/env, ingress, and NetworkPolicy. | Only for `centaur_subscription`; direct provider mode is the rollback |
| Agent Context tool | Load the Context tool from an overlay, keep real read/write tokens in iron-proxy, and allow ports 8081 and 8084 as authorized. | Optional explicit agent reads/writes |
| Multiple Slack apps | Add named instance routes/workloads, state prefixes, personas, credentials, and instance-scoped principals. | Only for multi-app deployments |
| YouTube caption host | Retain the tool host declaration. | Optional and unrelated to Context |
| Terminal proxy cleanup | Retain teardown/orphan sweeping or obtain an upstream equivalent. | Recommended operational fix; unrelated to Context |

A third-party adopter should carry the required rows, not cherry-pick the first
two hook commits in isolation. The current Context API depends on the later
canonical identity, thread binding, timestamp, Run, usage, and evidence support.
Organization-specific personas, identity override data, endpoints, workspace
IDs, and secrets belong in a private overlay, never in this public fork.

## Verification and evidence limits

The refreshed branch produced the following local evidence:

- `pnpm install --frozen-lockfile` passed with the locked workspace;
- Slackbot v2 type-check passed and the complete Bun 1.4.2 suite reported 318
  passed, 1 intentionally skipped, and 0 failed;
- api-rs formatting and workspace Clippy passed, and the workspace test command
  passed, including the Curator, iron-control, sandbox-agent-k8s, runtime, and
  cleanup regressions;
- harness formatting and Clippy passed; tests reported 94 unit tests and 22
  offline integration tests passed, with 4 real-provider tests ignored;
- all 52 sandbox Python tests and the complete repository tool-test script
  passed, including the YouTube host regression;
- Helm lint, JSON Schema parsing, singleton Context Secret/env rendering,
  multi-instance Service/Deployment rendering, Context-to-api-rs NetworkPolicy
  rendering, conflict-marker scan, and `git diff --check` passed.

Unit and static coverage proves contract construction, authentication,
fail-open behavior, structured output/tool prohibition, sandbox teardown,
prompt evidence, chart wiring, and proxy/tool declarations. The api-rs database
environment variables were not set, so tests that return early without a
disposable database are not claimed as database-backed evidence. The sandbox
Kind integration binaries were also ignored because their dedicated test
namespace/images were not prepared.

The following cannot be claimed from local unit tests alone and must remain
explicit in the PR handoff:

- no live Slack workspace end-to-end was performed for this refresh;
- no live Context service/database was used to prove ingestion, retrieval, or a
  completed Run against the refreshed upstream;
- no Console subscription identity or real model call was used to prove the
  private Curator route;
- no local Kubernetes deployment was mutated to prove rendered policies,
  temporary sandbox cleanup, or ordinary Slack replies during a live Context
  outage;
- provider-hidden instructions and provider-managed tool definitions remain
  correctly labelled unavailable rather than guessed.

Prior PRs contain historical live evidence, but it is not a substitute for a
fresh end-to-end proof of this exact merged SHA.

## Context documentation follow-up

[Centaur Context Issue #21](https://github.com/bradwmorris/centaur-context/issues/21)
already corrected the misleading “two hooks are the whole fork” setup language
by separating the hooks, their later identity/evidence support, the Curator
transport, and the optional tool. The remaining confirmed gap is to publish the
exact refreshed Centaur SHA and audited adopter matrix in Context’s
`compatibility.toml` and integration guide; it is tracked by the documentation
[Issue #23](https://github.com/bradwmorris/centaur-context/issues/23).
