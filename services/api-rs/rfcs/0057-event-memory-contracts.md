# Versioned Event and Memory inference contracts

## Outcome
Establish Events-first capture and selective, evidence-linked evolving Memories for new activity. Historical cleanup is deferred.

## Repository scope
Public shared broker, Issue #57; consumer bradwmorris/centaur-context#149. Related #49.

## Requirements
Conversations and verified action evidence produce coherent canonical Events; Events selectively produce useful evolving Memories. Zero output is a checkpointed success. Preserve evidence, uncertain times, attribution, historical applicability, protected/manual records, revisions and recovery. Synthesis is the single automatic Memory writer; explicit correction remains separate. No historical backfill, legacy sweep, new scheduler/service, vector store or generalized framework.

## Approach
Extend curator_inference.rs exact allowlist with event-extraction-v1 and memory-synthesis-v1 schemas matching Context. Retain existing extraction/maintenance/chat-summary schemas for compatible broker-first deployment. Both new schemas are bounded, deny unknown fields, and convey explicit evidence references. Context retains authority to validate provenance, scope and revisions; model output is never permission. Update narrow runtime guidance to Event-first capture. Verify the actual installed broker in each destination after approved release; existing image tags are not source identity proof.

## Acceptance
Pre-release: schema compatibility; grouping and evidence validation; interactive/background deduplication; new/updated/withdrawn evidence; explicit preference and change of mind; zero output; stale revisions; replay, late commits and restart; protected/manual preservation; narrow invalidation and no self-trigger loop; visible retry/deferred/failure state. Use synthetic fixtures and existing CI databases. No extra local database or destructive live test.
Post-release: small reviewed saved-plan trial and actual supported ingress paths in each installation; truthful timing/evidence and useful selective Memory output; enable automatic synthesis only after reviewed trial. Preserve old records and prove cutover coverage.

## Completion
Self-review and passing draft PRs precede one exact-revision owner approval checkpoint. No merge/deployment before approval. Deploy compatible broker first, pause legacy automatic Memory paths, install new consumer in preview, review/apply exact saved trial, enable synthesis and verify both destinations. Keep parent open until live acceptance. Rollback pauses new workers and preserves evidence/checkpoints; it must not restart legacy flooding. Material scope changes require owner clarification; ordinary implementation details are executor-owned.
