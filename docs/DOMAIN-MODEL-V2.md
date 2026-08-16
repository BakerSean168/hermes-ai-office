# Hermes AI Office — Domain Model V2

**Status:** North-star domain specification
**Purpose:** Authoritative business model for the next architecture and data-model migration
**Supersedes:** The earlier `Profile -> Position -> Model Worker = Channel × Model` model where this document conflicts with it

**Implementation package:** [`implementation-v2/README.md`](implementation-v2/README.md) translates this model into architecture, persistence, API, event, workflow, projection, migration, roadmap, and verification contracts.

## 1. Executive model

Hermes AI Office models an AI organization, not a collection of runtime processes.

The primary business metaphor is:

- **WorkScope** — where work belongs: a project, responsibility area, or long-lived operating context.
- **Position** — a job/seat in the organization: Profile Lead, Researcher, Reviewer, Codex Developer, OpenCode Developer, and so on.
- **Employee** — a durable workforce identity (`Supplier × SupplierModel`) that can hold one or many Positions across multiple commercial periods.
- **Employment** — the temporal commercial fact that a SupplyAgreement currently or historically lets us use that Employee.
- **Appointment** — the temporal organizational fact that an Employee holds a Position.
- **DutySession** — one activation of a Position for a concrete Run.
- **StaffingSegment** — the temporal fact that an Employee actually staffs a DutySession.
- **RuntimeSession** — the technical execution shell used by that DutySession, such as Hermes Profile, Hermes Subagent, Codex, or OpenCode.
- **ModelInvocation / InvocationAttempt** — logical model work and its concrete upstream attempts.
- **UsageEntry** — immutable accounting attached to the actual Employee, Employment, Position, Run, supplier agreement, and route involved.

The most important separation is:

```text
Position != Employee != RuntimeSession != Channel
Employee != Employment != Appointment

Employment       = "this commercial relationship lets us use this employee"
Appointment      = "this employee holds this position"
DutySession      = "this position is active for this run"
StaffingSegment  = "this employee is actually staffing this duty now"
InvocationAttempt= "this concrete employment + route handled this request attempt"
```

This separation is required to support concurrent jobs, history, failover, animation, auditable routing, cost attribution, and archival without identity corruption.

## 2. Bounded contexts

### 2.1 Organization

Owns the stable structure of the AI organization.

Core objects:

- WorkScope
- RoleDefinition
- PositionTemplate
- Position
- PositionRelation

Answers:

- What areas of responsibility exist?
- What jobs exist in each area?
- What does each job mean?
- Which jobs supervise, review, delegate to, or depend on other jobs?

### 2.2 Workforce Supply

Owns external model labor and the commercial/technical supply chain.

Core objects:

- ModelPublisher
- ModelDefinition
- Supplier
- Plan
- SupplyAgreement
- SupplierModel
- ModelOffering
- Employee
- Employment
- Channel
- CapacityPool

Answers:

- Which external AI employees do we have?
- Who supplies them?
- Which supplier-specific model identity makes each Employee durable?
- Through which current or historical Employments can we use that Employee?
- Under which subscription/account/contract was each period supplied?
- Which channels can reach them?
- Which quotas and concurrency pools are shared?

### 2.3 Staffing

Owns suitability, organizational appointment, constraints, and dispatch.

Core objects:

- CapabilityDefinition
- CapabilityClaim
- RequirementSet
- QualificationAssessment
- StaffingRule
- Appointment
- StaffingConstraint
- DispatchDecision

Answers:

- Who is qualified to do a job?
- Who is organizationally allowed/appointed to do it?
- Who is routable right now?
- Who should actually staff this duty?
- Why was one employee selected and another rejected?

### 2.4 Execution & Ledger

Owns concrete work, runtime identity, activity, invocations, and accounting.

Core objects:

- Task
- Run
- DutySession
- StaffingSegment
- RuntimeSession
- ActivityEvent
- ModelInvocation
- InvocationAttempt
- UsageEntry
- Evaluation

Answers:

- What work is happening?
- Which positions are active?
- Which employees are actually working right now?
- What technical runtimes are executing?
- Which supplier route served each model call?
- How many tokens and how much value/cost were consumed?

### 2.5 Projection layer

The Office UI, Organization view, Operations view, workforce pages, animations, and dashboards are **projections**, not additional sources of truth.

They combine facts from the four bounded contexts above.

## 3. Identity policy

### 3.1 General rule

Canonical identifiers are opaque, durable, and never encode mutable business meaning.

Recommended form:

```text
<type>_<ULID>
```

Examples:

```text
scope_01K...
pos_01K...
emp_01K...
apt_01K...
duty_01K...
run_01K...
inv_01K...
```

Human-readable names and slugs are separate fields and may change.

External runtime IDs, CPA IDs, provider IDs, PIDs, session IDs, and model aliases are stored as external references, never used as the canonical business identity.

### 3.2 Type prefixes

| Object                  | Prefix     |
| ----------------------- | ---------- |
| WorkScope               | `scope_`   |
| RoleDefinition          | `role_`    |
| PositionTemplate        | `ptpl_`    |
| Position                | `pos_`     |
| PositionRelation        | `prel_`    |
| ModelPublisher          | `pub_`     |
| ModelDefinition         | `mdl_`     |
| Supplier                | `sup_`     |
| Plan                    | `plan_`    |
| SupplyAgreement         | `agr_`     |
| SupplierModel           | `smdl_`    |
| ModelOffering           | `off_`     |
| Employee                | `emp_`     |
| Employment              | `empl_`    |
| Channel                 | `chn_`     |
| CapacityPool            | `pool_`    |
| CapabilityDefinition    | `cap_`     |
| QualificationAssessment | `qual_`    |
| StaffingRule            | `rule_`    |
| Appointment             | `apt_`     |
| StaffingConstraint      | `con_`     |
| DispatchDecision        | `disp_`    |
| Task                    | `task_`    |
| Run                     | `run_`     |
| DutySession             | `duty_`    |
| StaffingSegment         | `seg_`     |
| RuntimeSession          | `rts_`     |
| ActivityEvent           | `evt_`     |
| ModelInvocation         | `inv_`     |
| InvocationAttempt       | `attempt_` |
| UsageEntry              | `usage_`   |
| Evaluation              | `eval_`    |

## 4. Organization model

### 4.1 WorkScope

A WorkScope is a durable area where work belongs.

Examples:

- MemoFlow
- BodySense
- Personal Infrastructure
- Global / Organization-wide

A legacy Hermes Profile is decomposed into:

```text
Hermes Profile
  = WorkScope
  + Profile Lead Position
  + runtime/config references
```

Suggested fields:

```text
WorkScope {
  id
  slug
  name
  description
  lifecycle
  workspaceRefs[]
  knowledgeRefs[]
  communicationRefs[]
  policyRefs[]
  createdAt
  updatedAt
  archivedAt?
  archiveReason?
}
```

Lifecycle:

```text
ACTIVE <-> PAUSED
ACTIVE  -> ARCHIVED
PAUSED  -> ARCHIVED
ARCHIVED -> PAUSED   // explicit restore only
```

Archival never deletes historical Runs, Positions, Appointments, Usage, or Evaluations.

### 4.2 RoleDefinition

A RoleDefinition describes **what kind of responsibility** a Position carries, independently of runtime technology.

Examples:

- PROFILE_LEAD
- SUPERVISOR
- ARCHITECT
- RESEARCHER
- SOFTWARE_ENGINEER
- REVIEWER
- TESTER
- INTEGRATOR

Suggested fields:

```text
RoleDefinition {
  id
  slug
  name
  purpose
  defaultRequirementSetId?
  lifecycle
}
```

`SOFTWARE_ENGINEER` is a role. `CODEX` is not a role.

### 4.3 PositionTemplate

A PositionTemplate is a reusable blueprint for creating Positions.

Examples:

- Profile Lead
- Hermes Research Subagent
- Codex Software Engineer
- OpenCode Software Engineer
- Independent Reviewer

Suggested fields:

```text
PositionTemplate {
  id
  slug
  name
  roleId
  runtimePolicy
  defaultRequirementSetId
  lifecyclePolicy        // STANDING | RUN_SCOPED
  defaultRelations[]
  defaultStaffingConstraints[]
  enabled
}
```

`runtimePolicy` may include:

```text
kind: HERMES_PROFILE | HERMES_SUBAGENT | CODEX | OPENCODE | GENERIC_LLM | TOOL_ONLY
protocolRequirements[]
requiredTools[]
```

### 4.4 Position

A Position is a concrete organizational job/seat.

Examples:

- MemoFlow Lead
- MemoFlow Reviewer
- MemoFlow / Run 102 / Researcher 01
- BodySense / Codex Developer 02

Suggested fields:

```text
Position {
  id
  scopeId
  templateId?
  roleId
  name
  runtimePolicy
  requirementSetId
  lifecyclePolicy        // STANDING | RUN_SCOPED
  originRunId?           // external reference for ephemeral positions
  lifecycle
  createdAt
  retiredAt?
  archivedAt?
}
```

Lifecycle:

```text
DRAFT -> ACTIVE <-> PAUSED
ACTIVE/PAUSED -> RETIRED
RETIRED -> ARCHIVED
```

Rules:

1. Position identity survives employee changes.
2. Position identity survives runtime process restarts.
3. A RUN_SCOPED Position is retired when its owning Run finishes; it is not deleted.
4. Vacancy is a projection, not a lifecycle state.

### 4.5 PositionRelation

Position-to-Position relationships define organization topology.

Types:

```text
SUPERVISES
DELEGATES_TO
REVIEWS
DEPENDS_ON
ESCALATES_TO
```

Suggested fields:

```text
PositionRelation {
  id
  fromPositionId
  toPositionId
  relationType
  effectiveFrom
  effectiveTo?
  source             // MANUAL | TEMPLATE | POLICY
}
```

Supervision belongs to Positions, not Employees. Replacing an employee must not rewrite the organization graph.

## 5. Workforce Supply model

### 5.1 ModelPublisher

The organization that originates a canonical model family.

Examples: DeepSeek, OpenAI, Anthropic.

### 5.2 ModelDefinition

Canonical model identity independent of where it is purchased.

Suggested fields:

```text
ModelDefinition {
  id
  publisherId
  canonicalName
  family
  version?
  contextWindow?
  modality[]
  lifecycle
}
```

### 5.3 Supplier

The external company/service from which the organization receives usable model capacity.

Examples:

- OpenCode
- Kiro
- direct API provider
- an aggregator

Supplier is not necessarily the ModelPublisher.

### 5.4 Plan

A commercial product offered by a Supplier.

Example: `OpenCode Go`.

Suggested fields:

```text
Plan {
  id
  supplierId
  name
  commercialType     // FREE | SUBSCRIPTION | PREPAID | METERED | SPONSORED
  termsMetadata
}
```

### 5.5 SupplyAgreement

A SupplyAgreement is one concrete commercial entitlement owned by this organization: subscription, account, API contract, sponsored allocation, or another purchasable/renewable relationship.

Example:

```text
"My primary OpenCode Go subscription"
```

Suggested fields:

```text
SupplyAgreement {
  id
  supplierId
  planId?
  externalAccountRef?
  lifecycle
  validFrom
  validTo?
  fixedCost?
  currency?
  billingPeriod?
  createdAt
  endedAt?
  archivedAt?
}
```

Lifecycle:

```text
PENDING -> ACTIVE <-> SUSPENDED
ACTIVE/SUSPENDED -> EXPIRED
ACTIVE/SUSPENDED -> TERMINATED
EXPIRED/TERMINATED -> ARCHIVED
```

SupplyAgreement is a purchasing/accounting identity, not an Employee identity. Provider credentials and gateway secrets are not part of this business aggregate; they remain gateway/secret-manager concerns.

A renewal may continue the same agreement or create a new agreement record depending on the external contract/account semantics. Either choice must not create a new Employee when the Supplier and SupplierModel are unchanged.

Credential rotation for the same entitlement never creates a new SupplyAgreement or Employee by itself.

### 5.6 SupplierModel

SupplierModel is the durable model identity as represented by one Supplier.

It exists because a canonical ModelDefinition and a supplier-facing model are not always identical concepts. The same canonical model may be exposed under supplier-specific aliases, capabilities, rollout versions, or protocol constraints.

Suggested fields:

```text
SupplierModel {
  id
  supplierId
  modelDefinitionId
  supplierModelKey       // stable identity within the Supplier when available
  aliases[]
  displayName
  lifecycle
  firstSeenAt
  retiredAt?
}
```

Identity rule:

```text
same Supplier + same SupplierModel = same Employee
```

Changing plan, subscription, account, credential, or Channel does not change SupplierModel identity.

If a Supplier changes an alias while it is known to represent the same underlying supplier model, adapters should preserve the SupplierModel and add/update aliases. When equivalence is uncertain, the system may create a provisional SupplierModel and later merge it through an explicit identity-reconciliation operation rather than silently rewriting history.

### 5.7 ModelOffering

ModelOffering describes that a Plan or SupplyAgreement currently entitles the organization to use a SupplierModel under particular commercial or technical terms.

This is an entitlement object, not an employee identity.

Suggested fields:

```text
ModelOffering {
  id
  supplierId
  supplierModelId
  planId?
  supplyAgreementId?
  advertisedCapabilities
  protocolOptions[]
  commercialMetadata
  lifecycle
  validFrom?
  validTo?
}
```

Multiple ModelOfferings may point to the same SupplierModel—for example OpenCode Go and OpenCode Enterprise may both provide the same DeepSeek V4 Flash employee.

### 5.8 Employee

An Employee is the durable business identity for model labor supplied by one Supplier.

Canonical identity rule:

```text
Employee = Supplier × SupplierModel
```

Example:

```text
DeepSeek V4 Flash @ OpenCode
```

The same SupplierModel remains the same Employee across:

- plan upgrades/downgrades;
- subscription expiration and later re-subscription;
- account replacement;
- credential rotation;
- multiple concurrent SupplyAgreements;
- multiple Channels.

The same canonical model supplied by another Supplier is a different Employee because supplier-specific reliability, commercial behavior, routing, and service characteristics are different.

Suggested fields:

```text
Employee {
  id
  supplierId
  supplierModelId
  displayName
  recordLifecycle       // ACTIVE | RETIRED | ARCHIVED
  firstSeenAt
  retiredAt?
  archivedAt?
  archiveReason?
}
```

Employee does not directly own `hiredAt` or `endedAt`. Those are temporal facts of Employment records.

Derived cooperation state:

```text
EMPLOYED = at least one current Employment exists
DORMANT  = no current Employment exists, but Employee is not retired/archived
RETIRED  = Supplier/SupplierModel is no longer considered usable as a workforce identity
ARCHIVED = hidden from default operational views while history remains
```

Operational availability is also derived separately from active Employments, Channels, protocol compatibility, health, and CapacityPools:

```text
AVAILABLE
DEGRADED
EXHAUSTED
UNREACHABLE
DISABLED
UNKNOWN
```

An Employee can therefore keep current Appointments while `DORMANT` or operationally `EXHAUSTED`. Dispatch simply treats the Employee as not routable and may choose a backup. If the same Employee is later re-employed, those organizational Appointments do not need to be recreated unless policy changed.

### 5.9 Employment

Employment is the temporal relationship that grants this organization the right to use an Employee through a particular SupplyAgreement.

It answers "through which commercial relationship could we use this employee during this period?"

Suggested fields:

```text
Employment {
  id
  employeeId
  supplyAgreementId
  modelOfferingId?
  status                // SCHEDULED | CURRENT | SUSPENDED | ENDED
  effectiveFrom
  effectiveTo?
  endedReason?
  createdAt
}
```

Lifecycle:

```text
SCHEDULED -> CURRENT <-> SUSPENDED
CURRENT/SUSPENDED -> ENDED
SCHEDULED -> ENDED
```

Rules:

1. One Employee may have many historical Employments.
2. One Employee may have multiple concurrent current Employments through different accounts/plans.
3. Ending the last Employment makes the Employee `DORMANT`; it does not create a new Employee identity later.
4. A later subscription/re-hire creates or reactivates an Employment for the same Employee.
5. Employment history is retained for accounting and procurement analysis.
6. Appointment history and Employment history are independent timelines.

### 5.10 Channel

A Channel is a technical route, not an employee identity or employment identity.

Examples:

- one LiteLLM deployment under an Employment-scoped model group;
- one CPA upstream exposed by the compatibility adapter;
- another gateway-specific physical route.

Channel is a **safe business projection of a gateway route**, not a copy of gateway configuration. Credentials and full provider configuration stay in the gateway/secret manager.

Suggested fields:

```text
Channel {
  id
  supplyAgreementId
  gatewayId
  externalRouteRef
  name
  protocol
  endpointHint?       // non-secret only
  lifecycle
  health
  latencyStats
  lastCheckedAt
}
```

Lifecycle:

```text
DISABLED <-> ENABLED
ENABLED/DISABLED -> QUARANTINED
QUARANTINED -> ENABLED | DISABLED
* -> ARCHIVED
```

Health is separate:

```text
UNKNOWN | HEALTHY | DEGRADED | UNHEALTHY
```

One Employee may be reachable through many Employments and Channels. One Channel may carry multiple Employees from the same SupplyAgreement.

### 5.11 CapacityPool

CapacityPool models shared scarcity.

Examples:

- monthly token allowance shared by all models in one plan
- request quota
- concurrent request limit
- daily credit pool

Suggested fields:

```text
CapacityPool {
  id
  supplyAgreementId
  name
  dimension           // TOKENS | REQUESTS | COST | CONCURRENCY | CUSTOM
  limit
  remaining?
  resetPolicy?
  resetAt?
  lifecycle
}
```

Employees consume CapacityPools only through active Employments/Channels belonging to the associated SupplyAgreement.

This prevents the false assumption that every Employee has an independent quota while preserving one stable Employee career across different plans and subscription periods.

## 6. Capability and qualification model

### 6.1 CapabilityDefinition

Examples:

```text
coding
reasoning
review
research
tool_use
web_search
long_context
vision
structured_output
fast_response
high_reliability
```

A capability may be boolean, ordinal, numeric, categorical, or measured.

### 6.2 CapabilityClaim

A CapabilityClaim is evidence or configuration about a subject.

Possible subjects:

- ModelDefinition
- Supplier
- SupplierModel
- ModelOffering
- Employee
- SupplyAgreement
- Employment
- Channel

Suggested fields:

```text
CapabilityClaim {
  subjectType
  subjectId
  capabilityId
  value
  source             // DECLARED | MEASURED | MANUAL | INFERRED
  confidence?
  observedAt?
  expiresAt?
}
```

### 6.3 RequirementSet

A Position points at a RequirementSet.

Example:

```text
Architecture Reviewer

reasoning >= 90
review >= 85
context_window >= 200000
tool_use == true
allowedProtocol includes responses
```

Requirements may include:

- capabilities
- protocol compatibility
- supplier allow/deny policies
- minimum health
- cost ceilings
- context requirements
- jurisdiction/security rules

### 6.4 QualificationAssessment

Qualification is not a permanent boolean stored on Employee.

It is an explainable assessment:

```text
QualificationAssessment {
  id
  employeeId
  positionId
  qualified
  reasons[]
  effectiveCapabilities
  evaluatedAt
  inputVersionRefs[]
}
```

Three distinct questions must always be available:

```text
Qualified  = has the capability to do the job?
Eligible   = organizational/policy rules permit the employee to do it?
Routable   = can the employee actually be reached and consume capacity now?
```

Example:

```text
Employee: DeepSeek V4 Flash @ OpenCode
Qualified: YES
Eligible:  YES
Routable:  NO
Reason:    all current Employments are quota-exhausted or unreachable
```

## 7. Staffing model

### 7.1 StaffingRule

A StaffingRule expresses reusable policy and avoids exploding configuration.

Example:

```text
Employee E-014 is PRIMARY for every Position where:
  role = PROFILE_LEAD
  scope = *
```

Suggested fields:

```text
StaffingRule {
  id
  employeeSelector
  positionSelector
  appointmentClass      // PRIMARY | BACKUP | RESERVE
  priority
  effectiveFrom
  effectiveTo?
  lifecycle
  provenance
}
```

A StaffingRule is a rule, not employment history.

When a rule matches a concrete Position, the system materializes or reconciles an Appointment so exact history remains available.

### 7.2 Appointment

Appointment is the temporal organizational fact that one Employee holds one Position.

Suggested fields:

```text
Appointment {
  id
  employeeId
  positionId
  class                 // PRIMARY | BACKUP | RESERVE
  priority
  status
  effectiveFrom
  effectiveTo?
  sourceRuleId?
  source                // MANUAL | RULE | IMPORT
  endedReason?
  createdAt
}
```

Lifecycle:

```text
SCHEDULED -> CURRENT <-> SUSPENDED
CURRENT/SUSPENDED -> ENDED
SCHEDULED -> REVOKED
```

Critical rules:

1. Multiple current Appointments may exist for one Position.
2. One Employee may hold many current Appointments.
3. Appointment does not mean the Employee is currently working.
4. Historical Appointments are never overwritten by current configuration.
5. Changing a rule creates/reconciles future/current facts; it must not rewrite closed history.

### 7.3 StaffingConstraint

Constraints apply when staffing one or more Positions.

Examples:

```text
Developer MUST_DIFFER_EMPLOYEE Reviewer
Reviewer PREFER_DIFFERENT_SUPPLIER_FROM Developer
SecurityReviewer ALLOW_SUPPLIERS [A, B]
Employee maxConcurrentDutySessions = 4
```

Constraint strength:

```text
HARD
SOFT
```

Hard constraints reject candidates. Soft constraints contribute explainable penalties or preferences.

### 7.4 DispatchDecision

A DispatchDecision is the immutable audit record for choosing the Employee who will actually staff a DutySession.

Suggested fields:

```text
DispatchDecision {
  id
  dutySessionId
  selectedEmployeeId?
  selectedAppointmentId?
  candidateResults[] {
    employeeId
    appointmentId?
    qualified
    eligible
    routable
    score?
    reasons[]
  }
  policyVersion
  decidedAt
}
```

Selection order should be conceptually:

1. Position requirement qualification
2. hard staffing constraints
3. Appointment eligibility
4. Employee cooperation state (`EMPLOYED` vs `DORMANT`)
5. at least one routable Employment for the Employee
6. Channel availability/protocol compatibility
7. CapacityPool availability
8. explicit appointment class/priority
9. soft constraints
10. quality/reliability/cost/latency/utilization score

The decision must explain every rejection and the winner.

`Appointment != DispatchDecision`.

## 8. Execution model

### 8.1 Task

A Task is the unit of intent.

It may originate from user chat, Kanban, a scheduled workflow, another agent, or an external trigger.

### 8.2 Run

A Run is one attempt to fulfill a Task.

Suggested lifecycle:

```text
QUEUED -> PLANNING -> RUNNING -> FINALIZING -> COMPLETED
                    |       |
                    |       -> BLOCKED -> RUNNING
                    -> FAILED
                    -> CANCELLED
```

A Task may have multiple Runs because of retries, reruns, or alternative execution strategies.

### 8.3 DutySession

A DutySession is one concrete activation of a Position during a Run.

This is the missing boundary between the organizational job and the employee actually doing work.

Suggested fields:

```text
DutySession {
  id
  runId
  positionId
  lifecycle
  currentActivity
  openedAt
  closedAt?
  closeReason?
}
```

Lifecycle:

```text
PLANNED -> ACTIVE -> COMPLETED
                 -> FAILED
                 -> CANCELLED
```

Current activity is orthogonal:

```text
IDLE
THINKING
PLANNING
CODING
RESEARCHING
BROWSING
TESTING
REVIEWING
WAITING_IO
NEEDS_INPUT
BLOCKED
```

This activity state drives visual animation.

### 8.4 StaffingSegment

A StaffingSegment records the interval during which one Employee actually staffs one DutySession.

Suggested fields:

```text
StaffingSegment {
  id
  dutySessionId
  employeeId
  appointmentId?
  dispatchDecisionId
  startedAt
  endedAt?
  endedReason?        // COMPLETED | REPLACED | FAILOVER | UNAVAILABLE | CANCELLED
}
```

Rules:

1. Employee current work is derived from open StaffingSegments.
2. Employee work history is derived from closed StaffingSegments.
3. A DutySession may have multiple sequential StaffingSegments if staff changes.
4. One Employee may have multiple concurrent StaffingSegments.
5. Changing Employee does not require changing Position or Run identity.

This model solves the case where an OpenCode runtime remains alive while the model employee changes behind a logical Position alias.

### 8.5 RuntimeSession

RuntimeSession is technical execution identity.

Suggested fields:

```text
RuntimeSession {
  id
  dutySessionId
  runtimeKind         // HERMES_PROFILE | HERMES_SUBAGENT | CODEX | OPENCODE | ...
  externalSessionId?
  pid?
  cwd?
  workspace?
  worktree?
  branch?
  startedAt
  endedAt?
  metadata
}
```

RuntimeSession is not an Employee and not a Position.

A runtime restart may create a new RuntimeSession for the same DutySession.

### 8.6 ActivityEvent

ActivityEvent is append-only runtime observation used to derive current activity and timeline.

Examples:

```text
runtime.started
model.thinking
tool.started
tool.completed
coding
browsing
testing
needs_input
blocked
runtime.ended
```

UI animations consume projections of these events rather than mutating business state directly.

### 8.7 ModelInvocation

A ModelInvocation is one logical model request made by a DutySession/RuntimeSession.

Suggested fields:

```text
ModelInvocation {
  id
  runId
  dutySessionId
  runtimeSessionId?
  logicalPositionId
  requestedAt
  completedAt?
  status
}
```

Lifecycle:

```text
PENDING -> STREAMING -> SUCCEEDED
                    -> FAILED
                    -> CANCELLED
```

### 8.8 InvocationAttempt

An InvocationAttempt is one concrete physical attempt to satisfy a ModelInvocation.

A logical invocation may have multiple attempts because of retry or failover.

Suggested fields:

```text
InvocationAttempt {
  id
  invocationId
  employeeId
  employmentId
  channelId
  supplyAgreementId
  modelOfferingId?
  attemptNumber
  startedAt
  endedAt?
  outcome
  errorClass?
  latencyMs?
}
```

This is the correct level for answering:

- which Channel actually handled the request?
- did a retry happen?
- did failover cross Employee or Supplier boundaries?
- which route generated the tokens and cost?

### 8.9 UsageEntry

UsageEntry is immutable accounting attached to a concrete InvocationAttempt.

Suggested fields:

```text
UsageEntry {
  id
  invocationAttemptId
  runId
  dutySessionId
  positionId
  employeeId
  supplierId
  employmentId
  supplyAgreementId
  modelDefinitionId
  supplierModelId
  modelOfferingId?
  channelId

  inputTokens
  outputTokens
  cacheReadTokens
  cacheWriteTokens
  reasoningTokens

  actualCost
  allocatedCost
  marketValue
  currency

  occurredAt
  source
}
```

The three cost concepts remain distinct:

```text
actualCost    = amount actually charged for this consumption
allocatedCost = share of fixed/subscription cost allocated to this usage
marketValue   = counterfactual value using configured reference pricing
```

Closed UsageEntry records are never recalculated destructively. Revaluation should produce versioned valuation records or derived reports rather than rewriting audit history without trace.

### 8.10 Evaluation

Evaluation captures quality/performance outcomes that can later influence staffing.

Possible subjects:

- Run
- DutySession
- StaffingSegment
- Employee in a Position/Role

Dimensions may include:

```text
correctness
review_quality
task_success
latency
retry_rate
human_intervention
cost_efficiency
```

Historical performance should be role-aware. A strong Developer is not automatically a strong Reviewer.

## 9. Current vs historical semantics

The system must never infer history only from the current row.

### 9.1 Employee current employments

All Employments where `status = CURRENT` and the effective interval contains now.

This answers "through which commercial relationships can we currently use this employee?"

### 9.2 Employee employment history

All ENDED Employments plus previous non-current intervals. This history is retained across cancellation and re-subscription.

This answers "through which contracts/plans/accounts have we used this employee over its career?"

### 9.3 Employee current appointments

Derived from Appointments where:

```text
status = CURRENT
and effectiveFrom <= now
and (effectiveTo is null or effectiveTo > now)
```

### 9.4 Employee historical appointments

All ENDED/REVOKED Appointments plus prior time-bounded CURRENT records.

This answers "which jobs has this employee been appointed to?"

### 9.5 Employee current work

All open StaffingSegments.

This answers "what is this employee actually doing right now?"

### 9.6 Employee work history

All closed StaffingSegments joined to Position, WorkScope, Role, Run, and runtime information.

This answers "which jobs did this employee actually perform?"

### 9.7 Appointed but never worked

This is valid and must remain distinguishable:

```text
Appointment history: YES
StaffingSegment history: NO
```

Example: an Employee was a Backup Reviewer for three months but was never dispatched.

## 10. Employee dossier projection

The Employee page should be a projection over source facts, not a special mutable aggregate.

Example:

```text
E-014 — DeepSeek V4 Flash @ OpenCode
Supplier: OpenCode
Supplier Model: DeepSeek V4 Flash
Cooperation: EMPLOYED
Availability: AVAILABLE

Current Employments
- OpenCode Go / Primary subscription      CURRENT

Employment History
- OpenCode Go / 2026 H1 subscription     2026-01-01 -> 2026-06-30

Current Appointments
- MemoFlow Lead                PRIMARY
- BodySense Lead               PRIMARY
- Global Codex Developer       PRIMARY
- Reviewer                     BACKUP

Current Work
- MemoFlow Lead / Run 102      THINKING
- Codex Developer / Run 103    CODING

Appointment History
- Infrastructure Reviewer      2026-05-03 -> 2026-07-12
- Researcher                   2026-04-11 -> 2026-06-20

Work History
- Duty sessions staffed        824
- Runs participated            391
- Distinct positions worked     11

Usage
- Requests                    8,214
- Input tokens                 128M
- Output tokens                 31M
- Cache tokens                 894M
- Reasoning tokens              12M
- Actual cost                   $38
- Allocated cost                $94
- Market value                 $612

Performance by Role
- Software Engineer    ...
- Reviewer             ...
```

## 11. Position dossier projection

A Position page should expose:

```text
Position identity
WorkScope
Role
Runtime policy
Requirements
Position relations

Current Appointments
Current DutySessions
Current Employees actually staffing duties

Appointment history
Staffing history
Usage by Employee
Performance by Employee
Dispatch/failover history
```

This provides the inverse view of the Employee dossier.

## 12. Supplier and agreement projections

Supplier/Agreement dashboards should expose:

- Employees supplied by the Supplier
- currently employed vs dormant Employees
- current and historical Employments by agreement
- available SupplierModels / ModelOfferings
- Channel health
- shared CapacityPools
- usage by Employee / Position / WorkScope
- actual spend
- allocated subscription cost
- market value
- quota burn and reset forecast
- failover/retry counts

## 13. Archive and retention rules

### 13.1 General rule

Business history is archived, not hard-deleted.

Hard deletion is reserved for:

- secrets/credentials that must be destroyed
- ephemeral caches
- corrupt test data under explicit maintenance procedures

### 13.2 Supply end, dormancy, and re-employment

When a SupplyAgreement permanently ends:

1. associated Channels become unusable/archived according to policy;
2. Employments backed by that agreement become `ENDED`;
3. active duties staffed by affected Employees are re-evaluated; if another routable Employment for the same Employee exists, the StaffingSegment may continue unchanged while later InvocationAttempts switch commercial route;
4. if the Employee has no routable Employment, the current StaffingSegment is closed/re-dispatched or the duty fails explicitly;
5. the Employee remains the same durable identity;
6. current Appointments do **not** automatically end merely because procurement stopped;
7. if no other current Employment exists, cooperation state becomes `DORMANT`;
8. Usage, Appointment, Employment, Staffing, and Evaluation history remain.

If the same Supplier later provides the same SupplierModel again, the system reuses the same Employee and records a new/current Employment. Career statistics continue across the gap.

Employee becomes `RETIRED` only when the SupplierModel/workforce identity itself is intentionally retired, and `ARCHIVED` only when the record should be hidden from default views. Neither operation deletes history.

### 13.3 Position retirement

Retiring a Position:

1. prevents new DutySessions;
2. ends or schedules the end of current Appointments according to policy;
3. does not delete historical DutySessions or Usage;
4. may later be archived from default views.

### 13.4 WorkScope archive

Archiving a WorkScope hides it from normal operation but preserves all organizational and execution history.

## 14. Projection rules for Office animations

The pixel office is a visual projection with the following semantic mapping:

```text
WorkScope       -> room / department / area
Position        -> job/desk/seat
Employee        -> character identity / employee portrait
Appointment     -> nameplate / employment badge / roster
DutySession     -> occupied active desk for a Run
StaffingSegment -> which Employee appears at that desk now
RuntimeSession  -> computer/runtime context
ActivityEvent   -> typing/thinking/browsing/testing/waiting animation
```

Important rules:

1. The domain allows one Employee to staff multiple concurrent DutySessions.
2. The UI may render clones, numbered manifestations, or one primary avatar plus a concurrency indicator.
3. UI rendering choices must not constrain domain cardinality.
4. An Employee with current Appointments but no open StaffingSegment is "on the roster" but not "working now".
5. A DutySession can remain visible while its Employee changes due to failover.

## 15. Hermes model discovery and routing workflow

Hermes should not need to understand raw provider credentials or gateway internals.

Target flow:

```text
Supplier adapters / GatewayDiscoveryPort
        |
        v
SupplierModel / Employee / SupplyAgreement / Employment / ModelOffering / Channel / CapacityPool registry
        |
        v
Qualification + current Availability
        |
        v
Position requirements + current Appointments
        |
        v
DispatchDecision
        |
        v
StaffingSegment
        |
        v
stable logical Position route
        |
        v
GatewayExecutionPort (reference: LiteLLM; compatibility: CPA)
        |
        v
InvocationAttempt(s)
        |
        v
UsageEntry
```

Hermes asks questions such as:

```text
Which Employees are currently qualified, eligible, and routable for Position X?
Who is currently staffing DutySession Y?
Which logical route should this RuntimeSession use?
```

It should not ask:

```text
What raw API key should I use?
Which provider table row should I hard-code?
```

## 16. Dispatch and failover semantics

### 16.1 Appointment does not pin every request forever

A PRIMARY Appointment expresses organizational preference, not guaranteed perpetual availability.

### 16.2 Failover levels

Recommended levels:

```text
L0: retry same Employee through the same Employment and Channel
L1: same Employee + same Employment through another Channel
L2: same Employee through another active Employment/SupplyAgreement
L3: another Employee holding the same Position
L4: another qualified Employee allowed by StaffingRule/constraints
L5: explicit escalation / human decision
```

Each transition must create auditable DispatchDecision and/or InvocationAttempt evidence.

### 16.3 Mid-duty employee replacement

If the Employee assigned to an active DutySession can no longer serve:

1. close current StaffingSegment with reason `FAILOVER` or `UNAVAILABLE`;
2. create a new DispatchDecision;
3. open a new StaffingSegment for the replacement Employee;
4. keep the DutySession, Position, Run, and—when technically possible—RuntimeSession identity stable.

## 17. Concurrency rules

The domain explicitly permits:

```text
one Employee -> many current Appointments
one Employee -> many concurrent StaffingSegments
one Position -> many Appointments (primary/backups)
one Position -> many historical DutySessions
one Run -> many DutySessions
one DutySession -> sequential StaffingSegments
one ModelInvocation -> many InvocationAttempts
one SupplierModel -> one durable Employee per Supplier
one Employee -> many historical/current Employments
one SupplyAgreement -> many Employments
one CapacityPool -> consumption by many Employees through Employments
```

Default policy may impose practical concurrency limits, but these are Staffing/Capacity constraints rather than identity assumptions.

## 18. Cardinality summary

```text
WorkScope 1 ---- * Position
RoleDefinition 1 ---- * Position
PositionTemplate 1 ---- * Position
Position * ---- * Position             via PositionRelation

Supplier 1 ---- * Plan
Supplier 1 ---- * SupplierModel
ModelDefinition 1 ---- * SupplierModel
SupplierModel 1 ---- 1 Employee        durable workforce identity within a Supplier
Plan 1 ---- * ModelOffering
SupplierModel 1 ---- * ModelOffering
SupplyAgreement 1 ---- * Employment
Employee 1 ---- * Employment
ModelOffering 1 ---- * Employment       optional entitlement provenance
SupplyAgreement 1 ---- * Channel
SupplyAgreement 1 ---- * CapacityPool
Employee * ---- * Channel              derived routability through Employment + Agreement

Employee 1 ---- * Appointment
Position 1 ---- * Appointment
StaffingRule 1 ---- * Appointment      materialization/provenance

Task 1 ---- * Run
Run 1 ---- * DutySession
Position 1 ---- * DutySession
DutySession 1 ---- * StaffingSegment
Employee 1 ---- * StaffingSegment
DutySession 1 ---- * RuntimeSession
DutySession 1 ---- * ModelInvocation
ModelInvocation 1 ---- * InvocationAttempt
Employee 1 ---- * InvocationAttempt
Channel 1 ---- * InvocationAttempt
InvocationAttempt 1 ---- * UsageEntry
```

## 19. Business invariants

These invariants are architecture-level contracts.

1. `Employee != ModelDefinition`.
2. `Employee != Channel`.
3. `Employee != RuntimeSession`.
4. `Position != Employee`.
5. `Position != RuntimeSession`.
6. `Appointment != StaffingSegment`.
7. `Appointment != DispatchDecision`.
8. `Qualified != Eligible != Routable`.
9. One Employee may hold many current Appointments.
10. One Position may have multiple current Appointments for primary/backup coverage.
11. One Employee may staff multiple concurrent DutySessions unless policy/capacity forbids it.
12. Employee identity is `Supplier × SupplierModel`, not `SupplyAgreement × ModelOffering` and not `Channel × Model`.
13. Plan, SupplyAgreement, Employment, Channel, account, and credential changes must not change Employee identity when Supplier + SupplierModel remain the same.
14. The same canonical model from a different Supplier is a different Employee.
15. Employment and Appointment are independent timelines: procurement ending does not automatically revoke organizational responsibility.
16. An Employee with no current Employment is `DORMANT`, not a newly archived/ended employee.
17. Re-employing the same SupplierModel reuses the same Employee and preserves lifetime statistics.
18. Position supervision and organizational relations are Position-to-Position, not Employee-to-Employee.
19. Current work is derived from open StaffingSegments, never from Appointment status.
20. Historical appointment and historical actual work are separate timelines.
21. A logical invocation may contain multiple physical InvocationAttempts.
22. Every InvocationAttempt identifies the concrete Employment + SupplyAgreement + Channel used.
23. Usage is attributed to the concrete attempt and then projected upward to Employee career, Employment period, Position, Run, Supplier, and agreement views.
24. Closed historical records are never silently rewritten by current policy.
25. Archive hides records from default operations but preserves referential history.
26. Secrets may be destroyed; their historical business metadata must not expose secret values.
27. Every dispatch/failover must be explainable from recorded candidate outcomes or a documented external cause.
28. UI animation state is a projection and never the source of business lifecycle transitions.

## 20. Canonical employee statistics

All Employee statistics are derived from immutable/temporal facts.

### 20.1 Employment and staffing

- first seen / first employed date
- current cooperation state (`EMPLOYED` / `DORMANT`)
- current Employment count
- historical Employment count
- cumulative employed days across all Employment periods
- current Appointment count
- historical Appointment count
- distinct Positions ever appointed
- active StaffingSegment count
- total StaffingSegments
- distinct Positions actually worked
- Runs participated
- DutySession count
- concurrency peak

### 20.2 Usage

- logical ModelInvocations
- physical InvocationAttempts
- successful/failed attempts
- input tokens
- output tokens
- cache read/write tokens
- reasoning tokens
- actualCost
- allocatedCost
- marketValue

### 20.3 Reliability

- success rate
- retry rate
- failover-in count
- failover-out count
- p50/p95 latency
- unavailable duration
- quota-exhausted duration

### 20.4 Role-aware performance

Aggregate separately by:

- RoleDefinition
- PositionTemplate
- WorkScope
- time range

Never collapse all performance into one universal "employee quality" number.

## 21. Canonical position statistics

- current Appointments by class
- current StaffingSegments
- historical Employees appointed
- historical Employees actually used
- number of DutySessions
- Runs served
- token usage
- actual/allocated/market cost
- failure rate
- employee switch/failover count
- quality/performance by Employee
- vacancy/unroutable duration

## 22. Event vocabulary

Business events should describe facts rather than UI commands.

Organization:

```text
scope.created
scope.paused
scope.archived
position.created
position.activated
position.retired
position.archived
position.relation.changed
```

Workforce Supply:

```text
agreement.activated
agreement.suspended
agreement.ended
supplier_model.discovered
supplier_model.identity_reconciled
offering.discovered
employee.discovered
employee.retired
employee.archived
employment.started
employment.suspended
employment.resumed
employment.ended
channel.discovered
channel.health.changed
channel.quarantined
capacity.changed
capacity.exhausted
```

Staffing:

```text
qualification.assessed
staffing_rule.changed
appointment.started
appointment.suspended
appointment.ended
dispatch.decided
dispatch.failed
```

Execution:

```text
task.created
run.started
run.blocked
run.completed
duty.started
duty.activity.changed
staffing_segment.started
staffing_segment.ended
runtime.started
runtime.ended
invocation.started
invocation.attempted
invocation.completed
usage.recorded
evaluation.recorded
```

Events should carry entity IDs and correlation IDs (`taskId`, `runId`, `dutySessionId`, `invocationId`) sufficient for replay and projections.

## 23. Migration from the current model

### 23.1 Current `Profile`

Migrate to:

```text
WorkScope
+ Profile Lead Position
```

Preserve legacy profile slug as an external reference and transitional API field.

### 23.2 Current `Position`

Current model-control-plane Positions become Position records, but their semantics must expand from "logical model alias" to organizational jobs.

During migration, a compatibility alias may continue to map one Position to `position:<slug>` in the current CPA adapter. The north-star gateway route is Employment-scoped and does not delegate staffing to the gateway.

### 23.3 Current `Worker = Channel × ModelDefinition`

Retire as a business identity.

Migrate into:

```text
Supplier
SupplierModel
Employee = Supplier × SupplierModel
SupplyAgreement
Employment = Employee × SupplyAgreement over time
ModelOffering = entitlement/provenance
Channel = route
```

Legacy rows that differ only by Channel or agreement but clearly represent the same SupplierModel should converge on one Employee while retaining separate Employment/Channel history. A compatibility projection may continue exposing legacy `workerId` until clients move.

### 23.4 Current `Assignment`

Split into:

```text
StaffingRule
Appointment
DispatchDecision
```

Legacy assignment priority/status fields become migration inputs, not the long-term aggregate.

### 23.5 Current `ExecutionNode`

Split into:

```text
Position / PositionTemplate
DutySession
RuntimeSession
ActivityEvent
```

Runtime PID/session/tool state belongs to RuntimeSession/ActivityEvent, not Position.

### 23.6 Current usage snapshots

Preserve imported aggregate snapshots as legacy accounting facts with source metadata.

New request-level usage should converge on:

```text
ModelInvocation -> InvocationAttempt -> UsageEntry
```

Do not fabricate historical request-level detail that was never observed.

## 24. Protected compatibility contracts during migration

Until explicitly retired, preserve:

- Pixel Office HTTP endpoints used by the current web UI;
- existing Hermes bridge endpoints and SSE behavior;
- current CPA/gatewayctl secret-handling boundary while that compatibility adapter remains active;
- stable `position:*` logical aliases where currently published;
- current dashboard projection shape through an adapter where feasible;
- historical cost/accounting data;
- current service deployment ports and loopback boundaries;
- existing Agent/runtime correlation data needed for current visualizations.

Breaking changes require a versioned API/projection or explicit migration step.

## 25. Decisions now considered settled

For the next architecture phase, this document treats the following as decisions rather than open questions:

1. **Profiles are decomposed:** WorkScope + Profile Lead Position.
2. **Hermes Profile/Subagent/Codex/OpenCode are runtime forms of Positions, not employee identities.**
3. **Employee identity is supplier-scoped model labor:** Supplier × SupplierModel.
4. **SupplyAgreement/Employment describe how and when we can hire/use that Employee; they do not define the Employee.**
5. **Channel is a route, not an Employee.**
6. **Employees may hold many Positions and staff many concurrent duties.**
7. **Appointments and actual work are different temporal facts.**
8. **Employment and Appointment are independent temporal facts.**
9. **StaffingRule handles bulk policy; Appointment preserves concrete history.**
10. **DispatchDecision is separate from Appointment and records why a concrete Employee was chosen.**
11. **DutySession survives Employee replacement; StaffingSegment records the replacement timeline.**
12. **Logical invocation and physical attempts are separate to represent retry/failover and agreement/channel changes.**
13. **Quota/concurrency may be shared through CapacityPool.**
14. **Archive preserves business history.**
15. **UI/animation is a projection over domain facts.**
16. **Gateway implementation is infrastructure:** LiteLLM is the reference adapter; CPA is compatibility/current-state only.
17. **Domain chooses Employee and Employment; a gateway may only choose business-equivalent physical routes inside the selected Employment.**

## 26. Remaining bounded decisions

These no longer threaten the core domain shape and can be decided during implementation planning:

1. Exact capability score scales and confidence model.
2. Whether all capability claims are persisted or some remain adapter-derived.
3. Exact policy DSL for StaffingRule and StaffingConstraint selectors.
4. Whether RUN_SCOPED Positions are persisted immediately or represented as provisional records until a Run starts.
5. Exact retention duration for raw ActivityEvents and InvocationAttempt diagnostic payloads.
6. Whether a logical ModelInvocation may intentionally split output across multiple Employees, beyond retry/failover.
7. Which automatic failover levels require operator approval for expensive or lower-trust Employees.

## 27. Next implementation boundary

The next code phase should **not** rewrite the UI first.

The safest vertical slice is:

```text
existing gateway evidence (initially CPA; reference target LiteLLM)
  -> Supplier / SupplierModel / stable Employee identity
  -> SupplyAgreement / Employment / ModelOffering / Channel projection
  -> one existing Position
  -> StaffingRule + materialized Appointment
  -> DispatchDecision
  -> DutySession + StaffingSegment
  -> one logical position route
  -> ModelInvocation / InvocationAttempt / UsageEntry
  -> compatibility dashboard projection
```

Acceptance for that slice:

1. A discovered Supplier + SupplierModel maps to one stable Employee independent of Agreement and Channel.
2. Ending and later recreating an Employment for the same SupplierModel reuses the Employee identity and career history.
3. The Employee can hold more than one Appointment.
4. Current appointments and historical appointments can be queried separately.
5. Current and historical Employments can be queried separately from Appointments.
6. A Run can open a DutySession for a Position.
7. Dispatch chooses an Employee with recorded reasons and only considers the Employee routable when at least one valid Employment route exists.
8. The resulting StaffingSegment makes "who is working now" queryable.
9. A model call records logical invocation and physical attempt separately, including the actual Employment + Agreement + Channel.
10. Usage is attributable both to Employee lifetime and to a concrete Employment/Agreement period, plus Position and Run.
11. Existing Pixel Office remains operational through compatibility projections.
12. No secret value enters business tables, events, or UI payloads.

## Deployed conformance note — 2026-08-16

The domain model in this document is now represented in the running V2 control plane. In particular, RuntimeSession is explicitly below Position/Duty and cannot create Employee identity from `modelHint`; qualification/constraints feed dispatch; PositionRelation remains stable across employee replacement; finance/performance values are evidence/versioned overlays; Incidents are replayable projections of append-only events. Production V1 is compatibility-only and intentionally dual-run until cutover blockers are removed.
