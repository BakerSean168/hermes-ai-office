# First Vertical Slice — Implementation Plan

> **Historical phase note (2026-08-16):** references below to V1 being authoritative or dual-run describe the migration stage at the time. Production has since completed V1 retirement; see `IMPLEMENTATION-STATUS.md`.

## 1. Goal

Prove the new architecture with the smallest real path that exercises durable Employee identity, Employment routing, actual work, LiteLLM transport, and usage attribution **without replacing current CPA production routing**.

Recommended first position:

```text
coding-review
```

Fallback choice:

```text
codex-general
```

Do not use `hermes-brain` for the first cut. A Codex/OpenCode-style runtime can receive a model/base URL at process launch, so the domain service can stay outside the token streaming path.

## 2. Slice outcome

For one real review/coding Run, the system should be able to say:

```text
Run R
  -> Position coding-review
  -> DutySession D
  -> Employee E
  -> Employment M
  -> LiteLLM route L
  -> physical provider request(s)
  -> Usage U
```

and the Office can show:

- who is working;
- which Position they are staffing;
- which Employment made them routable;
- current activity;
- token/cost usage;
- why the Employee was selected.

Existing `/api/v1`, CPA routes, and current Office remain operational throughout.

## 3. Scope reduction

The conceptual Domain Model V2 remains the north star, but the first slice implements only the business spine.

### Implement now

Organization:

- WorkScope;
- Position.

Workforce:

- Supplier;
- SupplierModel;
- Employee;
- SupplyAgreement;
- Employment;
- Gateway;
- GatewayBinding;
- Channel/physical deployment evidence when observable.

Staffing/execution:

- Appointment;
- DispatchDecision;
- Run;
- DutySession;
- StaffingSegment;
- ModelInvocation;
- InvocationAttempt;
- UsageEntry;
- Event.

### Defer

- RoleDefinition normalization;
- PositionTemplate;
- ModelPublisher/complex ModelDefinition mapping;
- ModelOffering as a rich aggregate;
- CapabilityDefinition/CapabilityClaim;
- RequirementSet;
- generalized Qualification engine;
- StaffingRule DSL;
- StaffingConstraint DSL;
- CapacityPool automation;
- Evaluation/performance scoring;
- automated gateway administration;
- advanced pricing/contract allocation rules;
- full Employee/Position dashboards.

For the first slice, a manual Appointment is sufficient and Dispatch can use a deterministic small candidate policy.

## 4. Implementation batch A — Freeze and type the existing service

### A1. Characterize V1

Capture non-secret fixtures for:

- `/api/v1/dashboard/workforce`;
- `/api/v1/resolve/:positionId`;
- current events replay;
- CPA sync normalization;
- existing SQLite schema;
- usage aggregation.

Acceptance:

- fixtures are deterministic;
- current tests remain green.

### A2. Convert control plane to TypeScript

Preserve behavior while converting the small package to strict TypeScript.

Deliverables:

```text
model-control-plane/tsconfig.json
model-control-plane/src/**/*.ts
model-control-plane/dist/
```

Use Fastify 5. No API redesign in this ticket.

Acceptance:

- V1 fixture outputs match;
- systemd can run compiled output;
- no change to current route behavior.

### A3. Make package ownership explicit

Add `model-control-plane` to npm workspaces and declare runtime dependencies explicitly.

Acceptance:

- clean install works without relying on undeclared root dependencies.

## 5. Implementation batch B — Gateway contract before LiteLLM integration

### B1. Define Gateway Ports

TypeScript interfaces:

```text
GatewayExecutionPort
GatewayDiscoveryPort
GatewayUsagePort
```

Do not implement GatewayAdminPort yet.

### B2. Build fake gateway contract harness

Fake server must exercise:

- chat/completions or responses call shape used by target runtime;
- streaming;
- route health;
- selected deployment evidence;
- retry evidence;
- token/usage normalization;
- errors/timeouts;
- prohibition on cross-Employment fallback.

### B3. Wrap CPA compatibility adapter

Adapt existing CPA discovery/usage behind the generic ports without changing V1 production behavior.

This proves the ports are not LiteLLM-specific.

## 6. Implementation batch C — Deploy a minimal LiteLLM reference gateway

### C1. Pin image

Choose a tested LiteLLM release/image digest. Do not use `main-latest` in production.

Oracle2 ARM64 support has already been confirmed from the image manifest.

### C2. Minimal config

Run on loopback and configure exactly one Employment-scoped model group for the first slice.

No Postgres.
No Redis.
No virtual-key/team administration.
No LiteLLM UI dependency.

Secrets come from host environment/secret files.

### C3. Contract tests

Run the same Gateway Port contract suite against LiteLLM.

Acceptance:

- target endpoint supports required protocol;
- streaming behavior is correct;
- G0/G1 retry stays inside one Employment route;
- deployment/usage evidence is sufficient or documented as missing;
- no paid traffic is required for normal CI.

## 7. Implementation batch D — Minimal V2 persistence spine

Do not create every conceptual V2 table in one migration.

Suggested first migrations:

```text
v2_schema_migrations
v2_suppliers
v2_supplier_models
v2_employees
v2_supply_agreements
v2_employments
v2_gateways
v2_gateway_bindings
v2_work_scopes
v2_positions
v2_appointments
v2_dispatch_decisions
v2_runs
v2_duty_sessions
v2_staffing_segments
v2_model_invocations
v2_invocation_attempts
v2_usage_entries
v2_events
```

Where the future domain contains richer concepts, use nullable external/provenance metadata rather than prematurely implementing the full aggregate.

### D1. Migration runner

Ordered SQL + checksum table.

### D2. Typed repositories

One repository per aggregate boundary, not one giant Store class.

### D3. Transaction helper

Required atomic transitions:

- DispatchDecision + StaffingSegment + events;
- InvocationAttempt + UsageEntry + events;
- Employment state change + event.

## 8. Implementation batch E — Seed one real Employee/Employment

Do not attempt broad auto-discovery first.

For one real route:

1. create/import Supplier;
2. create SupplierModel;
3. create stable Employee;
4. create SupplyAgreement;
5. create Employment;
6. register `litellm-reference` Gateway;
7. create one GatewayBinding from Employment to the LiteLLM `externalRouteRef`;
8. create one WorkScope + Position;
9. create one PRIMARY Appointment.

Acceptance:

- Employee remains stable if GatewayBinding/physical deployment evidence is refreshed;
- Employment is independently queryable;
- no gateway secret exists in V2 tables.

## 9. Implementation batch F — Deterministic first Dispatch

Do not implement generalized scoring yet.

Candidate rule for the first slice:

```text
current Appointment
AND Employee not retired/archived
AND current Employment exists
AND bound Gateway route is healthy
```

Selection:

```text
PRIMARY before BACKUP
then explicit priority
then stable ID order as deterministic tie-breaker
```

Persist every candidate reason in DispatchDecision.

This proves explainability before adding capability scores.

## 10. Implementation batch G — Launch one runtime through LiteLLM

When a `coding-review` DutySession opens:

1. create DispatchDecision;
2. open StaffingSegment;
3. select Employment binding;
4. configure launched Codex/OpenCode runtime with:
   - LiteLLM base URL;
   - external route/model name;
   - internal gateway auth from runtime environment;
5. keep the Node domain service out of the request body/stream path.

Record RuntimeSession correlation if the existing bridge can identify it.

Failure behavior:

- LiteLLM route unavailable -> Duty blocked or B2/B3 policy;
- never fall back to an unrelated raw model.

## 11. Implementation batch H — Invocation and usage

### H1. Invocation identity

Create a ModelInvocation tied to DutySession before/around the model call when the runtime integration permits.

### H2. Physical attempt evidence

Record:

- Employee;
- Employment;
- Gateway;
- external route;
- selected deployment/Channel when known;
- status;
- latency/error.

### H3. Usage

Record actual token fields available from runtime/gateway.

For the first slice:

- `actualCost` may come from gateway/provider evidence;
- `allocatedCost` can remain zero/uncomputed;
- `marketValue` can remain zero/uncomputed until pricing is implemented.

Do not block the vertical slice on full finance logic.

## 12. Implementation batch I — Minimal projections

Implement only the projections needed to prove the product:

```text
GET /api/v2/projections/office
GET /api/v2/projections/workforce
GET /api/v2/projections/employees/:id/dossier
GET /api/v2/projections/positions/:id/dossier
```

First Office projection needs:

- WorkScope;
- Position;
- DutySession;
- current Employee;
- activity/staleness;
- current Run.

Employee dossier needs:

- identity;
- current Employment;
- current Appointment;
- current work;
- lifetime token summary.

## 13. Implementation batch J — UI vertical slice

Do not redesign the whole Office.

Add one narrow V2 surface:

- V2 status/source indicator;
- one Employee dossier drawer/page;
- one Position staffing explanation;
- Office avatar/desk driven by V2 DutySession + StaffingSegment for the selected position.

Use existing React/Vite/Tailwind and EventSource patterns.

## 14. Batch K — Only after the slice is proven

Then expand in this order:

1. second Employee and B3 replacement;
2. second Employment for same Employee and B2 switch;
3. capability/qualification model;
4. StaffingRules for bulk appointments;
5. CapacityPool/quota normalization;
6. broader runtime correlation;
7. cost allocation/market value;
8. remaining Positions;
9. Hermes brain route;
10. optional gateway admin UI.

This order keeps each new concept justified by a working path.

## 15. First-slice protected contracts

Do not break:

- `/api/v1/*`;
- Pixel `/api/model/*`;
- current CPA routing;
- Hermes Bridge SSE/runtime visibility;
- service port 8320;
- current database file;
- secret-handling boundary;
- historical usage rows.

V2 tables are additive.

LiteLLM can be stopped without affecting existing CPA production traffic until explicit cutover.

## 16. Verification gate

The first slice is complete only when one real Run demonstrates:

1. stable Employee ID;
2. separate Employment ID;
3. manual current Appointment;
4. persisted DispatchDecision with reasons;
5. DutySession + StaffingSegment;
6. direct runtime -> LiteLLM model traffic;
7. InvocationAttempt correlated to Employee + Employment;
8. token usage recorded;
9. Office projection identifies who is working and what Position;
10. Employee dossier distinguishes employment/appointment/work;
11. restart preserves/reconstructs state correctly;
12. CPA/V1 still behaves identically;
13. no secret appears in V2 database/events/UI;
14. LiteLLM cannot silently switch Employment or Employee.

## 17. Rollback

Before any selected position is V2-authoritative:

```text
stop LiteLLM
MODEL_CP_V2_ENABLED=0
run previous/current control-plane behavior
```

V1 remains authoritative.

After one position is V2-authoritative, store the cutover marker explicitly and retain a tested fallback mapping to its previous CPA route until the V2 slice has completed a soak period.
