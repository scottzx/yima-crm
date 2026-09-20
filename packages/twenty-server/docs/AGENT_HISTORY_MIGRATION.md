# Agent history workspace migration

This is an operator-run storage migration, separate from normal instance upgrades.
Deploy the complete stack to **every API server, worker and command runner** first.
All processes must connect to the same primary PostgreSQL database and support
`agent-history-storage-v1`. Session advisory locks require a direct database
connection or session pooling; do not run these commands through a transaction
pooler. No deployment step automatically switches existing workspaces.

The object definitions follow Twenty's standard application synchronization path.
The dedicated APIs retain their current ownership, AI/AI_SETTINGS permissions and
support-consent checks. Raw history objects are SYSTEM-only. This does not enable
conversation sharing or expose prompts/tool payloads through generic record APIs.

## Rollout

Run commands from the server package in the deployed build, with its normal
database configuration. The commands below are examples, not an automatic rollout.

1. Verify that the old API/worker fleet has terminated. The `--routing-deployed`
   switch is an explicit operator attestation; it cannot detect old binaries.
   Keep the previous release artifact and take the normal database backup.
2. Dry-run a canary. This validates additive schema changes and source references,
   reports per-table counts and current progress, and rejects active streams.
   Dry-run does not copy, compare the destination, or change the route.

   ```sh
   node dist/command/command.js agent-history:migrate --workspace-id WORKSPACE_UUID --dry-run
   ```

3. Let active streams finish or cancel them through the normal chat controls.
   Run the canary migration. The command prepares missing metadata and core
   reference constraints, then fences AI history operations for that workspace.
   New stream claims cannot race the drain check. If a stream claimed first,
   migration refuses to start and leaves normal traffic enabled.

   ```sh
   node dist/command/command.js agent-history:migrate --workspace-id WORKSPACE_UUID --batch-size 1000 --routing-deployed
   ```

   Clearing the inactive destination and copying both use bounded batches.
   Source IDs, every source column, hidden messages, queued messages, tool JSON,
   evaluations and credit precision are preserved. Thread `deletedAt` maps to
   `archivedAt`; workspace `deletedAt` remains unused by the chat archive feature.
   Verification compares every row/column, checks references, and changes the
   primary database route only after success. The command emits no record events.

4. Check chat lists, archive/unarchive, attachments, retry/cancel, queued messages,
   onboarding kickoff, question answers, monitoring/evaluations, usage counts and
   support access with consent both enabled and disabled. Check two owners and
   two workspaces. Measure latency, error rates, primary load and migration time.
   Support's global chat list groups core workspaces and batches workspace queries; test
   its latency with the instance's actual number of consenting workspaces.
5. Enable workspace storage for newly initialized workspaces. This affects only
   new empty workspaces; existing workspaces without a route remain on core.

   ```sh
   node dist/command/command.js agent-history:set-default --storage workspace --routing-deployed
   ```

6. Expand with `--workspace-count-limit`, `--start-from-workspace-id`, or repeated
   `--workspace-id` flags. The standard provisioned-workspace iterator handles
   selection and shutdown signals. Review its per-workspace failure report;
   do not interpret partial progress as completion. Rerunning is idempotent.

   ```sh
   node dist/command/command.js agent-history:migrate --workspace-count-limit 20 --start-from-workspace-id WORKSPACE_UUID --routing-deployed
   ```

AI history returns a retryable service-unavailable error while its workspace is
being copied; other workspaces continue serving. Plan a maintenance interval per
workspace. This is not a zero-downtime, dual-write migration. The durable route
is intentionally separate from cached feature flags, and must never be edited
manually. Before a final retirement release, account for all workspace activation
states and any workspaces excluded by the provisioned-workspace iterator.

## Failure and rollback

A killed runner leaves its progress and fence durable. Rerun the same command to
resume. An inconsistent schema, reference, or full-row comparison leaves the
source authoritative and AI history fenced; investigate or abort. Two runners
cannot migrate/abort/clean the same workspace concurrently.

To abandon an incomplete copy after stopping its runner:

```sh
node dist/command/command.js agent-history:migrate --workspace-id WORKSPACE_UUID --abort
```

Abort clears only the incomplete destination, then restores access to the source.
It preserves verification/cleanup timestamps and needs no new deployment attestation.
If abort itself is interrupted, rerun it. Its durable aborting state prevents a
copy from resuming against a destination that abort has already partly cleared.

After successful cutover, rollback requires reverse migration. Drain active
streams, disable workspace storage for future new workspaces if appropriate, and
copy the latest workspace history back. This includes writes and deletions made
after cutover and rejects core IDs belonging to another workspace.

```sh
node dist/command/command.js agent-history:set-default --storage core --routing-deployed
node dist/command/command.js agent-history:migrate --workspace-id WORKSPACE_UUID --target core --routing-deployed
```

Changing the default affects future initializations only. Workspaces initialized
directly onto workspace storage also need individual reverse migration.

Only deploy a pre-routing binary after **every** workspace has completed reverse
migration and the default for new workspaces is core. A flag flip or restoring
an old snapshot would lose post-cutover writes.

## Retention and cleanup

Retain the inactive core snapshot for the agreed rollback window (14 days by
default). The snapshot keeps its legacy foreign keys during this window, so it
may still prevent deletion of files that only the old snapshot references.
Cleanup requires a verified workspace route and an elapsed retention window;
it deletes only core rows in batches and allows live workspace traffic.
Fleet-wide cleanup skips core routes, active migrations, already cleaned stores
and workspaces still inside retention. Invalid state and database errors remain
failures. Dry-run reports eligible workspaces without changing them.

```sh
node dist/command/command.js agent-history:cleanup --workspace-id WORKSPACE_UUID --dry-run
node dist/command/command.js agent-history:cleanup --workspace-id WORKSPACE_UUID --retention-days 14
```

Cleanup is resumable/idempotent. Reverse migration can still rebuild core rows
from workspace data afterward while the compatibility release is deployed.
The five legacy tables/entities and router remain for this rollback release.
Their removal is a subsequent contract release gated on zero core routes, no
in-progress migrations, no legacy rows, no old binaries and expired rollback
commitments; never drop tables in the additive migration release. Join route rows
against workspace activation states when auditing the fleet: initialization may
write its route before a later provisioning step fails. A route row alone does
not prove successful provisioning.

Missing or mistyped routes with workspace history fail closed, including after
cleanup. During this compatibility release, a missing route on an empty store is
indistinguishable from a never-migrated workspace and defaults to core. Protect
and back up these configuration rows; the contract release must require an
explicit route for every provisioned workspace before removing that fallback.

Standard application synchronization reconciles the cross-schema owner/file
constraints and rejects drift in their definitions. Workspace hard deletion
removes members, then drops its schema before deleting the core workspace and
files. Keep that ordering when changing workspace teardown. Generic trash is not
part of the history API; all five objects remain SYSTEM-only, chat archive uses
`archivedAt`, and history deletion is hard deletion.

Runtime mutations load metadata before taking a core connection. The workspace
ORM has a separate PostgreSQL pool (`WorkspaceDataSourceService`); the core fence
stays held until the workspace operation finishes. The fence transaction does
not make the workspace write atomic with its own final commit, so callers must
retain their existing idempotence/stream ownership checks when retrying failures.
Budget connections for both pools and measure streaming checkpoint throughput.
Do not cache the route using asynchronous invalidation: a process with stale
state could acquire the shared lock after cutover and still write to the old
store. Support reports instead use a read-only repeatable-read snapshot spanning
route selection and data queries, including concurrent cleanup.

## Verification

The PostgreSQL acceptance suite builds workspace tables using the real standard
field definitions and exercises the workspace ORM. It covers exact high-value
credits, archives, crash/resume, active streams, exclusive runner ownership,
concurrent stream claims/checkpoints, row verification failure, abort, owner
cascades, file restrictions, tenant references, reverse copy, retention/cleanup
and the new-workspace default. CI runs disposable databases on PostgreSQL 16
(the self-hosted Compose default) and 18. The suite also exercises replayed
updates with original timestamps, SQL credit increments, route loss, constraint
repair, abort state preservation and reports concurrent with cleanup.

For a local disposable PostgreSQL database named `agent_history_migration_test`:

```sh
AGENT_HISTORY_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_history_migration_test \
  npx jest --config packages/twenty-server/jest.config.mjs --runInBand \
  src/database/commands/agent-history/__tests__/agent-history-migration.postgres.spec.ts
```

The suite recreates only its own schemas and refuses a different database name.
It does not substitute for a staging canary with the real fleet and production
traffic characteristics.
