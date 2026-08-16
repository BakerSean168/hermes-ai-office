# Event Contract V2

## 1. Purpose

V2 events are durable business facts used for replay, projections, audit, and loosely coupled UI updates. They are not imperative UI commands.

Bad:

```text
make_employee_avatar_red
refresh_workforce_panel
```

Good:

```text
employment.ended
gateway.health.changed
channel.health.changed
staffing_segment.started
capacity.exhausted
```

## 2. Canonical envelope

```json
{
  "eventId": "event_01...",
  "seq": 1842,
  "type": "employment.started",
  "schemaVersion": 1,
  "occurredAt": "2026-08-16T12:00:00+08:00",
  "entity": {
    "type": "Employment",
    "id": "empl_...",
    "version": 1
  },
  "correlation": {
    "correlationId": "corr_...",
    "causationId": "event_...",
    "taskId": null,
    "runId": null,
    "dutySessionId": null,
    "invocationId": null
  },
  "actor": {
    "kind": "SYSTEM",
    "ref": "gateway:litellm-reference"
  },
  "payload": {}
}
```

## 3. Ordering semantics

`seq` provides total order for events committed by one control-plane database.

Guarantees:

1. sequence values are monotonically increasing;
2. sequence gaps are allowed;
3. consumers must not infer event time solely from `seq`;
4. `occurredAt` is business observation time;
5. event transport may deliver duplicates;
6. consumers deduplicate by `eventId` or last applied `seq`.

No global distributed ordering guarantee is claimed beyond this service.

## 4. Delivery semantics

SSE is at-least-once from the consumer perspective.

Endpoint:

```text
GET /api/v2/events
```

SSE frame:

```text
id: 1842
event: employment.started
data: {canonical envelope JSON}
```

Client reconnect:

```text
Last-Event-ID: 1842
```

Server behavior:

1. replay events with `seq > 1842` from durable history;
2. switch to live feed;
3. periodically send comment heartbeat;
4. if requested replay is outside retained history, emit/return a resync-required condition so the client can reload a projection.

## 5. Event compatibility

Event type semantic meaning is immutable within one `schemaVersion`.

Allowed changes without schema version bump:

- adding optional payload fields;
- adding new event types.

Requires schema evolution/version handling:

- renaming/removing a required field;
- changing field meaning;
- changing identity semantics.

Consumers must ignore unknown optional fields and unknown event types unless they explicitly require exhaustive handling.

## 6. Correlation and causation

Use one `correlationId` for a complete business operation or flow.

Example failover:

```text
channel.health.changed        correlation C1
invocation.attempted          correlation C1, causation health event
employment.route.rejected     correlation C1
staffing_segment.ended        correlation C1
staffing.dispatched           correlation C1
staffing_segment.started      correlation C1
```

Not every flow needs every event. Correlation exists so audit can reconstruct what did happen.

## 7. Organization events

### `scope.created`

Payload:

```json
{
  "slug": "memoflow",
  "name": "MemoFlow"
}
```

### `scope.lifecycle.changed`

Payload:

```json
{
  "from": "ACTIVE",
  "to": "PAUSED",
  "reason": "OPERATOR"
}
```

### `position.created`

Payload includes:

```text
workScopeId
roleId
positionTemplateId?
runtimeKind?
```

### `position.lifecycle.changed`

### `position.relation.changed`

Must identify `fromPositionId`, `toPositionId`, `relationType`, and change action.

## 8. Workforce supply events

### Supplier/model identity

```text
supplier.discovered
supplier_model.discovered
supplier_model.alias.changed
supplier_model.identity_reconciled
model_offering.discovered
```

`identity_reconciled` must retain both old provisional identity references and resulting canonical identity; it must never hide a merge.

### Employee lifecycle

```text
employee.discovered
employee.retired
employee.archived
employee.restored
```

There is intentionally no `employee.ended` for ordinary subscription expiration. Ending supply produces Employment events and may derive Employee cooperation state `DORMANT`.

### SupplyAgreement

```text
agreement.created
agreement.activated
agreement.suspended
agreement.expired
agreement.terminated
agreement.archived
```

### Employment

```text
employment.started
employment.suspended
employment.resumed
employment.ended
```

`employment.ended` payload:

```json
{
  "employeeId": "emp_...",
  "supplyAgreementId": "agr_...",
  "effectiveTo": "...",
  "reason": "SUBSCRIPTION_EXPIRED",
  "employeeCooperationStateAfter": "DORMANT"
}
```

If another current Employment remains, state after may remain `EMPLOYED`.

### Gateway and Channel

Gateway events describe normalized adapter availability, not provider business identity:

```text
gateway.discovered
gateway.health.changed
gateway.disabled
gateway.retired
```

Channel events describe safe route/deployment projections:

```text
channel.discovered
channel.enabled
channel.disabled
channel.quarantined
channel.restored
channel.health.changed
channel.test.completed
```

No secret or full credential-bearing endpoint data is allowed in payloads.

### Capacity

```text
capacity.changed
capacity.exhausted
capacity.reset
```

Payload identifies CapacityPool and normalized remaining/limit values if safe.

## 9. Staffing events

```text
qualification.assessed
staffing_rule.created
staffing_rule.changed
staffing_rule.disabled
appointment.started
appointment.suspended
appointment.resumed
appointment.ended
dispatch.decided
dispatch.failed
```

### `qualification.assessed`

Payload includes:

```text
employeeId
positionId
qualified
reasonCodes[]
requirementSetId/version
```

### `dispatch.decided`

Payload should not duplicate huge candidate diagnostics if they are stored in the DispatchDecision row. Include compact summary:

```json
{
  "dutySessionId": "duty_...",
  "decisionId": "disp_...",
  "selectedEmployeeId": "emp_...",
  "selectedAppointmentId": "apt_...",
  "candidateCount": 4,
  "rejectedCount": 3,
  "winnerReasons": ["PRIMARY_APPOINTMENT", "HEALTHY_ROUTE"]
}
```

Full candidate evidence remains queryable from the decision API.

## 10. Execution events

```text
task.created
task.status.changed
run.started
run.status.changed
run.completed
run.failed
run.cancelled
duty.started
duty.activity.changed
duty.completed
duty.failed
duty.cancelled
staffing_segment.started
staffing_segment.ended
runtime.started
runtime.ended
activity.observed
```

### `staffing_segment.started`

Payload:

```json
{
  "dutySessionId": "duty_...",
  "employeeId": "emp_...",
  "appointmentId": "apt_...",
  "dispatchDecisionId": "disp_..."
}
```

### `duty.activity.changed`

This is a normalized business projection of runtime activity and may carry:

```text
THINKING
CODING
RESEARCHING
BROWSING
TESTING
REVIEWING
WAITING_IO
NEEDS_INPUT
BLOCKED
IDLE
```

It is suitable for UI animation; raw tool payloads belong in ActivityEvent storage and may have stricter retention.

## 11. Invocation and ledger events

```text
invocation.started
invocation.attempt.started
invocation.attempt.failed
invocation.attempt.succeeded
invocation.completed
invocation.failed
usage.recorded
evaluation.recorded
```

### `invocation.attempt.started`

Payload includes:

```text
invocationId
attemptId
attemptNumber
employeeId
employmentId
supplyAgreementId
gatewayId?
channelId?
gatewayRequestRef?
gatewayDeploymentRef?
```

### `usage.recorded`

Payload should be compact:

```json
{
  "usageEntryId": "usage_...",
  "invocationAttemptId": "attempt_...",
  "employeeId": "emp_...",
  "employmentId": "empl_...",
  "positionId": "pos_...",
  "inputTokens": 12000,
  "outputTokens": 1700,
  "actualCost": 0.0,
  "allocatedCost": 0.0042,
  "marketValue": 0.031,
  "currency": "USD"
}
```

## 12. Projection invalidation

Projection consumers should update incrementally when possible, but event semantics must not require UI code to perfectly reconstruct every aggregate.

Recommended strategy:

- small local projection change: patch from event;
- uncertain/unknown event: refetch affected projection;
- replay gap: full projection refetch;
- after reconnect: use event replay then refetch if projection version changed.

## 13. V1 event coexistence

V1 `/api/v1/events` and V2 `/api/v2/events` may coexist.

Rules:

1. Do not emit a V2 event merely by renaming a V1 event unless V2 semantics are actually established.
2. A migration adapter may consume V1/current-state changes and emit V2 facts after reconciliation.
3. V1 consumers continue receiving V1 shapes.
4. Pixel V2 consumers should subscribe to only one authoritative stream for a given projection to avoid double updates.

## 14. Event retention

Business events needed to reconstruct appointments, employments, dispatch, staffing changes, and accounting should be retained long-term.

Raw high-volume activity observations may have a retention/compaction policy. Before deleting raw activity, preserve:

- DutySession activity summary;
- RuntimeSession lifecycle;
- final status;
- timing needed for statistics;
- references needed for audit.

## 15. Event acceptance criteria

1. Every V2 state-changing command emits at least one meaningful business event or explicitly documents why not.
2. Dispatch/failover can be reconstructed from event + decision history.
3. No secret appears in events.
4. Current UI can recover after SSE disconnect through replay/refetch.
5. Duplicate delivery does not duplicate durable facts.
6. Supply expiration emits Employment changes without creating/replacing Employee identity.
