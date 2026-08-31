# Pixel Agent V4 — Durable Supervisor Runtime

## Purpose

Pixel V4 turns the current workflow-first control plane into an autonomous engineering system without discarding its deterministic safety kernel.

The design has two cooperating layers:

```text
User / API / GitHub / Jules / scheduled maintenance
                         |
                         v
+-------------------------------------------------------+
| Durable Plan Supervisor                              |
| OpenHands conversation + planning/reasoning model    |
| observes, diagnoses, replans, proposes typed actions |
+---------------------------+---------------------------+
                            | SupervisorActionV1
                            v
+-------------------------------------------------------+
| Pixel Deterministic Kernel                           |
| validation, leases, provenance, review, integration  |
| budgets, delivery, persistence, rollback             |
+-------------+----------------------+------------------+
              |                      |
              v                      v
      implementation workers   independent reviewers
      DSH / OpenCode / ZCode    Codex / Claude / others
      Codex + Luna / OH         provider-native or managed
```

The AI supervisor owns understanding and adaptation. The kernel owns authority and effects.

## Design principles

1. **One orchestration authority.** Workers and reviewers may be intelligent, but they do not secretly create durable project work. Every subordinate action passes through Pixel.
2. **Event-sourced continuity.** Conversation memory is helpful but never authoritative; the supervisor can be reconstructed from durable events and projections.
3. **Wake on decisions, sleep otherwise.** A supervisor is persistent in identity, not continuously consuming tokens.
4. **Append-only planning.** Replanning revises pending work and preserves accepted history.
5. **Exact provenance.** The approved implementation is an exact execution/result revision pair reviewed by an exact review execution.
6. **Bounded autonomy.** Budgets, action limits, cooldowns, and safety policies are deterministic.
7. **Self-repair through normal governance.** Pixel can repair Pixel only through a child plan, independent review, safe deployment, health verification, and rollback.
8. **External agents are suppliers.** Jules, Anti-Gravity, GitHub contributors, and other agents may propose or implement changes but cannot self-approve them.

## Component model

### `SupervisorRepository`

Durable records for:

- `SupervisorRecord`
  - `supervisorId`
  - `planId`
  - `conversationId`
  - `status`
  - `observationCursor`
  - `policyId`
  - `budgetId`
  - `leaseToken` / `leaseClaimedAt`
  - `lastDecisionAt`
  - `createdAt` / `updatedAt`
- `SupervisorDecisionRecord`
  - immutable input projection digest
  - model/backend/route evidence
  - typed decision payload
  - validator result
  - resulting action request IDs
- `SupervisorActionRecord`
  - idempotency key
  - precondition snapshot
  - status and rejection reason
  - linked executions/plans/PRs
- `PlanGraphVersionRecord`
  - parent graph version
  - preserved work
  - superseded pending work
  - added work/dependencies
  - reason and decision ID

Suggested additive tables:

```text
v4_supervisors
v4_supervisor_decisions
v4_supervisor_actions
v4_plan_graph_versions
v4_plan_graph_work_items
v4_plan_relationships
v4_resource_budgets
v4_resource_observations
v4_maintenance_programs
v4_improvement_candidates
```

V4 must migrate additively over the V3 SQLite database. V3 plans remain readable and recoverable.

### `SupervisorProjectionBuilder`

Builds a bounded, sanitized projection. It must not dump all logs or secrets into prompts.

The projection includes:

- objective and authoritative repository documents;
- current graph version and dependency-ready work;
- current plan/batch/work-item state;
- latest exact implementation/review lineage;
- recent structured events and normalized error classes;
- execution route health and failure history;
- workspace/integration/delivery evidence summaries;
- resource budget and provider availability;
- child-plan and external-gate status;
- actions currently allowed by policy.

Large evidence is referenced through typed fetch tools rather than inlined.

### `SupervisorWakeScheduler`

An event-driven scheduler wakes a supervisor on:

- initial orchestration materialization;
- terminal execution state;
- review verdict;
- repeated or unknown failure;
- plan stall timeout;
- repair/review/delivery limit;
- resource availability transition;
- GitHub/Jules external result;
- child-plan transition;
- explicit operator instruction.

Wake requests are coalesced by `(supervisorId, observationCursor, reasonClass)`. Only one process may own the supervisor lease.

### `OpenHandsSupervisorHost`

The supervisor uses a durable OpenHands conversation with:

- read-oriented repository snapshots;
- the current projection;
- Pixel supervisor tools;
- no direct project write capability;
- no direct GitHub merge or deployment credential;
- no hidden nested orchestration namespace.

A recovered supervisor may resume its existing conversation when safe. If the conversation is lost, Pixel starts a replacement from the durable projection and records the lineage.

### `SupervisorActionValidator`

Validates typed actions before any state mutation. Validation examples:

| Proposed action | Deterministic validation |
| --- | --- |
| `CONTINUE_EXECUTION` | same non-terminal execution, resumable host conversation, workspace lease still owned |
| `RETRY_EXECUTION` | prior attempt terminal, retry budget available, no active writer conflict |
| `SWITCH_ROUTE` | backend enabled, capability compatible, resource policy permits it |
| `CREATE_REPAIR` | blocking evidence exists, exact candidate pinned, repair limit available |
| `REQUEST_REVIEW` | exact writer result revision persisted, reviewer independent and read-only |
| `REPLAN_REMAINDER` | completed work preserved, no accepted revision removed, graph remains acyclic |
| `CREATE_CHILD_PLAN` | classified target repository allowed, parent/child cycle impossible, child budget available |
| `ADOPT_EXTERNAL_PR` | exact repository/base/head/ref identity and origin recorded |
| `AUTO_MERGE` | exact approved SHA, required checks, independent review, branch policy and delivery gate pass |
| `PAUSE_FOR_RESOURCE` | resource policy explicitly requires pause rather than fallback |
| `PARK_EXTERNAL_GATE` | gate type is declared and evidence cannot be produced from reachable execution hosts |

Rejected actions are durable observations for the next supervisor turn.

### Existing coordinators

V4 reuses, rather than duplicates, current owners:

- `WorkItemCoordinator`: implementation/review/fix lifecycle;
- `BatchCoordinator`: integration/repair/aggregate review;
- `PlanRecoveryCoordinator`: deterministic known recovery paths;
- `PlanDeliveryPort`: PR/check/merge behavior;
- `WorkspaceProvisioningPort`: Git/filesystem mechanics;
- `ExecutionLinkRepository`: exact execution evidence.

The supervisor sits above these coordinators. It does not absorb their implementation.

## Lifecycle

### Plan supervisor lifecycle

```text
CREATED
  -> ACTIVE
  -> SLEEPING
  -> OBSERVING
  -> DIAGNOSING
  -> ACTION_PENDING
  -> RECOVERING
  -> SLEEPING

Terminal/suspended branches:
  -> WAITING_FOR_RESOURCE
  -> WAITING_FOR_SYSTEM_REPAIR
  -> WAITING_FOR_EXTERNAL_EVIDENCE
  -> SAFETY_HOLD
  -> COMPLETED
  -> CANCELLED
```

`SLEEPING` is healthy. It means there is no unresolved decision requiring model work.

### Normal engineering flow

```text
Supervisor materializes/revises graph
       |
       v
Kernel launches IMPLEMENT worker
       |
       v
writer completion -> exact resultRevision
       |
       v
Kernel launches independent VERIFY_REVIEW
       | PASS                         | FAIL
       v                              v
batch integration              scoped IMPLEMENT_FIX
       |                              |
       v                              +-> re-review
BATCH_VERIFY
       |
       v
next batch / delivery
```

### Unknown-failure flow

```text
Unknown or repeated failure
        |
        v
Supervisor wake + evidence projection
        |
        v
classification
  | transient/provider -> retry/switch route
  | task too broad      -> graph revision
  | implementation bug -> scoped repair
  | control-plane bug   -> child system-repair plan
  | external gate       -> park gate
  | unsafe/ambiguous    -> safety hold or operator escalation
```

### System-repair flow

```text
Parent plan detects CONTROL_PLANE_DEFECT
        |
        v
parent = WAITING_FOR_SYSTEM_REPAIR
        |
        v
child plan targets pixel-agents/infrastructure repo
        |
        v
implement -> independent review -> full tests
        |
        v
zero-writer/canary deployment -> health/rollback gate
        |
        v
child SUCCEEDED
        |
        v
parent auto-reconcile from original durable checkpoint
```

## Dynamic graph revisions

Replanning is not mutation of history.

A graph revision may:

- split a pending broad ticket;
- add a newly discovered prerequisite;
- change dependencies among pending items;
- park an item behind a resource/external gate;
- replace a pending strategy with an alternative.

It may not:

- remove a succeeded item or its provenance;
- claim an unreviewed revision was approved;
- change the base of an accepted batch;
- bypass a failed review or required check;
- hide a child/system repair relationship.

## Autonomy budgets

Each plan/program has a `SupervisorPolicy` with:

- maximum supervisor decisions per hour/day;
- maximum consecutive recovery actions for one cause;
- maximum graph revisions;
- maximum child plans and nesting depth;
- token/cost/provider budgets;
- allowed implementation and review routes;
- permitted delivery targets and merge methods;
- cooldown/backoff rules;
- actions requiring operator confirmation.

Budget exhaustion changes state; it does not silently downgrade to an unauthorized route.

## Self-improvement boundary

“Self-improvement” means:

1. observe metrics and failure patterns;
2. produce a versioned improvement candidate;
3. implement it through a child plan;
4. run regression/evaluation suites;
5. independently review it;
6. canary it against shadow or selected plans;
7. promote or roll back deterministically.

It does **not** mean allowing a running model to rewrite its prompts, policies, database, or deployment in place.

## Observability

Required metrics include:

- plans completed without operator intervention;
- recoverable blockers resolved autonomously;
- time spent in each waiting/block state;
- supervisor wake/decision/action/rejection counts;
- duplicate-decision suppression;
- route/provider failures and resource waits;
- repair/re-review convergence;
- graph revision frequency and outcomes;
- child system-repair success/rollback rate;
- external PR acceptance, repair, and merge rates;
- supervisor model usage and cost.

Every model decision is correlated by `supervisorDecisionId`, `planId`, and any resulting `executionId`/`childPlanId`.

## Rollout

1. **Shadow:** supervisor observes existing plans and proposes actions, but the kernel records only simulated validator results.
2. **Advisory:** low-risk actions may be operator-approved; no autonomous graph revisions or child deployment.
3. **Bounded autonomous:** enable known recovery actions and resource waiting on a canary project.
4. **Autonomous maintenance:** enable Digital Biome external PR review/repair/merge under strict resource policy.
5. **General:** enable for trusted project plans after provenance, safety, cost, and rollback SLOs pass.

V3 endpoints and plans remain supported during rollout. V4 is an additive supervisor/program layer over the proven V3 execution kernel.
