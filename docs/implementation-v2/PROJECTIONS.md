# Projections and UI Semantics V2

## 1. Purpose

The UI reads purpose-built projections over canonical domain facts. It must not reinterpret raw database rows or make identity decisions in React components.

Projection rules exist so Office animation, Organization, Operations, and Workforce views all tell the same story.

## 2. Projection principles

1. Canonical state lives in domain tables/events.
2. Projections may denormalize freely for read performance.
3. Projections are rebuildable.
4. Projection version is explicit.
5. Unknown/stale telemetry is shown as unknown/stale, not converted into a false lifecycle transition.
6. The same Employee ID must appear consistently across all views.

## 3. Office projection

Endpoint:

```text
GET /api/v2/projections/office
```

Suggested shape:

```json
{
  "projectionVersion": 1,
  "generatedAt": "...",
  "workScopes": [
    {
      "id": "scope_...",
      "name": "MemoFlow",
      "lifecycle": "ACTIVE",
      "positions": [
        {
          "id": "pos_...",
          "name": "MemoFlow Lead",
          "role": "PROFILE_LEAD",
          "runtimeKind": "HERMES_PROFILE",
          "duty": {
            "id": "duty_...",
            "runId": "run_...",
            "activity": "THINKING",
            "staffing": {
              "segmentId": "seg_...",
              "employeeId": "emp_...",
              "employeeName": "DeepSeek V4 Flash @ OpenCode"
            },
            "runtime": {
              "kind": "HERMES_PROFILE",
              "externalSessionId": "..."
            }
          }
        }
      ]
    }
  ],
  "incidents": []
}
```

### Animation semantic mapping

```text
WorkScope       -> room / department / area
Position        -> desk / job seat
DutySession     -> desk activated for work
StaffingSegment -> which Employee occupies it
Employee        -> character identity
RuntimeSession  -> computer/runtime context
Activity        -> animation
```

### Character identity

Character appearance should be stable by `employeeId`, not by runtime PID or Channel.

If one Employee staffs multiple duties concurrently, projection may emit multiple manifestations:

```json
{
  "employeeId": "emp_...",
  "manifestationId": "emp_...:duty_...",
  "ordinal": 1,
  "totalConcurrent": 3
}
```

The domain Employee remains one identity.

### Activity mapping

| Domain activity | Visual behavior          |
| --------------- | ------------------------ |
| `IDLE`          | standing/sitting idle    |
| `THINKING`      | thinking animation       |
| `PLANNING`      | reading/planning         |
| `CODING`        | typing                   |
| `RESEARCHING`   | reading/searching        |
| `BROWSING`      | browser/search animation |
| `TESTING`       | test/terminal animation  |
| `REVIEWING`     | reading/review animation |
| `WAITING_IO`    | waiting                  |
| `NEEDS_INPUT`   | attention bubble         |
| `BLOCKED`       | blocked/error indicator  |

UI must not translate animation back into business state.

## 4. Organization projection

Endpoint:

```text
GET /api/v2/projections/organization
```

Focus:

- WorkScopes;
- Position hierarchy/relations;
- current Appointment coverage;
- current DutySessions;
- current Employees actually staffing duties;
- vacancies and unroutable positions.

Suggested per-position summary:

```json
{
  "positionId": "pos_...",
  "name": "MemoFlow Reviewer",
  "relations": [],
  "appointments": {
    "primary": ["emp_..."],
    "backup": ["emp_..."]
  },
  "currentDuties": 1,
  "staffing": [
    {
      "dutySessionId": "duty_...",
      "employeeId": "emp_...",
      "activity": "REVIEWING"
    }
  ],
  "coverage": "HEALTHY"
}
```

Coverage states:

```text
HEALTHY        // at least one routable candidate, preferred coverage exists
DEGRADED       // fallback only or primary unroutable
UNSTAFFED      // no current Appointment
UNROUTABLE     // appointments exist but none routable
PAUSED
RETIRED
```

## 5. Operations projection

Endpoint:

```text
GET /api/v2/projections/operations
```

High-density operational rows may combine:

```text
Run
DutySession
Position
Employee
Employment
Channel
current activity
latest attempt
health/capacity incident
tokens/cost to date
elapsed time
```

Operations should distinguish:

```text
STAFFING incident   // no eligible/routable Employee
SUPPLY incident     // Employment/Capacity problem
ROUTE incident      // Channel/protocol problem
RUNTIME incident    // process/tool problem
UPSTREAM incident   // provider response problem
```

This prevents every failure from appearing as generic "model offline".

## 6. Workforce projection

Endpoint:

```text
GET /api/v2/projections/workforce
```

Hierarchy:

```text
Supplier
  -> Employees
       -> current Employments
            -> SupplyAgreement
            -> ModelOffering
            -> Channels
            -> CapacityPools
```

Do not render Channel as an Employee card.

Employee summary includes:

```text
identity
cooperation state
operational availability
current appointments
current duty count
current employments
lifetime tokens
lifetime actual/allocated/market cost
recent reliability
```

## 7. Employee dossier

Endpoint:

```text
GET /api/v2/projections/employees/:employeeId/dossier
```

Sections:

### Identity

```text
Employee ID
Supplier
SupplierModel
canonical ModelDefinition
first seen
record lifecycle
```

### Cooperation

```text
EMPLOYED / DORMANT / RETIRED / ARCHIVED
current Employments
historical Employments
cumulative employed days
```

### Organization career

```text
current Appointments
historical Appointments
distinct Positions appointed
roles appointed
```

### Actual work

```text
current StaffingSegments
historical DutySessions staffed
Runs participated
positions actually worked
concurrency peak
```

### Usage/value

```text
requests
input/output/cache/reasoning tokens
actualCost
allocatedCost
marketValue
```

### Performance

Group by RoleDefinition/PositionTemplate, never one universal score.

### Timeline

Unified timeline may interleave:

```text
employment.started
appointment.started
staffing_segment.started
usage milestones
evaluation.recorded
employment.ended
```

but filters must let users view each history independently.

## 8. Position dossier

Endpoint:

```text
GET /api/v2/projections/positions/:positionId/dossier
```

Sections:

- identity, WorkScope, Role, runtime policy;
- requirement set;
- Position relations;
- current Appointments;
- current candidate qualification/routability;
- active Duties;
- current staffing;
- appointment history;
- actual staffing history;
- usage/performance by Employee;
- dispatch/failover history;
- vacancy/unroutable duration.

## 9. Supplier dossier

Endpoint:

```text
GET /api/v2/projections/suppliers/:supplierId/dossier
```

Shows:

- SupplierModels/Employees;
- current vs dormant Employees;
- plans/agreements;
- current Employments;
- Channel health;
- shared CapacityPools;
- quota burn/reset;
- actual spend;
- allocated cost;
- market value;
- failover rate;
- usage by Employee/Position/WorkScope.

## 10. Statistics semantics

Statistics are time-windowed queries over source facts or rollups.

### Employee lifetime

Includes all Employments across subscription gaps.

### Employment-period statistics

Only UsageEntries attributed to that Employment.

### Appointment history

Counts organizational responsibility even when no work occurred.

### Actual work history

Counts StaffingSegments/DutySessions only.

### Cost

Never show a single unlabeled `cost` number. UI labels:

```text
Actual Spend
Allocated Subscription Cost
Market Value
```

## 11. Staleness

Projection payloads include:

```text
generatedAt
sourceFreshness.runtime
sourceFreshness.controlPlane
sourceFreshness.gateway
```

If runtime source is stale, Office should show telemetry stale instead of marking Employee idle/completed.

If gateway health/usage evidence is stale, routability may be `UNKNOWN` rather than `AVAILABLE`. The projection exposes the gateway source separately so LiteLLM/CPA-specific freshness never becomes business identity.

## 12. Incident projection

Create an explicit incident read model rather than forcing users to infer problems.

Suggested incident shape:

```json
{
  "id": "incident_...",
  "kind": "CAPACITY_EXHAUSTED",
  "severity": "WARNING",
  "subjectType": "Employment",
  "subjectId": "empl_...",
  "affectedPositionIds": ["pos_..."],
  "affectedDutySessionIds": ["duty_..."],
  "startedAt": "...",
  "resolvedAt": null,
  "explanation": "OpenCode Go monthly quota exhausted; same Employee has no second routable Employment."
}
```

Incidents may initially be derived rather than persisted.

## 13. V1 projection compatibility

During migration, build a compatibility adapter that can project V2 into the existing `/api/v1/dashboard/workforce` shape.

Rules:

- legacy `workerId` stays legacy-compatible;
- V2 Employee IDs may appear only in new optional metadata until V1 is retired;
- current Pixel UI must not be forced to understand Employment before its V2 migration;
- V1 projection tests snapshot current field meanings.

## 14. Projection acceptance criteria

1. One Employee appears consistently across supplier plans/channels.
2. Current Appointment and current work are visually distinguishable.
3. DORMANT Employee can remain appointed but is clearly unroutable.
4. Same Employee switching Employment does not visually look like employee replacement.
5. Actual Employee replacement visibly changes staffing history.
6. Employee dossier shows career stats across supply gaps.
7. UI never needs raw secret-bearing provider data.

## Implemented projection addendum

Purpose-built projections now include Workforce, Office, Position dossier, Run dossier and Incident. Office Position status deliberately distinguishes `WORKING` from `RUNTIME_ACTIVE_UNATTRIBUTED`; runtime evidence without a StaffingSegment never counts as staffed work.
