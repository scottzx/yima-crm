# Agent history in workspace schemas

Status: implementation and deployment contract. Related audit: twentyhq/core-team-issues#2905.

## Decision

Register `agentChatThread`, `agentMessage`, `agentMessagePart`, `agentTurn`, and
`agentTurnEvaluation` as standard workspace objects. Agent definitions remain
syncable metadata. Files and billing remain shared infrastructure.

The initial storage transition preserves dedicated chat and monitoring APIs.
All five raw history objects declare SYSTEM readability and SYSTEM writability,
are not searchable, and do not emit generic record events. The chat API continues
to require AI permission and thread ownership; monitoring continues to require
AI_SETTINGS; instance support access continues to require impersonation consent.
Hidden messages and raw tool payloads must not become queryable by generic APIs,
applications, workflows, exports, or subscriptions as a side effect of migration.
SYSTEM visibility must hold regardless of record-sharing entitlement or flags.

This separates a tenant's registered data model from its public API surface.
A later conversation-sharing feature can expose an explicitly sanitized model
using the existing record-share machinery, with mandatory private enforcement
and strictly parent-controlled child access. Merely changing these objects to
PRIVATE/INHERITED is unsafe: current entitlement fallbacks, application bypass,
and independent child grants do not implement those requirements. Do not build
a separate ACL engine inside the chat persistence layer.

## Pull request stack

1. Mandatory SYSTEM event visibility and this architecture/deployment contract.
2. Standard object definitions, stable identifiers, relations, indexes, and types.
3. Explicit workspace-scoped history persistence and compatibility routing for
   chat, streaming jobs, monitoring, attachments, stats, onboarding, and support.
4. Per-workspace resumable copy, verification, cutover, rollback, and guarded cleanup commands.
5. New-workspace initialization, CI acceptance coverage, and the rollout runbook.

Each PR targets its predecessor. Deploy the additive definitions and all routing
code before running cutover. No PR automatically destroys the source tables.

## Deployment and consistency

Storage selection is durable migration state read from the primary database,
not a cached product flag. An operator cannot safely roll a workspace back by
flipping a boolean once it has accepted writes in workspace storage.

Every persistence operation participates in a per-workspace database fence.
The migration serializes with operations before selecting a source and changing
state. Migration ownership is database-backed; a second runner cannot migrate
the same workspace concurrently. Existing streams must finish before migration;
new claims cannot race the drain check. Other workspaces keep serving traffic.

Copy in bounded primary-key batches, preserving UUIDs, timestamps, archive state,
message ordering, queued messages, hidden context, evaluations, and exact integer
credit/token values. Persist progress with each batch so a killed runner resumes.
Validate all source columns and references, not counts alone. Only after a full
verification may the runner switch the authoritative store. Do not broadcast
historical rows as newly created records or trigger workflows during the copy.

Core user-workspace, file, and agent identifiers remain explicit references;
workspace history relations use workspace metadata. Archived threads retain
existing archive semantics; a generic soft-delete default must not change chat
lists or monitoring. Keep the unique hidden-kickoff-message invariant and atomic
compare-and-set stream ownership updates.

During copying, the workspace's AI history may be temporarily unavailable.
Expose a retryable migration error; do not silently fall back to another store.
A failed or killed migration retains its durable state and source data. Resume
or explicitly abort it. Migration is an operator-run maintenance operation,
not a normal request or an unbounded transaction during deployment.

Rollback after cutover requires draining writes, copying the authoritative
workspace data back, checking equality, and atomically restoring the core route.
Restoring an old binary or toggling a flag is not a rollback procedure.

## Release gates

- Deploy routing to every API server, worker, and command runner before migrating.
- First dry-run a representative workspace, including archived/hidden messages,
  attachments, pending questions, large payloads, and high credit counters.
- Migrate a canary; verify chat, retry/cancel, queued messages, onboarding,
  monitoring/evaluation, file downloads, support search, and usage stats.
- Test two owners and two workspaces, sharing enabled/disabled, API keys,
  applications, workflows, subscriptions, and entitlement loss.
- Kill a copy mid-batch; resume. Race a stream claim with cutover. Run concurrent
  migration attempts. Verify both failures leave one authoritative store.
- Verify rollback with new/updated/deleted workspace records after cutover.
- Roll out in bounded workspace batches and monitor failures and duration.
- Retain core rows for an explicit rollback window. Cleanup requires successful
  cutover for that workspace and must never delete workspace-owned history.
- Dropping the five core tables belongs to a subsequent release after all
  workspaces (including suspended ones) are migrated and rollback has expired.

The operator procedure is in [the rollout runbook](../AGENT_HISTORY_MIGRATION.md).
