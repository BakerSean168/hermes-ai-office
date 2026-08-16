# Implementation Roadmap V2

## 1. Goal

Implement Domain Model V2 with the **smallest custom system that preserves Hermes-specific business value**.

The concrete stack is defined in [`TECH-STACK.md`](TECH-STACK.md). The first execution-ready path is [`FIRST-VERTICAL-SLICE.md`](FIRST-VERTICAL-SLICE.md).

This roadmap is intentionally gateway-neutral. Current CPA production traffic is protected during migration, while LiteLLM Proxy is the reference implementation for the new Gateway Ports.

The key simplification is:

> We build organizational identity, staffing, history, attribution, and projections. We do not build a generic AI gateway, and we do not implement the complete conceptual domain before one real business spine works.

## 2. Protected contracts throughout

- current `/api/v1/*` semantics;
- Pixel `/api/model/*` compatibility;
- Hermes Bridge endpoints/SSE;
- current CPA production path until explicit cutover;
- current service port `8320` until deployment migration is approved;
- existing historical usage totals;
- no raw provider/gateway secret persistence in V2 business state/events/UI;
- current Office remains useful while V2 is partial.

## 3. Work deliberately removed from our backlog

Unless gateway contract tests prove otherwise, do not implement custom generic versions of:

- provider protocol transformation;
- generic streaming adaptation;
- generic provider retries;
- same-Employment deployment load balancing;
- generic gateway auth/rate limits;
- generic provider spend logging;
- provider credential vaulting;
- generic provider error normalization;
- a second gateway admin dashboard.

Also do not pre-implement every Domain Model V2 concept before the first vertical slice.

## 4. Phase order

```text
Phase 0  freeze V1 + type the service + gateway contract
  -> Phase 1  minimal LiteLLM reference gateway
  -> Phase 2  V2 persistence spine
  -> Phase 3  one Employee/Employment/Position/Appointment
  -> Phase 4  one real coding-review Duty through LiteLLM
  -> Phase 5  invocation/usage + minimal projections/UI
  -> Phase 6  business failover and richer staffing
  -> Phase 7  discovery/capacity/finance expansion
  -> Phase 8  broader runtime migration and hardening
```

The first six phases form the first release-sized vertical slice.

---

## Phase 0 — Baseline, TypeScript foundation, Gateway Port

### Objective

Freeze current behavior and establish a typed, replaceable infrastructure boundary before new V2 state is added.

### V2-000 — Capture V1 compatibility fixtures

Capture non-secret fixtures for:

- V1 schema;
- `/api/v1/dashboard/workforce`;
- `/api/v1/resolve/:positionId`;
- event replay;
- CPA discovery normalization;
- usage aggregation;
- selected logical alias behavior.

**Acceptance:** fixture outputs fail loudly if a compatibility contract changes.

### V2-001 — Convert model-control-plane package to strict TypeScript

Convert the small current `.mjs` service without behavioral redesign.

Target:

```text
model-control-plane/src/**/*.ts
model-control-plane/tsconfig.json
model-control-plane/dist/**/*.js
```

Production runs compiled JavaScript on the pinned Node runtime.

**Protected:** V1 endpoints/database behavior.

### V2-002 — Make model-control-plane an explicit npm workspace/package

Declare Fastify and other runtime dependencies explicitly instead of relying on accidental root dependency resolution.

### V2-003 — Define Gateway Ports

Create only:

```text
GatewayExecutionPort
GatewayDiscoveryPort
GatewayUsagePort
```

`GatewayAdminPort` is deferred.

### V2-004 — Gateway contract harness

Build deterministic fake HTTP gateway tests for:

- required OpenAI-compatible endpoint behavior;
- streaming;
- health/route evidence;
- usage normalization;
- errors/timeouts;
- G0/G1 retry boundaries;
- no B2+ cross-Employment/Employee fallback;
- secret redaction.

### V2-005 — Wrap CPA behind compatibility adapter

Keep existing CPA behavior but expose it through the generic port types where practical. No production cutover.

### Phase 0 acceptance

- current tests/fixtures green;
- compiled TypeScript service can replace current JS binary with identical V1 behavior;
- gateway interfaces contain no LiteLLM/CPA-specific business types;
- current CPA production path remains unchanged.

---

## Phase 1 — Minimal LiteLLM reference gateway

### Objective

Prove the selected external gateway on oracle2 before domain logic depends on it.

### V2-100 — Pin LiteLLM image and deployment unit

Use a tested image release/digest, not `main-latest`.

Run on loopback, suggested `127.0.0.1:4000`.

No Postgres or Redis initially.

### V2-101 — Configure one Employment-scoped model group

Configure exactly one non-critical route suitable for `coding-review` or `codex-general`.

The route may use a native provider or CPA as a downstream compatibility upstream.

### V2-102 — LiteLLM GatewayExecutionPort adapter

Normalize base URL/model route/health required by the runtime launcher.

### V2-103 — LiteLLM discovery/usage evidence adapter

Implement only evidence actually available and required by the first slice. Missing fields remain explicit `UNKNOWN`; do not synthesize precision.

### V2-104 — Run gateway contract suite against LiteLLM

Verify streaming/protocol/retry/deployment attribution and secret isolation.

### Phase 1 acceptance

- one controlled runtime can call the LiteLLM route;
- G0/G1 stays within one selected business route;
- no V2 business state exists solely because of a LiteLLM row ID;
- stopping LiteLLM does not affect existing CPA production traffic.

---

## Phase 2 — Minimal V2 persistence spine

### Objective

Implement only the tables required to express one real work path.

### V2-200 — SQL migration runner

Implement ordered SQL migrations with checksums and explicit transactions.

### V2-201 — Workforce identity tables

Initial tables:

```text
v2_suppliers
v2_supplier_models
v2_employees
v2_supply_agreements
v2_employments
v2_gateways
v2_gateway_bindings
```

Physical `v2_channels` discovery is optional in this phase and can be added when gateway evidence is useful. Do not implement Plan/ModelOffering/CapacityPool richness yet unless the selected route requires it.

### V2-202 — Organization/staffing spine tables

```text
v2_work_scopes
v2_positions
v2_appointments
v2_dispatch_decisions
```

Role/PositionTemplate/StaffingRule/Qualification DSL remain deferred.

### V2-203 — Execution/ledger spine tables

```text
v2_runs
v2_duty_sessions
v2_staffing_segments
v2_model_invocations
v2_invocation_attempts
v2_usage_entries
v2_events
```

### V2-204 — Typed repositories

Replace the current giant-store pattern for V2 with small aggregate-oriented repositories.

### V2-205 — Transaction/event helper

Guarantee state + event atomicity for:

- Employment transitions;
- Dispatch + StaffingSegment;
- InvocationAttempt + UsageEntry.

### Phase 2 acceptance

- V2 migrations are additive/idempotent;
- V1 tables/endpoints remain unchanged;
- restart preserves V2 facts;
- no secrets exist in V2 schema.

---

## Phase 3 — One manually seeded business route

### Objective

Prove business identity before broad discovery automation.

### V2-300 — Seed/register one SupplierModel and stable Employee

Create one real Employee identity for the selected test route.

### V2-301 — Create one SupplyAgreement + Employment

Represent the commercial period independently from Employee identity.

### V2-302 — Register LiteLLM Gateway + GatewayBinding

Bind Employment to a safe `externalRouteRef`. Do not auto-edit LiteLLM config.

### V2-303 — Create one WorkScope + Position

Use `coding-review` as preferred first position.

### V2-304 — Create one manual PRIMARY Appointment

No StaffingRule DSL yet.

### V2-305 — Deterministic minimal DispatchDecision

First candidate pipeline:

```text
CURRENT Appointment
AND Employee active
AND CURRENT Employment
AND gateway route healthy
```

Selection:

```text
PRIMARY > BACKUP > priority > stable-ID tie break
```

Persist rejection reasons for every considered candidate.

### Phase 3 acceptance

The service can answer:

```text
who is Employee E?
through which Employment can E work?
which Position does E currently hold?
would E be selected for Position P, and why?
```

without reading raw CPA/LiteLLM identity as business truth.

---

## Phase 4 — First real Duty through LiteLLM

### Objective

Run one real coding/review runtime with the selected V2 Employee while keeping the domain service out of the token stream.

### V2-400 — Run + DutySession lifecycle

Correlate one existing task/run or controlled launch to V2 Run and DutySession.

### V2-401 — StaffingSegment lifecycle

Open the selected Employee staffing interval from DispatchDecision.

### V2-402 — Runtime launch route injection

Launch/configure Codex/OpenCode with:

```text
base URL -> LiteLLM
model    -> externalRouteRef
```

Gateway auth comes from runtime/deployment environment, not business database.

### V2-403 — RuntimeSession correlation

Attach existing bridge/process/session evidence when available.

### V2-404 — Failure containment

If the route is unavailable:

- do not silently select a raw unrelated model;
- return/block/re-dispatch according to explicit business policy;
- leave CPA/V1 route intact as rollback.

### Phase 4 acceptance

One actual coding/review Duty shows a stable Position, Employee, Employment, StaffingSegment, runtime and LiteLLM route.

---

## Phase 5 — Invocation, usage, projections, minimal UI

### Objective

Make the first real path observable and auditable end to end.

### V2-500 — ModelInvocation correlation

Create invocation identity from runtime integration where possible.

### V2-501 — InvocationAttempt evidence

Record:

- Employee;
- Employment;
- Gateway;
- route/Channel;
- selected deployment when observable;
- status/error/latency.

### V2-502 — UsageEntry

Record token counts available from runtime/gateway.

For this phase:

- `actualCost`: use trusted gateway/provider evidence when present;
- `allocatedCost`: may remain zero/uncomputed;
- `marketValue`: may remain zero/uncomputed.

Do not delay the vertical slice for full finance logic.

### V2-503 — Minimal V2 projection endpoints

Implement:

```text
/projections/office
/projections/workforce
/projections/employees/:id/dossier
/projections/positions/:id/dossier
```

### V2-504 — V2 SSE replay

Use append-only V2 events and EventSource replay by sequence.

### V2-505 — Narrow UI integration

Add only:

- V2 status/source indicator;
- Employee dossier surface;
- Position selection explanation;
- V2-driven avatar/desk for the selected position.

No whole-UI rewrite.

### Phase 5 acceptance

One real Run is visible from Position through Employee/Employment to usage, and V1/CPA behavior remains unchanged.

---

## Phase 6 — Business failover and richer staffing

Implement complexity only after the spine is proven.

### V2-600 — Second Employment for same Employee

Prove B2 switching without changing Employee or StaffingSegment.

### V2-601 — Second Employee for same Position

Prove B3 replacement and sequential StaffingSegments.

### V2-602 — Capability/Requirement model

Add capability claims and explainable qualification only now.

### V2-603 — StaffingRule materialization

Add bulk rules such as “Employee E is PRIMARY for all Profile Lead positions”.

### V2-604 — StaffingConstraint v1

Add only required hard/soft constraints, such as reviewer separation.

### V2-605 — PositionTemplate/run-scoped positions

Support dynamic Subagent positions after static Position behavior is stable.

---

## Phase 7 — Discovery, capacity and finance expansion

### V2-700 — GatewayDiscovery reconciliation

Automate SupplierModel/Channel evidence from LiteLLM/CPA without changing Employee identity.

### V2-701 — CapacityPool

Normalize quota/concurrency only for providers where reliable evidence exists.

### V2-702 — ModelOffering/Plan enrichment

Add richer commercial metadata if it improves actual operator workflows.

### V2-703 — Pricing and market-value model

Implement market reference pricing.

### V2-704 — Subscription cost allocation

Implement configurable allocated-cost policy after real usage data exists.

### V2-705 — Evaluation/role performance

Add quality/performance evidence after enough completed work exists to make it meaningful.

---

## Phase 8 — Broader runtime migration and hardening

### V2-800 — Expand V2 positions

Migrate additional Codex/OpenCode/Subagent positions one by one.

### V2-801 — Hermes brain routing integration

Only after session-launch routing is proven. Long-lived Hermes routing may require a route resolver/lease mechanism; do not build this earlier.

### V2-802 — Restart/reconciliation hardening

### V2-803 — concurrency/transaction tests

### V2-804 — stale telemetry and gateway outage behavior

### V2-805 — archive/retention jobs

### V2-806 — migration discrepancy report

### V2-807 — V1 compatibility reads from V2 where appropriate

### V2-808 — V1 write retirement decision

### V2-809 — CPA retirement/special-upstream decision

CPA may remain for special routes. Retirement is not required for V2 success.

---

## 5. Implementation session protocol

For every ticket:

1. inspect current files and active diffs;
2. write characterization/failing test first where practical;
3. implement one coherent boundary;
4. run focused tests;
5. run package type/lint/build checks;
6. run relevant V1 compatibility fixtures;
7. inspect diff hygiene and secret scan;
8. update docs only when a real contract decision changed.

## 6. Stop conditions

Stop and create a focused decision if implementation would:

- change Employee identity semantics;
- make gateway row IDs canonical business identity;
- expose secrets to V2 state/events/UI;
- make the Node domain service proxy LLM streaming traffic;
- require Postgres/Redis solely because LiteLLM supports them;
- require automatic LiteLLM admin/config mutation before the first slice;
- break `/api/v1` without compatibility evidence;
- invent historical precision unavailable in current data;
- implement deferred domain richness without a real use case.

## Implementation status — 2026-08-16

The V2 north-star domain and control plane are implemented through migration `010_maintenance`, including gateway-neutral execution, persistent idempotency, supply/capacity, finance/evaluation, capability/qualification/staffing policy, organization topology, Hermes RuntimeSession projection, purpose-built Office projections, replayable incidents and safe retention maintenance.

The remaining roadmap item is an **operational V1 retirement cutover**, not another business-domain rewrite. Production intentionally remains `DUAL_RUN` while CPA V1 synchronization, `position:*` alias ownership and protected V1 consumers still exist. The machine-readable readiness decision is `GET /api/v2/compatibility/status`. See `IMPLEMENTATION-STATUS.md` for the exact deployed state and cutover rule.
