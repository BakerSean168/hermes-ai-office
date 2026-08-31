# ADR-001: Durable AI Supervisor over the Deterministic Engineering Kernel

- Status: Proposed
- Date: 2026-08-31
- Decision owners: Pixel Agent / AI Office
- Target version: Pixel Agent V4
- Supersedes: the one-shot-only interpretation of `ORCHESTRATE` in V3; it does not replace the V3 execution kernel

## Context

Pixel Agent V3 already provides the hard parts that ordinary coding-agent sessions usually lack:

- durable plans, batches, work items, attempts, and event history;
- writer admission, isolated workspaces, exact Git baselines, result verification, and batch integration;
- independent implementation review, repair, re-review, aggregate review, and delivery gates;
- retry/fallback routing across OpenHands, ACP workers, LiteLLM-managed models, and provider-native reviewers;
- crash recovery and idempotent control-plane operations.

However, V3 places AI primarily *inside individual workflow nodes*. `ORCHESTRATE` is a one-shot, read-oriented OpenHands execution that emits an initial graph and then exits. After materialization, deterministic coordinators drive the plan. They can recover cases that have already been encoded in the state machine, but a novel failure normally becomes `BLOCKED` and requires an operator or ChatGPT Web to diagnose it.

This creates a mismatch with the intended product experience: a user delegates an engineering objective to Pixel and expects an AI engineering lead to keep observing, diagnosing, replanning, and dispatching subordinate agents until the objective is complete or a genuine external/safety gate remains.

The current split has produced two practical symptoms:

1. recoverable infrastructure, adapter, migration, or control-plane defects often appear as ordinary plan blockers;
2. ChatGPT Web informally acts as the missing plan-level supervisor, which makes autonomy depend on the conversation that launched or inspected the plan.

At the same time, replacing the deterministic kernel with one unconstrained long-running OpenHands conversation would regress the strongest properties of V3: exact provenance, independent review, single-writer safety, bounded costs, crash recovery, and auditable delivery.

## Decision

Pixel Agent V4 will use a **deterministic kernel plus a durable AI supervisor**.

### 1. The deterministic kernel remains the sole authority for side effects

The kernel continues to own:

- durable state transitions;
- workspace and writer leases;
- execution creation and correlation;
- Git provenance and ancestry gates;
- review independence;
- budget and route authorization;
- PR/check/merge/release gates;
- cancellation, rollback, and safety holds.

An AI response alone never changes a plan, writes to a repository, starts a worker, merges a PR, deploys the control plane, or edits policy.

### 2. Every eligible plan receives one durable plan supervisor

The supervisor is a persistent, read-oriented OpenHands conversation associated with a stable `supervisorId` and `planId`. It observes a bounded projection of plan events and may propose typed actions through Pixel-owned tools.

The supervisor is not a writer and receives no direct write access to project repositories. It may inspect approved read snapshots and request subordinate work through the control plane.

### 3. Supervisor activity is event-driven, not a permanently consuming loop

The supervisor sleeps when no decision is required. It wakes on meaningful events, including:

- a new delegated objective;
- a terminal implementation or review result;
- an unknown or repeated failure;
- a repair/fallback limit;
- a stalled plan threshold;
- delivery or CI failure;
- an external PR or Jules result;
- a resource becoming available;
- completion/failure of a child system-repair plan.

This preserves continuity without paying tokens merely to poll.

### 4. Supervisor decisions use a versioned typed action protocol

The supervisor may propose actions such as:

- continue or retry an existing execution;
- switch an authorized backend/model class;
- request independent review;
- create a scoped repair;
- revise the remaining plan graph without rewriting accepted history;
- create a child plan for a control-plane/infrastructure defect;
- adopt an external PR candidate for review;
- pause for a resource budget;
- park a genuine external-machine/user-secret gate;
- escalate a product or safety decision.

The kernel validates preconditions and either executes the action idempotently or records a structured rejection that the supervisor can reconsider.

### 5. Plan graph changes are append-only revisions

The supervisor may replan remaining work, but it cannot delete or rewrite completed evidence. A new graph version records:

- its parent version;
- the triggering observations;
- superseded pending work;
- preserved completed work and accepted revisions;
- newly introduced dependencies and acceptance criteria.

### 6. Control-plane self-repair uses parent/child plans

When the supervisor classifies a blocker as a Pixel/control-plane defect, it creates a child system-repair plan targeting the appropriate repository. The parent plan enters `WAITING_FOR_SYSTEM_REPAIR`, referencing the child plan. The child must pass normal implementation, independent review, tests, safe deployment, and health checks. Only then may the parent automatically reconcile.

The supervisor may never patch its own running control plane directly or self-certify the repair.

### 7. `BLOCKED` becomes a last-resort state

V4 distinguishes:

- `RECOVERING`: an autonomous recovery action is in progress;
- `WAITING_FOR_SYSTEM_REPAIR`: a child repair plan owns the blocker;
- `WAITING_FOR_RESOURCE`: an authorized provider/credit pool is unavailable;
- `WAITING_FOR_EXTERNAL_EVIDENCE`: native machine, secret, account, or human evidence is required;
- `SAFETY_HOLD`: a deterministic policy refuses autonomous continuation;
- `BLOCKED`: no safe recovery action remains after diagnosis.

### 8. Autonomous improvement and external PRs reuse the same kernel

Repository maintenance programs, Jules tasks, Anti-Gravity workers, and GitHub PRs enter the same implementation/review/repair/integration/delivery pipeline. External agents are execution sources, not authorities. Their code is accepted only through exact-source provenance, independent review, project checks, and merge policy.

## Consequences

### Positive

- The system can reason about novel failures instead of requiring every recovery path to be hard-coded in advance.
- The durable plan, not a ChatGPT conversation, remains the continuity boundary.
- OpenHands gains the intended engineering-lead role without becoming an untracked second control plane.
- External PR automation and continuous project improvement share one governance model.
- Self-repair becomes explicit, reviewable, and reversible.
- `BLOCKED` frequency should fall while safety and provenance remain fail-closed.

### Costs and risks

- New durable schema, action validation, event projection, and supervisor lifecycle code are required.
- A persistent supervisor can loop or spend excessively without budgets, cooldowns, and duplicate-decision suppression.
- Incorrect AI classification may create unnecessary child plans or graph revisions; deterministic validation and bounded autonomy are mandatory.
- Self-improvement can become unsafe if it mutates policy or deployment without independent evaluation. V4 therefore allows proposal and child-plan execution, not direct self-modification.

## Alternatives considered

### Keep V3 workflow-only orchestration

Rejected as the long-term product model. It is auditable but turns novel recoverable failures into operator work and makes ChatGPT Web a de facto supervisor.

### Give one long-running OpenHands conversation unrestricted control

Rejected. It cannot by itself guarantee exact Git lineage, review independence, bounded concurrency, crash-safe side effects, or protected delivery.

### Allow nested agents to launch each other invisibly

Rejected. Pixel must remain the single orchestration authority. Supervisor tools may request subordinate agents, but every launch receives a durable execution identity and kernel authorization.

### Require ChatGPT Web approval between phases

Rejected as a default. ChatGPT Web remains an operator and exceptional escalation surface, not a mandatory planner/reviewer.

## Acceptance criteria

V4 is accepted only when:

1. a plan supervisor survives service and OpenHands restarts without losing its observation cursor;
2. the supervisor can resolve a previously unknown but recoverable blocker through typed actions without bypassing deterministic gates;
3. duplicate observations cannot create duplicate workers, repairs, child plans, or merges;
4. completed graph history and exact Git/review provenance remain immutable;
5. resource-unavailable programs pause without silently falling back to disallowed paid models;
6. a control-plane defect can create, review, deploy, and verify a child repair plan before the parent resumes;
7. a Jules/third-party PR can be reviewed, repaired, re-reviewed, and auto-merged only at the exact approved head SHA;
8. genuine native-machine, secret, policy, and safety gates remain explicit and cannot be hallucinated away.
