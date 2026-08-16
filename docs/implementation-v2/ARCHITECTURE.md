# Architecture V2

## 1. Objective

The target architecture makes Hermes AI Office an organizational control surface over four authoritative business contexts while leaving CPA as the model-request data plane and Hermes runtimes as execution engines.

The architecture must answer, without ambiguous identity translation:

1. Which Positions exist and what do they require?
2. Which durable Employees exist and through which Employments can they currently work?
3. Who is appointed, who is working now, and why was that Employee selected?
4. Which concrete Employment/Agreement/Channel handled every physical model attempt?
5. How does usage roll up to Employee career, procurement period, Position, WorkScope, and Run?

## 2. North-star service boundaries

```text
                         +---------------------------+
                         |     Hermes AI Office      |
                         | UI + thin command facade  |
                         +-------------+-------------+
                                       |
                         queries/events|commands
                                       v
+------------------+     +-------------+-------------+      +------------------+
| Hermes execution | --> | Model / Org Control Plane| ---> | CPA / gatewayctl |
| Bridge/runtime   |     | V2 domain + projections  |      | request data plane|
+------------------+     +-------------+-------------+      +------------------+
       |                           |                              |
       | runtime observations      | durable state                | provider calls
       v                           v                              v
 Activity adapters          SQLite V2 store               external suppliers
```

### Hermes execution plane owns

- Task/Run observations it actually knows;
- RuntimeSession identity and lifecycle;
- tool/activity observations;
- external process/session IDs;
- runtime-local cancellation/interrupt behavior.

It does **not** own Employee identity, supplier procurement, appointment policy, or accounting truth.

### V2 Control Plane owns

Organization:

- WorkScope
- RoleDefinition
- PositionTemplate
- Position
- PositionRelation

Workforce supply:

- Supplier
- SupplierModel
- ModelDefinition mapping
- Plan
- SupplyAgreement
- ModelOffering
- Employee
- Employment
- Channel metadata/health policy
- CapacityPool

Staffing:

- capability/requirement facts;
- StaffingRule;
- Appointment;
- StaffingConstraint;
- DispatchDecision.

Execution ledger:

- DutySession;
- StaffingSegment;
- ModelInvocation;
- InvocationAttempt;
- UsageEntry;
- Evaluation;
- normalized runtime references received from Hermes.

### CPA / gatewayctl owns

- secret-bearing upstream credentials;
- request forwarding;
- protocol adaptation;
- provider-specific retry/session behavior that must happen below the business layer;
- concrete upstream configuration lifecycle;
- logical alias publication mechanism.

The control plane may command CPA through `gatewayctl`, but it must never become a second secret store.

### Pixel Office owns

- human-facing projections;
- animation state derived from business/runtime facts;
- explicit operator commands;
- navigation and explanation.

It owns no canonical business lifecycle.

## 3. Ownership matrix

| State transition             | Authoritative owner                       | Consumers             |
| ---------------------------- | ----------------------------------------- | --------------------- |
| SupplierModel discovered     | Control Plane supply adapter              | staffing, UI          |
| Employment starts/ends       | Control Plane                             | dispatch, finance, UI |
| Appointment starts/ends      | Control Plane staffing                    | dispatch, UI          |
| Task/Run observed            | Hermes adapter or task integration        | Control Plane, UI     |
| DutySession opens/closes     | Control Plane execution domain            | UI, accounting        |
| Employee selected for duty   | Dispatch engine                           | UI, audit             |
| StaffingSegment opens/closes | Control Plane                             | UI, history           |
| RuntimeSession starts/ends   | Hermes/runtime adapter                    | Control Plane, UI     |
| Channel health changes       | CPA adapter/control plane health          | dispatch, UI          |
| InvocationAttempt happens    | request/usage adapter                     | ledger, UI            |
| Usage recorded               | Control Plane ledger                      | statistics, UI        |
| animation state changes      | projection from ActivityEvent/DutySession | UI only               |

No state transition should have two authoritative writers.

## 4. Request path

Target model-call path:

```text
RuntimeSession
  -> logical Position route
  -> current DutySession context
  -> Employee already staffing duty OR dispatch resolution
  -> choose routable Employment
  -> choose compatible healthy Channel
  -> publish/resolve CPA route
  -> CPA forwards request
  -> InvocationAttempt recorded
  -> UsageEntry recorded
```

The system separates two decisions:

```text
staffing decision: which Employee owns this duty?
routing decision: through which Employment + Channel does this invocation reach that Employee?
```

Changing Employment/Channel for the same Employee does not require changing StaffingSegment.

## 5. Runtime event path

```text
Hermes / Codex / OpenCode runtime observation
    -> Hermes Office Bridge / provider adapter
    -> normalized RuntimeObservation
    -> correlate to Run + DutySession + RuntimeSession
    -> append ActivityEvent
    -> update current projection
    -> emit V2 business/projection event
    -> Pixel Office animation
```

The bridge may remain a compatibility source during migration. Long term, normalized runtime observations should not encode supplier/model staffing identity that belongs to the control plane.

## 6. Read/write architecture

Use command/query separation at the API level even if both are implemented in one process initially.

Commands:

- change canonical state;
- validate invariants;
- append events;
- return authoritative result IDs.

Queries:

- read canonical entities or purpose-built projections;
- never perform hidden state mutation;
- may aggregate across contexts.

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
  adapters/
  api/
  events/
  migrations/
```

This is a target boundary, not a requirement to create all directories on day one.

## 7. Logical routing boundary

Clients should increasingly target stable Position identities/aliases, not provider/model credentials.

```text
position:<position-slug>
```

remains a compatibility-friendly logical alias. Internally the control plane resolves:

```text
Position
 -> DutySession / Appointment context
 -> Employee
 -> Employment
 -> Channel
 -> CPA concrete upstream
```

If a Position currently has no routable Employee, the result must be an explicit `UNROUTABLE` outcome with reasons; it must not silently pick an unrelated raw model.

## 8. Failure containment

### Control Plane unavailable

- existing CPA routes may continue serving previously published aliases if safe;
- no new staffing/policy mutations occur;
- UI shows control-plane degraded rather than inventing stale health;
- runtime execution state remains independently observable through Hermes/Bridge.

### CPA unavailable

- Employees may remain appointed;
- Employees become operationally unroutable through affected routes;
- open duties may remain visible but model invocations fail or trigger approved failover;
- no Employee/Appointment history is deleted.

### Bridge/runtime feed unavailable

- canonical organization/supply/staffing state stays intact;
- current activity projection becomes stale/unknown;
- do not mark duties complete merely because telemetry disappeared.

## 9. Concurrency and transaction boundary

SQLite remains acceptable for the next phase because the control plane is single-host and write volume is modest. Use short explicit transactions around state transitions that must be atomic.

Atomic examples:

- create Employment + emit `employment.started`;
- create DispatchDecision + open StaffingSegment;
- close StaffingSegment + open replacement segment during failover;
- record InvocationAttempt + UsageEntry when usage is available synchronously.

Long external calls such as channel tests must not hold database transactions open.

## 10. Protected contracts

Until migration explicitly retires them:

- `127.0.0.1:8320` remains the Model Control Plane service boundary;
- `/api/v1/*` keeps current behavior;
- Pixel backend `/api/model/*` continues to serve current UI;
- Hermes bridge `8787` contracts remain available;
- CPA lifecycle mutations remain behind `gatewayctl`;
- no raw secret enters V2 business tables or event payloads;
- current `position:*` aliases remain valid where already published;
- current usage/accounting records remain queryable.

## 11. Architecture decisions

1. V2 is an additive migration, not an in-place reinterpretation of V1 rows.
2. `/api/v2` is the canonical future API boundary.
3. Employee identity is stable across supply periods.
4. Employment and Appointment are separate temporal facts.
5. DutySession and StaffingSegment are the bridge between organization and runtime work.
6. InvocationAttempt is the bridge between staffing identity and physical routing/accounting.
7. UI reads projections; it does not join raw tables itself.
8. Events are append-only facts with replayable sequence numbers.
