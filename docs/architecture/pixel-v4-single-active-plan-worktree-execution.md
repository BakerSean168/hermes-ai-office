# Pixel V4 Single-Active-Plan Worktree Execution Architecture

Date: 2026-09-04
Status: TARGET ARCHITECTURE
Governing decision: `docs/adr/ADR-004-single-active-plan-worktree-execution.md`

## 1. Goal

Replace execution-scoped full Git clones with a simpler project concurrency model:

```text
one project
  -> zero or one active root Plan
  -> zero or more queued root Plans
  -> controlled parallel WorkItems only inside the active Plan
  -> Git worktrees for writer/review/integration roles
```

The architecture deliberately removes support for unrelated top-level Plans mutating one project concurrently.

## 2. Current implementation baseline

The current V4 `LocalGitWorkspaceAdapter.provision()` does approximately:

```text
resolve canonical repository
-> validate source revision
-> git bundle create --all
-> git clone --no-hardlinks --no-checkout <bundle> <execution-repo>
-> checkout/switch source revision
-> materialize submodules
-> publish execution workspace
```

A separate repository is therefore created for each Execution.

Current stable contracts include:

```text
host:      /opt/data/hermes-ai-office-v3/workspaces/v4/executions/<executionId>/repo
container: /workspace/v4/executions/<executionId>/repo
```

Execution completion is bound to clean committed Git evidence and exact review provenance. These evidence contracts remain; only the workspace ownership topology changes.

## 3. Target ownership model

### Project

The project/repository identity is the top-level concurrency key.

```text
ProjectExecutionState
  projectKey
  canonicalRepositoryPath
  activeRootPlanId: string | null
  leaseVersion
  leaseAcquiredAt
```

A project may have one active root Plan family.

### Root Plan

The root Plan owns:

- queue position before activation;
- integration branch/worktree;
- all parallel WorkItem worktrees;
- all exact-SHA review worktrees;
- delivery repair worktrees;
- descendant repair Plans/graph revisions;
- protected-ref snapshot;
- final cleanup and lease release.

### WorkItem

The WorkItem becomes the normal mutable-worktree ownership unit.

```text
WorkItem
  -> Worktree
      -> one active writer at a time
      -> many sequential Execution attempts
```

Execution is still the audit/provenance unit, not the source-tree storage unit.

## 4. Proposed filesystem layout

Recommended host layout:

```text
/opt/data/hermes-ai-office-v3/worktrees/v4/
  <projectKey>/
    <rootPlanId>/
      integration/
        repo/
      items/
        <workItemId>/
          repo/
      reviews/
        <reviewId>/
          repo/
      repairs/
        <repairId>/
          repo/
```

Recommended OpenHands aliases:

```text
/workspace/v4/plans/<rootPlanId>/integration
/workspace/v4/plans/<rootPlanId>/items/<workItemId>
/workspace/v4/plans/<rootPlanId>/reviews/<reviewId>
/workspace/v4/plans/<rootPlanId>/repairs/<repairId>
```

Existing `WorkspaceDescriptor` callers should not be forced to understand Git worktree internals. Introduce a richer descriptor while preserving `hostPath`, `executionPath`, source revision, and evidence paths.

Suggested additive fields:

```text
workspaceKind: WORKTREE | LEGACY_CLONE
rootPlanId
worktreeId
worktreeRole: INTEGRATION | WORK_ITEM | REVIEW | DELIVERY_REPAIR
workItemId?
branchRef?
baseRevision
```

The shared common Git directory is Controller metadata and should not be serialized into model-facing prompts.

## 5. Durable persistence

### 5.1 Project active-plan lease

Add a durable project lease table rather than inferring activity by scanning Plan status.

Suggested schema:

```text
project_plan_leases
  project_key              PRIMARY KEY
  repository_root          NOT NULL
  active_root_plan_id      NULL
  version                  NOT NULL
  acquired_at              NULL
  updated_at               NOT NULL
```

Operations must be CAS-based:

```text
tryAcquire(projectKey, rootPlanId, expectedVersion)
renew(...)
release(...)
```

A stale process may not activate another Plan after losing the lease.

### 5.2 Durable queue

Two acceptable implementations:

A. additive Plan columns:

```text
queue_sequence
queued_at
activated_at
root_plan_id
```

or B. a dedicated `project_plan_queue` table.

Prefer a dedicated queue table if queue reprioritization/audit is required:

```text
project_plan_queue
  plan_id          PRIMARY KEY
  project_key      NOT NULL
  sequence         NOT NULL
  priority         NOT NULL DEFAULT 0
  enqueued_at      NOT NULL
  activated_at     NULL
  cancelled_at     NULL
```

Ordering:

```text
priority DESC, sequence ASC
```

Default priority is equal for all user tasks, giving FIFO behavior.

### 5.3 Plan worktree registry

Suggested durable table:

```text
plan_worktrees
  worktree_id        PRIMARY KEY
  root_plan_id       NOT NULL
  work_item_id       NULL
  role               NOT NULL
  host_path          NOT NULL UNIQUE
  execution_path     NOT NULL UNIQUE
  branch_ref         NULL
  base_revision      NOT NULL
  current_revision   NOT NULL
  state              NOT NULL
  owner_execution_id NULL
  created_at         NOT NULL
  updated_at         NOT NULL
```

States:

```text
PROVISIONING
READY
WRITER_ATTACHED
QUIESCENT
REVIEWING
INTEGRATED
RETIRED
FAILED
```

Only one `WRITER_ATTACHED` owner is legal per mutable worktree.

## 6. Plan queue lifecycle

Target top-level state flow:

```text
submission
  -> DRAFT
  -> QUEUED
  -> project lease acquired
  -> READY
  -> RUNNING
  -> ...
  -> delivery terminal boundary
  -> SUCCEEDED / FAILED / CANCELLED
  -> cleanup
  -> release project lease
  -> activate next QUEUED root Plan
```

`QUEUED` should be a real Plan status rather than overloading `DRAFT` or `WAITING_FOR_RESOURCE`.

`WAITING_FOR_RESOURCE`, `WAITING_FOR_SYSTEM_REPAIR`, and `WAITING_FOR_EXTERNAL_EVIDENCE` do **not** release the project lease. The root Plan is still the active project owner because its integration/delivery lineage remains live.

A Plan releases the project lease only when:

- it is terminal and its owned worktrees are retired; or
- an explicit operator cancellation/preemption procedure reaches a quiescent boundary.

Automatic preemption is out of scope.

## 7. Internal graph parallelism

### 7.1 Eligibility

A WorkItem is parallel-dispatch eligible only when:

```text
status == READY
AND all dependencies == SUCCEEDED
AND planner says parallelSafe
AND no active sibling has overlapping conflict scope
AND active writer count < plan.parallelism
```

### 7.2 Conflict declarations

Extend WorkItem planning metadata with optional deterministic hints:

```text
parallelSafe: boolean
writeScopes: string[]
conflictKeys: string[]
```

Examples:

```text
frontend/workbench
backend/diagnosis-api
infra/r2-distribution
schema/patient-profile
```

The kernel does not need perfect static path prediction. Its rule is conservative:

- explicit non-overlap may run concurrently;
- overlap serializes;
- unknown serializes unless the Planner provides a validated parallel group.

### 7.3 Waves

Use integration waves to keep a stable base:

```text
integration HEAD = S0
  |
  +-- Item A @ S0
  +-- Item B @ S0
  +-- Item C @ S0

A/B/C reviewed
  -> serial integration into integration worktree
  -> integration HEAD = S1

next DAG-ready wave starts @ S1
```

This prevents downstream WorkItems from silently starting on stale ancestry.

## 8. Worktree roles

### 8.1 Integration worktree

Controller-owned.

```text
branch: pixel-v4/<rootPlanId>/integration
writer: deterministic Controller only
lifetime: entire active root Plan
```

Responsibilities:

- integration base authority;
- serial merge/cherry-pick of accepted WorkItems;
- integration checks;
- delivery candidate production.

No model worker receives unrestricted ownership of this worktree.

### 8.2 WorkItem writer worktree

```text
branch: pixel-v4/<rootPlanId>/items/<workItemId>
writer: one active implementation Agent
lifetime: WorkItem implementation/review-fix lineage
```

Reuse for:

- provider/transport retry when workspace state is safe;
- ACP session replacement;
- `IMPLEMENT_FIX` after review findings;
- same WorkItem continuation.

Do not create another worktree merely because a new Execution record is created.

### 8.3 Review worktree

```text
branch: detached
HEAD: exact reviewed SHA
writer: none for tracked files
lifetime: one review attempt or reusable exact-SHA review cache
```

Reviewer may materialize ignored dependencies/caches. Completion requires exact HEAD and no tracked/non-ignored changes.

### 8.4 Delivery repair worktree

```text
base: latest durable deliveryHeadSha
branch: pixel-v4/<rootPlanId>/repairs/<repairId>
writer: one repair Agent
```

A repeated CI failure starts from the latest repaired delivery head.

## 9. Worktree creation mechanics

Host Controller is the only component allowed to create/remove worktrees.

Examples:

```text
# integration
git -C <canonical> worktree add -b pixel-v4/<plan>/integration <path> <baseSha>

# work item
git -C <canonical> worktree add -b pixel-v4/<plan>/items/<item> <path> <waveBaseSha>

# review
git -C <canonical> worktree add --detach <path> <exactSha>
```

Do not use `--force` as normal control flow.

Every operation is fenced by:

- project active-root-plan lease;
- plan worktree durable record;
- filesystem lock for the specific worktree path;
- branch/ref namespace validation;
- exact base SHA validation.

## 10. OpenHands/Git common-dir topology

### Current limitation

The host and container use different paths for the workspace root, and Git 2.43 records absolute worktree administrative paths by default.

Current mapping:

```text
host      /opt/data/hermes-ai-office-v3/...
container /workspace/...
```

Canonical repositories are not currently mounted at `/home/dev/projects` inside OpenHands.

### Target mount rule

Preserve both:

1. model-friendly stable `/workspace/...` aliases;
2. Git administrative path identity required by linked worktrees.

A production implementation should use explicit mounts for:

```text
managed worktree root -> /workspace
managed worktree root -> same host absolute path (identity alias)
allowed project common Git dir -> same absolute path
```

Do not mount all project working trees read-write.

The release gate must execute Git commands **inside the OpenHands container as the real Agent UID** against a production-shaped worktree before enabling the feature.

Required smoke:

```text
git status
git rev-parse --show-toplevel
git rev-parse --git-common-dir
edit fixture
run test
commit on plan-scoped branch
verify canonical checkout unchanged
```

## 11. Shared Git metadata safety policy

Literal worktrees share Git metadata, so safety shifts from physical isolation to ownership and detection.

### Protected refs

At minimum protect:

```text
main/master
release branches
non-Pixel user branches
production tags
refs not under refs/heads/pixel-v4/<activeRootPlanId>/
```

Persist a protected-ref snapshot when the Plan activates.

Before/after worker completion and during reconciliation:

```text
current protected refs == expected protected refs
```

Unexpected movement:

```text
-> SAFETY_HOLD
-> cancel active writer sessions
-> no automatic ref repair unless exact restoration is proven safe
```

### Worker-prohibited Git maintenance

Worker instructions/policy must deny:

```text
git gc
git repack
git prune
git worktree add/remove/prune/repair
git update-ref outside own allowed branch
git branch -D sibling/protected branches
git reflog expire
arbitrary reset of integration/protected refs
```

Controller owns those operations.

### Honest security statement

This is a bounded-worker safety model, not a hostile-code sandbox for the Git common directory. If the model/runtime is considered adversarial, use an isolated repository execution mode.

## 12. Integration semantics

Accepted WorkItem revision must satisfy:

- exact candidate SHA exists;
- candidate descends from recorded wave base or approved dependency base;
- WorkItem review PASS binds to exact SHA;
- writer worktree is clean;
- protected refs unchanged.

Controller then integrates in deterministic order.

If merge is clean:

```text
integration HEAD advances
WorkItem exactAcceptedRevision persists
item worktree may retire
```

If conflict:

```text
no partial hidden merge state
-> integration repair WorkItem
-> same root Plan
-> bounded repair/re-review
```

## 13. Crash recovery

On restart:

1. recover project active-root-plan lease;
2. enumerate `plan_worktrees` for the active root Plan;
3. run `git worktree list --porcelain` from the canonical repository;
4. match durable IDs/paths/branch refs exactly;
5. reject duplicate/mismatched ownership;
6. re-adopt quiescent valid worktrees;
7. recover active Agent sessions by Execution identity;
8. do **not** create a replacement worktree when a valid durable worktree exists.

A filesystem worktree with no durable registry record is orphan residue. Do not silently adopt it. Quarantine/remove it only after proving it belongs to the Pixel namespace and no active Agent references it.

## 14. Cleanup lifecycle

### WorkItem completion

After accepted revision is integrated and all evidence is durable:

```text
stop/release writer
remove WorkItem worktree
git worktree prune
retain commit objects in common DB
```

### Review completion

Remove detached review worktree after review evidence persists and no resume lease remains.

### Root Plan completion

Order:

```text
1. no active execution/provider sessions
2. delivery terminal condition satisfied
3. retire item/review/repair worktrees
4. retire integration worktree
5. delete plan-scoped local branches no longer required
6. git worktree prune
7. verify protected refs
8. release project plan lease
9. atomically activate next queued Plan
```

Do not run automatic `git gc` as part of ordinary Plan cleanup.

## 15. Storage behavior

With execution-private clones, N parallel executions can duplicate repository history N times.

With worktrees:

```text
1 x Git common object database
N x checked-out working trees
N x worktree-local dependencies/build output when needed
shared package/build download caches where supported
```

For large repositories such as MemoFlow, this removes the repeated multi-gigabyte Git-history component from normal Plan-internal parallelism.

Disk-pressure policy still remains necessary for:

- `node_modules`;
- `.venv`;
- build outputs;
- ignored caches;
- review/repair worktrees;
- common Git object growth.

## 16. Compatibility

During migration:

- an Execution with a durable legacy clone continues using that clone;
- a new root Plan activated after the feature gate uses Plan-owned worktrees;
- never convert an in-flight writer clone into a worktree in place;
- never attach one WorkItem lineage to both a legacy clone and a new worktree concurrently.

A feature flag should gate new provisioning until production-shaped worktree smokes pass.
