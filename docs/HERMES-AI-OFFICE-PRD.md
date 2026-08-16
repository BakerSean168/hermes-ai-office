# Hermes AI Office — Product & Domain Requirements

Status: Draft v0.1 for business alignment
Date: 2026-08-16
Scope: Hermes AI Office, the AI Workforce Domain Service, Hermes runtimes, and replaceable model gateways

> **Domain model authority:** [`DOMAIN-MODEL-V2.md`](DOMAIN-MODEL-V2.md) is the authoritative domain specification for identity, staffing, execution, supply, history, routing, and archival semantics. Where older terminology in this PRD conflicts with Domain Model V2—especially `Profile -> Position`, `Model Worker = Channel × Model`, `Assignment`, and `Execution Node`—Domain Model V2 supersedes it. This PRD remains authoritative for product goals, workflows, and scope.

## 1. Why this document exists

The repository currently contains several strong implementation specifications (`SPEC-*`), the Hermes bridge specifications, and a Model Control Plane README. Those documents explain how individual features are built, but they do not yet provide one authoritative business-level description of the product.

This document defines the intended product, the stable domain concepts, the user-facing workflows, and the ownership boundaries between Hermes AI Office, Hermes runtimes, the Model Control Plane, and CPA.

It is deliberately written at a higher level than an implementation spec. Engineering tickets should derive from this document rather than redefine the domain ad hoc.

## 2. Product statement

Hermes AI Office is the operational control surface for a personal AI workforce.

It gives the operator one place to answer four questions:

1. What work is happening now?
2. Which AI workers are doing it, under which team/profile and role?
3. Which model/provider capacity is available, healthy, constrained, or expensive?
4. What should the system route, pause, replace, or escalate next?

The product is not merely a pixel visualization of terminal agents, and it is not merely a provider configuration panel. Its purpose is to make a multi-agent, multi-model personal AI system understandable and governable as one coherent organization.

## 3. Primary user

The primary user is the owner/operator of the Hermes environment.

The operator manages several concurrent projects and expects Hermes to use different runtimes, models, providers, and sub-agents without requiring manual inspection of terminals, provider dashboards, or raw routing configuration.

The operator should be able to reason in organizational terms such as:

- WorkScope / Profile
- Position / Role
- Employee / Employment
- Task / Run
- Model capacity
- Cost / quota / health

rather than raw process IDs, API endpoints, OAuth files, or provider-specific routing syntax.

## 4. Product layers

The product consists of four distinct layers.

### 4.1 Execution plane — Hermes

Hermes owns execution of work.

It owns:

- conversations and user requests;
- task planning and orchestration;
- runtime/tool invocation;
- spawning and supervising sub-agents;
- execution sessions and process lifecycle;
- human-in-the-loop interaction.

Hermes is the source of truth for what work is actually being executed.

### 4.2 Model transport plane — replaceable Gateway

Model transport is infrastructure behind a **Gateway Port**. It is not a product-domain identity.

The gateway owns generic transport concerns such as:

- provider credentials and authentication;
- provider protocol/request transformation;
- streaming transport;
- physical request forwarding;
- retry/load balancing among business-equivalent deployments inside one selected Employment route;
- generic gateway rate limits/budgets/physical usage evidence where supported.

V2 is gateway-neutral. **LiteLLM Proxy is the reference implementation** because it already provides broad provider normalization, OpenAI-compatible APIs, routing, and usage/spend infrastructure. **CPA is the current compatibility adapter**, not a north-star architectural dependency. Special providers may remain behind CPA or another adapter when useful.

The gateway must not silently select another Employee or cross an Employment boundary; those are business decisions.

### 4.3 AI Workforce Domain Service

The V2 domain service owns organizational workforce policy and durable business state. It is the evolution of the currently named Model Control Plane, with a deliberately smaller infrastructure scope.

It owns:

- WorkScopes, Roles, PositionTemplates, Positions and relations;
- Suppliers, SupplierModels, durable Employees and Employment history;
- capabilities, qualifications and requirements;
- StaffingRules, Appointments, constraints and DispatchDecisions;
- DutySessions, StaffingSegments and runtime correlation;
- business route policy that chooses an Employment for a selected Employee;
- InvocationAttempt correlation and business Usage attribution;
- allocated cost, market value, career statistics and audit history;
- gateway-independent events and projections.

It deliberately does **not** own a generic provider gateway, provider credential vault, protocol transformation, generic retries, or deployment load balancing. Those capabilities are consumed through Gateway Ports.

### 4.4 Hermes AI Office

Hermes AI Office is the operator-facing control surface.

It owns:

- visualization of teams, runs and execution nodes;
- visualization of model workforce and capacity;
- operator actions that are safe to expose;
- unified navigation between execution state and model state;
- projections optimized for human understanding.

It is not the source of truth for execution or provider credentials. It reads authoritative state from Hermes/Bridge and the Model Control Plane and issues explicit commands back to them.

## 5. Stable domain model

The authoritative detailed model is [`DOMAIN-MODEL-V2.md`](DOMAIN-MODEL-V2.md). This PRD uses the following business vocabulary.

### 5.1 WorkScope and Profile compatibility

A **WorkScope** is a durable area where work belongs: a project, responsibility area, or long-lived operating context such as `memoflow`, `bodysense`, `default`, or `infra`.

A Hermes Profile is treated as a compatibility/runtime concept composed primarily of:

```text
WorkScope + Profile Lead Position + Hermes runtime configuration
```

The WorkScope persists even when no process, Position duty, or model call is active.

### 5.2 Position

A **Position** is a job/seat in the AI organization. Examples include Profile Lead, Researcher, Reviewer, Codex Developer, and OpenCode Developer.

Position describes responsibility, requirements, runtime policy, and organizational relations. Hermes Profile/Subagent/Codex/OpenCode are runtime forms used by Positions; they are not employee identities.

### 5.3 Supplier, ModelDefinition, and SupplierModel

A **Supplier** is the external workforce provider, such as OpenCode, Kiro, a direct API provider, or an aggregator. `Provider` remains a legacy implementation term where needed.

A **ModelDefinition** is the canonical model identity independent of supplier.

A **SupplierModel** is that model as represented by one Supplier, including supplier-specific aliases and characteristics.

### 5.4 Employee

An **Employee** is the durable workforce identity:

```text
Employee = Supplier × SupplierModel
```

For example, `DeepSeek V4 Flash @ OpenCode` is one Employee.

Changing plan, subscription, account, API key, or Channel does not create a new Employee if Supplier + SupplierModel are unchanged. The same canonical model from another Supplier is a different Employee.

### 5.5 SupplyAgreement, Employment, ModelOffering

A **SupplyAgreement** is a concrete subscription/account/contract owned by this organization.

An **Employment** is the time-bounded fact that a SupplyAgreement currently or historically grants the organization access to one Employee.

A **ModelOffering** records the commercial/technical entitlement by which a Plan or SupplyAgreement exposes a SupplierModel.

This distinction allows one Employee to have a continuous career history across cancellation, dormancy, re-subscription, plan changes, and multiple concurrent accounts.

### 5.6 Channel and CapacityPool

A **Channel** is only a technical access route: CPA upstream, OAuth route, base URL/credential route, or similar.

A **CapacityPool** models shared scarcity such as monthly tokens, requests, credits, or concurrency shared by multiple Employees under one agreement.

Neither Channel nor CapacityPool defines Employee identity.

### 5.7 Staffing and actual work

The system separates four facts:

- **StaffingRule** — reusable policy such as "this Employee is PRIMARY for all Profile Lead Positions";
- **Appointment** — historical/current organizational fact that an Employee holds a Position;
- **DispatchDecision** — auditable decision selecting who should actually staff a concrete duty;
- **StaffingSegment** — the time interval during which an Employee actually staffs a DutySession.

A **DutySession** is one activation of a Position during a Run. The DutySession survives employee failover; StaffingSegments record who staffed it over time.

### 5.8 Task, Run, runtime, and usage

A **Task** is durable work intent. A **Run** is one attempt to fulfill it.

A **RuntimeSession** is the technical shell—Hermes Profile, Subagent, Codex, OpenCode, browser, terminal, and so on—used by a DutySession.

A logical **ModelInvocation** may have multiple **InvocationAttempts** because of retries, Channel changes, Employment changes, or Employee failover.

Each **UsageEntry** records the actual Employee, Employment, SupplyAgreement, Channel, Position, DutySession, Run, tokens, and cost/value dimensions used by the concrete attempt.

## 6. Critical distinctions

The product must preserve these distinctions even if the UI uses a playful employee/office metaphor:

```text
Position != Employee != RuntimeSession != Channel
Appointment != StaffingSegment != DispatchDecision
Employee identity != SupplyAgreement identity
```

The key identity rule is:

```text
Employee = Supplier × SupplierModel
```

The key temporal rules are:

```text
Appointment = "this employee holds this job"
Employment  = "this commercial relationship lets us use this employee"
DutySession = "this job is active for this run"
StaffingSegment = "this employee is actually working this duty during this interval"
```

An Employee may remain appointed while temporarily `DORMANT` because all Employments ended. Re-subscribing to the same SupplierModel restores an Employment for the same Employee instead of creating a new career identity.

## 7. Core business workflows

### 7.1 Observe current work

Operator opens Hermes AI Office.

The system shows:

- Profiles and their current workload;
- active Runs;
- Execution Nodes and parent/child relationships;
- current task/action/state;
- runtime/model where known;
- blocked or waiting states;
- recent completion/failure transitions.

The operator should not need to inspect Hermes logs to understand current activity.

### 7.2 Understand model workforce and capacity

Operator opens the model workforce view.

The system shows:

- Suppliers and SupplierModels;
- durable Employees supplied by each Supplier;
- Employee cooperation state (`EMPLOYED`, `DORMANT`, retired/archived where relevant);
- current and historical Employments / SupplyAgreements;
- Channels and health;
- CapacityPools and remaining quota;
- effective actual/allocated/market value;
- Positions currently appointed to each Employee;
- work the Employee is actually staffing now;
- career usage and role-aware performance history.

### 7.3 Add or restore model supply

Operator supplies or imports a commercial/technical access path: plan/account metadata, protocol, base URL, credential material, and model discovery information.

Expected flow:

1. Secret is forwarded directly to the gateway-management boundary and is not persisted in UI state or business event history.
2. SupplyAgreement/Channel is created or reconciled according to the external entitlement.
3. Channel is tested before routing is enabled.
4. Discovery resolves SupplierModel identities.
5. Existing Supplier + SupplierModel reuses the same Employee; plan/account changes do not create a duplicate Employee.
6. Current Employment records are created/reconciled for Employees enabled by the agreement.
7. CapacityPools are discovered/configured where quota is shared.
8. Employees become routable for Positions only when qualification, Appointment/policy, Employment, Channel, protocol, health, and capacity all allow it.

Failure must leave the commercial/technical record visible but inactive with a reason; it must not silently delete Employee career history.

### 7.4 Fill a Position

A Position has requirements, runtime policy, Appointments, and staffing constraints.

The control plane evaluates candidate Employees according to:

1. qualification against Position requirements;
2. hard staffing constraints;
3. Appointment eligibility/class/priority;
4. Employee cooperation state;
5. at least one active/routable Employment;
6. Channel/protocol/health compatibility;
7. CapacityPool availability;
8. soft constraints and quality/reliability/cost/latency/utilization policy.

The resulting **DispatchDecision** records the selected Employee and rejection reasons for alternatives. Invocation routing then selects the concrete Employment + Channel used for each physical attempt.

Hermes and coding clients should consume stable Position aliases where possible rather than embedding concrete upstream credentials or employee routes.

### 7.5 Handle degradation and failover

When an Employment, Channel, CapacityPool, or Employee becomes temporarily unroutable:

1. health/capacity/cooperation state changes without deleting the Employee;
2. retries may stay on the same Employee and route;
3. routing may switch Channel within the same Employment;
4. routing may switch to another Employment for the same Employee;
5. if needed, Dispatch selects another Employee for the Position;
6. StaffingSegment/InvocationAttempt history records the transition;
7. UI explains the reason and operator actions remain available.

Temporary cooldown, quota exhaustion, operator quarantine, SupplyAgreement suspension, Employee dormancy, and true Employee retirement are distinct states.

### 7.6 Attribute usage and cost

Every model usage event should be attributed as deeply as the available identity allows.

Three financial concepts remain separate:

- Actual Cost: money actually charged for metered usage.
- Allocated Cost: a share of subscription/fixed cost assigned to usage.
- Market Value: estimated counterfactual value based on configured model pricing.

The UI should never collapse these into one ambiguous "cost" number.

## 8. Product views

### 8.1 Office view

Purpose: ambient understanding of current execution.

Shows people/process metaphor, areas, activity and state transitions.

This view optimizes for situational awareness, not dense administration.

### 8.2 Organization view

Purpose: understand formal structure and relationships.

Shows:

- WorkScopes / Profile compatibility views;
- Positions and Position relations;
- Runs and DutySessions;
- Employees currently staffing each duty;
- RuntimeSessions and activity;
- workforce summary associated with organizational roles.

This is the main bridge between execution and model-management concepts.

### 8.3 Operations view

Purpose: high-density troubleshooting and supervision.

Shows tabular, filterable state for tasks, runs, nodes, errors, waits, tokens, cost and timing.

### 8.4 Workforce and Suppliers views

Purpose: separate "who works here" from "where our workforce comes from."

The **Workforce** view is Employee-centric: durable Employees, cooperation state, Appointments, actual current work, career usage and performance.

The **Suppliers** view is HR/commercial-centric: Suppliers, SupplierModels, Plans, SupplyAgreements, Employments, CapacityPools and mapped Gateway/Channel evidence. Technical routes without explicit commercial identity appear as unclassified infrastructure evidence and never become Suppliers/Employees by naming convention.

These are first-class product areas in the AI Company Console rather than panels appended to the Hermes runtime view.

## 9. Business invariants

The following rules are stable product contracts; the detailed architecture invariants live in Domain Model V2.

1. WorkScope/Profile context is not an active process or employee.
2. Position is a job, not a model name or runtime process.
3. Employee identity is `Supplier × SupplierModel`.
4. Plan, SupplyAgreement, Employment, Channel, account, and credential changes do not create a new Employee when Supplier + SupplierModel are unchanged.
5. Employment, Appointment, actual StaffingSegment, and runtime identity are separate facts.
6. Current work is derived from active DutySessions/StaffingSegments, not from Appointment alone.
7. An Employee may be appointed while temporarily dormant/unroutable.
8. Model transport is provided through a replaceable Gateway Port; LiteLLM is the V2 reference gateway and CPA is a compatibility adapter. The Office never handles raw provider secrets.
9. Hermes remains authoritative for execution observations; the Office is a projection/control surface rather than an execution database.
10. Usage remains attributable to Employee career and to the concrete Employment/Agreement/Channel actually used.
11. Historical Appointment, Employment, Staffing, Run, Usage, and Evaluation records are retained for audit/statistics.
12. Health, quota, cancellation, or contract expiry must never silently delete an Employee identity or career history.
13. Destructive Supplier/Channel/credential operations require explicit, auditable behavior appropriate to their risk.

## 10. Current implementation mapping

Current production services on oracle2:

- Hermes native dashboard: `127.0.0.1:9119`
- Hermes Office Bridge: `127.0.0.1:8787`
- Hermes Pixel Office: `127.0.0.1:3100`
- Model Control Plane: `127.0.0.1:8320`
- CPA: `127.0.0.1:8317`

Current data path:

```text
Hermes execution
  -> Hermes dashboard / runtime state
  -> Office Bridge
  -> HermesProvider
  -> Organization projection
  -> Hermes AI Office

CPA
  <-> gatewayctl
  <-> Model Control Plane
  -> workforce projection / events
  -> Hermes AI Office
```

The two sides currently meet in the UI, but deeper Run/Position/Employee/Employment attribution is still incomplete.

## 11. Current gaps

### 11.1 No single product source of truth document

Existing documents are feature or implementation oriented. Product semantics are distributed across `CONTEXT.md`, `SPEC-*`, bridge specs, and `model-control-plane/README.md`.

### 11.2 Execution and model workforce are only loosely joined

The UI can show both execution state and model workforce state, but a Run is not yet reliably linked end-to-end to DutySession, Employee, Employment, and concrete InvocationAttempt/Usage facts.

### 11.3 Position semantics are not yet fully user-facing

Positions exist in the control plane, but the operator experience still exposes Channels/legacy Workers more strongly than stable Positions, Employees, Employments, and current DutySessions.

### 11.4 Task/Run semantics are still derived from several sources

Hermes session state, kanban state, spawned process state and UI state still require reconciliation. There should eventually be one explicit lifecycle model for Task and Run.

### 11.5 Management UI is early

The current `ModelWorkforcePanel` proves the integration but is not yet a complete operational product surface for contracts, quotas, policy, history, and incident handling.

### 11.6 Business events and audit history need stronger semantics

Control-plane events exist, but operator-level explanations such as "why did this duty switch Employee, Employment, or Channel?" should become first-class.

## 12. Next product milestone

The next milestone should not primarily add more visual features. It should make one complete V2 business loop correct and observable:

> A user request becomes a Run in a WorkScope; the Run activates a Position as a DutySession; Dispatch chooses a durable Employee; the Employee is usable through a concrete current Employment and Channel; physical model attempts and Usage are attributed back to Employee career + Employment/Agreement + Position + Run; and the operator can see who worked, why they were selected, which commercial route was used, and what it cost.

This vertical slice establishes the core organizational and workforce semantics needed for later automation.

### Acceptance for the milestone

For one real Hermes request:

1. The Office identifies WorkScope/Profile compatibility context and Run.
2. The Run opens one or more DutySessions for concrete Positions.
3. Dispatch selects a stable Employee and records candidate reasons.
4. The Employee may have multiple Appointments and multiple historical/current Employments.
5. Invocation routing records the concrete Employment + SupplyAgreement + Channel used.
6. Usage is attributed to Run + Position + DutySession + Employee + Employment/Agreement + Channel.
7. The UI can distinguish current Appointment, current work, Employee lifetime history, and Employment history.
8. Channel failover within one Employee does not create a new Employee.
9. Ending and later restoring supply for the same SupplierModel reuses the same Employee identity.
10. Changing staffing or quarantining a route causes a visible, auditable re-resolution/failover.

## 13. Non-goals for the next milestone

Do not expand scope yet into:

- generalized enterprise multi-user RBAC;
- arbitrary workflow builders;
- autonomous financial purchasing;
- replacing Hermes orchestration;
- replacing generic gateway infrastructure already provided by LiteLLM or another selected gateway;
- a full billing platform;
- complex game mechanics unrelated to operational understanding;
- multiple competing business-domain control planes; gateway adapters are intentionally replaceable.

## 14. Documentation hierarchy going forward

The documentation hierarchy is now explicit:

1. [`HERMES-AI-OFFICE-PRD.md`](HERMES-AI-OFFICE-PRD.md) — product goals, user outcomes, scope and product invariants.
2. [`DOMAIN-MODEL-V2.md`](DOMAIN-MODEL-V2.md) — authoritative business identity, lifecycle, staffing, execution, history and archival semantics.
3. [`implementation-v2/README.md`](implementation-v2/README.md) — implementation-preparation package index.
4. `implementation-v2/ARCHITECTURE.md` — service/state ownership and protected runtime boundaries.
5. `implementation-v2/PERSISTENCE.md` — additive V2 schema and V1-to-V2 data mapping.
6. `implementation-v2/API-CONTRACT.md` — `/api/v2` command/query contract and compatibility rules.
7. `implementation-v2/EVENT-CONTRACT.md` — durable business events, ordering, replay and correlation.
8. `implementation-v2/WORKFLOWS.md` — end-to-end business behavior and failure/recovery scenarios.
9. `implementation-v2/PROJECTIONS.md` — Office/Organization/Operations/Workforce read models and animation semantics.
10. `implementation-v2/MIGRATION.md` — non-destructive V1-to-V2 strangler migration and rollback.
11. `implementation-v2/ROADMAP.md` — phased implementation sequence and execution-ready ticket boundaries.
12. `implementation-v2/VERIFICATION.md` — acceptance evidence, migration reconciliation and regression matrix.
13. `SPEC-*` — historical or narrowly scoped implementation specifications; they must not redefine V2 core terms.

Implementation work should cite the exact authoritative document/section for every domain or compatibility decision instead of restating it ad hoc.

## 15. Remaining bounded product decisions

The core domain shape is no longer blocked by these decisions. They should be resolved during the relevant implementation phase and recorded without changing Employee/Position/Employment identity semantics:

1. Exact capability score scales, confidence model, and how measured performance updates qualification evidence.
2. Exact StaffingRule/StaffingConstraint selector DSL and precedence rules.
3. Which Position classes require operator approval before L3/L4 Employee failover, especially when cost/trust changes materially.
4. Default optimization objective order among quality, reliability, latency, prepaid quota utilization, and marginal cost.
5. Subscription cost allocation policy by SupplyAgreement: token-based, request-based, active-time-based, or configurable.
6. Retention/compaction duration for high-volume raw ActivityEvents and InvocationAttempt diagnostics; business history remains retained.
7. Whether Task remains primarily Hermes/Kanban-owned or a later control-plane task registry becomes authoritative; Run/Duty attribution contracts must remain stable either way.
8. Which supply/staffing commands Hermes may perform autonomously versus operator-only commands (for example quarantine, new Employment activation, Appointment changes).
9. Whether RUN_SCOPED Positions are persisted immediately or provisionally materialized when a Run starts.
10. Whether a future ModelInvocation may intentionally split work across multiple Employees beyond retry/failover.

Until these are decided, implementation should preserve current behavior and avoid embedding assumptions that make these choices expensive to change.

## Implementation baseline — 2026-08-16

The product is implemented around the V2 AI-company semantics: organizational positions are distinct from model Employees; one Employee may hold multiple Appointments; actual work attribution requires a StaffingSegment; Hermes/Subagent/Codex/OpenCode are runtime/position execution mechanisms rather than Employee identity. Purpose-built Office/Workforce projections expose this distinction. The V1 Worker/Assignment compatibility runtime and public facade were retired on 2026-08-16; historical V1 database evidence is retained without remaining authoritative.
