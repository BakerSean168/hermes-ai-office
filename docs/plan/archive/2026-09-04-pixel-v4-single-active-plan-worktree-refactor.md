# Pixel V4 Single Active Plan + Git Worktree Refactor

Date: 2026-09-04
Status: IMPLEMENTED / DEPLOYED / PRODUCTION GATE ENABLED
Governing ADR: `docs/adr/ADR-004-single-active-plan-worktree-execution.md`

## Goal

Replace execution-scoped full Git clones for normal new V4 work with Plan-owned literal Git worktrees while simplifying top-level concurrency:

```text
one project -> one active root Plan -> queued later tasks
```

and preserving controlled parallelism only for mutually independent WorkItems inside that active Plan.

## 2026-09-05 closure snapshot

The refactor is now **fully enabled in production for the intended scope**. The production-shaped canary and the real BodySense recovery lineage together prove the complete control path: root Plans serialize per project, parallel-safe WorkItems can execute concurrently, exact-SHA independent review precedes integration, delivery is reconciled durably, terminal cleanup releases the project lease, and the canonical checkout remains unchanged.

The BodySense exact-SHA recovery Plan `plan_5e1ab84d-5eb1-4ed5-ba22-800f3bfc8fae` completed at revision `a53052129a95ab017be3bd8b427ab4cc0b95d028`. Its independent review passed at that exact SHA, PR #165 was verified and merged as `a82da464f109c407e66328d9f9aff94a01589629`, and the older sibling delivery `plan_938c89bb-5b2f-4f74-a7b7-856d5818ce4f` was safely marked `SUPERSEDED` only after exact Git ancestry and shared delivery lineage were proven. There are now **zero non-terminal BodySense Plans**.

The production gates are enabled:

```text
MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED=true
MODEL_CP_V4_LITERAL_WORKTREES_ENABLED=true
MODEL_CP_V4_LITERAL_WORKTREE_PROJECTS=bodysense
MODEL_CP_V4_MAX_PARALLEL_WORK_ITEMS=2
```

`MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED` is project-scoped: MemoFlow, Digital Biome, and BodySense may each own one active root Plan independently. Literal worktrees are currently enabled only for BodySense; the other project workspace providers are intentionally unchanged.

The final runtime/release line is:

- `ee21e7e` — close terminal Supervisor recovery and exact verified-sibling delivery lineage;
- `32a9224` — enable the production single-active/literal-worktree gates;
- `d98c22f` — retry transient runtime transport admission failures on the short recovery TTL;
- `9ed8b2f` — make release artifact publication safe against Spot preemption;
- `a50289b` — verify candidate/live artifacts with a path-independent relative manifest.

The model-control-plane quality gate is **224/224 tests PASS**, with typecheck, release-script syntax validation, Python helper compilation, JavaScript syntax validation, `git diff --check`, and a production-shaped literal-worktree smoke also passing. The final release reported source SHA `a50289ba860e07b8f26ebecb69e733c6401e6157`, exact review `true`, canonical checkout unchanged `true`, and production health with both gates enabled.

A real GCP Spot preemption during the rollout proved an additional failure mode: the VM was preempted while Git/build output was being written, leaving zero-length loose Git objects and a truncated `dist/main.js`. Source integrity was recovered from the last complete commit, `git fsck --full` returned clean, and the release path was hardened. Releases now use `core.fsync=committed`, a single-release lock, an ignored staging candidate, production-shaped smoke against that candidate, and an atomic same-filesystem `renameat2(RENAME_EXCHANGE)` cutover. A preemption during compilation therefore leaves either the previous complete runtime or the new complete runtime, not a partially rebuilt live `dist`.

Runtime admission remains intentionally fail-closed and dynamic. At the final observation the available implementation probe set had READY capacity while the reasoning routes were temporarily returning transport failures, so `reviewReady=0`. This does **not** reopen the worktree rollout: new review work waits for an admitted reviewer rather than bypassing review. `RUNTIME_PROBE_TRANSPORT_ERROR` now uses the short transient retry TTL, and production timestamps confirmed affected bindings were re-probed on subsequent resource-refresh cycles instead of remaining negatively cached for 15 minutes.

## Definition of Done — satisfied

The refactor was considered complete only after a production-shaped scenario proved:

```text
submit Plan A
submit Plan B while A active
-> A active, B queued, B owns no workspace

A planner creates independent WorkItems X/Y/Z
-> X/Y/Z run concurrently in separate worktrees sharing one common Git DB
-> each can commit/test independently
-> exact-SHA reviews bind to their commits
-> Controller serially integrates accepted commits
-> integration exact-SHA review passes
-> delivery/CI repair stays in A
-> A terminal
-> every A worktree removed
-> project lease released
-> B activates automatically
```

The canonical project checkout must remain unchanged throughout.

## Non-goals

- no unrelated top-level Plan concurrency for the same project;
- no automatic Plan preemption;
- no cross-host worktree sharing;
- no hostile-worker guarantee for the shared Git common directory;
- no removal of current ResourceSelector/model-agent routing;
- no redesign of exact-SHA review/evidence formats;
- no conversion of already-active legacy clone workspaces in place.

# Phase 0 — Baseline and migration fences

## WT-0001 — Record current clone behavior and storage baseline

**Scope**

- `model-control-plane/src/v4/adapters/gitWorkspace.ts`
- storage/forensics docs/tests

**Work**

1. Add a characterization test proving current new Execution provisioning uses a private repository clone.
2. Record representative repository `.git` size and execution workspace size.
3. Record current Git version and OpenHands mount topology.
4. Keep a test that legacy workspaces remain recoverable after migration.

**Acceptance**

- baseline is reproducible;
- no production behavior changes.

## WT-0002 — Introduce feature gates

Add:

```text
MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED
MODEL_CP_V4_LITERAL_WORKTREES_ENABLED
MODEL_CP_V4_MAX_PARALLEL_WORK_ITEMS
```

Default worktree flag OFF until release smoke exists.

**Acceptance**

- old behavior remains identical with flags off;
- configuration is visible in health projection without exposing secrets.

# Phase 1 — Project single-active-root-plan queue

## WT-1001 — Add explicit `QUEUED` root Plan state

**Target files**

- `src/v4/domain/plan.ts`
- schema/repositories/tests

**Work**

1. Add `QUEUED` to Plan status.
2. Define legal transitions:

```text
DRAFT -> QUEUED
QUEUED -> READY | CANCELLED
```

3. Prevent ordinary automation from running a queued Plan.
4. Add `rootPlanId` semantics for internal child repair compatibility.

**Acceptance**

- queued Plan creates no Execution;
- queued Plan creates no workspace;
- replay preserves queue state.

## WT-1002 — Durable project lease

Create `project_plan_leases` with CAS version fencing.

**API**

```text
get(projectKey)
tryAcquire(projectKey, rootPlanId, expectedVersion)
renew(...)
release(...)
```

Repository root must also be bound to the lease so a reused/misconfigured `projectKey` cannot point at two repositories.

**Acceptance**

- two service instances cannot acquire two root Plans for one project;
- stale owner cannot release newer owner lease;
- restart preserves owner.

## WT-1003 — Durable FIFO queue

Create durable queue ordering.

Required operations:

```text
enqueue
list
reprioritize
cancelQueued
claimNext
```

`claimNext` must be atomic with lease acquisition/activation.

**Acceptance**

- Plan B/C remain queued while A owns lease;
- after A releases, B activates before C;
- duplicate scheduler cycles do not double-activate.

## WT-1004 — Parent/child Plan family semantics

Internal repair child Plans inherit the root Plan lease.

Longer-term repair paths should prefer WorkItems/graph revisions.

**Acceptance**

- system/delivery repair cannot appear as a second active root Plan;
- independent user follow-up is queued as a new root Plan.

# Phase 2 — Plan worktree manager

## WT-2001 — Add `PlanWorktreeManager`

Do not mutate `LocalGitWorkspaceAdapter` into a mixed monolith. Introduce a V4 worktree-specific manager behind the workspace/provider boundary.

Suggested source files:

```text
src/v4/adapters/planWorktrees.ts
src/v4/domain/worktree.ts
src/v4/persistence/worktreeRepository.ts (or existing repository module)
```

Responsibilities:

- create/recover/remove integration worktree;
- create/recover/remove WorkItem worktree;
- create/remove detached review worktree;
- create/recover delivery repair worktree;
- validate branch namespace and exact base;
- reconcile with `git worktree list --porcelain`;
- never perform provider/session logic.

## WT-2002 — Durable worktree registry

Persist:

```text
worktreeId
rootPlanId
workItemId?
role
hostPath
executionPath
branchRef?
baseRevision
currentRevision
state
ownerExecutionId?
```

All attach/release operations CAS on state/version.

**Acceptance**

- restart can recover without cloning;
- duplicate worktree ownership fails closed;
- unknown filesystem residue is not silently adopted.

## WT-2003 — Integration worktree

Create one integration worktree at Plan activation.

```text
pixel-v4/<rootPlanId>/integration
```

Only Controller integration code may mutate its branch.

**Acceptance**

- canonical checkout HEAD/index/files unchanged;
- one Plan -> exactly one integration writer;
- restart re-adopts exact branch/path.

## WT-2004 — WorkItem writer worktree

Create one mutable worktree per active WorkItem lineage, not per Execution.

```text
pixel-v4/<rootPlanId>/items/<workItemId>
```

**Acceptance**

- provider retry uses same path;
- ACP replace uses same path;
- `IMPLEMENT_FIX` uses same path when provenance is safe;
- two active writers on one WorkItem are rejected.

## WT-2005 — Exact-SHA review worktree

Create detached worktree at reviewed SHA.

**Acceptance**

- reviewed SHA exact;
- tracked files unchanged;
- review evidence durable before removal;
- removal does not delete candidate commit.

## WT-2006 — Delivery repair worktree

Base repair on durable delivery head.

**Acceptance**

- first CI repair starts from first failed head;
- second repair starts from previous repaired head;
- repair remains in root Plan family.

# Phase 3 — OpenHands literal worktree runtime

## WT-3001 — Production path identity design

Current Git 2.43 lacks `worktree add --relative-paths`, so do not assume portable relative administrative links.

Implement explicit container path identity:

- managed worktree host root visible under stable `/workspace` alias;
- managed worktree host root also available at required host-identical absolute path when Git references it;
- only allowlisted project Git common directories exposed at exact absolute paths;
- no broad read-write `/home/dev/projects` mount.

**Acceptance**

Inside real OpenHands container/UID:

```text
git status
rev-parse --show-toplevel
rev-parse --git-common-dir
commit on plan branch
```

all work.

## WT-3002 — Git common-dir permissions

Define the minimum worker access required for plan-scoped commits.

Document and test the intentional bounded-worker trust model.

**Fail closed if** the only way to make worktrees work is to expose unrelated project working trees or unrelated Git directories writeable to the Agent.

## WT-3003 — Worker Git policy

Agent Harness instructions/policy deny maintenance/ref-admin commands outside worker role.

Controller-only:

```text
worktree add/remove/prune/repair
gc/repack/prune
arbitrary update-ref
integration branch mutation
protected branch mutation
```

Add command/evidence monitoring where possible.

## WT-3004 — Protected-ref snapshot and drift gate

At Plan activation persist protected refs.

Reconcile at least:

- before launching a writer;
- after writer terminal completion;
- before integration;
- before delivery;
- before Plan cleanup.

Unexpected drift -> `SAFETY_HOLD`.

# Phase 4 — Plan-internal parallelism

## WT-4001 — WorkItem parallel metadata

Add optional:

```text
parallelSafe
writeScopes
conflictKeys
```

Planner/Supervisor may propose; kernel validates.

## WT-4002 — Deterministic wave scheduler

Select DAG-ready parallel set.

Rules:

```text
no dependency relationship
no conflict overlap
same wave/integration base
within max parallelism
```

Unknown -> serialize.

## WT-4003 — Integration wave advancement

After accepted WorkItems complete, integrate serially into integration worktree.

Next wave starts from resulting integration HEAD.

**Acceptance**

- downstream WorkItem never starts from pre-dependency base;
- integration order deterministic and persisted.

# Phase 5 — ExecutionWorker/workspace ownership refactor

## WT-5001 — Decouple Execution from workspace creation

Today provisioning is execution-scoped. Change orchestration so Execution obtains a worktree lease/reference from its WorkItem/root Plan role.

ExecutionSession continues to persist the concrete workspace descriptor used.

## WT-5002 — Same-WorkItem retry reuse

Reuse worktree for:

- provider retry;
- route retry when worker state is recoverable;
- ACP session replacement;
- `IMPLEMENT_FIX`.

Dirty/ambiguous workspace is resumed or fails closed; never attach a second fresh writer silently.

## WT-5003 — Evidence compatibility

Keep current completion evidence schema where possible.

`executionId` remains evidence provenance even when multiple Executions share one WorkItem worktree sequentially.

Verification must bind:

```text
Execution
+ WorkItem worktree lease
+ source SHA
+ result SHA
+ exact tests
```

## WT-5004 — Meaningful-progress/recovery integration

The current meaningful-progress recovery logic must replace/resume the provider session **without replacing the WorkItem worktree**.

A stalled model turn is not a reason to create another Git worktree.

# Phase 6 — Review, integration, delivery alignment

## WT-6001 — Per-item exact-SHA review on detached worktree

Preserve current independent review policy.

## WT-6002 — Controller-only integration

Replace any remaining execution-repository import assumptions with shared-repo worktree integration.

Because candidate commits already exist in the common object database, normal integration no longer needs bundle export/fetch from private execution clones.

**Acceptance**

- no full-history bundle during normal worktree integration;
- candidate SHA resolves directly;
- canonical checkout untouched.

## WT-6003 — Aggregate review

Review exact integration HEAD using detached review worktree.

## WT-6004 — Delivery/CI repair

Reuse the already implemented delivery-head lineage, but provision a repair worktree rather than another full clone.

# Phase 7 — Cleanup and queue handoff

## WT-7001 — WorkItem worktree retirement

Remove after:

```text
accepted SHA durably integrated
AND no repair/resume lease
AND no active provider session
```

## WT-7002 — Plan terminal cleanup

Remove integration/review/repair worktrees and plan-scoped local branches.

Do not run automatic GC.

## WT-7003 — Atomic lease release and queue activation

Release root Plan lease only after cleanup/safety gates.

Then atomically activate queue head.

**Acceptance**

- there is never a gap where two schedulers activate two Plans;
- queued Plan provisions nothing until activated.

# Phase 8 — Storage/operations

## WT-8001 — Storage accounting by Plan/worktree role

Expose:

```text
project
rootPlanId
worktree count
role
working tree bytes
ignored cache bytes
shared common Git bytes (count once)
```

Dashboard must not multiply shared `.git` size by worktree count.

## WT-8002 — Safe worktree reconciler

Periodic reconciler:

- validates durable registry vs `git worktree list`;
- removes only proven stale Pixel administrative residue;
- never removes active/human worktrees.

## WT-8003 — Project-level Git maintenance runbook

GC/repack only at quiescent boundary with no Pixel worktrees.

# Phase 9 — Migration and cutover

## WT-9001 — Legacy workspace compatibility

Existing `LEGACY_CLONE` sessions continue to recover normally.

## WT-9002 — Canary project

Recommended first canary: BodySense, after no legacy active execution remains.

Scenario:

1. enqueue two root Plans;
2. activate first only;
3. split first into at least two parallel-safe WorkItems;
4. run two different Agent backends;
5. review/integrate;
6. force one CI repair;
7. finish delivery;
8. confirm second Plan activates only afterward.

## WT-9003 — Remove normal full-clone provisioning

Only after canary and another project pass:

- normal trusted V4 new Plan uses worktrees;
- legacy clone provider remains compatibility/fallback for explicit isolated mode;
- metrics prove `legacy_clone_provision_count == 0` for normal paths.

# Verification Matrix

## Queue/concurrency

- second root Plan queues;
- queued Plan has zero workspace/provider activity;
- project lease survives restart;
- stale scheduler cannot activate another Plan;
- internal child repair inherits root lease.

## Worktree mechanics

- all WorkItem worktrees share same Git common dir;
- no history-sized clone per Execution;
- canonical checkout unchanged;
- plan-scoped commit works as real Agent UID;
- exact detached review works;
- retry/fix reuses worktree;
- worktree removal leaves candidate objects resolvable while referenced.

## Parallelism

- independent scopes run concurrently;
- dependency/overlap serializes;
- only one writer per WorkItem worktree;
- only one integration writer.

## Security/safety

- protected ref drift -> safety hold;
- worker cannot use Controller maintenance API;
- unknown Git worktree residue not auto-adopted;
- branch namespace injection rejected;
- canonical repo path/common dir stays allowlisted.

## Recovery

- service crash after worktree creation/before DB attach;
- crash after DB record/before worktree creation;
- crash while provider writes;
- crash after candidate commit before review;
- crash after integration before WorkItem retirement;
- crash during Plan terminal cleanup;
- every case resumes/adopts or fails closed without duplicate writer/worktree.

## Delivery

- exact-SHA review before delivery;
- required-check failure creates internal repair;
- repeated repair follows latest delivery head;
- next root Plan does not activate until delivery lifecycle terminal.

# Release Gate

Before enabling `MODEL_CP_V4_LITERAL_WORKTREES_ENABLED=true` for a project in production:

```text
full unit/integration suite PASS
typecheck PASS
build PASS
git diff --check PASS
production-shaped OpenHands worktree smoke PASS
parallel two-WorkItem smoke PASS
exact-SHA review smoke PASS
crash-recovery smoke PASS
queue handoff smoke PASS
protected-ref drift negative test PASS
storage baseline demonstrates shared Git object DB
```

A release must fail closed if the current container mount/UID topology cannot support literal worktrees without broad unsafe host exposure.

# Rollout Order

```text
1. Merge queue + project lease with clone workspaces still enabled.
2. Observe single-active-plan behavior in production.
3. Add worktree manager and production-shaped smoke behind flag.
4. Enable BodySense canary.
5. Run full active Plan including parallel WorkItems + repair + delivery.
6. Enable MemoFlow/Digital Biome.
7. Retain legacy clone mode only as explicit compatibility/strong-isolation fallback.
```
