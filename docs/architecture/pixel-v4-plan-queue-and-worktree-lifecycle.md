# Pixel V4 Plan Queue and Worktree Lifecycle

Date: 2026-09-04
Status: TARGET LIFECYCLE CONTRACT

## Purpose

This document defines the state-machine rules that make literal Git worktrees safe enough for Pixel's simplified concurrency model.

The central rule is:

> Top-level concurrency is serialized at the project boundary; parallelism exists only inside one active root Plan and is owned by one supervisor/kernel lineage.

## 1. Root Plan versus internal repair

### Root Plan

A root Plan represents an independently submitted project objective:

```text
"Refactor BodySense diagnosis workspace"
"Replace BodySense logging system"
"Add new MemoFlow GitHub sync flow"
```

Only one root Plan may actively own a project.

### Internal work

These are **not** separately schedulable root tasks:

- implementation fix after review;
- integration conflict repair;
- delivery CI repair;
- provider/session recovery;
- bounded system/infrastructure repair caused by the active Plan;
- graph revision caused by a newly discovered dependency.

They inherit the current root Plan's lease and stay inside its lifecycle.

## 2. Submission and queueing

### No active Plan

```text
submit Plan A
-> persist queue entry
-> CAS acquire project lease
-> activate Plan A
```

### Active Plan exists

```text
Plan A RUNNING
submit Plan B
-> Plan B QUEUED
-> no execution
-> no worktree
-> no provider reservation
```

The queue is durable before the API acknowledges submission.

## 3. Activation transaction

Activation must atomically establish:

- queue item selected;
- project lease owned by root Plan;
- Plan leaves `QUEUED`;
- root Plan activation timestamp;
- protected-ref snapshot baseline;
- integration worktree intent/record.

If the process crashes after the lease CAS but before integration worktree publication, restart resumes the same Plan activation. It must not activate the next queued Plan.

## 4. Waiting states keep ownership

The following statuses still own the project:

```text
RUNNING
WAITING_FOR_RESOURCE
WAITING_FOR_SYSTEM_REPAIR
WAITING_FOR_EXTERNAL_EVIDENCE
SAFETY_HOLD
```

Rationale: the Plan still has a live source/integration/delivery lineage. Letting another root Plan mutate the project while the first waits would reintroduce the concurrency problem this design removes.

## 5. DAG dispatch

The Supervisor may propose parallel WorkItems, but the kernel owns dispatch.

For each cycle:

```text
ready = graph items whose dependencies are satisfied
eligible = ready filtered by safety/conflict policy
wave = deterministic subset up to parallelism limit
```

Recommended deterministic ordering inside a wave:

```text
explicit planner priority
then graph insertion order/itemKey
```

Two WorkItems are not concurrent when:

- one depends on the other;
- their declared write scopes overlap;
- either one has unknown conflict scope and is not explicitly approved as parallel-safe;
- one is an integration/delivery single-writer operation.

## 6. Writer worktree state machine

```text
PROVISIONING
  -> READY
  -> WRITER_ATTACHED
  -> QUIESCENT
  -> WRITER_ATTACHED   (retry/fix/resume)
  -> INTEGRATED
  -> RETIRED
```

Failure paths:

```text
PROVISIONING -> FAILED
WRITER_ATTACHED -> QUIESCENT after provider interruption/recovery
QUIESCENT -> FAILED only when provenance is unrecoverable
```

No second writer may attach while state is `WRITER_ATTACHED`.

## 7. Execution relationship

Execution attempts reference a worktree; they do not own it.

```text
WorkItem WT
  Execution #1 FAILED retryable (provider)
  Execution #2 RUNNING same WT
  Execution #2 SUCCEEDED SHA X
  Review X FAIL
  Execution #3 IMPLEMENT_FIX same WT
  Execution #3 SUCCEEDED SHA Y
  Review Y PASS
  integrate Y
```

Product attempt accounting remains independent from physical worktree reuse.

## 8. Review lifecycle

Per-item review:

```text
candidate SHA X
-> create detached review worktree @ X
-> independent reviewer
-> persist exact-SHA evidence
-> remove review worktree
```

A review failure returns findings to the same WorkItem lineage. The writer worktree is reused if still provenance-safe.

Aggregate/integration review follows the same exact-SHA rule against integration HEAD.

## 9. Delivery lifecycle

```text
integration HEAD
-> delivery candidate
-> push/update PR
-> required checks
```

If checks pass, finalize delivery.

If checks fail:

```text
persist CHECKS_FAILED + headSha
-> create internal delivery repair
-> repair worktree @ headSha
-> repair commit
-> exact-SHA review
-> update delivery
```

There is never a second independently active root Plan for the repair.

## 10. Queue release boundary

The next root Plan may activate only after all of these are true:

```text
current root Plan terminal
AND no active implementation/review/repair provider session
AND no mutable plan-owned worktree has a writer
AND integration/delivery state is terminal or explicitly abandoned
AND plan worktrees cleaned or durably quarantined
AND protected refs verified
AND project lease released by its current version owner
```

The release and next activation should use one fenced scheduling transaction/critical section so two service instances cannot activate two queued Plans simultaneously.

## 11. Cancellation

User cancellation is explicit.

Procedure:

```text
mark cancellation requested
-> stop new WorkItem dispatch
-> interrupt active providers
-> persist terminal/paused observations
-> prevent integration/delivery advancement
-> clean/quarantine worktrees
-> mark Plan CANCELLED
-> release project lease
-> activate queue head
```

Do not simply change Plan status while Agents still write shared worktrees.

## 12. Safety hold

Enter `SAFETY_HOLD` when:

- protected ref moved unexpectedly;
- durable worktree path does not match Git worktree registry;
- worktree branch escapes active Plan namespace;
- two active writers claim one worktree;
- canonical checked-out branch/working tree changed unexpectedly due to Pixel;
- shared Git common dir fails integrity/trust checks;
- a destructive Git-maintenance operation is detected from a Worker.

`SAFETY_HOLD` keeps the project lease. Human/operator resolution is required before another root Plan runs.

## 13. Plan-family child compatibility

Current V4 has parent/child Plan relationships. During migration:

- top-level independent child/follow-up objectives should queue as new root Plans;
- `SYSTEM_REPAIR`, `INFRASTRUCTURE_REPAIR`, and delivery `FOLLOW_UP` caused by the active Plan inherit `rootPlanId` and the project lease;
- child repair must not create another integration root;
- long-term target is to represent most repair as graph/work items rather than nested top-level Plan scheduling.

## 14. Operator UX

The Dashboard/API should show one unambiguous project status:

```text
BodySense
  Active: PLAN-123 — Diagnosis workbench refactor
  Parallel workers: 3/4
  Integration SHA: abc123
  Delivery: CHECKS_RUNNING
  Queue:
    1. PLAN-124 — Logging refactor
    2. PLAN-125 — UI polish
```

The operator should not need to inspect filesystem directories to understand concurrency.

Required controls:

- enqueue new task;
- reprioritize queued task;
- cancel queued task;
- cancel active Plan;
- inspect active WorkItems/worktrees;
- place/release safety hold;
- manually retry a failed internal repair.

## 15. Metrics

Track at least:

```text
project_active_plan_count             (must be 0/1)
project_queue_depth
plan_parallel_writer_count
plan_worktree_count
plan_worktree_reuse_count
plan_worktree_create_duration
plan_worktree_cleanup_duration
protected_ref_drift_count
worktree_recovery_count
legacy_clone_provision_count
```

A production invariant alert should fire if `project_active_plan_count > 1` for the same project identity.
