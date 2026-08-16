# Implementation Roadmap V2

## 1. Goal

Implement Domain Model V2 incrementally while keeping the deployed Hermes Office and CPA model gateway operational.

The roadmap is ordered by identity risk and dependency, not frontend/backend categories.

## 2. Protected contracts throughout

- current `/api/v1/*` semantics;
- Pixel `/api/model/*` compatibility;
- Hermes Bridge endpoints/SSE;
- CPA/gatewayctl secret boundary;
- current service ports;
- current logical aliases until explicitly migrated;
- existing historical usage totals;
- no raw secret persistence/events/UI.

## Phase 0 — Characterization and migration fixtures

### Objective

Freeze the current behavior so V2 work has regression evidence.

### Deliverables

- V1 schema fixture;
- representative CPA discovery fixture with multiple channels/models;
- V1 workforce projection snapshots;
- employee dedup migration fixtures;
- usage reconciliation fixtures;
- compatibility contract tests.

### Acceptance

Current tests remain green and V1 projection changes fail characterization tests.

### Tickets

#### V2-000 — Capture V1 schema and projection fixtures

**Goal:** deterministic baseline for migration tests.

**Implementation:** export non-secret schema/data fixtures, add test helpers, snapshot route shapes.

**Acceptance:** fixtures reproduce current `workers/assignments/dashboard` semantics without credentials.

#### V2-001 — Add migration reconciliation test corpus

Cases:

- two channels same supplier model;
- two agreements same supplier model;
- same canonical model different suppliers;
- alias ambiguity;
- quota shared across models.

## Phase 1 — V2 persistence foundation

### Objective

Introduce V2 schema and repository APIs without changing runtime behavior.

### Tickets

#### V2-100 — Schema migration framework

Create `v2_schema_migrations`, transaction helper, migration checksum rules.

#### V2-101 — Organization schema

WorkScope, Role, PositionTemplate, Position, PositionRelation.

#### V2-102 — Workforce supply schema

Supplier, SupplierModel, Employee, Plan, SupplyAgreement, ModelOffering, Employment, Channel, CapacityPool.

#### V2-103 — Staffing schema

Capability, RequirementSet, Qualification, StaffingRule, Appointment, Constraint, DispatchDecision.

#### V2-104 — Execution/ledger schema

Task, Run, DutySession, StaffingSegment, RuntimeSession, ActivityEvent, Invocation, Attempt, Usage, Evaluation, V2 events.

### Acceptance

- schema migration idempotent;
- foreign keys on;
- old service/tests unaffected;
- rollback to previous binary leaves V1 usable.

## Phase 2 — Identity discovery and compatibility projection

### Objective

Make stable Employee identity real before changing staffing.

### Tickets

#### V2-200 — Supplier/SupplierModel normalizer

Deterministically maps CPA discovery to SupplierModel identity with provenance.

#### V2-201 — Stable Employee reconciliation

Enforce `UNIQUE(Supplier, SupplierModel)` and idempotent sync.

#### V2-202 — SupplyAgreement/Employment reconciliation

Derive/import current commercial access periods conservatively.

#### V2-203 — Channel/Capacity mapping

Move health/routes/quotas into V2 representation without secrets.

#### V2-204 — Employee dossier query

Prove current/historical Employment and lifetime identity.

#### V2-205 — V1 workforce compatibility adapter

Generate equivalent V1 read shape from V2 where possible; compare against current output.

### Acceptance vertical evidence

```text
OpenCode channel A + channel B + same DeepSeek model
 -> one Employee
 -> one/more Employments as appropriate
 -> two Channels
```

Re-subscription fixture reuses Employee ID.

## Phase 3 — Organization and appointment migration

### Objective

Represent WorkScopes/Positions and durable career appointments independently from routing.

### Tickets

#### V2-300 — Profile -> WorkScope mapping

Preserve profile external refs.

#### V2-301 — Position import and role/template model

Create RoleDefinitions and Position semantics for existing logical jobs.

#### V2-302 — Assignment -> Appointment migration

Map current active/standby policy without pretending it is request routing truth.

#### V2-303 — StaffingRule reconciliation

Support bulk selectors and materialized Appointment history.

#### V2-304 — Qualification engine v1

Implement explicit boolean/capability/protocol/context requirements with explainable reasons.

### Acceptance

Employee dossier can show current/historical Appointments separately from Employments.

## Phase 4 — One complete staffing vertical slice

### Objective

Make one Position V2-authoritative end to end.

Choose a low-risk or well-observed Position.

### Tickets

#### V2-400 — DutySession lifecycle

Open/close one duty from a Run/Position observation.

#### V2-401 — Dispatch engine

Candidate pipeline:

```text
qualified
 -> constraints
 -> appointment eligibility
 -> employee cooperation
 -> routable employment
 -> channel/capacity
 -> priority/score
```

Persist complete DispatchDecision.

#### V2-402 — StaffingSegment lifecycle

Open/close/replace Employee staffing intervals.

#### V2-403 — Logical route adapter

Resolve selected Employee to Employment + Channel and publish/use existing CPA logical alias safely.

#### V2-404 — Failover levels L0-L3

Test same-channel retry, channel switch, Employment switch, Employee replacement.

### Acceptance

One real duty can explain:

- who was appointed;
- who was selected;
- why;
- through which Employment it was routable;
- who replaced whom if failover occurred.

## Phase 5 — Invocation and accounting vertical slice

### Tickets

#### V2-500 — ModelInvocation correlation

Correlate logical request to DutySession/RuntimeSession.

#### V2-501 — InvocationAttempt recording

Record Employee + Employment + Agreement + Channel per attempt.

#### V2-502 — UsageEntry recording

Token and cost dimensions; immutable append semantics.

#### V2-503 — CPA usage reconciliation

Compare request-level ledger with external aggregate snapshots.

#### V2-504 — Employee/Employment/Position stats

Implement rollups and dossier statistics.

### Acceptance

One request with a retry/failover shows each physical attempt and correct accounting attribution.

## Phase 6 — Runtime projection integration

### Tickets

#### V2-600 — RuntimeSession correlation adapter

Map Hermes/Bridge worker/session evidence into DutySession/RuntimeSession without redefining Employee identity.

#### V2-601 — ActivityEvent normalization

Normalize thinking/coding/review/testing/etc.

#### V2-602 — Office projection

WorkScope + Position + Duty + Employee + activity.

#### V2-603 — Organization/Operations projections

Coverage, active work, incidents, route state.

### Acceptance

Current Office can eventually consume V2 projection and show the same or better real-time work information.

## Phase 7 — V2 API and frontend migration

### Tickets

#### V2-700 — `/api/v2` query endpoints

Implement canonical entities and projections.

#### V2-701 — `/api/v2` command endpoints

Business verbs + idempotency + error model.

#### V2-702 — V2 event SSE/replay

Durable replay from `v2_events`.

#### V2-703 — Employee dossier UI

Current Employment, Appointment, Work, history, usage, role performance.

#### V2-704 — Position dossier UI

Coverage, candidates, staffing history, dispatch explanations.

#### V2-705 — Workforce/Office integration

Migrate current panels progressively.

## Phase 8 — Hardening and V1 retirement preparation

### Tickets

#### V2-800 — restart/reconciliation hardening

#### V2-801 — concurrency and transaction tests

#### V2-802 — stale telemetry behavior

#### V2-803 — archive/retention jobs

#### V2-804 — event replay/load tests

#### V2-805 — migration discrepancy report

#### V2-806 — disable selected V1 writes

#### V2-807 — final V1 retirement decision record

## 3. Dependency order

```text
Phase 0
  -> Phase 1
  -> Phase 2 identity
  -> Phase 3 appointments
  -> Phase 4 staffing
  -> Phase 5 accounting
  -> Phase 6 projections
  -> Phase 7 UI/API migration
  -> Phase 8 hardening/retirement
```

Some UI read-only work may start after projections exist, but no UI design should drive domain identity changes.

## 4. Implementation session protocol

For each ticket:

1. inspect current files and active diffs;
2. add characterization/failing test first where practical;
3. implement one coherent boundary;
4. run focused tests;
5. run package/type/lint checks affected;
6. inspect diff hygiene;
7. update docs only when an actual contract decision changed;
8. report commands and evidence.

## 5. Stop conditions

Pause implementation and create a decision record if work would:

- change Employee identity semantics;
- expose secrets to business state/events;
- break `/api/v1` without migration path;
- invent unavailable historical precision;
- make UI the owner of a domain lifecycle;
- require destructive V1 data migration before V2 parity exists.
