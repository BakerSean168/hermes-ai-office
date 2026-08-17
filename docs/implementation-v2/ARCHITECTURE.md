# Architecture V2

## 1. Objective

The target architecture makes Hermes AI Office an organizational control surface over four authoritative business contexts while treating external Agent configuration and model transport as replaceable infrastructure adapters.

**Current production deployment is not a north-star constraint.** The default external-Agent path is RuntimeAccessProfile -> native Agent configuration. CPA and LiteLLM remain optional adapters for concrete Employments that need account pools, compatibility transport, gateway evidence, or protocol conversion. None of these infrastructure choices changes Employee, Employment, Appointment, DutySession, or Usage business identity.

The architecture must answer, without ambiguous identity translation:

1. Which Positions exist and what do they require?
2. Which durable Employees exist and through which Employments can they currently work?
3. Who is appointed, who is working now, and why was that Employee selected?
4. Which concrete Employment and RuntimeAccessProfile was selected, and what physical access path handled the attempt?
5. How does usage roll up to Employee career, procurement period, Position, WorkScope, and Run?

See [Runtime Access](RUNTIME-ACCESS.md) for the primary Employment-to-Agent contract and [Gateway Strategy](GATEWAY-STRATEGY.md) for optional gateway boundaries.

## 2. North-star service boundaries

```text
                          +---------------------------+
                          |     Hermes AI Office      |
                          | UI + thin command facade  |
                          +-------------+-------------+
                                        |
                          queries/events|commands
                                        v
+-------------------+     +-------------+-------------+
| Hermes execution  | --> | AI Workforce Domain     |
| Bridge/runtime    |     | V2 state + projections  |
+-------------------+     +-------------+-------------+
        |                           |
        | runtime observations      | selected Employment access
        v                           v
 Activity adapters          +-------+-------------------+
                            | RuntimeAccessProfile       |
                            | -> native Agent config     |
                            | -> optional gateway        |
                            +------------+---------------+
                                         |
                                         v
                                   model providers
```

Optional special-provider topology:

```text
AI Workforce Domain -> LiteLLM -> CPA -> special subscription/provider
```

Neither topology changes business identities.

## 3. Ownership boundaries

### Hermes execution plane owns

- Task/Run observations it actually knows;
- RuntimeSession identity and lifecycle;
- tool/activity observations;
- external process/session IDs;
- runtime-local cancellation/interrupt behavior.

It does **not** own Employee identity, supplier procurement, appointment policy, or accounting truth.

### AI Workforce Domain Service owns

Organization:

- WorkScope;
- RoleDefinition;
- PositionTemplate;
- Position;
- PositionRelation.

Workforce:

- Supplier;
- SupplierModel;
- ModelDefinition mapping;
- Plan;
- SupplyAgreement;
- ModelOffering;
- Employee;
- Employment;
- safe gateway/Channel references;
- CapacityPool business facts when the gateway/provider exposes them.

Staffing:

- capability/requirement facts;
- StaffingRule;
- Appointment;
- StaffingConstraint;
- DispatchDecision.

Execution/ledger:

- DutySession;
- StaffingSegment;
- ModelInvocation;
- InvocationAttempt;
- UsageEntry;
- Evaluation;
- normalized runtime and gateway references.

The service does **not** implement provider protocol translation, generic retries, generic deployment load balancing, provider credential storage, or a generic AI gateway.

### Gateway owns

Through `GatewayExecutionPort` / `GatewayDiscoveryPort` / `GatewayUsagePort`:

- secret-bearing provider credentials;
- request forwarding;
- provider request/response transformation;
- provider protocol normalization;
- streaming transport behavior;
- same-Employment retry/load-balancing across business-equivalent deployments;
- generic gateway auth/rate limits/budget enforcement when enabled;
- physical request usage/latency/provider-cost evidence it observes.

Gateway administration is an **optional** `GatewayAdminPort`. The AI workforce product must function if operators administer LiteLLM/CPA through their native tooling.

### Pixel Office owns

- human-facing projections;
- animation state derived from business/runtime facts;
- explicit operator business commands;
- navigation and explanation.

It owns no canonical lifecycle and never receives raw provider credentials.

## 4. Ownership matrix

| State transition                   | Authoritative owner                       | Consumers                    |
| ---------------------------------- | ----------------------------------------- | ---------------------------- |
| SupplierModel identity reconciled  | Workforce adapter/domain                  | staffing, UI                 |
| Employment starts/ends             | Workforce domain                          | route policy, finance, UI    |
| Appointment starts/ends            | Staffing domain                           | dispatch, UI                 |
| Task/Run observed                  | Hermes adapter/task integration           | domain, UI                   |
| DutySession opens/closes           | Execution domain                          | UI, accounting               |
| Employee selected for duty         | Dispatch engine                           | UI, audit                    |
| Employment selected for invocation | Business route policy                     | gateway adapter, audit       |
| physical deployment selected       | Gateway                                   | usage adapter, observability |
| StaffingSegment opens/closes       | Execution domain                          | UI, history                  |
| RuntimeSession starts/ends         | Hermes/runtime adapter                    | domain, UI                   |
| gateway route health changes       | Gateway adapter                           | routability, UI              |
| InvocationAttempt happens          | Gateway usage/correlation adapter         | ledger, UI                   |
| UsageEntry recorded                | Hermes ledger                             | statistics, UI               |
| animation state changes            | projection from ActivityEvent/DutySession | UI only                      |

No transition has two authoritative writers.

## 5. Model request path

North-star path:

```text
RuntimeSession
  -> Position / current DutySession
  -> Employee already staffing duty OR DispatchDecision
  -> business route policy chooses Employment
  -> GatewayExecutionPort resolves employment:<employment-id>
  -> gateway chooses equivalent physical deployment/channel
  -> provider request
  -> gateway usage/result evidence
  -> InvocationAttempt correlation
  -> UsageEntry business attribution
```

Two business decisions stay above the gateway:

```text
staffing: which Employee owns this duty?
commercial route: which Employment may be used for this invocation?
```

One physical decision stays below:

```text
gateway routing: which equivalent deployment/channel within that Employment handles the request?
```

Changing physical deployment never changes StaffingSegment. Changing Employment for the same Employee also leaves StaffingSegment intact but creates a distinct InvocationAttempt route fact. Changing Employee requires redispatch and a new StaffingSegment.

## 6. Gateway route identity

Recommended generated logical route:

```text
employment:<employment-id>
```

A gateway route can contain multiple deployments only when they are business-equivalent under that Employment.

Do **not** build gateway groups that silently mix:

- different Employees;
- unrelated Employments;
- fallback models with different staffing meaning.

During migration, `position:*` was a client compatibility identity rather than permission for the gateway to make staffing decisions. Those CPA compatibility aliases are now retired; current routing is Employment-scoped while Position staffing remains domain-owned.

## 7. Runtime event path

```text
Hermes / Codex / OpenCode observation
    -> Hermes Office Bridge/runtime adapter
    -> normalized RuntimeObservation
    -> correlate Run + DutySession + RuntimeSession
    -> append ActivityEvent
    -> update projection
    -> emit V2 event
    -> Pixel Office animation
```

Gateway events are a separate source:

```text
LiteLLM / CPA / future gateway evidence
    -> GatewayUsagePort / GatewayDiscoveryPort
    -> normalized GatewayObservation
    -> InvocationAttempt / Channel projection / UsageEntry
```

Do not infer runtime work state from gateway traffic alone.

## 8. Read/write architecture

Use command/query separation even if one Node process hosts V2 initially.

Recommended internal modules:

```text
model-control-plane/src/v2/
  ids/
  organization/
  supply/
  staffing/
  execution/
  ledger/
  projections/
  gateways/
    ports/
    litellm/
    cpa/
  api/
  events/
  migrations/
```

The `gateways/` boundary is deliberately infrastructure-facing; no LiteLLM/CPA identifier appears in core domain types except as an opaque external reference.

## 9. Persistence boundary

SQLite remains acceptable for the next domain phase because the service is single-host and business write volume is modest.

V2 persistence stores:

- canonical business identity/history;
- opaque gateway/route/deployment references needed for reconciliation;
- immutable business events and usage attribution.

It does **not** become a mirror of LiteLLM/CPA internal configuration databases and does not store provider credentials.

Short transactions cover atomic business transitions. Long gateway/provider calls never hold DB transactions open.

## 10. Failure containment

### Domain service unavailable

- gateway can continue serving already-resolved Employment routes where safe;
- no new staffing/Appointment business mutation occurs;
- UI marks domain state degraded;
- Hermes runtime telemetry remains independently observable.

### Reference gateway unavailable

- Employee and Appointment history remain intact;
- affected Employments become unroutable/unknown from current evidence;
- open DutySessions remain visible;
- invocation can fail or trigger an approved B2+ business failover;
- no staffing/history row is deleted.

### One gateway adapter unavailable

Other gateway adapters may remain usable if the selected Employee has a permitted Employment through them. The adapter failure itself never creates a new Employee identity.

### Bridge/runtime feed unavailable

- organization/supply/staffing history remains intact;
- current activity becomes stale/unknown;
- duties are not marked complete merely because telemetry disappeared.

## 11. Protected compatibility contracts

Until explicitly retired:

- `127.0.0.1:8320` remains the current service boundary;
- `/api/v1/*` keeps current behavior;
- Pixel backend `/api/model/*` keeps current behavior;
- Hermes Bridge `8787` contracts remain available;
- current CPA `8317` may continue serving production traffic during migration;
- CPA secret mutations remain behind the existing safe boundary while CPA is active;
- migration-era `position:*` aliases are retired; current gateway bindings are Employment-scoped;
- historical V1 usage/accounting remains queryable.

These are migration constraints, not north-star architecture choices.

## 12. Architecture decisions

1. V2 is gateway-neutral.
2. LiteLLM Proxy is the reference gateway implementation; CPA is a compatibility adapter.
3. The business service does not reimplement generic AI gateway capabilities.
4. V2 is an additive migration, not an in-place reinterpretation of V1 rows.
5. `/api/v2` is the canonical future business API boundary.
6. Employee identity is stable across supply periods and gateway changes.
7. Employment and Appointment are independent temporal facts.
8. Domain chooses Employee and Employment; gateway chooses only business-equivalent physical deployments under the selected Employment.
9. DutySession/StaffingSegment bridge organization and runtime work.
10. InvocationAttempt bridges business identity to physical gateway evidence.
11. UI reads projections; it does not join raw tables or gateway admin state itself.
12. Events are append-only facts with replayable sequence numbers.

## Implemented architecture addendum — 2026-08-16

The deployed V2 architecture now includes the complete separation between organizational Position, Employee staffing, and RuntimeSession technical execution. HermesProvider/OrgStore is the normalized execution source; MCP receives latest-wins snapshots and projects ProfileController/Run/ExecutionNode/ExecutionEdge into WorkScope/Position/DutySession/RuntimeSession without creating Employee identity from runtime model hints.

Operational governance is part of the same modular monolith: append-only V2 events feed replayable Incident/checkpoint projections, and maintenance is restricted to ephemeral replay cache plus stale operational-run repair. See `IMPLEMENTATION-STATUS.md` for the deployed migration and verification matrix.
