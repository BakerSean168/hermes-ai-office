# AI Office Execution Closure

Status: COMPLETE  
Owner: AI Office V3 Control Plane  
Base revision: `1ceb18f`  
Project key: `pixel-agents`  
Created: 2026-08-23

## Objective

Turn AI Office from a phase-by-phase delegation facade into a durable plan
executor. A multi-ticket active plan must survive Hermes retries, gateway
restarts, worker failures, review failures, and operator reconnects without
duplicating writes, skipping review gates, losing causal links, or hiding live
work from the dashboard.

## Acceptance criteria

1. `ORCHESTRATE` produces a durable `plan_id` and a validated batch graph.
2. Every work item has a stable identity independent of Hermes tool-call IDs.
3. Repeating the same plan/batch/work-item command returns the existing
   execution instead of creating a duplicate writer.
4. A successful `IMPLEMENT` automatically creates its `VERIFY_REVIEW` gate.
5. A blocking review automatically creates `IMPLEMENT_FIX`; a passing review
   unlocks the next batch only after deterministic integration succeeds.
6. Later batches start from the preceding integrated revision.
7. Dashboard and Pixel Office can read the same plan/batch/execution projection.
8. Platform readiness evidence is displayed separately from current plan
   progress.
9. Removed continuation semantics are not required for normal recovery.
10. The end-to-end test survives a simulated gateway restart and one failed
    review without duplicate implementation execution.
11. A delivery-authorized plan pushes its integrated revision to a named branch,
    creates or reuses one pull request, waits for remote checks, merges through
    branch protection, and verifies checks on the merge revision.
12. Failed pre-merge checks create a bounded, durable repair batch instead of
    stranding implementation commits in an isolated workspace.
13. `SUCCEEDED` means remote delivery and post-merge verification completed when
    delivery was requested; polling or observer timeout never changes plan truth.

## Execution graph

```text
P0 Contract + durable plan records
 ├─ P1 Stable work-item identity and business idempotency
 ├─ P2 Single-batch automatic IMPLEMENT → REVIEW → FIX loop
 │   └─ P3 Deterministic integration revision and next-batch unlock
 ├─ P4 Unified plan projection for dashboard and Pixel Office
 └─ P5 Remove continuation compatibility and run failure-injection E2E
     └─ P6 Remote delivery, CI repair, merge, and post-merge proof
```

## Batches

### Batch 0 — Contract and durable plan records

Status: COMPLETE  
Dependencies: none  
Complexity: HIGH  
Risk: HIGH  
Quality: PREMIUM  
Parallelism: 1

Scope:

- Add `Plan`, `Batch`, and `WorkItem` records to the V3 SQLite schema.
- Add a small repository interface for creating and reading plan projections.
- Add `POST /api/v3/development/plans` and `GET /api/v3/development/plans/:id`.
- Persist the ORCHESTRATE proposal before any worker is launched.
- Return stable plan and work-item identities to Hermes.

Acceptance:

- Restarting the control plane does not lose a plan or its batch graph.
- Invalid dependency graphs are rejected before execution starts.
- Existing execution APIs and tests remain green.

### Batch 1 — Business idempotency and causal lineage

Status: COMPLETE  
Dependencies: Batch 0  
Complexity: HIGH  
Risk: HIGH  
Quality: PREMIUM  
Parallelism: 1

Scope:

- Add `plan_id`, `batch_id`, `work_item_id`, and `attempt` to executions.
- Replace tool-call-derived identity with a business command key.
- Enforce one active writer per work item and one active phase attempt.
- Make retries return the existing execution.

Acceptance:

- Repeating the same IMPLEMENT command produces one execution ID.
- A review cannot target another project or another work item.

### Batch 2 — Single-batch automatic gate loop

Status: COMPLETE  
Dependencies: Batch 1  
Complexity: HIGH  
Risk: HIGH  
Quality: PREMIUM  
Parallelism: 1

Scope:

- Add a durable coordinator/reconciler.
- IMPLEMENT success schedules VERIFY_REVIEW.
- FAIL schedules IMPLEMENT_FIX and a fresh review.
- PASS marks the work item complete.
- No Hermes follow-up call is required for the loop.

Acceptance:

- One batch reaches a terminal state after a simulated failed review.
- Every transition is represented by an append-only plan event.

### Batch 3 — Integration revision and batch unlock

Status: COMPLETE  
Dependencies: Batch 2  
Complexity: HIGH  
Risk: HIGH  
Quality: PREMIUM  
Parallelism: 1

Scope:

- Add deterministic `BATCH_INTEGRATE` operation.
- Advance `plan.current_revision` only after all reviews pass.
- Provision the next batch from the integrated revision.
- Enter `BLOCKED` on merge conflicts or missing evidence.

Acceptance:

- Batch 2 sees Batch 1's integrated changes.
- Conflicts never silently advance the plan.

### Batch 4 — Unified observability projection

Status: COMPLETE  
Dependencies: Batch 0  
Complexity: MEDIUM  
Risk: MEDIUM  
Quality: STANDARD  
Parallelism: 2

Scope:

- Add plan, batch, work-item, and gate counts to the read-only dashboard DTO.
- Make the office bridge consume V3 active executions as a second projection
  source rather than inferring them from Hermes sessions.
- Separate platform readiness from current plan progress.

Acceptance:

- A live V3 execution appears in both dashboard and Pixel Office projections.
- Readiness `2/10` does not masquerade as plan ticket progress.

### Batch 5 — Protocol cleanup and failure-injection verification

Status: COMPLETE  
Dependencies: Batch 3, Batch 4  
Complexity: MEDIUM  
Risk: HIGH  
Quality: PREMIUM  
Parallelism: 1

Scope:

- Remove continuation from the normal public protocol.
- Keep operator recovery plan-scoped (`get`, `list`, `reconcile`, `cancel`).
- Test Hermes restart, control-plane restart, worker timeout, review FAIL,
  duplicate request, and integration conflict.

Acceptance:

- The full plan resumes without raw database edits.
- No duplicate implementation execution is created.
- No plan can reach FINALIZE without review and integration evidence.

### Batch 6 — Remote delivery and closeout proof

Status: COMPLETE  
Dependencies: Batch 3, Batch 5  
Complexity: HIGH  
Risk: HIGH  
Quality: PREMIUM  
Parallelism: 1

Scope:

- Add an explicit delivery authorization contract to durable plans.
- Push the integrated revision without mutating the source worktree.
- Create or reuse one pull request and project its URL and delivery stage.
- Wait for PR checks; create a bounded reviewed repair batch on failure.
- Merge only after checks pass and verify checks on the merge revision.
- Prove the complete path with the BodySense BS-PROD-012 recovery task.

Acceptance:

- A plan remains `RUNNING` while checks or merge are pending.
- A failed PR check enters IMPLEMENT → independent REVIEW repair flow.
- A plan reaches `SUCCEEDED` only with pull-request URL, merge revision, and
  passing post-merge check evidence.
- BS-PROD-012 is recovered from its abandoned workspace outcome and delivered
  through the production AI Office control plane.

## Non-goals

- Replacing OpenHands, ACP workers, or LiteLLM.
- Adding another provider registry.
- Treating the static platform readiness file as project progress.
- Automatically merging code without an explicit deterministic integration gate.

## Completion evidence

- Control-plane restart and failed-review recovery are covered by automated tests.
- Hermes created production smoke plan `plan_2ad7ccb6-9b1c-473d-836f-66e1676256c2` through `ai_office_create_plan`.
- Both dependent batches completed IMPLEMENT, independent Codex review, and deterministic integration.
- Final integrated revision `095209fad47a8554ab834d5658ca38933bc9d89c` passes all five repository tests.
- Production proof plan `plan_5ae46a70-cd67-4914-930e-3d38b9489a1f` completed through the durable control plane.
- BodySense PR #119 was delivered and merged; the plan recorded integrated revision
  `398adda9032313cdd6a2c90defa009e066600df3` and merge revision
  `dfcf52c3a8cfcba44b39775d1b1f9351d4d9db79`.
- Post-merge checks passed, including Repository quality gate, commit-lint,
  PostgreSQL 16/18 migration paths, Browser longitudinal health E2E, and release-please.
- Explicit bounded delivery recovery shipped in AI Office PR #37 and its full CI/E2E
  matrix passed before merge.
- Batch 6 and this execution-closure plan are complete.
