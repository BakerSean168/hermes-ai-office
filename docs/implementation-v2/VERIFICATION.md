# Verification Matrix V2

## 1. Purpose

This matrix defines observable evidence required before each V2 capability is considered complete. Passing a build alone is insufficient.

## 2. Baseline commands

Current repository checks remain mandatory where affected:

```text
npm run check-types
npm run lint
npm run test:server
npm run test:webview
npm run build

cd model-control-plane
npm test
```

Exact commands may evolve; implementation tickets must record what they actually ran.

## 3. Domain identity verification

| Scenario                                   | Expected evidence                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| same SupplierModel through two Channels    | one Employee ID, two route records                                           |
| same SupplierModel through two Agreements  | one Employee ID, two Employments                                             |
| subscription ends                          | Employment ended, Employee DORMANT if last employment, Employee ID unchanged |
| re-subscribe later                         | same Employee ID, new/current Employment                                     |
| same canonical model from another Supplier | different Employee ID                                                        |
| credential rotation                        | no new Employee, no new Employment unless commercial entitlement changed     |
| supplier alias known equivalent            | SupplierModel preserved, aliases updated                                     |
| ambiguous alias                            | no silent merge; reconciliation finding/evidence                             |

## 4. Appointment/history verification

| Scenario                          | Expected                                     |
| --------------------------------- | -------------------------------------------- |
| Employee appointed PRIMARY        | current Appointment visible                  |
| Appointment ends                  | historical Appointment retained              |
| employee DORMANT                  | Appointment remains unless separately ended  |
| backup never dispatched           | Appointment history yes, staffing history no |
| StaffingRule matches 10 Positions | 10 concrete Appointments with sourceRuleId   |
| rule later changes                | closed history unchanged                     |

## 5. Dispatch verification

Candidate tests must cover:

```text
unqualified
hard-constraint rejected
no appointment / policy ineligible
DORMANT
no routable Employment
channel unhealthy
protocol incompatible
capacity exhausted
primary vs backup priority
soft preference
score tie
```

For every decision verify:

- winner or explicit no-winner;
- candidate result for every considered Employee;
- reason codes;
- policy version;
- immutable decision record;
- event emitted.

## 6. Failover verification

### L0 same route retry

Expected:

- same Employee;
- same Employment;
- same Channel;
- second InvocationAttempt;
- StaffingSegment unchanged.

### L1 Channel switch

Expected:

- same Employee;
- same Employment;
- different Channel;
- StaffingSegment unchanged.

### L2 Employment switch

Expected:

- same Employee;
- different Employment/Agreement;
- StaffingSegment unchanged;
- usage attributed to new Employment.

### L3 Employee replacement

Expected:

- old StaffingSegment closed;
- new DispatchDecision;
- new StaffingSegment with replacement Employee;
- same DutySession/Position/Run;
- visible history of replacement.

## 7. Runtime/Office verification

| Observation                      | Expected projection                                     |
| -------------------------------- | ------------------------------------------------------- |
| Duty opens                       | active desk/position appears                            |
| StaffingSegment starts           | Employee character occupies duty                        |
| `CODING` activity                | coding animation                                        |
| telemetry stale                  | stale/unknown indicator, not false completion           |
| Employee Employment switches     | same character identity remains                         |
| Employee replaced                | character identity changes with transition              |
| one Employee 3 concurrent duties | 3 manifestations or explicit concurrency representation |

## 8. Persistence verification

- all V2 foreign keys enabled;
- migration versions/checksums recorded;
- migrations rerun idempotently;
- invalid temporal range rejected;
- one Employee unique per Supplier/SupplierModel;
- duplicate invocation attempt number rejected;
- append-only decision/event/usage facts not mutated by normal update APIs;
- archive does not cascade-delete history.

## 9. API verification

### Contract

- JSON envelope stable;
- IDs opaque;
- RFC3339 timestamps;
- business error codes deterministic;
- filters allowlisted;
- pagination deterministic.

### Idempotency

Retry same command/key/payload:

```text
same authoritative result
no duplicate business facts
```

Reuse same key different payload:

```text
409 IDEMPOTENCY_CONFLICT
```

### Security

Scan responses/logs/events/database fixtures for:

- API keys;
- authorization headers;
- raw CPA management credentials;
- secret-bearing full URLs if considered sensitive.

No secret may appear.

## 10. Event verification

Test:

1. monotonically increasing `seq`;
2. unique eventId;
3. SSE replay with `Last-Event-ID`;
4. duplicate delivery safe;
5. consumer reconnect after gap;
6. unknown event ignored/refetch policy;
7. event correlation across failover;
8. no secret payloads;
9. schema version present.

## 11. Migration verification

### Counts are not enough

Because workers deduplicate into Employees, expected counts can change. Verify mapping quality:

```text
legacy worker -> V2 Employee mapping complete
all legacy channels mapped
all current assignments mapped or discrepancy reported
all usage totals preserved/reconcilable
```

### Accounting reconciliation

For fixed time ranges compare:

```text
sum input tokens
sum output tokens
sum cached/reasoning tokens
sum actual cost
sum allocated cost
sum market value
```

by legacy and V2 dimensions.

Differences require a documented reason.

## 12. Projection verification

Golden fixtures for:

- workforce;
- employee dossier;
- position dossier;
- office current state;
- organization coverage;
- operations incident.

Projection rebuild from canonical facts must produce equivalent output.

## 13. Restart verification

Simulate service restart while:

- current Employment exists;
- Employee DORMANT;
- DutySession active;
- Channel unhealthy;
- event client disconnected.

Expected:

- stable IDs preserved;
- no duplicate Employee/Employment/Appointments;
- runtime activity may become stale but not falsely completed;
- event replay resumes correctly.

## 14. Archive verification

### Employee archive

- excluded from default active workforce;
- dossier still queryable with includeArchived/admin history query;
- historical Appointments/Employment/Usage remain.

### Position archive

- no new DutySession;
- history preserved.

### Secret destruction

- credential no longer retrievable;
- historical Channel/Usage references remain non-secret.

## 15. Performance targets for next phase

These are guardrails rather than contractual SLAs:

- current workforce/office projection should be comfortably interactive on the single-user deployment;
- event append/query must not block external channel tests;
- indexes must prevent full scans for common employee/position/time-range statistics;
- SSE consumers should not require polling as normal operation.

Record actual benchmark baselines before setting hard numeric targets.

## 16. Release evidence checklist

For each migrated vertical slice attach:

- migration version;
- relevant test names and outputs;
- API request/response fixture;
- event sequence fixture;
- before/after V1 compatibility fixture;
- DB reconciliation summary;
- screenshot/manual UI evidence when visualization changes;
- rollback command/procedure exercised or reviewed.

## 17. Completion gate for first V2 vertical slice

The first slice is not complete until all are true:

1. stable Employee identity proven across Channel and Agreement variants;
2. Employment history query works;
3. Appointment history query works;
4. DutySession + StaffingSegment make current work queryable;
5. dispatch decision is explainable;
6. InvocationAttempt records concrete Employment/Channel;
7. UsageEntry reconciles with observed usage;
8. V2 event replay works;
9. V1 Pixel/Control Plane path remains operational;
10. no secrets found by repository secret scanning.
