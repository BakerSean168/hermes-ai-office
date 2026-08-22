# OpenHands Execution Architecture

## 1. Decision

Use **OpenHands Agent Server / Software Agent SDK as the default execution host** for serious Hermes development work.

AI Office does not build its own general worker runtime. OpenHands owns conversation lifecycle, remote execution, workspace isolation, and ACP delegation.

## 2. Why OpenHands fits this architecture

The verified upstream capabilities align closely with the custom components V3 wants to avoid implementing:

- HTTP/WebSocket remote Agent Server;
- Conversation abstraction for local and remote execution;
- isolated Docker/remote workspaces;
- command and file operations inside workspaces;
- execution/event streaming;
- built-in software agent runtime;
- `ACPAgent` for delegating to external ACP-compatible coding agents;
- support for remote conversations with ACP-backed agents;
- token/cost metrics exposed by ACP agent integration when the ACP server reports them.

The value is not merely "use OpenHands as another coding model." The value is:

> **OpenHands becomes the stable execution host above multiple coding-agent runtimes.**

## 3. Execution backend model

V3 treats the coding-agent backend as a policy choice.

Initial backend kinds:

```text
openhands-builtin
codex-acp
opencode-acp
claude-code-acp
gemini-acp
custom-acp:<name>
external-adapter:dsh
```

### OpenHands built-in Agent

Use when:

- OpenHands' own reasoning/tool loop is good enough;
- complete control of model endpoint through LiteLLM is desired;
- a generic coding worker is sufficient;
- ACP-specific subscription features are not required.

### Codex ACP

OpenHands Agent Canvas upstream documents a Codex ACP preset backed by an ACP subprocess. This preserves Codex's own tools/context/runtime while OpenHands owns the outer conversation and workspace execution lifecycle.

Use when:

- premium planning/review benefits from Codex;
- Codex-specific behavior is preferred;
- subscription or API-key auth economics are acceptable.

### OpenCode ACP

OpenCode exposes `opencode acp`, which starts OpenCode as an ACP-compatible JSON-RPC subprocess.

This makes the preferred integration:

```text
OpenHands ACPAgent
   -> command: opencode acp
   -> OpenCode owns its agent loop
```

Use when:

- provider-agnostic implementation is desired;
- OpenCode plan/build behavior is useful;
- LSP/project-aware coding capability is preferred.

### Claude Code ACP

Use when:

- Anthropic coding quality is desired;
- a Claude Code subscription/API path is available;
- the work justifies premium execution cost.

### DSH

DSH must not be forced into the ACP abstraction until an actual compatible ACP server path is proven.

V3 fallback:

```text
ExecutionHostPort
  ├─ OpenHandsExecutionHost
  └─ DshExecutionAdapter   # only if still needed
```

If DSH later exposes ACP, delete the bespoke adapter and register it as `custom-acp:dsh`.

## 4. OpenHands as execution authority

For every V3 execution, OpenHands owns:

```text
conversation creation
agent settings
run state
streamed events
pause/resume/cancel
workspace association
final agent result
```

AI Office may cache status for UI latency but never creates an independent state transition that contradicts OpenHands.

Example:

```text
AI Office cache: RUNNING
OpenHands: ERROR
```

The projection must reconcile to `ERROR`; AI Office does not attempt to preserve its own lifecycle truth.

## 5. Proposed `ExecutionHostPort`

The custom boundary should remain intentionally small:

```text
create_execution(spec) -> execution_ref
get_execution(execution_ref) -> execution_snapshot
stream_execution(execution_ref) -> events
continue_execution(execution_ref, message)
cancel_execution(execution_ref)
```

No provider logic belongs in this interface.

Conceptual spec:

```text
ExecutionSpec
├─ execution_id
├─ backend_kind
├─ workspace_spec
├─ prompt
├─ phase
├─ model_class
├─ transport_mode
├─ session_policy
└─ correlation_metadata
```

The OpenHands adapter translates that into upstream Agent/ACP settings and conversation APIs.

## 6. Workspace strategy

### 6.1 Read-oriented investigation workspace

`INVESTIGATE_PLAN` should receive a repository snapshot/workspace where accidental mutation is constrained as far as practical.

Options in preference order:

1. filesystem/workspace policy that denies writes;
2. read-only mount with writable temp/build directories;
3. ordinary isolated workspace with explicit plan/read-only agent policy when upstream limitations make strict read-only impractical.

Do not pretend prompt-only "do not edit" is equivalent to a filesystem boundary.

### 6.2 Writable implementation workspace

Each write-capable execution receives an isolated worktree/clone.

Required metadata:

```text
repo_source
base_revision
workspace_path/ref
branch_name
execution_id
```

Recommended branch:

```text
ai-office/<execution-id>
```

### 6.3 Review workspace

A reviewer receives a fresh view of the candidate branch/diff. It does not need the implementer's mutable conversation state.

## 7. ACP execution mechanics

OpenHands `ACPAgent` delegates to a subprocess over ACP/JSON-RPC. The external agent manages its own:

- LLM calls;
- tools;
- context window;
- repository actions.

OpenHands remains useful because the outer conversation/workspace lifecycle is consistent.

Important implication:

> OpenHands cannot inject all built-in Agent features into an ACP backend.

Upstream documentation explicitly distinguishes ACP-compatible prompt context from features the external server owns itself. Therefore V3 must configure tools/MCP/context on the ACP agent side when required rather than assuming OpenHands can override them.

## 8. Permission/security rule

OpenHands ACP integration may auto-approve ACP permission requests depending on the execution mode/upstream behavior. Treat ACP workers as trusted automation with potentially strong repository/shell capability.

Mitigations:

- run in isolated workspace/container;
- use a non-privileged OS user;
- do not mount host secrets broadly;
- restrict Docker/socket exposure;
- phase-specific write/network policy where practical;
- separate infrastructure-changing agents from ordinary source-code agents.

See [SECURITY.md](SECURITY.md).

## 9. Model access for OpenHands built-in Agent

OpenHands directly supports a LiteLLM Proxy model configuration. The intended managed path is:

```text
model = litellm_proxy/<logical-model>
base_url = LiteLLM Proxy
api_key = scoped LiteLLM virtual key
```

This is the cleanest path for complete model/provider observability.

## 10. Model access for ACP agents

ACP servers own their LLM transport, so integration depends on the underlying coding agent.

V3 classifies each backend capability:

```text
supports_litellm_base_url: yes/no/conditional
supports_native_subscription: yes/no
reports_token_metrics: yes/no/partial
supports_model_override: yes/no
```

Do not claim central provider routing for a backend unless a tested configuration proves its model calls pass through LiteLLM.

## 11. Conversation reuse

OpenHands conversation IDs give V3 a natural continuation primitive.

Policy:

```text
INVESTIGATE_PLAN internal continuation -> same conversation
IMPLEMENT fix follow-up               -> may resume implementation conversation
VERIFY_REVIEW                          -> fresh conversation
```

AI Office stores only the OpenHands conversation reference and the policy reason.

## 12. Result normalization

The adapter should return both authoritative upstream data and a small normalized envelope:

```text
ExecutionResult
├─ execution_id
├─ openhands_conversation_id
├─ backend_kind
├─ status
├─ started_at
├─ ended_at
├─ final_text
├─ workspace_ref
├─ git_summary?        # collected mechanically if available
├─ usage_summary?      # source-labelled
├─ langfuse_trace_id?
└─ upstream_ref
```

`final_text` remains the coding agent's result. Hermes Brain interprets it semantically.

## 13. Usage authority

Usage quality must be labelled:

```text
LITELLM_REPORTED
ACP_REPORTED
OPENHANDS_REPORTED
ESTIMATED
UNKNOWN
```

For managed-lane calls, LiteLLM/Langfuse are preferred. For native subscription ACP runs, OpenHands/ACP metrics may be the best available execution-level evidence.

## 14. Failure and restart behavior

The V3 adapter must be tested for:

- Agent Server restart while conversation exists;
- worker/container crash;
- ACP subprocess exit;
- websocket disconnect and reconnect;
- cancellation race;
- workspace cleanup after failure;
- duplicate `create_execution` calls caused by Hermes retry.

Idempotency belongs in the thin adapter by using `execution_id` as the correlation key; it must not accidentally create two coding workers for one retried Hermes tool call.

## 15. Non-goals

Do not customize OpenHands core unless a hard requirement cannot be satisfied through documented SDK/server extension points.

Forking OpenHands is a last resort because it turns upstream lifecycle code back into our maintenance burden.
