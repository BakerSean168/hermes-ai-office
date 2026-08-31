# Pixel Agent V4 — Durable Supervisor and Autonomous Improvement Program

- Status: ACTIVE / PLANNED
- Date: 2026-08-31
- Repository: `pixel-agents`
- Target: additive V4 supervisor/program layer over the V3 deterministic execution kernel
- Primary canary: Digital Biome autonomous maintenance
- Related decision: `docs/adr/ADR-001-durable-ai-supervisor-and-deterministic-kernel.md`
- Architecture:
  - `docs/architecture/pixel-v4-current-gap-analysis.md`
  - `docs/architecture/pixel-v4-durable-supervisor-runtime.md`
  - `docs/architecture/pixel-v4-supervisor-action-protocol.md`
  - `docs/architecture/autonomous-improvement-programs-and-external-pr-governance.md`
  - `docs/architecture/pixel-v4-resource-policy-and-safety-budgets.md`

## 1. North-star outcome

A user delegates a software-engineering objective once. A durable AI supervisor continues observing the plan, diagnosing failures, revising pending work, dispatching implementation/review agents, opening system-repair child plans, and resuming the parent until delivery completes or a genuine resource/external/safety gate remains.

The supervisor does not replace the deterministic control plane. Pixel remains the only authority for workspaces, executions, provenance, review, integration, budgets, GitHub delivery, deployment, and rollback.

The same substrate runs autonomous maintenance programs. Digital Biome is the first canary: Anti-Gravity/Jules may discover or implement improvements, Pixel independently validates and repairs the exact PR revision, and the delivery adapter auto-merges only after all repository and safety gates pass.

## 2. Why this plan exists

V3 already automates known implementation/review/repair/integration flows, but `ORCHESTRATE` is one-shot. Unknown state-machine failures become `BLOCKED`, and ChatGPT Web currently acts as an informal plan supervisor. The system therefore behaves like a robust workflow engine with AI workers rather than a continuously adaptive autonomous engineering lead.

Recent evidence demonstrates both the value and the limit of V3:

- model/backend fallback, independent review, integration repair, linked workspaces, and durable recovery work;
- novel issues such as systemd mount boundaries, adapter token defaults, storage amplification, schema/provenance migration, and exact review lineage required external diagnosis;
- the current MemoFlow batch exposes a legacy result-provenance gap that must be fixed before V4 relies on it.

## 3. Protected contracts

Every implementation ticket must preserve:

- V3 API and durable-plan compatibility unless an additive migration is explicitly documented;
- one durable execution identity per phase attempt;
- single-writer admission and workspace ownership;
- monotonic terminal execution state;
- exact writer baseline/result revision verification;
- exact implementation-to-review causal lineage;
- read-only independent review snapshots;
- append-only plan/batch/work-item/event history;
- deterministic integration ancestry and exact candidate refs;
- no direct DB edits as a recovery mechanism;
- no hidden nested writers or second orchestration authority;
- provider credentials and secrets outside prompts, events, and repository files;
- fail-closed external-machine, safety, resource, CI, merge, and release gates;
- exact-SHA delivery and protected-branch behavior.

## 4. Architecture boundary

```text
V4 Supervisor/Application layer
  SupervisorRepository
  SupervisorProjectionBuilder
  SupervisorWakeScheduler
  SupervisorDecisionService
  SupervisorActionValidator/Executor
  PlanGraphRevisionService
  PlanRelationshipService
  MaintenanceProgramService
  ImprovementCandidateService
  ResourcePolicyService
          |
          v
V3 deterministic kernel (reused)
  DurablePlanOrchestrator
  WorkItemCoordinator
  BatchCoordinator
  PlanRecoveryCoordinator
  ExecutionLinkRepository
  WorkspaceProvisioningPort
  PlanDeliveryPort
  OpenHandsExecutionHost
```

Do not implement V4 as a second copy of the V3 coordinator tree. V4 proposes and authorizes higher-level decisions; V3 performs normal engineering transitions.

## 5. Delivery strategy

Implement in additive, independently reviewable waves:

1. stabilize exact provenance in V3;
2. add schema/domain/protocol with no autonomous effects;
3. add shadow supervisor observations and decisions;
4. enable bounded low-risk recovery actions;
5. add graph revisions and system-repair parent/child plans;
6. add maintenance programs, Jules/PR intake, and Anti-Gravity resource policy;
7. canary Digital Biome review/repair/merge;
8. promote V4 supervisor to normal trusted plans.

No big-bang V3 replacement is permitted.

---

# Phase 0 — Provenance baseline and existing blocker closure

## PV4-0001 — Always reverify legacy result attestation

**Owner:** Control-plane provenance

**Objective:** Fix the current legacy attestation P1 so every operator-submitted result revision is checked against the current managed workspace, even when `result_revision` is already populated.

**Required behavior:**

- verify the submitted revision format;
- require the exact selected successful writer execution;
- require a managed workspace and usable baseline;
- run `verifyWriterCompletion` on every attestation;
- require clean workspace, descendant relation, and exact `HEAD == submitted SHA`;
- when a durable value exists, require it to match both submitted SHA and verified HEAD;
- perform multi-item attestation atomically;
- preserve idempotency and event evidence.

**Likely files:**

- `model-control-plane/src/v3/planOrchestrator.ts`
- `model-control-plane/src/v3/correlation.ts`
- `model-control-plane/test/v3Plans.test.ts`

**Acceptance:** focused regression proves an already-recorded revision is rejected when workspace HEAD/metadata no longer verifies.

## PV4-0002 — Bind approved review to the exact implementation execution

**Owner:** Work-item review provenance

**Objective:** Prevent a historical PASS review from approving a later implementation/fix.

**Required behavior:**

- select the implementation candidate first;
- require `review.previousExecutionId == implementation.executionId`;
- require review snapshot `sourceRevision == implementation.resultRevision` (or the exact frozen reviewed revision defined by the workspace contract);
- reject missing/mismatched lineage;
- use the exact pair for repair ancestry and batch integration evidence;
- cover retries, fixes, review retries, and legacy records.

**Likely files:**

- `model-control-plane/src/v3/plan/workItemCoordinator.ts`
- `model-control-plane/src/v3/service.ts`
- `model-control-plane/test/v3Plans.test.ts`
- `model-control-plane/test/v3Api.test.ts`

**Acceptance:** a PASS review of implementation A cannot approve implementation C; an exact A→review pair still integrates.

## PV4-0003 — Exact-commit review, deploy, and recover the existing MemoFlow plan

**Depends on:** PV4-0001, PV4-0002

**Objective:** Establish a clean V4 baseline and close the current real-world provenance blocker without rewriting durable plan state.

**Steps:**

1. focused tests, full control-plane tests, typecheck/build, deployment-boundary tests;
2. independent Business Codex review of the exact repaired commit;
3. safe control-plane backup and deployment at a zero-writer boundary;
4. production health and schema migration verification;
5. exact legacy attestation/recovery of the MemoFlow executions;
6. normal Batch 5 integration and aggregate review;
7. confirm downstream work starts through the unchanged plan lineage.

**Acceptance:** no manual DB mutation; the original plan advances using verified evidence.

---

# Phase 1 — V4 domain, persistence, and protocol

## PV4-1101 — Supervisor domain records and additive SQLite schema

**Depends on:** PV4-0003

**Objective:** Add durable supervisor identity, lifecycle, cursor, decisions, and actions.

**Deliverables:**

- domain types and validation;
- additive schema/migrations;
- repository CRUD/CAS/lease operations;
- indexes and list/lookup queries;
- restart/idempotency tests;
- V3 database compatibility test.

**Initial tables:**

- `v4_supervisors`
- `v4_supervisor_decisions`
- `v4_supervisor_actions`

**Likely modules:**

```text
model-control-plane/src/v4/supervisor/model.ts
model-control-plane/src/v4/supervisor/sqlite.ts
model-control-plane/src/v4/supervisor/repository.ts
```

## PV4-1102 — `PIXEL_SUPERVISOR_DECISION_V1` parser and schema

**Parallel with:** PV4-1101

**Objective:** Implement strict, bounded parsing for classifications and typed actions.

**Requirements:**

- one JSON object only;
- versioned action union;
- size/count/string limits;
- path/repository identifiers are references, not arbitrary shell input;
- stable idempotency key;
- no credentials, raw headers, or opaque executable commands;
- invalid output produces a correction turn within a bounded attempt limit.

**Tests:** valid/invalid corpus, oversize payload, unknown action, duplicate keys, stale cursor/digest.

## PV4-1103 — Supervisor policy and budget model

**Parallel with:** PV4-1101, PV4-1102

**Objective:** Define allowed actions, models/backends, budgets, graph changes, child plans, delivery, and operator-confirmation requirements.

**Requirements:** versioned configuration, strict defaults, project/program overrides, no implicit paid fallback.

## PV4-1104 — Plan relationship and graph-version schema

**Depends on:** PV4-1101

**Objective:** Add append-only parent/child relationships and future graph revisions without changing existing V3 plan rows.

**Tables:**

- `v4_plan_relationships`
- `v4_plan_graph_versions`
- `v4_plan_graph_work_items`

**Acceptance:** cycles, completed-work removal, and conflicting graph keys fail closed.

### Phase 1 gate

- no AI supervisor execution yet;
- all schema changes additive and restart-safe;
- V3 full suite remains green;
- architecture tests enforce dependency direction.

---

# Phase 2 — Observation, wake scheduling, and shadow supervisor

## PV4-2101 — Bounded supervisor projection builder

**Depends on:** PV4-1101, PV4-1103

**Objective:** Build a sanitized, deterministic projection from durable state.

**Projection sections:** objective/docs, graph, current state, exact lineage, recent events, normalized failures, route/resource health, delivery/PR, child plans, allowed actions.

**Requirements:**

- deterministic ordering and digest;
- cursor-based incremental events;
- evidence handles for large logs;
- secret/path redaction policy;
- token-size budget with priority/truncation evidence;
- snapshot tests.

## PV4-2102 — Supervisor wake event classifier and coalescing scheduler

**Depends on:** PV4-1101

**Parallel with:** PV4-2101

**Objective:** Wake supervisors only when a decision is required.

**Triggers:** new plan, terminal result, review result, repeated/unknown failure, stall, limit, resource transition, PR/Jules event, child-plan event, operator request.

**Requirements:** cursor/idempotency coalescing, CAS lease, restart recovery, cooldown/backoff, no duplicate turns.

## PV4-2103 — Persistent OpenHands supervisor host

**Depends on:** PV4-2101, PV4-2102, PV4-1102

**Objective:** Create/resume one read-oriented supervisor conversation per eligible plan.

**Requirements:**

- stable `supervisorId` and durable `conversationId`;
- replacement lineage when host conversation is lost;
- Pixel supervisor toolset only;
- no direct write, merge, deployment, secret, or DB access;
- no hidden nested-agent launch;
- model/backend selected by supervisor policy;
- event/usage correlation.

## PV4-2104 — Shadow decision recording

**Depends on:** PV4-2103

**Objective:** Run the supervisor on real V3 plan events but execute no proposed side effects.

**Deliverables:** decision/rejection dashboard projection, comparison against actual operator recovery, cost/latency metrics.

### Phase 2 gate

Shadow mode must prove:

- no duplicate decisions for unchanged state;
- reconstructability after control-plane/OpenHands restart;
- bounded prompt and decision cost;
- correct classification on historical blocked-plan fixtures;
- no effect on V3 production state.

---

# Phase 3 — Typed action validator and bounded autonomous recovery

## PV4-3101 — Supervisor action validator/executor framework

**Depends on:** Phase 2, PV4-1102, PV4-1103

**Objective:** Validate and execute typed actions idempotently.

**Initial low-risk actions:**

- `NO_ACTION`
- `CONTINUE_EXECUTION`
- `RETRY_EXECUTION`
- `SWITCH_ROUTE`
- `PAUSE_FOR_RESOURCE`
- `PARK_EXTERNAL_GATE`
- `ESCALATE`

**Requirements:** precondition snapshot, action lease/idempotency, accepted/rejected result record, audit events, policy/budget checks.

## PV4-3102 — Review and repair actions

**Depends on:** PV4-3101, exact provenance Phase 0

**Actions:**

- `REQUEST_REVIEW`
- `CREATE_REPAIR`

**Requirements:** exact implementation/result pair, independent fresh review, pinned findings/candidate, repair limits, automatic re-review.

## PV4-3103 — Failure normalization and repeated-failure diagnosis

**Depends on:** PV4-2101, PV4-3101

**Objective:** Convert raw adapter/host/Git/delivery failures into structured cause classes without discarding raw sanitized evidence.

**Sources:** OpenHands, ACP, DSH, Codex, OpenCode, ZCode, LiteLLM, Git/workspace, systemd/container, GitHub/Jules.

**Acceptance:** repeated same-cause retries trigger supervisor diagnosis instead of unbounded route rotation.

## PV4-3104 — Autonomous recovery canary

**Depends on:** PV4-3101–3103

**Objective:** Enable low-risk actions for a synthetic/canary plan.

**Fault injection:** paused host, retryable provider error, disabled route, resource exhaustion, stale observation, duplicate wake.

### Phase 3 gate

- no provenance/review/single-writer regression;
- all accepted actions are idempotent;
- stale decisions are rejected;
- resource policy pause is proven;
- rollback to shadow mode is one configuration change.

---

# Phase 4 — Dynamic replanning and system repair

## PV4-4101 — Append-only `REPLAN_REMAINDER`

**Depends on:** PV4-1104, PV4-3101

**Objective:** Allow the supervisor to split/resequence pending work while preserving accepted history.

**Requirements:** graph validation, protected succeeded work, acyclic dependencies, versioned reason/evidence, plan projection of active/superseded versions.

## PV4-4102 — Parent/child plan relationships

**Depends on:** PV4-1104

**Parallel with:** PV4-4101

**Objective:** Represent `SYSTEM_REPAIR`, `INFRASTRUCTURE_REPAIR`, and `FOLLOW_UP` child plans.

**Requirements:** cycle/depth limits, parent waiting state, child completion propagation, cancellation semantics, dashboard/API visibility.

## PV4-4103 — `CREATE_CHILD_PLAN` and safe system-repair lifecycle

**Depends on:** PV4-4102, PV4-3101

**Objective:** Let the supervisor create a repair plan for Pixel/infrastructure defects.

**Hard gates:** repository/environment allow-list, independent review, full tests, backup, safe deployment window, health smoke, rollback, parent auto-reconcile.

## PV4-4104 — Unknown-block recovery E2E

**Depends on:** PV4-4101–4103

**Scenario:** inject a novel provenance/control-plane defect, have the parent classify it, create a child repair, deploy the fix in a canary environment, and resume from the original checkpoint.

### Phase 4 gate

No production self-repair deployment until the complete child-plan/canary/rollback scenario passes independently reviewed E2E.

---

# Phase 5 — Maintenance programs, Jules, GitHub, and Anti-Gravity

## PIM-5101 — Maintenance program and improvement-candidate domain

**Depends on:** PV4-1101, PV4-1103

**Objective:** Add long-lived program configuration and concrete candidate lifecycle.

**Tables:**

- `v4_maintenance_programs`
- `v4_improvement_candidates`
- candidate evidence/source/link records as needed.

**Requirements:** deduplication fingerprint, queue limits, project scope, schedule/webhook triggers, linked plan/PR identities.

## PIM-5102 — Discovery adapters and bounded candidate triage

**Depends on:** PIM-5101, PV4-2101

**Sources:** static/security/dependency/performance checks, runtime evidence, read-only AI discovery, issues/manual API.

**Requirements:** repository-grounded evidence, impact/risk, duplicate search, acceptance criteria, disallowed-scope classification.

## PIM-5103 — Jules task dispatch and result/PR correlation

**Depends on:** PIM-5101, existing `JulesApiPort`

**Parallel with:** PIM-5102

**Objective:** Reuse the current Jules adapter to submit scoped work and correlate session/result/PR to candidate and plan.

**Requirements:** exact source/starting branch, idempotency, bounded prompt, no secret exposure, verified GitHub result identity, failure/quota classification.

## PIM-5104 — GitHub PR event intake as external-change plans

**Depends on:** PIM-5101, existing GitHub PR intake

**Parallel with:** PIM-5102, PIM-5103

**Objective:** Pin PR base/head identity and create/reuse a candidate + `EXTERNAL_CHANGE` plan.

**Requirements:** force-push invalidation, exact-head review, installation/environment routing, duplicate webhook idempotency.

## PIM-5105 — Anti-Gravity readiness, resource observations, and leases

**Depends on:** PV4-1103

**Objective:** Make declared Anti-Gravity backends genuinely selectable only when enabled, authenticated, ready, and within policy/quota.

**Requirements:**

- enablement separated from declaration;
- worker/reviewer capability probes;
- normalized quota/auth/availability state;
- durable resource observations and bounded probes;
- resource leases/admission;
- `WAITING_FOR_RESOURCE` behavior;
- no implementation fallback for the Digital Biome profile.

## PIM-5106 — Digital Biome program policy

**Depends on:** PIM-5101, PIM-5105

**Objective:** Add the initial Digital Biome maintenance program configuration.

**Policy:** Anti-Gravity-only implementation, Anti-Gravity-first review, optional one-call bounded GPT-5.6 review, lower-priority maintenance queue, conservative autonomous scope, exact-SHA auto-merge.

## PIM-5107 — External PR review/repair/re-review pipeline

**Depends on:** PIM-5103 or PIM-5104, PV4-3102

**Objective:** Validate the problem, review implementation quality/architecture/style, repair when needed, and independently re-review.

**Verdicts:** `INVALID`, `FAIL`, `PASS` for external changes.

## PIM-5108 — Exact-SHA auto-merge and post-merge verification

**Depends on:** PIM-5106, PIM-5107, existing delivery adapter

**Objective:** Auto-merge approved Digital Biome candidates and verify the result.

**Requirements:** expected head SHA, protected checks, policy/risk gate, one merge attempt, post-merge health/performance/security verification, rollback/follow-up plan.

### Phase 5 gate

Run canary scenarios:

1. Anti-Gravity unavailable -> pause, no paid implementation fallback;
2. invalid Jules/PR candidate -> reject;
3. valid but flawed PR -> repair and re-review;
4. force-pushed PR -> stale review invalidated;
5. valid exact SHA -> merge and post-merge verify;
6. post-merge failure -> rollback/follow-up.

---

# Phase 6 — Self-improvement metrics, evaluation, and promotion

## PV4-6101 — Supervisor/maintenance observability and dashboard

**Depends on:** Phases 2–5

**Deliverables:** supervisor timeline, decisions/actions/rejections, graph versions, child plans, resource waits, candidate/PR lifecycle, model/provider usage, autonomous-resolution metrics.

## PV4-6102 — Historical replay and evaluation suite

**Objective:** Replay historical Pixel blockers and measure whether V4 proposes safe useful actions.

**Corpus:** storage ENOSPC, EXDEV mount boundary, DSH token default, route exhaustion, review failures, integration conflicts, legacy provenance, external machine gates, stale PR head.

**Metrics:** correct classification/action, unsafe action rate, unnecessary escalation, duplicate suppression, token/cost, recovery convergence.

## PV4-6103 — Versioned supervisor policy/prompt proposals

**Depends on:** PV4-6101, PV4-6102

**Objective:** Let V4 propose improvements to its own policy/prompts from aggregate outcomes.

**Boundary:** proposals become reviewed system-improvement plans; no runtime self-edit.

## PV4-6104 — Shadow/advisory/autonomous rollout controls

**Objective:** Per-project/program mode, kill switch, budget override, pause/resume, auto-merge disable, system-repair deployment disable, rollback to V3 behavior.

## PV4-6105 — General trusted-plan rollout

**Depends on:** all prior gates

**Objective:** Promote the durable supervisor beyond Digital Biome to selected MemoFlow/BodySense plans.

**Promotion SLOs:**

- zero duplicate writers/merges;
- zero provenance/review bypasses;
- no disallowed provider fallback;
- material reduction in operator-required recoverable blockers;
- bounded supervisor cost and action loops;
- all external/safety gates correctly retained.

---

# 6. Parallel implementation map

```text
Phase 0: PV4-0001 || PV4-0002 -> PV4-0003

Phase 1: PV4-1101 || PV4-1102 || PV4-1103
                       |
                       +-> PV4-1104

Phase 2: PV4-2101 || PV4-2102 -> PV4-2103 -> PV4-2104

Phase 3: PV4-3101 -> PV4-3102
              |       |
              +-> PV4-3103 -> PV4-3104

Phase 4: PV4-4101 || PV4-4102 -> PV4-4103 -> PV4-4104

Phase 5: PIM-5101 -> PIM-5102 || PIM-5103 || PIM-5104
              |                        |
PV4-1103 -> PIM-5105 -> PIM-5106      +-> PIM-5107 -> PIM-5108

Phase 6: PV4-6101 || PV4-6102 -> PV4-6103
                               -> PV4-6104 -> PV4-6105
```

Do not parallelize tickets that independently redesign the same schema, action protocol, or coordinator ownership surface.

# 7. Verification strategy

## Focused tests

- supervisor parser/action validator;
- repository migrations/leases/idempotency;
- observation cursor and wake coalescing;
- graph revision invariants;
- parent/child cycles and propagation;
- resource pause/fallback policy;
- PR exact-head/force-push behavior;
- Jules correlation;
- review exact lineage;
- auto-merge expected SHA.

## Full regression

```bash
cd model-control-plane
npm test
npm run typecheck
npm run build

git diff --check
```

Include existing deployment-boundary, workspace, recovery, plan, delivery, and architecture suites.

## E2E fault injection

- service/OpenHands restart during supervisor turn;
- duplicate wake and duplicate webhook;
- stale decision cursor;
- provider quota/rate/auth errors;
- paused/resumable writer;
- corrupted/missing conversation with durable projection intact;
- child repair failure and rollback;
- PR force-push between review and merge;
- production health failure after self-repair/merge.

# 8. Security and trust review checklist

- supervisor has no write/merge/deploy secrets;
- actions are typed and validated, not shell strings;
- projections redact secrets and sensitive paths;
- external PR/Jules content is untrusted;
- Business OAuth is not exposed to untrusted implementation;
- independent review is exact and causal;
- append-only accepted history;
- self-repair target and deployment environment allow-listed;
- no direct database recovery edits;
- rollback evidence retained;
- resource policies cannot be widened by a model response.

# 9. Rollout and rollback

## Feature flags

```text
MODEL_CP_V4_SUPERVISOR_MODE=disabled|shadow|advisory|autonomous
MODEL_CP_V4_ENABLED_PROJECTS=...
MODEL_CP_V4_SYSTEM_REPAIR_ENABLED=false
MODEL_CP_V4_MAINTENANCE_ENABLED=false
MODEL_CP_V4_AUTO_MERGE_ENABLED=false
```

Exact names may change during implementation, but modes and independent kill switches are required.

## Rollback

- disable V4 supervisor/program schedulers;
- retain V4 records read-only for audit;
- V3 plans/executions continue normally;
- cancel only V4 action requests that have not created a V3 execution/plan;
- never delete child-plan, PR, review, or merge evidence;
- deployment rollback returns to the previously verified control-plane revision and database backup when schema behavior requires it.

# 10. Definition of done

This Active Plan closes only when:

1. the Phase 0 provenance defects are fixed, independently reviewed, deployed, and the existing MemoFlow plan resumes normally;
2. a durable supervisor can survive restart and operate from event projections rather than ChatGPT conversation memory;
3. unknown/repeated failures cause diagnosis and safe typed actions instead of immediate generic `BLOCKED`;
4. graph revisions and system-repair child plans preserve accepted history and exact provenance;
5. Digital Biome has a working resource-bounded maintenance program;
6. Anti-Gravity exhaustion demonstrably pauses work without unauthorized fallback;
7. Jules/GitHub PRs complete exact-SHA validation, review, repair, re-review, and auto-merge under policy;
8. post-merge verification and rollback/follow-up paths work;
9. shadow/replay metrics show safe bounded behavior and a material reduction in operator-required recovery;
10. docs, ADR, architecture, API/protocol references, operational runbooks, and dashboard projections match the shipped implementation.
