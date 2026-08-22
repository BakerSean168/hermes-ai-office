# AI Office V3 — Thin Facade and UI

## 1. Product redefinition

V3 changes AI Office from a broad "AI workforce platform" into a thin development-resource facade.

The new product answer to "what is AI Office?" is:

> **AI Office is the Hermes development execution policy and observability surface over OpenHands, LiteLLM and Langfuse.**

It tells Hermes what kind of worker/model path to use, correlates the resulting execution across systems, and shows the user what is working now.

## 2. What custom code remains

Only four areas are first-class custom product logic:

### 2.1 Development execution policy

```text
phase + complexity + risk + economics
  -> execution backend
  -> logical model class
  -> transport mode
  -> session/workspace policy
```

### 2.2 Hermes adapter

A small set of tools/API calls that let the Development Skill start, continue, query, and cancel a development execution.

### 2.3 Correlation index

A tiny durable mapping across:

```text
Hermes <-> execution_id <-> OpenHands <-> Langfuse <-> Git
```

### 2.4 AI Office Desktop UI/BFF

A read-oriented projection that aggregates active executions, logical policy decisions, provider/gateway health, and trace summaries.

## 3. What V3 explicitly removes

AI Office does **not** implement:

```text
custom agent scheduler
custom agent heartbeat protocol
custom ACP runtime
custom model protocol adapters
custom LLM proxy
provider request retry engine
provider load balancer
full provider credential vault
full token/cost ledger
custom trace database
custom workspace container runtime
```

OpenHands/LiteLLM/Langfuse own those concerns.

## 4. Proposed internal modules

```text
ai-office-v3/
  policy/
    development-policy
    provider-economics
    backend-capabilities

  correlation/
    execution-links

  adapters/
    openhands/
    litellm/
    langfuse/
    git/

  api/
    development-execution
    projections

  projections/
    active-work
    execution-history
    provider-summary
    usage-summary
```

This should stay small enough that a new developer can understand the entire custom domain quickly.

## 5. Policy input

A policy request should contain business semantics, not provider-specific transport details:

```text
phase
objective summary
project
complexity
risk
write access
parallelism
quality preference
budget preference
explicit agent/model override if user supplied one
```

## 6. Policy output

```text
ExecutionSelection
├─ backend_kind
├─ logical_model_class
├─ transport_mode
├─ workspace_mode
├─ session_policy
├─ reasons[]
└─ fallback_candidates[]
```

Provider API keys and concrete secrets are never part of this response.

## 7. Backend capability registry

Keep a small declarative registry:

```yaml
codex-acp:
  phases: [INVESTIGATE_PLAN, IMPLEMENT, VERIFY_REVIEW]
  native_subscription: true
  litellm_managed: conditional
  write_capable: true

opencode-acp:
  phases: [INVESTIGATE_PLAN, IMPLEMENT, VERIFY_REVIEW]
  native_subscription: true
  litellm_managed: true
  write_capable: true

openhands-builtin:
  phases: [INVESTIGATE_PLAN, IMPLEMENT, VERIFY_REVIEW]
  native_subscription: false
  litellm_managed: true
  write_capable: true
```

This is policy/configuration, not a worker implementation.

## 8. Provider economics registry

AI Office may maintain a small overlay that LiteLLM does not natively understand as personal business priority:

```yaml
sources:
  provider-a:
    commercial_class: FREE
    priority: 100

  provider-b-subscription:
    commercial_class: SUBSCRIPTION
    priority: 80
    quota_expires_at: ...

  provider-c-payg:
    commercial_class: PAYG
    priority: 20
```

The registry should reference LiteLLM deployment/group IDs, not duplicate endpoint credentials.

## 9. Correlation index schema

Suggested SQLite table for the first implementation:

```sql
CREATE TABLE execution_links (
  execution_id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  objective_summary TEXT NOT NULL,
  hermes_profile TEXT,
  hermes_session_id TEXT,
  hermes_turn_id TEXT,
  openhands_conversation_id TEXT,
  execution_backend TEXT NOT NULL,
  transport_mode TEXT NOT NULL,
  logical_model_class TEXT NOT NULL,
  langfuse_trace_id TEXT,
  workspace_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

If a cached terminal status is later added, it must be clearly non-authoritative.

## 10. Desktop page design

Recommended top-level V3 UI:

```text
AI Office
├─ Active Work
├─ History
├─ Routing Policy
├─ Models & Providers
└─ Usage & Traces
```

### Active Work

Cards are derived execution slots:

```text
[IMPLEMENT]
MemoFlow — optimize bootstrap loading
OpenCode (ACP)
implementation-efficient
LiteLLM-managed
Running 08:31
last provider route: Provider B
2.1M input / 71K output
```

### History

Join correlation records with OpenHands terminal state and Langfuse summary.

### Routing Policy

Edit safe policy only:

- phase -> backend candidates;
- phase -> logical model class;
- commercial preference;
- overrides/disable flags.

Do not build a second LiteLLM configuration editor for every low-level setting unless there is a clear user benefit.

### Models & Providers

Show LiteLLM-derived inventory/health/spend and link to native LiteLLM administration for advanced operations.

### Usage & Traces

Show aggregate metrics and link to Langfuse for full trace detail.

## 11. "Worker occupies a job" visualization

The original AI Office metaphor can remain visually without corrupting the domain.

Underlying mapping:

```text
Job slot        = DevelopmentPhase instance
Worker avatar   = ExecutionBackend
Brain label     = logical model class
Supplier label  = observed physical route(s)
Clock           = OpenHands execution duration
Cost meter      = Langfuse/LiteLLM usage summary
```

The UI may animate this as an office, but persistence remains execution-based.

## 12. Read composition rules

AI Office BFF performs joins at query time:

```text
active state     <- OpenHands
correlation      <- execution_links
provider health  <- LiteLLM
usage/cost       <- Langfuse
code artifact    <- Git/workspace
```

If one dependency is unavailable, return partial data with explicit source health instead of fabricating complete state.

Example:

```json
{
  "executionId": "exec-123",
  "status": "RUNNING",
  "usage": null,
  "sourceHealth": {
    "openhands": "OK",
    "langfuse": "DEGRADED"
  }
}
```

## 13. Write surface rules

AI Office V3 write operations should be few:

```text
start development execution
continue execution
cancel execution
change routing policy
change commercial preference/enablement
```

Low-level provider credentials, deployment health mechanics, trace mutation, and workspace internals stay in upstream systems.

## 14. Admin UI reuse

A major maintenance-saving principle:

> Do not rebuild upstream admin consoles merely for visual consistency.

AI Office should provide concise everyday controls and deep-link to:

- LiteLLM admin/dashboard for detailed gateway management;
- Langfuse for detailed traces and analytics;
- OpenHands native UI/Agent Canvas when direct conversation debugging is needed.

## 15. Success criterion

The V3 facade is successful if its deletion would leave OpenHands, LiteLLM and Langfuse individually understandable and operable. AI Office should add Hermes-specific coordination and convenience, not become the hidden owner of all three systems.
