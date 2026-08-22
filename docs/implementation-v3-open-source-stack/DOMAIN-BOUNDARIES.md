# V3 Domain Boundaries and Source-of-Truth Model

## 1. Goal

V3 deliberately avoids a large custom domain. The model contains only concepts that are uniquely required to connect Hermes software-development semantics to upstream execution/model/observability systems.

The test for adding an entity is:

> If OpenHands, LiteLLM, Langfuse, Hermes, or Git already owns this fact authoritatively, AI Office should reference it rather than recreate it.

## 2. Bounded contexts

### Hermes Context

Owns:

- Hermes profile/session/turn identity;
- user request and conversation history;
- memory available to the Brain;
- semantic decision to enter/continue/stop a workflow.

### Development Workflow Context

Owns:

- phase names and semantics;
- entry/exit criteria;
- session reuse/freshness policy;
- read/write safety policy;
- parallelism rules;
- phase result interpretation guidance.

It does not persist a second durable scheduler unless real requirements later justify one.

### AI Office Policy Context

Owns:

- `ExecutionPolicy`;
- `ModelClass` business names;
- `ExecutionBackendPolicy`;
- provider economic preferences not represented by LiteLLM itself;
- `ExecutionLink` correlation records.

### OpenHands Execution Context

Owns:

- conversation ID;
- agent kind/settings;
- run state;
- workspace lifecycle;
- execution events;
- pause/resume/cancel behavior;
- agent final result.

### LiteLLM Gateway Context

Owns for managed-lane requests:

- provider/model deployment registry;
- deployment health/cooldown;
- actual route attempt;
- retry/fallback behavior;
- request usage/cost evidence;
- gateway auth, budgets and rate limits where enabled.

### Langfuse Observability Context

Owns:

- trace/observation storage;
- token/cost analytics;
- latency/TTFT/throughput analytics when present;
- tag/metadata filtering;
- observability dashboards and Metrics API.

### Git Context

Owns:

- repository content;
- worktree/branch/commit identity;
- diff;
- merge history.

## 3. Minimal custom concepts

### `DevelopmentPhase`

Stable enum-like business concept:

```text
INVESTIGATE_PLAN
IMPLEMENT
IMPLEMENT_FIX
VERIFY_REVIEW
FINALIZE
```

`FINALIZE` may remain a Hermes-only phase with no external execution.

### `ModelClass`

A business-level capability name, not a vendor model ID.

Initial classes:

```text
planning-premium
implementation-efficient
implementation-premium
review-premium
fast-general
```

A ModelClass can map to multiple LiteLLM deployments and may change its underlying providers without changing the Development Skill.

### `ExecutionBackend`

Logical coding-agent/runtime target:

```text
openhands-builtin
codex-acp
opencode-acp
claude-code-acp
custom-acp:<name>
external-adapter:<name>
```

DSH remains `external-adapter:dsh` until it has a proven ACP-compatible server path.

### `TransportMode`

```text
LITELLM_MANAGED
NATIVE_SUBSCRIPTION
```

This is explicit because usage authority and provider-routing capability differ materially between the two modes.

### `ExecutionPolicy`

Example conceptual value:

```yaml
phase: INVESTIGATE_PLAN
backend_candidates:
  - codex-acp
  - opencode-acp
model_class: planning-premium
transport_preference:
  - LITELLM_MANAGED
  - NATIVE_SUBSCRIPTION
workspace_mode: read_oriented
session_policy: fresh_then_continue_within_phase
```

### `ExecutionLink`

Correlation only:

```text
execution_id
Hermes refs
phase/project refs
OpenHands conversation ref
Langfuse trace ref
selected backend/model class/transport
```

It must not become a hidden copy of upstream lifecycle state.

## 4. Concepts intentionally removed from V3 custom domain

The following V2-style concepts are not needed in the core V3 domain unless a future requirement proves otherwise:

```text
Employee
Employment
Appointment
DutySession
StaffingSegment
InvocationAttempt ledger
UsageEntry ledger
ProviderConnection protocol implementation
RuntimeAccessProfile lifecycle
custom Channel health state
```

Some names may remain in historical V2 storage/UI during migration, but V3 must not preserve them merely for compatibility.

## 5. Identity mapping

Recommended identity graph:

```text
Hermes session/turn
       │
       ▼
AI Office execution_id
       │
       ├── OpenHands conversation_id
       │
       ├── Langfuse trace_id
       │
       ├── Git workspace/branch ref
       │
       └── LiteLLM request metadata execution_id
```

`execution_id` is the only custom cross-system identity that must be globally stable.

## 6. Lifecycle ownership matrix

| Lifecycle                  | Owner                                 | AI Office behavior                     |
| -------------------------- | ------------------------------------- | -------------------------------------- |
| Hermes turn                | Hermes                                | reference only                         |
| workflow semantic phase    | Hermes + Development Skill            | invoke phase tool and interpret result |
| coding conversation/run    | OpenHands                             | start/query/cancel through adapter     |
| workspace                  | OpenHands/workspace provisioner + Git | reference/display only                 |
| model request              | LiteLLM or native agent               | observe only                           |
| trace                      | Langfuse                              | query/link only                        |
| provider cooldown/fallback | LiteLLM                               | query/display, never duplicate writer  |
| code branch/commit         | Git                                   | query/display only                     |

## 7. Reconciliation principle

AI Office UI read models are disposable projections.

If the local correlation/cache database is lost, the system should be able to recover most useful history from:

- OpenHands conversation IDs/events;
- Langfuse traces tagged with execution/project/phase IDs;
- Git branches/workspaces;
- Hermes conversation logs if needed.

Loss of AI Office cache must not corrupt agent runs or provider state.

## 8. Accounting semantics

V3 distinguishes three different values:

```text
usage            = tokens/units actually consumed
provider_cost     = cost reported/calculated for the model request
marginal_cost     = user's effective incremental economic cost
```

For PAYG API routes these may be similar. For free quotas or subscriptions they are not.

`commercial_class` is AI Office policy metadata:

```text
FREE
SUBSCRIPTION
PAYG
```

LiteLLM/Langfuse should still record raw usage and provider-style cost evidence. AI Office policy may separately rank routes by commercial class and remaining quota.

## 9. UI language

Avoid pretending a model/provider is a durable human employee.

Recommended terminology:

```text
Work Slot / Phase
Execution
Agent Backend
Logical Model Class
Observed Provider Route
```

A friendly "AI Office" visualization may still animate workers occupying positions, but the underlying model must remain execution-based rather than inventing durable employee identity.
