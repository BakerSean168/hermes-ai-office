# Hermes AI Office — Product & Domain Requirements

Status: Draft v0.1 for business alignment
Date: 2026-08-16
Scope: Hermes AI Office, Model Control Plane, and their integration with Hermes runtimes and CPA

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

- Team / Profile
- Position / Role
- Worker
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

### 4.2 Model data plane — CPA

CPA owns forwarding model requests to upstream providers.

It owns:

- upstream protocol adaptation;
- provider credentials and auth pools;
- request forwarding;
- provider-specific retry/session behavior;
- low-level model aliases and routing primitives.

CPA should not become the product-level source of truth for organizational roles, business cost allocation, or workforce semantics.

### 4.3 Model control plane

The Model Control Plane owns model workforce policy and durable business state.

It owns:

- provider/channel registry;
- model definitions;
- model workers;
- contracts, quotas and pricing;
- health and eligibility;
- positions and assignments;
- routing policy and resolution;
- usage attribution and accounting;
- control-plane event history.

It translates business policy into CPA routing actions through an adapter such as `gatewayctl`.

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

The system should distinguish organizational identity from technical implementation identity.

### 5.1 Team / Profile

A Profile is a stable Hermes operating context for a project, workflow, or responsibility area.

Examples:

- `memoflow`
- `bodysense`
- `default`
- `infra`

A Profile persists even when no process or model is currently active.

A Profile is not a worker and is not a model.

### 5.2 Position

A Position is a stable job that needs to be filled by model capacity.

Examples:

- Hermes Brain
- General Coder
- Reviewer
- Researcher
- Fast Utility Model

A Position describes what capability the organization needs. Clients should ideally target a Position rather than a concrete provider/model pair.

### 5.3 Provider

A Provider is the external organization or service supplying model capacity.

Examples include OpenAI, Anthropic, xAI, or an aggregator.

Provider identity alone is insufficient to describe usable capacity.

### 5.4 Channel

A Channel is one concrete commercial/technical route to a provider.

It may represent:

- one API account;
- one OAuth pool;
- one subscription;
- one aggregator route;
- one sponsored/free endpoint.

A Channel has its own protocol, health, quota, contract, priority, and cost behavior.

### 5.5 Model Definition

A Model Definition represents a model family/capability independently of the route used to access it.

Examples:

- `deepseek-v4-flash`
- `claude-sonnet-*`
- `gpt-*`

### 5.6 Model Worker

A Model Worker is the schedulable unit of model capacity.

Identity:

`Worker = Channel × Model Definition`

The same model through two channels creates two Workers because those Workers can differ in cost, reliability, latency, quota, and contract terms.

### 5.7 Assignment

An Assignment links a Worker to a Position.

It answers:

- Is this Worker eligible for this Position?
- Is it active, standby, disabled, or quarantined?
- What priority and weight does it have?

Exactly one Worker should normally resolve as active for a Position at a point in time, while other eligible Workers remain available as fallback candidates.

### 5.8 Task

A Task is a durable unit of intended work.

It exists independently of a particular execution process.

A task can be queued, ready, running, blocked, completed, failed, or cancelled.

### 5.9 Run

A Run is one concrete execution attempt of a Task or user request.

A Run belongs to a Profile and can contain multiple Execution Nodes.

Retrying the same Task creates another Run rather than mutating history into a single ambiguous execution.

### 5.10 Execution Node

An Execution Node is one active or historical runtime worker participating in a Run.

Examples:

- Hermes sub-agent
- OpenCode process
- Codex process
- browser worker
- terminal worker

Execution Node identity is runtime identity, not model workforce identity.

A single Execution Node may use one or more Model Workers over its lifetime.

### 5.11 Usage Record

A Usage Record attributes model consumption to the relevant execution/business dimensions.

Where available, it should link:

- Profile
- Position
- Run
- Execution Node
- Worker
- Channel
- Model Definition

This linkage enables meaningful cost and performance analysis instead of aggregate provider-only totals.

## 6. Critical distinction: execution workers vs model workers

The word "worker" currently appears in multiple parts of the system and must not remain ambiguous.

There are two different concepts:

1. Execution Worker / Execution Node: a process or agent doing work.
2. Model Worker: a schedulable model capacity unit (`Channel × Model`).

The UI may present both as "employees" metaphorically, but the domain and APIs must keep them separate.

Example:

An OpenCode Execution Node may be the "developer currently implementing feature X". During that Run it might call the `codex-general` Position, which resolves to a GPT model through one CPA Channel. If the active Assignment changes, the Execution Node continues to exist while its model Worker changes.

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

### 7.2 Understand model capacity

Operator opens the model workforce view.

The system shows:

- Providers;
- Channels;
- Workers available through each Channel;
- health and recent test state;
- quota/remaining capacity;
- contract type;
- effective cost/value;
- Positions currently served by each Worker;
- active and standby Assignments.

### 7.3 Add a new model supply channel

Operator supplies:

- display name;
- protocol;
- base URL;
- API key or credential material;
- model mapping;
- optional priority/weight.

Expected flow:

1. Secret is forwarded directly to the gateway-management boundary and is not persisted in UI state or control-plane event history.
2. Channel is created disabled by default.
3. Channel is tested.
4. Discovery updates the control plane.
5. Operator explicitly enables it, or a defined policy enables it after successful validation.
6. Workers become eligible for Position assignments.

Failure must leave the Channel visible but inactive, with a reason.

### 7.4 Fill a Position

A Position has required capabilities and routing protocol.

The control plane evaluates eligible Assignments according to:

1. enabled state;
2. health;
3. protocol compatibility;
4. capability/context requirements;
5. quota availability;
6. explicit Assignment priority;
7. quality/reliability/cost/latency policy;
8. prepaid quota reset pressure where applicable.

The resolved Worker is published through a stable logical alias such as `position:hermes-brain`.

Hermes and coding clients should consume stable Position aliases where possible rather than embedding concrete upstream provider credentials.

### 7.5 Handle degradation

When a Channel or Worker becomes unhealthy:

1. health state changes;
2. affected Worker becomes ineligible or reduced in score according to policy;
3. Position is reconciled;
4. another eligible Assignment becomes active when available;
5. an event is emitted;
6. UI shows the transition and reason;
7. operator may test, disable, quarantine, or restore the Channel.

The system must distinguish temporary request-level cooldown from operator-level quarantine.

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

- Profiles;
- Runs;
- Execution Nodes;
- parent/spawn/delegation/review relationships;
- model workforce summary associated with organizational roles.

This is the main bridge between execution and model-management concepts.

### 8.3 Operations view

Purpose: high-density troubleshooting and supervision.

Shows tabular, filterable state for tasks, runs, nodes, errors, waits, tokens, cost and timing.

### 8.4 Model workforce view

Purpose: manage external model capacity.

Shows Channels, model Workers, Position Assignments, health, quota, contract and pricing.

This view should ultimately be a first-class product area, not merely a panel embedded inside Organization.

## 9. Business invariants

The following rules should be treated as stable product contracts.

1. A Profile is not an active process.
2. A Position is not a model name.
3. A Model Worker is identified by Channel × Model Definition.
4. An Execution Node is not a Model Worker.
5. Secrets never flow into dashboard projections, event history, or browser persistence.
6. CPA remains the model request data plane; the control plane manages policy, not raw request execution.
7. Hermes remains the execution source of truth; the Office does not invent execution state.
8. The UI is a projection/control surface, not an authoritative database.
9. Explicit operator priority dominates heuristic scoring unless a safety/eligibility constraint rejects the Worker.
10. Historical Runs and Usage Records remain immutable enough for auditing; retries create new execution attempts.
11. Health failure must never silently delete a Channel or Worker.
12. Destructive provider/channel removal requires explicit confirmation and recoverable/auditable behavior.

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

The two sides currently meet in the UI, but deeper Run/Position/Worker attribution is still incomplete.

## 11. Current gaps

### 11.1 No single product source of truth document

Existing documents are feature or implementation oriented. Product semantics are distributed across `CONTEXT.md`, `SPEC-*`, bridge specs, and `model-control-plane/README.md`.

### 11.2 Execution and model workforce are only loosely joined

The UI can show both execution state and model workforce state, but a Run is not yet reliably linked end-to-end to the Position and Model Worker that served its requests.

### 11.3 Position semantics are not yet fully user-facing

Positions exist in the control plane, but the operator experience still exposes Channels/Workers more strongly than stable organizational jobs.

### 11.4 Task/Run semantics are still derived from several sources

Hermes session state, kanban state, spawned process state and UI state still require reconciliation. There should eventually be one explicit lifecycle model for Task and Run.

### 11.5 Management UI is early

The current `ModelWorkforcePanel` proves the integration but is not yet a complete operational product surface for contracts, quotas, policy, history, and incident handling.

### 11.6 Business events and audit history need stronger semantics

Control-plane events exist, but operator-level explanations such as "why did this Position switch Workers?" should become first-class.

## 12. Next product milestone

The next milestone should not primarily add more visual features. It should make one complete business loop correct and observable:

> A user request becomes a Run under a Profile, the Run consumes a stable Position, that Position resolves to a concrete Model Worker through policy, usage is attributed back to the Run/Position/Worker, and the operator can see why that Worker was selected and what it cost.

This vertical slice establishes the core organizational semantics needed for later automation.

### Acceptance for the milestone

For one real Hermes request:

1. The Office can identify the Profile and Run.
2. The Run has one or more Execution Nodes.
3. Model calls identify the logical Position used.
4. The control plane records the resolved Worker and Channel.
5. Usage is attributed to the Run and Position.
6. The UI can show "Run X used Position Y, resolved to Worker Z through Channel C".
7. The UI can explain the current active Assignment and major rejection/fallback reasons.
8. Changing an Assignment or quarantining the active Channel causes a visible, auditable re-resolution.

## 13. Non-goals for the next milestone

Do not expand scope yet into:

- generalized enterprise multi-user RBAC;
- arbitrary workflow builders;
- autonomous financial purchasing;
- replacing Hermes orchestration;
- replacing CPA request forwarding;
- a full billing platform;
- complex game mechanics unrelated to operational understanding;
- multiple control planes before the CPA adapter path is mature.

## 14. Documentation hierarchy going forward

Recommended documentation structure:

1. `docs/HERMES-AI-OFFICE-PRD.md` — product intent, domain, workflows, invariants.
2. `docs/ARCHITECTURE.md` — runtime topology, state ownership, APIs, event flows, persistence.
3. `docs/DOMAIN-MODEL.md` — precise entity schemas, lifecycle/state machines and identity rules.
4. `docs/WORKFLOWS.md` — operator workflows and error/recovery behavior.
5. `docs/ROADMAP.md` — milestones and product-level acceptance criteria.
6. `SPEC-*` — implementation tickets/specifications derived from the above.

Implementation specs should reference the product/domain documents and should not redefine core terms independently.

## 15. Open decisions requiring product alignment

These questions materially affect the next architecture phase:

1. Is a Position global across all Profiles, or can Profiles override/own their own Position definitions?
2. Should Hermes always call logical Position aliases, or only selected critical paths at first?
3. Is the Task entity owned by Hermes/kanban, or should the Office/control plane eventually own a separate durable task registry?
4. How much automatic failover is allowed without operator approval for expensive or lower-quality Workers?
5. What is the desired default objective order among quality, reliability, latency, prepaid quota utilization, and marginal cost?
6. Should subscription allocation be primarily token-based, request-based, active-time-based, or configurable per contract?
7. What historical retention period is required for Runs, usage, health and routing decisions?
8. Which actions are operator-only versus allowed to Hermes autonomously (enable, disable, quarantine, assignment changes)?

Until these are decided, implementation should preserve current behavior and avoid embedding assumptions that make these choices expensive to change.
