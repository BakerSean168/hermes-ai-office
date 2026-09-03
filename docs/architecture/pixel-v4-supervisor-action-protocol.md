# Pixel V4 Supervisor Action Protocol

## Scope

This document defines the contract between the durable AI supervisor and the deterministic Pixel kernel. The protocol is intentionally narrow: the supervisor proposes an action; the kernel validates and performs it. Free-form model text is evidence, never authority.

## Envelope

```json
{
  "version": "PIXEL_SUPERVISOR_DECISION_V1",
  "planId": "plan_...",
  "supervisorId": "supervisor_...",
  "observationCursor": 1842,
  "projectionDigest": "sha256:...",
  "classification": "CONTROL_PLANE_DEFECT",
  "summary": "The writer succeeded but the legacy execution lacks a verified result revision.",
  "confidence": 0.92,
  "action": {
    "type": "CREATE_CHILD_PLAN",
    "idempotencyKey": "plan_...:cursor-1842:control-plane-provenance",
    "payload": {}
  },
  "alternatives": [],
  "externalGate": null
}
```

The kernel rejects decisions that do not match the current plan, supervisor lease, observation cursor, or projection digest.

## Classification vocabulary

```text
NO_ACTION
TRANSIENT_EXECUTION_FAILURE
PROVIDER_OR_RESOURCE_UNAVAILABLE
TASK_TOO_BROAD
TASK_GRAPH_DEFECT
IMPLEMENTATION_DEFECT
REVIEW_DEFECT
INTEGRATION_DEFECT
DELIVERY_DEFECT
CONTROL_PLANE_DEFECT
INFRASTRUCTURE_DEFECT
EXTERNAL_CHANGE_AVAILABLE
EXTERNAL_EVIDENCE_REQUIRED
PRODUCT_DECISION_REQUIRED
SAFETY_POLICY_CONFLICT
UNKNOWN
```

Classification is explanatory. The action validator remains authoritative.

## Action vocabulary

### `NO_ACTION`

The plan is healthy or currently executing. No side effect is requested.

### `CONTINUE_EXECUTION`

Resume the existing OpenHands conversation while preserving the same execution and mutable workspace.

Required payload:

```json
{
  "executionId": "exec_...",
  "instruction": "Continue the existing repair from the current workspace..."
}
```

The kernel requires a resumable non-terminal execution and an intact workspace lease.

### `RETRY_EXECUTION`

Create the next attempt through the existing work item.

```json
{
  "workItemId": "work_...",
  "failedExecutionId": "exec_...",
  "phase": "IMPLEMENT",
  "reasonClass": "TRANSIENT_EXECUTION_FAILURE"
}
```

The kernel chooses the next attempt number and enforces retry budgets.

### `SWITCH_ROUTE`

ADR-003 changes the meaning of route switching: the supervisor may classify why the current resource is unusable, but it does not choose the next concrete model, agent, or provider. The deterministic resource selector chooses the next executable profile.

Target shape:

```json
{
  "workItemId": "work_...",
  "phase": "IMPLEMENT",
  "failedExecutionId": "exec_...",
  "reasonClass": "QUOTA_EXHAUSTED"
}
```

The kernel/resource state adapter applies the normalized failure to the failed resource, then re-runs selection over the allowed `IMPLEMENTATION` or `REASONING` capability. The supervisor never provides credentials, physical provider keys, resource sequence, or an arbitrary backend/model override.

The pre-ADR-003 compatibility form containing `backend` and `modelClass` may remain accepted during migration, but it must be translated into/validated against the new selector and cannot remain the routing authority after the companion routing plan completes.

### `REQUEST_REVIEW`

Request independent review of an exact implementation result.

```json
{
  "implementationExecutionId": "exec_impl",
  "resultRevision": "40-character-sha",
  "reviewKind": "WORK_ITEM"
}
```

Validation requires `resultRevision` to be the deterministically verified result of the referenced implementation. Review must use a fresh read-only snapshot and an independent backend/session.

### `CREATE_REPAIR`

Create a scoped repair from blocking findings.

```json
{
  "candidateRevision": "40-character-sha",
  "findingExecutionId": "exec_review",
  "scope": ["path/or/contract"],
  "objective": "Resolve the exact blocking findings without discarding accepted behavior."
}
```

The kernel links the repair to the failing review/candidate and checks repair limits.

### `REPLAN_REMAINDER`

Append a new graph version for pending work.

```json
{
  "reason": "The current ticket combines two independently owned contracts.",
  "preserve": ["SUP-1001", "SUP-1002"],
  "supersedePending": ["SUP-2000"],
  "batches": [
    {
      "key": "batch-x",
      "dependsOn": [],
      "workItems": [
        {
          "key": "SUP-2001",
          "title": "...",
          "objective": "...",
          "acceptanceCriteria": ["..."]
        }
      ]
    }
  ]
}
```

The kernel validates acyclicity, stable unique keys, protected completed work, repository scope, and graph-revision budgets.

### `CREATE_CHILD_PLAN`

Create a durable child plan for a system/infrastructure dependency.

```json
{
  "relationship": "SYSTEM_REPAIR",
  "projectKey": "pixel-agents",
  "repositoryPath": "/home/dev/projects/pixel-agents",
  "objective": "Persist and verify exact writer/review provenance...",
  "resumeParentOnSuccess": true,
  "requiredVerification": ["full control-plane suite", "independent review", "production health"]
}
```

The target repository must be allow-listed. Child plans cannot form cycles and cannot autonomously deploy across an unapproved environment boundary.

### `ADOPT_EXTERNAL_PR`

Create/reuse an external-change plan from a GitHub/Jules PR.

```json
{
  "repository": "owner/repo",
  "pullRequestNumber": 123,
  "baseRef": "main",
  "baseRevision": "40-character-sha",
  "headRef": "agent/branch",
  "headRevision": "40-character-sha",
  "source": "JULES"
}
```

GitHub is re-read by the deterministic adapter; caller-supplied identities are not trusted without verification.

### `PAUSE_FOR_RESOURCE`

Pause a plan/program when its authorized resource pool is unavailable.

```json
{
  "resourcePolicyId": "digital-biome-antigravity-only",
  "resourceClass": "antigravity-worker",
  "retryAfterSeconds": 3600,
  "reason": "QUOTA_EXHAUSTED"
}
```

The kernel records `WAITING_FOR_RESOURCE`, schedules a bounded availability probe, and does not fall back unless the resource policy explicitly permits it.

### `PARK_EXTERNAL_GATE`

Record a real gate that cannot be satisfied from connected execution hosts.

```json
{
  "gateType": "NATIVE_MACHINE_VALIDATION",
  "description": "Run the signed WSLg packaged-runtime probe on the user's local machine.",
  "requiredEvidenceSchema": "PIXEL_NATIVE_VALIDATION_V1"
}
```

### `ESCALATE`

Escalate a product, safety, destructive-operation, or policy decision.

```json
{
  "reason": "PRODUCT_DECISION_REQUIRED",
  "question": "Should the migration intentionally discard existing production data?",
  "safeDefault": "DO_NOT_PROCEED"
}
```

## Kernel response

```json
{
  "version": "PIXEL_SUPERVISOR_ACTION_RESULT_V1",
  "decisionId": "decision_...",
  "actionId": "action_...",
  "status": "ACCEPTED",
  "resultingState": "WAITING_FOR_SYSTEM_REPAIR",
  "links": {
    "childPlanId": "plan_child"
  }
}
```

Possible statuses:

```text
ACCEPTED
NO_OP_ALREADY_APPLIED
REJECTED_STALE_OBSERVATION
REJECTED_PRECONDITION
REJECTED_POLICY
REJECTED_BUDGET
REJECTED_SAFETY
FAILED_TRANSIENT
FAILED_TERMINAL
```

Every response becomes part of the next observation projection.

## Idempotency and concurrency

- Every action has a stable idempotency key derived from plan/supervisor/cursor/intent.
- Supervisor decisions are first-write-wins for one projection digest.
- A supervisor lease prevents two processes from acting for the same cursor.
- Existing execution/workspace/host-launch claims remain authoritative for worker side effects.
- PR merge uses exact expected head SHA and is idempotent at the delivery adapter.

## Decision limits

The supervisor must not:

- edit SQLite or durable projection state directly;
- invent execution, review, CI, native-machine, resource, or merge evidence;
- change a succeeded work item to pending;
- review its own implementation;
- directly call GitHub merge, systemd, Docker deployment, or secret APIs;
- launch invisible nested writers;
- broaden repository scope beyond the plan/policy allow-list;
- remove tests or lower gates solely to obtain a pass;
- silently select a provider disallowed by the plan's resource policy.

## Example: recover a novel control-plane blocker

1. Plan emits `BATCH_INTEGRATION_EVIDENCE_MISSING`.
2. Known deterministic recovery cannot produce the missing exact evidence.
3. Supervisor classifies `CONTROL_PLANE_DEFECT` after inspecting schema, execution lineage, and workspace evidence.
4. It proposes `CREATE_CHILD_PLAN` for Pixel provenance repair.
5. Kernel validates target/budget and parks parent in `WAITING_FOR_SYSTEM_REPAIR`.
6. Child implements, receives independent review, deploys at a safe boundary, and passes health/evidence smoke tests.
7. Parent wakes and retries the original integration without reconstructing the plan from chat history.

## Example: review a Jules PR

1. GitHub webhook records an exact PR head revision and source installation.
2. Supervisor proposes `ADOPT_EXTERNAL_PR`.
3. Kernel creates an `EXTERNAL_CHANGE` plan and a read-only validation execution.
4. Independent review returns PASS, FAIL, or INVALID.
5. FAIL creates a repair against the exact PR head; the repaired revision is pushed to an authorized branch and re-reviewed.
6. Merge occurs only if the exact approved head still matches GitHub and all required checks pass.
