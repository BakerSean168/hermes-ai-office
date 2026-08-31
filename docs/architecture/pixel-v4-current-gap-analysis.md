# Pixel V4 Current Gap Analysis

## Scope

This is the repository-grounded baseline for the V4 durable supervisor and Digital Biome autonomous-maintenance work.

## What already exists

### One-shot AI orchestration

- `DurablePlanOrchestrator` creates an `ORCHESTRATE` execution for delegated objectives.
- `ORCHESTRATE` uses an OpenHands read-oriented supervisor and materializes a dependency-aware graph.
- The prompt explicitly tells that execution not to launch coding workers. After graph materialization, the deterministic coordinators own progression.

### Deterministic engineering kernel

The current V3 system already has:

- durable plan/batch/work-item/execution records;
- implementation, review, fix, integration repair, aggregate review, and delivery phases;
- retry/fallback policies;
- exact workspace and Git gates;
- recovery coordinator and explicit recovery modes;
- GitHub PR intake and delivery adapters;
- Jules source/session adapter boundaries;
- OpenHands/ACP execution hosting;
- LiteLLM-managed and provider-native routes.

### Relevant external backends

The development policy declares:

- `antigravity-worker` as a write-capable provider-native backend;
- `antigravity-review` as a read-only provider-native backend;
- `codex-business-planner-headless`;
- `codex-business-worker-headless`;
- `codex-business-review-headless`;
- DSH, OpenCode, ZCode, Claude Code, Codex ACP, and OpenHands backends.

### Exact review/repair workflow

Per-item and batch review paths exist. A failed review can create a focused implementation fix and a later independent review. Integration conflict and aggregate-review failure can create integration repair work.

## Why current behavior does not match the intended autonomous system

### 1. No persistent plan-level supervisor

`ORCHESTRATE` ends after producing the initial graph. There is no durable AI actor observing later events and diagnosing novel blockers. `PlanRecoveryCoordinator` handles only pre-modeled recovery transitions.

Result: unknown migration, infrastructure, adapter, resource, or control-plane failures become generic `BLOCKED` states and require external diagnosis.

### 2. AI is inside workflow nodes, not above the workflow

Implementation and review workers are intelligent, but they receive bounded phase objectives. They do not own the complete plan, cannot safely replan remaining work, and cannot create system-repair child plans through typed durable actions.

### 3. Nested orchestration is intentionally disabled

Codex nested multi-agent configuration is disabled to prevent a second invisible orchestration layer. This is correct for provenance and concurrency, but it means OpenHands/Codex cannot simply spawn arbitrary untracked workers to recover the plan.

V4 must add Pixel-owned supervisor tools rather than re-enable invisible nested agents.

### 4. Anti-Gravity is declared but not part of the active default routes

The current phase candidate lists do not use `antigravity-worker` or `antigravity-review`. The production enabled-backend list must also explicitly include a backend before it is available. Merely defining Anti-Gravity in the policy therefore does not make Digital Biome maintenance use it.

There is also no durable quota/credit observation or `WAITING_FOR_RESOURCE` state. A resource-constrained program cannot currently express “use Anti-Gravity when available; otherwise pause.”

### 5. Jules is an adapter, not an end-to-end autonomous program

The existing Jules API boundary can find a source and create a session. It does not by itself provide:

- a recurring improvement candidate queue;
- exact candidate/plan/PR correlation;
- provider-budget waiting;
- independent problem validation and repository-style review;
- repair/re-review ownership;
- exact-SHA auto-merge and post-merge verification.

### 6. GitHub PR intake is not a complete maintenance lifecycle

PR intake and external-change review capabilities exist, but no long-lived `MaintenanceProgram` currently owns discovery, deduplication, resource policy, queue priority, autonomous scope, and post-merge learning for Digital Biome.

### 7. Self-repair is informal

When a product plan exposes a Pixel/control-plane defect, the product worker cannot safely patch the running control plane. Today an external operator/ChatGPT conversation typically diagnoses and repairs Pixel, then reconciles the original plan. There is no explicit parent `WAITING_FOR_SYSTEM_REPAIR` state or governed child-plan deployment loop.

### 8. Current provenance baseline still has known P1 work

Before V4 autonomous effects are enabled, the current result/review provenance repair must:

- re-run managed workspace verification for every legacy result attestation;
- bind an approved review to the exact implementation execution/revision it reviewed.

V4 action validation depends on these invariants.

## Target delta

V4 does not discard current components. It adds the missing plan/program intelligence layer:

```text
Current:
  one-shot ORCHESTRATE
  -> deterministic workflow
  -> AI workers/reviewers at known nodes
  -> unknown failure = BLOCKED

V4:
  durable event-driven supervisor
  -> typed proposals
  -> deterministic validator/kernel
  -> existing workers/review/integration/delivery
  -> graph revision or child repair for novel recoverable failures
  -> explicit resource/external/safety waiting states
```

## Digital Biome migration conclusion

Digital Biome should not receive another standalone cron/agent workflow. It should become the first `MaintenanceProgram` on the V4 substrate:

- discovery/Jules/PR webhooks create candidates;
- Anti-Gravity resource policy controls dispatch and waiting;
- the durable supervisor validates the problem and adapts the plan;
- existing V3 implementation/review/repair/integration/delivery mechanics execute the work;
- exact-SHA auto-merge and post-merge verification remain deterministic.

This preserves one governance and observability model across user-requested work and continuous autonomous improvement.
