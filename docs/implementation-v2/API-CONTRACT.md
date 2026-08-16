# API Contract V2

## 1. API goals

`/api/v2` is the future canonical business API for Hermes AI Office. It must expose stable organizational and workforce concepts rather than legacy implementation identities.

V2 design principles:

1. Separate commands from queries.
2. Never expose raw credentials.
3. Use stable V2 IDs in canonical routes.
4. Return explainable routing/staffing outcomes.
5. Preserve temporal history rather than presenting only current mutable state.
6. Keep `/api/v1` behavior stable during migration.

## 2. Base conventions

Base path:

```text
/api/v2
```

Content type:

```text
application/json
```

IDs are opaque strings defined by Domain Model V2.

Timestamps are RFC3339 strings at the API boundary even if persistence uses integer epoch values.

Money values should be JSON numbers paired with explicit currency. If precision later requires decimal strings, change through a versioned schema rather than silently altering semantics.

## 3. Response envelopes

Canonical entity/query response:

```json
{
  "data": {},
  "meta": {
    "requestId": "req_...",
    "schemaVersion": 1
  }
}
```

List response:

```json
{
  "data": [],
  "meta": {
    "requestId": "req_...",
    "schemaVersion": 1,
    "nextCursor": null
  }
}
```

Command response:

```json
{
  "data": {
    "commandId": "cmd_...",
    "result": {},
    "emittedEventIds": ["event_..."]
  },
  "meta": {
    "requestId": "req_...",
    "schemaVersion": 1
  }
}
```

## 4. Error model

All non-2xx business errors use:

```json
{
  "error": {
    "code": "EMPLOYEE_NOT_ROUTABLE",
    "message": "No current employment route is usable for this employee.",
    "details": {
      "employeeId": "emp_...",
      "reasons": ["NO_CURRENT_EMPLOYMENT"]
    },
    "retryable": false
  },
  "meta": {
    "requestId": "req_...",
    "schemaVersion": 1
  }
}
```

Core error classes:

```text
NOT_FOUND
VALIDATION_ERROR
CONFLICT
INVALID_STATE_TRANSITION
IDEMPOTENCY_CONFLICT
QUALIFICATION_FAILED
STAFFING_CONSTRAINT_FAILED
EMPLOYEE_NOT_ROUTABLE
NO_STAFFABLE_EMPLOYEE
NO_ROUTABLE_EMPLOYMENT
CHANNEL_UNAVAILABLE
CAPACITY_EXHAUSTED
UPSTREAM_FAILURE
COMPATIBILITY_CONTRACT_VIOLATION
```

HTTP mapping:

- 400 validation/invalid command;
- 404 unknown entity;
- 409 lifecycle/conflict/idempotency conflict;
- 422 valid request but business rule rejects it;
- 503 no infrastructure route/control-plane dependency unavailable;
- 500 unexpected internal failure.

## 5. Idempotency

Mutating endpoints that may be retried by clients accept:

```text
Idempotency-Key: <opaque client key>
```

At minimum:

- create SupplyAgreement;
- start/end Employment;
- create Appointment;
- open/close DutySession;
- dispatch;
- record invocation/usage;
- channel onboarding/action commands.

The server stores `(idempotency_key, command_type, normalized_request_hash, response_ref)` for a bounded retention period. Reusing a key with a different payload returns `409 IDEMPOTENCY_CONFLICT`.

## 6. Query endpoints — Organization

### WorkScopes

```text
GET /api/v2/work-scopes
GET /api/v2/work-scopes/:scopeId
GET /api/v2/work-scopes/:scopeId/positions
```

Filters:

```text
lifecycle
q
cursor
limit
```

### Roles and Position templates

```text
GET /api/v2/roles
GET /api/v2/position-templates
GET /api/v2/position-templates/:templateId
```

### Positions

```text
GET /api/v2/positions
GET /api/v2/positions/:positionId
GET /api/v2/positions/:positionId/appointments
GET /api/v2/positions/:positionId/duties
GET /api/v2/positions/:positionId/history
GET /api/v2/positions/:positionId/stats
```

`GET /positions/:id` should include references, not giant embedded histories.

Example:

```json
{
  "data": {
    "id": "pos_...",
    "name": "MemoFlow Lead",
    "workScopeId": "scope_...",
    "roleId": "role_...",
    "runtimeKind": "HERMES_PROFILE",
    "lifecycle": "ACTIVE",
    "requirementSetId": "reqset_...",
    "current": {
      "appointmentCount": 2,
      "activeDutyCount": 1,
      "routableEmployeeCount": 1
    }
  }
}
```

## 7. Query endpoints — Workforce Supply

```text
GET /api/v2/suppliers
GET /api/v2/suppliers/:supplierId
GET /api/v2/suppliers/:supplierId/models
GET /api/v2/supplier-models
GET /api/v2/supplier-models/:supplierModelId
GET /api/v2/employees
GET /api/v2/employees/:employeeId
GET /api/v2/employees/:employeeId/employments
GET /api/v2/employees/:employeeId/appointments
GET /api/v2/employees/:employeeId/work-history
GET /api/v2/employees/:employeeId/usage
GET /api/v2/employees/:employeeId/evaluations
GET /api/v2/employees/:employeeId/stats
GET /api/v2/supply-agreements
GET /api/v2/supply-agreements/:agreementId
GET /api/v2/channels
GET /api/v2/capacity-pools
```

Employee dossier query:

```text
GET /api/v2/projections/employees/:employeeId/dossier
```

must distinguish:

```json
{
  "identity": {},
  "cooperation": {
    "state": "EMPLOYED",
    "currentEmployments": [],
    "employmentHistorySummary": {}
  },
  "organization": {
    "currentAppointments": [],
    "appointmentHistorySummary": {}
  },
  "currentWork": [],
  "career": {
    "staffingStats": {},
    "usage": {},
    "performanceByRole": []
  }
}
```

## 8. Query endpoints — Staffing

### Qualification

```text
GET /api/v2/positions/:positionId/candidates
GET /api/v2/positions/:positionId/qualification?employeeId=emp_...
```

Candidate response must expose three independent dimensions:

```json
{
  "employeeId": "emp_...",
  "qualified": true,
  "eligible": true,
  "routable": false,
  "reasons": ["CAPACITY_EXHAUSTED"],
  "appointments": [],
  "routableEmployments": []
}
```

### Staffing rules and appointments

```text
GET /api/v2/staffing-rules
GET /api/v2/appointments
GET /api/v2/appointments/:appointmentId
GET /api/v2/dispatch-decisions
GET /api/v2/dispatch-decisions/:decisionId
```

## 9. Query endpoints — Execution

```text
GET /api/v2/tasks
GET /api/v2/tasks/:taskId
GET /api/v2/runs
GET /api/v2/runs/:runId
GET /api/v2/runs/:runId/duties
GET /api/v2/duties/:dutySessionId
GET /api/v2/duties/:dutySessionId/staffing-history
GET /api/v2/duties/:dutySessionId/runtime-sessions
GET /api/v2/duties/:dutySessionId/invocations
GET /api/v2/invocations/:invocationId
GET /api/v2/invocations/:invocationId/attempts
GET /api/v2/usage
GET /api/v2/stats/:dimension
```

Supported stats dimensions should be explicit allowlisted values, not arbitrary SQL field names:

```text
employee
employment
supplier
agreement
work-scope
position
role
run
model
channel
```

## 10. Command endpoints — Organization

```text
POST /api/v2/commands/work-scopes/create
POST /api/v2/commands/work-scopes/:scopeId/pause
POST /api/v2/commands/work-scopes/:scopeId/archive

POST /api/v2/commands/positions/create
POST /api/v2/commands/positions/:positionId/activate
POST /api/v2/commands/positions/:positionId/pause
POST /api/v2/commands/positions/:positionId/retire
POST /api/v2/commands/positions/:positionId/archive
POST /api/v2/commands/position-relations/set
```

Commands should be business verbs, not generic PATCH of arbitrary columns.

## 11. Command endpoints — Workforce Supply

```text
POST /api/v2/commands/supply-agreements/create
POST /api/v2/commands/supply-agreements/:agreementId/activate
POST /api/v2/commands/supply-agreements/:agreementId/suspend
POST /api/v2/commands/supply-agreements/:agreementId/end

POST /api/v2/commands/employments/start
POST /api/v2/commands/employments/:employmentId/suspend
POST /api/v2/commands/employments/:employmentId/resume
POST /api/v2/commands/employments/:employmentId/end

POST /api/v2/commands/employees/:employeeId/retire
POST /api/v2/commands/employees/:employeeId/archive

POST /api/v2/commands/channels/onboard
POST /api/v2/commands/channels/:channelId/test
POST /api/v2/commands/channels/:channelId/enable
POST /api/v2/commands/channels/:channelId/disable
POST /api/v2/commands/channels/:channelId/quarantine
```

`channels/onboard` may accept credential material, but the V2 API handler must stream it to the gateway-management boundary and exclude it from:

- request logs;
- persisted command body;
- event payloads;
- error details;
- projections.

If safely guaranteeing this is difficult, keep secret-bearing onboarding on the existing dedicated admin path until a hardened V2 handler exists.

## 12. Command endpoints — Staffing

```text
POST /api/v2/commands/staffing-rules/create
POST /api/v2/commands/staffing-rules/:ruleId/update
POST /api/v2/commands/staffing-rules/:ruleId/disable

POST /api/v2/commands/appointments/create
POST /api/v2/commands/appointments/:appointmentId/suspend
POST /api/v2/commands/appointments/:appointmentId/resume
POST /api/v2/commands/appointments/:appointmentId/end

POST /api/v2/commands/duties/:dutySessionId/dispatch
POST /api/v2/commands/duties/:dutySessionId/redispatch
```

Dispatch request may include policy context but not a forced Employee unless an explicit operator override is being recorded.

Example:

```json
{
  "trigger": "DUTY_STARTED",
  "operatorOverrideEmployeeId": null,
  "constraints": {
    "maxActualCost": null
  }
}
```

Response includes the full decision summary:

```json
{
  "selectedEmployeeId": "emp_...",
  "selectedAppointmentId": "apt_...",
  "decisionId": "disp_...",
  "candidateResults": [
    {
      "employeeId": "emp_...",
      "qualified": true,
      "eligible": true,
      "routable": true,
      "score": 92.1,
      "reasons": ["PRIMARY_APPOINTMENT", "HEALTHY_ROUTE"]
    }
  ]
}
```

## 13. Command endpoints — Execution and ledger

Initially these are adapter/internal endpoints and should not all be exposed to browser clients.

```text
POST /api/v2/internal/runs/upsert-observation
POST /api/v2/internal/duties/open
POST /api/v2/internal/duties/:dutySessionId/close
POST /api/v2/internal/runtime-sessions/start
POST /api/v2/internal/runtime-sessions/:runtimeSessionId/end
POST /api/v2/internal/activity-events
POST /api/v2/internal/invocations/start
POST /api/v2/internal/invocations/:invocationId/attempts
POST /api/v2/internal/usage
POST /api/v2/internal/evaluations
```

These endpoints require loopback/authenticated service access, not the Pixel browser admin flag.

## 14. Discovery and reconciliation endpoints

Adapters need explicit commands:

```text
POST /api/v2/internal/adapters/cpa/discover
POST /api/v2/internal/adapters/cpa/usage-sync
POST /api/v2/internal/reconcile/employments
POST /api/v2/internal/reconcile/appointments
POST /api/v2/internal/reconcile/routes
```

Each reconciliation returns counts and emitted event IDs. Reconciliation must be idempotent.

## 15. Projection endpoints

Purpose-built read models avoid forcing the browser to join dozens of entities:

```text
GET /api/v2/projections/office
GET /api/v2/projections/organization
GET /api/v2/projections/workforce
GET /api/v2/projections/operations
GET /api/v2/projections/employees/:employeeId/dossier
GET /api/v2/projections/positions/:positionId/dossier
GET /api/v2/projections/suppliers/:supplierId/dossier
```

Projection payloads have their own `projectionVersion` and may evolve independently of canonical entity schemas under versioned compatibility rules.

## 16. Events API

```text
GET /api/v2/events
GET /api/v2/events/history?after=<seq>&limit=<n>
```

SSE event IDs use the database `seq` for local ordered replay. Full event schema is defined in `EVENT-CONTRACT.md`.

## 17. Pagination and filtering

Use cursor pagination for append-only histories and potentially large lists.

Example:

```text
GET /api/v2/usage?employeeId=emp_...&from=...&to=...&limit=100&cursor=...
```

Do not implement arbitrary user-provided `sortField`/SQL expressions. Expose allowlisted sort/filter options.

## 18. Authorization boundary

Current product is single-operator, but V2 should distinguish access classes now:

```text
PUBLIC_NONE
OPERATOR_READ
OPERATOR_COMMAND
INTERNAL_ADAPTER
SECRET_BEARING_ADMIN
```

This is not a full RBAC system. It is a boundary so browser-read APIs cannot accidentally inherit internal adapter privileges.

## 19. V1 compatibility

During migration:

- `/api/v1/workers` remains a legacy projection;
- `/api/v1/assignments` remains V1 semantics;
- `/api/v1/dashboard/workforce` may eventually be generated from V2 projections but must keep its current shape;
- `/api/v1/resolve/:positionId` keeps existing behavior until a documented cutover;
- Pixel `/api/model/*` remains stable.

No V1 response should silently change the meaning of `workerId` from legacy worker identity to V2 Employee ID.

## 20. API acceptance criteria

V2 API design is implemented correctly when:

1. one Employee is addressable independently from its Employments and Channels;
2. current and historical Employments are separately queryable;
3. current and historical Appointments are separately queryable;
4. dispatch exposes qualification/eligibility/routability reasons;
5. one logical invocation exposes multiple physical attempts;
6. usage identifies the exact Employment/Agreement/Channel used;
7. browser projections never contain secrets;
8. `/api/v1` compatibility tests remain green during migration.
