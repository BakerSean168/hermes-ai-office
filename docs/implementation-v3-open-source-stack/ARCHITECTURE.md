# V3 North-Star Architecture

## 1. Architectural objective

Build a Hermes-native development workflow that reliably delegates serious software-engineering work to specialized coding agents without building a custom agent platform.

The architecture must make the following user interaction natural:

```text
User: "The page stays white for too long. Investigate why and review it."

Hermes
  -> judges this as a non-trivial development investigation
  -> starts INVESTIGATE_PLAN
  -> policy selects a premium investigation execution profile
  -> OpenHands starts the chosen coding-agent backend
  -> the backend inspects the repository and returns root cause + plan
  -> Hermes evaluates the result
  -> if modification is appropriate, starts IMPLEMENT
  -> implementation runs in an isolated workspace
  -> VERIFY_REVIEW starts in a fresh conversation
  -> Hermes summarizes the final result to the user
```

The infrastructure should already know which agent is running, how long it has run, which logical model class it requested, which provider attempts actually served model calls, and how many tokens/cost were observed.

## 2. System layers

### 2.1 Hermes Brain

Hermes is the user-facing orchestrating brain.

It owns semantic decisions:

- is this a development task?
- is it trivial enough to handle locally?
- which development phase is required?
- after a phase result, should the workflow continue, stop, retry, or ask the user?
- how should the result be explained back to the user?

Hermes does **not** own:

- coding-agent process lifecycle;
- provider protocol translation;
- API-key distribution;
- deployment load balancing;
- token/cost aggregation;
- workspace container orchestration.

### 2.2 Development Skill

The Development Skill is the stable engineering method.

It contains:

- phase semantics;
- routing triggers;
- read/write safety expectations;
- review freshness rule;
- parallel-work constraints;
- completion expectations.

The skill may be backed by a small deterministic Hermes tool/plugin wrapper, but it is not a standalone workflow service.

### 2.3 AI Office V3 Facade

AI Office V3 is intentionally thin.

It owns only:

- phase/capability policy;
- execution-backend selection policy;
- logical model-class selection;
- provider economics metadata that LiteLLM does not understand as user intent;
- correlation IDs across Hermes, OpenHands, LiteLLM and Langfuse;
- read-model composition for the AI Office UI.

It does not own a second execution engine.

### 2.4 OpenHands execution plane

OpenHands is the default execution authority.

Responsibilities:

- create/attach/continue conversations;
- run or pause/cancel agent execution;
- maintain conversation events;
- provide workspace isolation;
- host the built-in OpenHands agent when desired;
- host ACP-backed coding agents through `ACPAgent`;
- expose execution progress over server APIs/events.

### 2.5 LiteLLM model gateway

LiteLLM is the managed LLM data plane **when the selected execution backend is configured for gateway-managed model access**.

Responsibilities:

- provider protocol normalization;
- logical model groups/aliases;
- eligible deployment selection;
- retry/fallback/cooldown/load balancing;
- provider auth boundary;
- virtual key/budget/rate-limit enforcement where used;
- request-level usage and cost evidence;
- observability callbacks to Langfuse.

### 2.6 Langfuse observability plane

Langfuse is the observability and analytics authority.

Responsibilities:

- trace/execution correlation;
- generation-level model observations;
- input/output/cache/reasoning usage types where available;
- cost and latency;
- metadata/tags;
- historical filtering and metrics aggregation.

It is not the workflow state machine.

## 3. Two execution transport lanes

A crucial V3 distinction is that not every coding agent can or should be forced through LiteLLM.

### 3.1 Gateway-managed lane

```text
OpenHands / ACP agent
        │
        │ API-key + custom base URL
        ▼
    LiteLLM Proxy
        │
        ▼
physical provider/deployment
```

Use when:

- provider selection must be controlled centrally;
- precise per-request gateway usage/cost is desired;
- the backend supports a custom API base and API-key auth;
- fallback across equivalent deployments is useful.

This is the preferred lane for AI Office-managed API providers.

### 3.2 Native-subscription lane

```text
OpenHands ACPAgent
        │
        ▼
Codex / Claude Code / other CLI
        │
        │ native OAuth/subscription login
        ▼
provider-native service
```

Use when:

- a subscription login has significantly better economics;
- the CLI's native auth/runtime is intentionally preserved;
- forcing the request through LiteLLM would break or weaken the provider-specific experience.

In this lane, LiteLLM is **not** authoritative for token/provider usage. AI Office relies on OpenHands/ACP metrics and any native telemetry that can be safely exported. UI must label the usage source accordingly.

### 3.3 Why both lanes are necessary

Pretending every Codex/Claude/OpenCode invocation is interchangeable with an OpenAI-compatible API request creates false abstractions. V3 instead models `transport_mode` explicitly:

```text
LITELLM_MANAGED
NATIVE_SUBSCRIPTION
```

This preserves the strongest native coding-agent paths without losing centralized routing for API-driven work.

## 4. Business routing vs infrastructure routing

V3 uses two routing layers with different responsibilities.

### Layer A — AI Office business policy

Input:

```text
phase
complexity
risk
write access
quality preference
cost class
parallelism
backend constraints
```

Output:

```text
execution backend
logical model class
transport mode
session policy
```

Example:

```text
INVESTIGATE_PLAN
  -> backend: codex-acp
  -> model_class: planning-premium
  -> transport: LITELLM_MANAGED
  -> session: fresh
```

### Layer B — LiteLLM infrastructure routing

Input:

```text
model = planning-premium
```

Output per model call:

```text
actual model/deployment/provider attempt
```

LiteLLM may use provider A on one call and provider B after a rate limit. AI Office must not represent a physical provider as a permanent worker identity.

## 5. Request flow: investigation and plan

```text
1. User message enters Hermes.
2. Hermes judges complexity and invokes Development Skill.
3. Skill calls AI Office `run_phase(INVESTIGATE_PLAN, ...)`.
4. AI Office creates `execution_id` and chooses an execution profile.
5. AI Office asks OpenHands to create a conversation in a read-oriented workspace.
6. OpenHands starts built-in Agent or ACPAgent.
7. The agent inspects code and produces diagnosis + plan.
8. Model calls use LiteLLM when transport=LITELLM_MANAGED.
9. LiteLLM exports generation observations to Langfuse.
10. AI Office correlates the OpenHands conversation and Langfuse trace using the shared execution ID.
11. OpenHands completes the run.
12. AI Office returns normalized execution metadata + final agent result to Hermes.
13. Hermes decides whether IMPLEMENT is required.
```

Investigation and plan default to the **same agent conversation** to preserve repository context and any upstream prompt/cache locality.

## 6. Request flow: implementation

```text
Hermes
  -> run_phase(IMPLEMENT)
  -> AI Office policy
  -> provision isolated writable workspace
  -> OpenHands conversation
  -> coding agent modifies/tests
  -> Git diff/branch is retained as artifact
  -> result returns to Hermes
```

For parallel implementation, each writer receives a separate worktree/clone/workspace. Merge/integration occurs only after individual work completes.

## 7. Request flow: verify/review

`VERIFY_REVIEW` defaults to:

- a fresh OpenHands conversation;
- no reuse of the implementer's hidden chain/context;
- read-only repository access except when an explicit fix loop is opened;
- premium review model class;
- checks against the actual diff/tests, not the implementer's self-description.

If review fails:

```text
VERIFY_REVIEW failed
   -> Hermes interprets findings
   -> IMPLEMENT_FIX phase
   -> fresh VERIFY_REVIEW
```

## 8. Minimal custom persistence

AI Office V3 may persist a tiny correlation index, not a full execution ledger.

Recommended `execution_links` record:

```text
execution_id
hermes_profile
hermes_session_id
hermes_turn_id
project_key
phase
objective_summary
openhands_conversation_id
execution_backend
transport_mode
logical_model_class
langfuse_trace_id
created_at
updated_at
```

Optional terminal status may be cached for UI performance, but OpenHands remains authoritative and reconciliation must be able to rebuild the projection.

No provider secrets, raw prompts, full model responses, or duplicate usage ledger belong in this store.

## 9. Active-work projection

The AI Office UI should display a running card as a projection, for example:

```text
MemoFlow · INVESTIGATE_PLAN
Codex (ACP) · planning-premium
Transport: LiteLLM managed
Running 06:42
Last observed route: GPT-family @ Provider A
382k input · 18k output · $0.42 so far
```

The important semantic distinction is:

- **agent/backend** — stable for the execution;
- **logical model class** — stable policy choice;
- **physical provider/model** — request-level observation and may change during the execution.

## 10. Failure behavior

### OpenHands unavailable before start

Fail the development phase cleanly. Hermes remains usable for ordinary conversation and can tell the user execution infrastructure is unavailable.

### OpenHands worker lost during execution

OpenHands is the lifecycle authority. AI Office reports the authoritative state and does not independently mark success.

### LiteLLM unavailable in managed lane

The execution cannot make managed model calls. LiteLLM handles configured retries/fallbacks within its own boundary; after gateway failure propagates, OpenHands/agent fails or pauses according to its behavior. AI Office may choose a new execution only after Hermes/workflow policy decides to retry.

### Langfuse unavailable

Observability is non-authoritative. Development execution should normally continue. LiteLLM/OpenHands local logs and usage remain temporary fallback evidence. The UI marks observability as degraded.

### AI Office facade unavailable

Existing OpenHands runs continue. New workflow executions fail to start through the managed path. Hermes normal conversation remains available.

## 11. Deliberately excluded architecture

V3 does not implement:

- Hermes Kanban as the main coding worker scheduler;
- custom profile-per-worker architecture;
- AI Office-owned generic worker heartbeat/retry protocol;
- a custom LLM proxy;
- a custom full tracing backend;
- a custom ACP client/runtime if OpenHands already covers the required backend;
- a second execution state machine shadowing OpenHands.

## 12. Escape hatch

Every upstream dependency sits behind a narrow port:

```text
ExecutionHostPort   -> OpenHands
ModelGatewayPort    -> LiteLLM
ObservabilityPort   -> Langfuse
```

If an upstream project later becomes unsuitable, the system can replace that adapter without restoring the entire V2 domain at once.
