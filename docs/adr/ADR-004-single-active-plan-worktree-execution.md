# ADR-004: Single Active Root Plan with Plan-Owned Git Worktrees

Date: 2026-09-04
Status: ACCEPTED — TARGET FOR V4, NOT YET IMPLEMENTED
Supersedes for V4 execution: `docs/adr/0001-adopt-linked-workspaces-over-full-clones.md`

## Context

Pixel V4 currently creates an execution-private Git repository for each new execution. The current `LocalGitWorkspaceAdapter` stages a Git bundle and then clones it with `--no-hardlinks` before checking out the requested source revision. This provides a strong Git-metadata isolation boundary, but it also makes the execution workspace the unit of source-tree ownership.

That topology is more general than the product now needs.

The intended product concurrency model is now narrower:

1. a project may have **at most one active root Plan**;
2. a newly submitted independent top-level task for the same project is queued instead of starting concurrently;
3. concurrency is permitted only **inside the active root Plan**;
4. the active Plan's Planner/Supervisor owns one coherent dependency graph and may run only mutually independent WorkItems in parallel;
5. integration, exact-SHA review, delivery, CI repair, and bounded system repair remain inside the same root Plan ownership boundary;
6. a queued root Plan becomes active only after the current root Plan reaches its terminal delivery boundary or is explicitly cancelled.

This changes the trust and conflict model materially. The primary problem is no longer “multiple unrelated top-level plans may mutate the same repository concurrently.” Instead, all mutable Pixel workspaces for a project belong to one supervisor-controlled lineage.

Under that constraint, creating a full private Git repository per Execution is unnecessarily expensive and complicates recovery, dependency reuse, and repair continuity. The natural Git abstraction is a linked worktree.

## Decision

Pixel V4 will adopt a **project single-active-root-plan model** and make **Plan-owned Git worktrees** the default execution workspace primitive.

The target flow is:

```text
Project
  |
  +-- ActiveRootPlan: 0..1
  |
  +-- QueuedRootPlans: 0..N

ActiveRootPlan
  |
  +-- Controller-owned integration worktree
  +-- WorkItem writer worktrees (0..N, DAG-gated)
  +-- Detached exact-SHA review worktree (0..1 per review slot)
  +-- Delivery-repair worktree (0..1 writer at a time)
  |
  +-- delivery / CI / repair / completion

terminal root Plan
  -> remove plan-owned worktrees
  -> prune Git worktree metadata
  -> release project active-plan lease
  -> activate next queued root Plan
```

### 1. Project-level concurrency boundary

A root Plan must acquire a durable project execution lease before it can enter the active lifecycle.

For one project/repository identity:

```text
root Plan A RUNNING
root Plan B QUEUED
root Plan C QUEUED
```

is valid.

```text
root Plan A RUNNING
root Plan B RUNNING
```

is invalid.

A descendant repair Plan created for the active root Plan does not acquire a second project lease. It is part of the same Plan family and inherits the root Plan's ownership boundary. New implementation should prefer graph revisions / internal repair WorkItems over creating another independently scheduled root Plan.

### 2. Plan-internal concurrency

The active Plan may run multiple WorkItems concurrently only when the deterministic kernel can prove they are simultaneously eligible:

- all declared dependencies are satisfied;
- no direct or transitive dependency exists between the concurrent candidates;
- the Planner/Supervisor marked the candidates parallel-safe;
- declared write/conflict scopes do not overlap when scopes are available;
- all candidates start from the same declared integration/wave base;
- each mutable worktree has exactly one active writer;
- configured Plan parallelism has not been exceeded.

Unknown conflict scope is conservative: serialize rather than guess.

### 3. WorkItem, not Execution, owns the mutable writer worktree

A transport retry, provider retry, ACP session replacement, and `IMPLEMENT_FIX` for the same WorkItem lineage should normally reuse the existing WorkItem worktree.

Execution remains the durable attempt/provenance record; it is no longer the physical Git repository ownership unit.

```text
WorkItem A
  -> worktree A
       -> Execution 1 / DSH
       -> provider retry
       -> Execution 2 / DSH
       -> review FAIL
       -> Execution 3 / Codex or DSH repair
       -> accepted commit
```

At no point may two active implementation writers attach to the same mutable WorkItem worktree.

### 4. Integration is a single-writer controller surface

Every active Plan owns one integration branch/worktree. Model workers do not own it.

Recommended branch namespace:

```text
refs/heads/pixel-v4/<rootPlanId>/integration
refs/heads/pixel-v4/<rootPlanId>/items/<workItemId>
refs/heads/pixel-v4/<rootPlanId>/repairs/<repairId>
```

The Controller serially integrates independently reviewed WorkItem commits into the integration worktree. If integration conflicts, a bounded integration-repair WorkItem is created inside the same root Plan.

The canonical human/deployment checkout is not used as the integration workspace and its checked-out branch/working files must remain unchanged.

### 5. Review uses exact-SHA detached worktrees

Review never follows a mutable writer branch.

For a candidate revision:

```text
git worktree add --detach <review-path> <exact-sha>
```

The reviewer must inspect exactly that SHA. Tracked modification remains forbidden by verification. Ignored dependency/tool caches may be materialized when required for checks.

A review worktree is disposable and may be removed after the durable review evidence has been persisted.

### 6. Delivery repair remains inside the active Plan

Delivery/CI failure does not create an independently scheduled top-level task.

The repair lineage starts from the durable `deliveryHeadSha`:

```text
integration SHA
  -> delivery head
  -> CI failure
  -> delivery repair worktree @ deliveryHeadSha
  -> repair commit
  -> exact-SHA review
  -> push/update delivery
  -> CI
```

Repeated repair uses the latest verified delivery head, not the original product revision.

### 7. Literal worktree means shared Git common metadata

This ADR intentionally changes the earlier trust boundary.

A Git linked worktree shares the repository common Git directory. New commits create objects in the shared object database and worktree branch updates share the same ref namespace.

Therefore the following are Controller-only operations:

- `git worktree add/remove/prune/repair`;
- `git gc`, `git repack`, `git prune`, reflog expiry;
- arbitrary `git update-ref`;
- deletion/reset of refs not owned by the current Plan;
- canonical branch mutation;
- integration branch merge/reset outside the deterministic integration path.

Worker policy permits ordinary repository inspection and plan-scoped commit operations but must prohibit repository maintenance and sibling-worktree administration.

The Controller additionally snapshots protected refs before Plan activation and verifies them during reconciliation. Unexpected protected-ref movement places the Plan in `SAFETY_HOLD`.

This is a deliberate simplification trade-off. If Pixel later treats an execution worker as fully hostile rather than bounded/trusted, literal canonical worktrees are not a sufficient hard security boundary and the isolated-repository model must be reinstated for that trust class.

### 8. OpenHands path topology is part of the implementation

Current production facts:

- host workspaces are under `/opt/data/hermes-ai-office-v3/...`;
- OpenHands sees them through `/workspace`;
- canonical projects live under `/home/dev/projects`;
- Git on GCP Dev is currently 2.43 and does not provide `git worktree add --relative-paths`.

A literal linked worktree records paths into the shared common Git directory. The execution container must therefore see the worktree administrative paths and allowed common Git directories consistently.

The migration must use explicit identity mounts rather than a broad writable `/home/dev/projects` mount:

- keep the stable `/workspace/...` execution alias;
- add an identity mount for the managed worktree host root at the same absolute host path when required by Git administrative back-references;
- expose only allowlisted project Git common directories required by active Pixel projects;
- never make every project working tree broadly writable inside OpenHands merely to satisfy Git worktree path resolution.

A later Git upgrade may allow relative worktree paths, but correctness must not depend on an unverified version upgrade.

### 9. Queue order is durable and deterministic

Top-level root Plans receive a durable project queue sequence. Normal activation is FIFO.

Explicit operator reprioritization may change queued ordering, but creating a new task does not preempt the active Plan. Preemption is out of scope for this ADR. The operator must explicitly cancel or safely pause the active root Plan before another root Plan may acquire the lease.

## Invariants

The migration is complete only when all of the following hold:

1. one project has at most one nonterminal active root Plan lease;
2. independent new top-level Plans queue instead of provisioning workspaces;
3. only DAG-ready, explicitly parallel-safe WorkItems may own concurrent writer worktrees;
4. every mutable worktree has a single active writer;
5. implementation retries/fixes for the same WorkItem reuse its writer worktree when provenance is unambiguous;
6. integration has exactly one Controller writer;
7. reviewers run on detached exact-SHA worktrees;
8. canonical human/deployment working tree remains unchanged;
9. protected refs outside the active Plan namespace cannot move unnoticed;
10. no new execution performs a full-history clone as its normal provisioning path;
11. crash recovery re-adopts durable worktrees instead of cloning a replacement;
12. Plan completion removes all Plan-owned worktrees and releases the project lease;
13. queue activation is atomic with project lease ownership;
14. legacy execution-private clones remain recoverable during migration.

## Consequences

Positive:

- one Git object database is shared across all concurrent WorkItems in the active Plan;
- adding a WorkItem no longer duplicates repository history;
- retries and review repair naturally preserve local dependency/build caches when safe;
- parallelism becomes easier to reason about because it exists only under one root Plan graph;
- unrelated user tasks cannot race the active integration lineage;
- cleanup is naturally Plan-scoped;
- recovery can re-adopt worktrees by durable role/WorkItem identity;
- queue state makes “what is currently being worked on?” unambiguous.

Costs/trade-offs:

- worker Git processes and the Controller share common Git metadata;
- a malformed/destructive local Git command has a larger blast radius than in an execution-private clone;
- OpenHands mount topology and UID/GID/permission handling must support the shared common Git directory;
- protected-ref drift detection and Controller-only maintenance become mandatory safety contracts;
- external/untrusted execution classes may still require isolated repositories rather than this worktree mode.

## Supersession of ADR-0001

ADR-0001 was correct for the earlier assumption that multiple unrelated top-level tasks could execute concurrently while workers required strong Git-metadata isolation.

ADR-004 changes that assumption. For **new V4 normal trusted execution**, the project-level single-active-root-plan lease replaces cross-plan Git isolation as the primary concurrency boundary, and literal worktrees become the preferred implementation.

ADR-0001 remains historical documentation and may remain useful for:

- legacy V3 execution recovery;
- an explicitly untrusted worker mode;
- future multi-host or multi-root-plan execution if reintroduced.

## Rollback

Workspace mechanics remain behind a workspace-management boundary. Rollback must be possible by:

1. stopping new worktree provisioning;
2. letting or cancelling active Plan worktrees at a safe boundary;
3. retaining durable execution/review/delivery evidence;
4. switching new writer provisioning back to execution-private clone mode;
5. leaving queued Plan and project lease records intact.

No rollback may silently run both literal-worktree and clone writers for the same active WorkItem.
