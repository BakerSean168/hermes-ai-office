# Business Workflows V2

## 1. Purpose

These workflows validate that the domain model closes over real product behavior. Each flow names authoritative state transitions, failure behavior, and UI evidence.

## 2. Workflow A — Discover an existing supplier workforce

Scenario: CPA already contains OpenCode Go routes and exposes DeepSeek V4 Flash.

### Flow

```text
CPA discovery
  -> identify Supplier(OpenCode)
  -> identify SupplierModel(OpenCode / DeepSeek V4 Flash)
  -> get-or-create stable Employee
  -> identify SupplyAgreement/Plan from configured/account metadata where available
  -> discover ModelOffering
  -> materialize/reconcile Employment
  -> discover Channel(s)
  -> discover CapacityPool(s)
  -> assess current routability
```

### Identity rule

If the same Supplier + SupplierModel appears through a second Channel, do not create another Employee.

If it appears under another current OpenCode agreement/account, create another Employment, not another Employee.

### Failure behavior

If agreement metadata is insufficient, create a conservative imported/default SupplyAgreement rather than inventing a precise commercial contract. Mark provenance as imported/inferred.

### UI evidence

Workforce view shows:

```text
DeepSeek V4 Flash @ OpenCode
EMPLOYED
2 routes
1 current employment
```

not two separate employees for two CPA routes.

## 3. Workflow B — Stop subscription and later re-subscribe

### Initial state

```text
Employee E-014: DeepSeek V4 Flash @ OpenCode
Employment A: OpenCode Go, CURRENT
Appointment: MemoFlow Lead, CURRENT
```

### Subscription ends

```text
SupplyAgreement A -> EXPIRED
Employment A -> ENDED
Employee cooperation -> DORMANT if no other Employment
Appointment -> unchanged
open Invocation route -> unavailable
open DutySession -> may need routing/employee failover according to current state
```

The Employee remains E-014.

### Re-subscribe later

```text
SupplyAgreement B -> ACTIVE
Employment B -> CURRENT for E-014
Employee cooperation -> EMPLOYED
Appointment -> still existing if not otherwise changed
```

Lifetime employee statistics continue across the gap.

### Acceptance

Employee dossier shows two Employment periods but one career.

## 4. Workflow C — Assign one Employee to many Positions

Scenario: DeepSeek V4 Flash is preferred as all Profile Leads and a coding executor.

### Configuration

Create a StaffingRule:

```text
employee = E-014
position selector:
  role in [PROFILE_LEAD, SOFTWARE_ENGINEER]
  scope = *
class = PRIMARY
```

### Reconciliation

For each matching Position, materialize/reconcile an Appointment.

Do not use the StaffingRule itself as career history; career history is the set of concrete Appointments.

### UI evidence

Employee dossier:

```text
Current Appointments
- MemoFlow Lead
- BodySense Lead
- Infra Lead
- Global Codex Developer
```

## 5. Workflow D — Start a Run and show who is working

User asks Hermes to fix MemoFlow synchronization.

### Flow

```text
Task observed/created
 -> Run starts under MemoFlow WorkScope
 -> required Position becomes active
 -> DutySession opens for MemoFlow Lead
 -> dispatch evaluates candidates
 -> E-014 selected
 -> StaffingSegment opens
 -> Hermes RuntimeSession correlates to DutySession
 -> ActivityEvents arrive
 -> Duty currentActivity updates
 -> Office projection renders Employee at Position
```

### What the UI means

- WorkScope = room/area;
- Position = desk/job;
- Employee = character identity;
- StaffingSegment = who occupies the active desk;
- ActivityEvent = animation.

The UI must not infer "working" from Appointment alone.

## 6. Workflow E — Same Employee works multiple jobs concurrently

E-014 is currently staffing:

```text
MemoFlow Lead / Duty A / THINKING
MemoFlow Codex Developer / Duty B / CODING
BodySense Reviewer / Duty C / REVIEWING
```

The domain allows three open StaffingSegments for E-014.

UI options include:

- clone manifestations labeled 1/3, 2/3, 3/3;
- one avatar plus active-duty count with drilldown.

The projection choice does not change domain identity or concurrency.

## 7. Workflow F — Channel fails but Employee remains the same

Initial route:

```text
Duty A staffed by Employee E-014
Invocation 1
  Attempt 1
    Employment A
    Channel A
```

Channel A fails.

### L1 failover

If Channel B belongs to the same Employment and can reach E-014:

```text
Attempt 1 -> FAILED
Attempt 2 -> same Employee, same Employment, Channel B
StaffingSegment -> unchanged
```

Only invocation route changes.

### UI evidence

Employee remains at the same desk; operations view may show route failover badge/event.

## 8. Workflow G — Employment quota exhausted but same Employee has another agreement

Initial:

```text
E-014
  Employment A = OpenCode Go
  Employment B = OpenCode Enterprise
```

A shared CapacityPool under Employment A becomes exhausted.

### L2 failover

```text
next InvocationAttempt
  Employee E-014 unchanged
  Employment B selected
  Channel from Agreement B selected
```

StaffingSegment remains unchanged because the person doing the job has not changed.

Accounting attributes new usage to Employment B/Agreement B.

## 9. Workflow H — Employee must be replaced mid-duty

If E-014 has no routable Employment and another Employee E-022 is qualified/eligible:

```text
close StaffingSegment(E-014) reason=UNAVAILABLE
create DispatchDecision
open StaffingSegment(E-022)
DutySession stays same
Position stays same
Run stays same
RuntimeSession may stay same if logical route can switch behind it
```

Office animation may show E-014 leaving and E-022 taking the desk.

History must show both staffing intervals.

## 10. Workflow I — Employee is appointed but never actually works

E-030 is `BACKUP` Reviewer for three months.

No dispatch selects E-030.

Expected history:

```text
Appointment history: Reviewer YES
Staffing history: Reviewer NO
Token usage in Reviewer role: 0
```

This distinction is required in employee statistics.

## 11. Workflow J — Dynamic Subagent position

A Run needs a research subagent.

### Flow

```text
PositionTemplate: Research Subagent
 -> instantiate RUN_SCOPED Position
 -> relate to supervising Position
 -> open DutySession
 -> dispatch Employee
 -> start Hermes Subagent RuntimeSession
 -> activity + invocations + usage
 -> complete Duty
 -> retire/archive run-scoped Position according to retention policy
```

The Subagent runtime is not the Employee.

## 12. Workflow K — Add a new supplier channel safely

Operator provides endpoint/protocol/credential.

### Flow

```text
operator command
 -> secret-bearing boundary
 -> gatewayctl creates disabled CPA channel
 -> channel test
 -> discovery
 -> Supplier/SupplierModel/Offering reconciliation
 -> Employment/Channel routability reconciliation
 -> explicit enable
```

### Safety

Credential must never appear in:

- V2 business tables;
- events;
- browser storage;
- logs;
- error payloads.

Failure leaves Channel visible but disabled/quarantined with reason.

## 13. Workflow L — Cost and token attribution

Successful model request:

```text
ModelInvocation
 -> InvocationAttempt
    Employee E-014
    Employment B
    Agreement B
    Channel C
 -> UsageEntry
```

Usage rolls up independently to:

```text
Employee lifetime
Employment period
SupplyAgreement
Supplier
Position
Role
WorkScope
Run
ModelDefinition
Channel
```

Three values remain distinct:

```text
actualCost
allocatedCost
marketValue
```

## 14. Workflow M — Employee dossier history

Employee page must answer:

1. Who is this Employee?
2. Is the Employee EMPLOYED or DORMANT?
3. Through which Employments can they currently work?
4. Which Employments existed historically?
5. Which Positions do they currently hold?
6. Which Positions did they hold historically?
7. Which duties are they actually working now?
8. Which positions did they actually perform historically?
9. How many tokens/cost/value across lifetime?
10. How does performance differ by role?

No answer should require interpreting raw Channel rows as separate people.

## 15. Workflow N — Archive without losing history

### Employee archive

Allowed when operator wants to hide a retired identity from normal views.

```text
Employee -> ARCHIVED
```

Preserve:

- Employments;
- Appointments;
- StaffingSegments;
- Usage;
- Evaluations;
- event references.

### WorkScope archive

Hide from current office/organization by default but preserve all Run/Position history.

### Channel secret removal

Credential may be destroyed while retaining non-secret historical metadata and Usage references.

## 16. Workflow O — Reconciliation after restart

On service start:

1. load canonical V2 facts;
2. resume/perform CPA discovery;
3. reconcile SupplierModels/Employees without duplicating identity;
4. reconcile current Employments;
5. reconcile current Appointment materialization from StaffingRules;
6. mark route/health state from fresh evidence;
7. do not fabricate closure of duties solely because no live runtime feed has arrived yet;
8. publish fresh projections.

## 17. Workflow P — No routable employee

If a DutySession has candidates but none is routable:

```text
DispatchDecision selectedEmployeeId = null
candidateResults explain each rejection
DutySession -> BLOCKED or remains PLANNED according to caller policy
UI -> explicit staffing incident
```

Never silently fall back to an unrelated raw model.

## 18. Workflow acceptance checklist

The model is considered workflow-complete when automated tests can demonstrate:

- same Employee survives subscription gaps;
- one Employee has multiple concurrent Appointments and duties;
- Channel failover does not change Employee;
- Employment failover for same Employee does not change staffing history;
- Employee replacement creates sequential StaffingSegments;
- usage attributes to the actual attempt route;
- appointed-but-never-worked remains distinguishable;
- V1 consumers remain operational during migration.
