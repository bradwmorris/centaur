# External workflow access

The host CLI and stdio MCP use a separate credential with only external workflow
access. All enabled, successfully discovered Python workflows are listed,
including those without webhooks or schedules. The operator intentionally grants
that caller the ability to invoke all these workflows. Do not distribute this
credential to untrusted agents: workflow invocation can incur costs and perform
side effects. Existing domain approvals remain the workflow's responsibility.

## Server and host installation

Release the API and Python workflow host together and apply migrations 0055 and 0056.
Configure `CENTAUR_EXTERNAL_WORKFLOW_CALLERS` in the existing API Secret as a JSON
object mapping stable caller names to independent random tokens of at least 32
characters. Never put token values in Helm values, command arguments or Git.
Each deployment has its own keys. Keep the same caller name during rotation so
previous request receipts remain accessible. Removing its key revokes access.
No token grants sessions, arbitrary events, cancellation or administrative routes.
Do not pass this server-only setting to the workflow-host sandbox.

Use an approved loopback port-forward to the API, or a configured HTTPS endpoint.
No new public ingress is required. On the host, install this package with a Python
3.11+ environment. Store configuration and token files owned by the local user,
mode 0600. Example configuration (the token contents are in separate files):

```json
{"targets":{"research":{"url":"http://127.0.0.1:18095","token_file":"~/.config/centaur-workflows/research-token"},"personal":{"url":"http://127.0.0.1:18096","token_file":"~/.config/centaur-workflows/personal-token"}}}
```

Configure a local stdio MCP command invoking `centaur-workflows --config
<absolute-config-path> mcp`. MCP calls use Codex-supplied `_meta.threadId`; CLI calls use the real
`CODEX_THREAD_ID` environment. Never set a fixed chat ID in global configuration; this is client attribution, not proof of a human
approval. The server authenticates the configured host caller independently.
MCP discovery starts no tunnel and invokes no workflow.

## Usage

`workflow_list(target)` returns name, description and optional input schema.
`workflow_validate(target, request_id, workflow_name, input)` checks admission
only: enabled workflow, native object input and bounded identifiers. Domain
validation still runs inside the workflow; a schema is documentation, not a
claim of full JSON Schema enforcement. Modules can publish `WORKFLOW_DESCRIPTION`
and `WORKFLOW_INPUT_SCHEMA` alongside their existing definitions.

`workflow_start` takes the same arguments and persists a caller-scoped request.
Use a new request ID for a new logical action, and retain it for retries.
`workflow_status(target, request_id)` resumes after reconnecting without starting
anything. It returns pending/terminal state and the workflow's result or failure, plus
up to 50 verified owned child executions. `children_truncated` explicitly flags
larger trees. Child input is checked before sharing an existing deduplicated
child result; child origin is not treated as a fresh desktop authorization.
An `admitted` result means enqueue was interrupted: resubmit identical arguments.
Changing any original input, workflow or chat under an existing ID fails before
another enqueue. A lost enqueue response is safe to retry under the same ID.
Request records must be retained as long as retries are supported; never delete
them as a routine cleanup while allowing old request IDs to be reused.

The API stores authenticated origin separately from user input and passes it as
`ctx.external_origin`. A workflow may adapt its native input for that surface;
it must not interpret an input field as authenticated origin. Child workflows
are not automatically given the caller's origin or approval. Existing workflows
remain responsible for validated domain inputs, their own executor identity and
explicit approval before protected external actions. Provider callbacks cannot
be treated as human approval merely because this API started a workflow.

CLI equivalents: `centaur-workflows --config <path> list --target research`,
`... validate --target research --file request.json`, `... start ...`, and
`... status --target research --request-id <same-id>`. The file contains
`request_id`, `workflow_name`, and `input`; the client supplies the chat ID.

## Validation and release evidence

Run the Python client and workflow-host suites and focused Rust API/workflow
checks. Database admission tests require a disposable database with migrations
0055 and 0056. Release acceptance additionally requires actual catalog discovery, a
synthetic workflow run, retry after response loss, caller isolation and result
readback through the deployed MCP path. Local unit tests are not deployment proof.

## Exact approvals

Workflows call `ctx.request_approval(name, event_type, correlation_id, preview=...,
exact=..., approvers=[...])` at an existing approval gate. `exact` contains the
immutable event fields; preview contains the complete human-reviewable proposal.
Default decisions are approve/reject/revise. A workflow may declare alternatives.
The API binds the descriptor to the durable task/step and original request owner.
Changing it on replay fails closed; start a new logical request for revised content.
Native invocations retain their existing event transport.

Status includes `approvals`: saved ID, canonical event name, preview digest, descriptor and nullable
first decision. Show the full proposal (and any linked preview) to the user.
Only after explicit human approval call `workflow_decide` with `request_id`,
`approval_id`, `preview_digest`, `decision` and `approval_reference` identifying
that human message. The tool supplies the actual Codex thread ID. A workflow
start, a model-generated claim, or text in a preview is never human approval.
The CLI equivalent is `decide --target <target> --file <decision.json>`.

An operator must separately set `CENTAUR_EXTERNAL_WORKFLOW_APPROVERS` to a JSON
mapping from configured caller name to an allowed domain approver, for example
`{"desktop-reviewer":"human-reviewer"}`. Omission denies desktop decisions.
This explicitly delegates approval transport to the trusted desktop agent. The
server cannot independently verify a human chat message: `verified` in the legacy
event means trusted configured ingress, not a cryptographic human signature.
Grant only to a trusted agent/operator pair and never expose this setting to
sandbox workflows. The decision endpoint cannot choose an actor or emit arbitrary
events. Removing the mapping revokes decisions without revoking read/start access.

Existing trusted Slack event ingress can answer the same registered event using
its exact saved fields and an allowed verified actor. Both surfaces share one
locked Postgres decision. The first decision wins; an opposing decision is denied.
Identical retries return the original audit and safely repeat durable event
emission after delivery loss. Read workflow completion after deciding; a saved
decision alone is not proof that the external action completed. This does not
add a Slack button or forward previews to a channel automatically.

For deployments with a customized existing sandbox image, build
`services/workflow-python/Dockerfile.overlay` using `WORKFLOW_HOST_BASE` set to
that verified image digest. This updates only the Python host and preserves its
existing tools and runtime trust. Set the API's `WORKFLOW_HOST_IMAGE` to the new
image; interactive session images need not change.
