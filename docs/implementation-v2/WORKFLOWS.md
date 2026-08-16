# Business Workflows V2

## 1. Purpose

These workflows validate that the domain model closes over real product behavior. Each flow names authoritative state transitions, failure behavior, and UI evidence.

## 2. Workflow A — Discover an existing supplier workforce

Scenario: a GatewayDiscoveryPort (current CPA adapter or LiteLLM reference adapter) reports OpenCode Go routes exposing DeepSeek V4 Flash.

### Flow

```text
Gateway discovery
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

not two separate employees for two gateway routes.

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

## 7. Workflow F — Gateway deployment fails but Employee remains the same

Initial route:

```text
Duty A staffed by Employee E-014
Invocation 1
  Attempt 1
    Employment A
    Channel A
```

Physical route/deployment A fails.

### G1 gateway-local failover

If another business-equivalent deployment/Channel B belongs to the same Employment and can reach E-014, the gateway may select it:

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

### B2 business Employment failover

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

## 12. Workflow K — Add or discover a supplier route safely

Gateway administration is optional to the core product. Two valid operator paths exist.

### Path 1 — native gateway administration (preferred first implementation)

```text
operator configures LiteLLM / CPA using gateway-native secure tooling
 -> gateway validates route/deployment
 -> GatewayDiscoveryPort observes safe metadata
 -> Supplier/SupplierModel/Offering reconciliation
 -> Employment/Channel routability reconciliation
 -> Office shows normalized business state
```

This path requires **no secret-bearing V2 business endpoint**.

### Path 2 — optional unified Office administration

Only if a real operator workflow justifies it:

```text
operator command
 -> isolated GatewayAdminPort adapter
 -> gateway creates/tests route
 -> GatewayDiscoveryPort observes result
 -> V2 reconciles safe business projection
```

### Safety

Credential must never appear in:

- V2 business tables;
- business events;
- browser persistence;
- application logs;
- projection payloads;
- error payloads.

Failure is represented as gateway route evidence; it never creates/changes Employee identity by itself.

## 13. Workflow L — Physical retry versus business failover

Initial state:

```text
Position -> Employee E-014 -> Employment B -> employment:empl_B
```

### Gateway-local failure

LiteLLM/another gateway may retry or choose another business-equivalent deployment inside `employment:empl_B`.

```text
Employment B
 -> deployment B1 fails
 -> deployment B2 succeeds
```

Employee, Employment, Appointment, and StaffingSegment remain unchanged. Physical attempt/deployment evidence is recorded when observable.

### Employment failover

If Employment B is no longer routable, the gateway must return failure/unroutable evidence rather than silently using Employment C. Hermes business route policy then chooses Employment C and records that decision.

### Employee failover

If E-014 has no permitted Employment, DispatchDecision may select E-022. This closes the old StaffingSegment and opens a new one. The gateway never makes this decision.

## 14. Workflow M — Cost and token attribution

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

## 15. Workflow N — Employee dossier history

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

## 16. Workflow O — Archive without losing history

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

## 17. Workflow P — Reconciliation after restart

On service start:

1. load canonical V2 facts;
2. resume/perform GatewayDiscoveryPort reconciliation;
3. reconcile SupplierModels/Employees without duplicating identity;
4. reconcile current Employments;
5. reconcile current Appointment materialization from StaffingRules;
6. mark route/health state from fresh evidence;
7. do not fabricate closure of duties solely because no live runtime feed has arrived yet;
8. publish fresh projections.

## 18. Workflow Q — No routable employee

If a DutySession has candidates but none is routable:

```text
DispatchDecision selectedEmployeeId = null
candidateResults explain each rejection
DutySession -> BLOCKED or remains PLANNED according to caller policy
UI -> explicit staffing incident
```

Never silently fall back to an unrelated raw model.

## 19. Workflow acceptance checklist

The model is considered workflow-complete when automated tests can demonstrate:

- same Employee survives subscription gaps;
- one Employee has multiple concurrent Appointments and duties;
- gateway-local G0/G1 retry/deployment switch does not change Employee or Employment;
- B2 Employment failover for the same Employee does not change StaffingSegment history;
- Employee replacement creates sequential StaffingSegments;
- usage attributes to the actual attempt route;
- appointed-but-never-worked remains distinguishable;
- V1 consumers remain operational during migration.

## Implemented workflow addendum

Hermes execution now follows `OrgStore snapshot → V2 Run/Position/Duty/RuntimeSession projection`, independently from Employee dispatch. A runtime can therefore be active but unattributed; only a StaffingSegment establishes which Employee was actually on duty. Employment/Appointment lifecycle changes redispatch active duties with B2/B3 failover semantics.
