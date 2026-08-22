# Hermes AI Office V3 — Open-Source Composition Architecture

**Status:** proposed North-Star architecture; not yet production truth
**Date:** 2026-08-21
**Supersedes:** V2 as the preferred future direction, but **does not supersede V2 operationally until cutover is complete**.

## 1. Why V3 exists

V2 proved that a rich AI Workforce domain can model providers, employees, positions, runtime access, usage, dispatch, and projections. It also exposed a cost: once AI Office owns provider translation, agent lifecycle, execution correlation, usage accounting, retries, runtime adapters, and UI projections, it starts becoming a general AI platform that must be maintained like one.

V3 deliberately trades some custom control for dramatically lower implementation and maintenance cost.

The central decision is:

> **Compose mature open-source systems instead of rebuilding them.**

The preferred stack is:

- **Hermes** — conversation brain, intent/complexity judgment, user context, workflow trigger.
- **Development Skill** — project-independent software-engineering process semantics.
- **OpenHands Agent Server / Software Agent SDK** — execution host, conversation lifecycle, workspace isolation, and ACP delegation.
- **LiteLLM Proxy** — managed LLM data plane for provider/model normalization, routing, retry/fallback, budgets, usage, and gateway-level health.
- **Langfuse** — trace, token, cost, latency, metadata, and analytics observability.
- **AI Office V3** — a thin policy/facade/projection layer joining the systems above; it is not a second agent runtime, gateway, or observability platform.

## 2. V3 in one diagram

```text
User
  │
  ▼
Hermes Brain
  │ intent / complexity / next phase
  ▼
Development Skill + thin runtime tool
  │
  ▼
AI Office V3 Facade
  │ business policy + correlation
  ├──────────────────┐
  ▼                  ▼
OpenHands         LiteLLM control API
Agent Server          │
  │                   │
  │ run agent         │ model groups / health / spend
  ▼                   │
OpenHands Agent       │
or ACP Agent          │
  │                   │
  ├─ Codex ACP        │
  ├─ OpenCode ACP     │
  ├─ Claude Code ACP  │
  └─ built-in Agent   │
  │                   │
  └──── LLM requests ─┴──► LiteLLM Proxy ─► providers
                              │
                              └──► Langfuse

AI Office Desktop UI
  ├─ active executions     ← OpenHands + correlation index
  ├─ logical route/policy  ← AI Office config
  ├─ provider health/spend ← LiteLLM
  └─ trace/usage/history   ← Langfuse
```

## 3. Critical scope boundary

V3 is **only** the Hermes software-development workflow path. It is not required to intercept every Hermes model call.

Hermes' own Brain Model remains independently configured and may call its provider directly. AI Office is entered only when a development workflow phase needs a specialized execution worker.

```text
Hermes Brain model calls               -> existing Hermes provider path
Hermes development execution requests  -> AI Office V3 -> OpenHands -> LiteLLM/native lane
```

This avoids turning AI Office into a mandatory dependency for normal Hermes conversation.

## 4. Authority map

| Concern                                                             | Authoritative owner |
| ------------------------------------------------------------------- | ------------------- |
| user conversation, long-lived context, next-phase semantic decision | Hermes              |
| development method and phase semantics                              | Development Skill   |
| agent conversation, execution state, pause/cancel, workspace        | OpenHands           |
| gateway-managed model request routing and provider attempts         | LiteLLM             |
| traces, usage/cost analytics, latency and observability queries     | Langfuse            |
| code and branch state                                               | Git                 |
| phase-to-capability policy and cross-system correlation IDs         | AI Office V3        |

A core rule is **no duplicate state machine**. AI Office must not recreate OpenHands execution lifecycle, LiteLLM routing state, or Langfuse trace storage.

## 5. Document map

| Document                                               | Purpose                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| [ARCHITECTURE.md](ARCHITECTURE.md)                     | complete target architecture and request/data flows                      |
| [DOMAIN-BOUNDARIES.md](DOMAIN-BOUNDARIES.md)           | source-of-truth rules and minimal V3 domain model                        |
| [DEVELOPMENT-WORKFLOW.md](DEVELOPMENT-WORKFLOW.md)     | INVESTIGATE_PLAN → IMPLEMENT → VERIFY_REVIEW workflow                    |
| [OPENHANDS-EXECUTION.md](OPENHANDS-EXECUTION.md)       | OpenHands Agent Server, ACP, workspace and agent backend strategy        |
| [LITELLM-GATEWAY.md](LITELLM-GATEWAY.md)               | model classes, deployments, routing, health, budgets and transport modes |
| [LANGFUSE-OBSERVABILITY.md](LANGFUSE-OBSERVABILITY.md) | trace hierarchy, metadata, token/cost and dashboard strategy             |
| [AI-OFFICE-FACADE.md](AI-OFFICE-FACADE.md)             | what custom AI Office code remains and what is explicitly removed        |
| [HERMES-INTEGRATION.md](HERMES-INTEGRATION.md)         | Hermes Skill/tool boundary and Brain responsibilities                    |
| [API-CONTRACT.md](API-CONTRACT.md)                     | proposed thin V3 API/tool contracts                                      |
| [CONFIGURATION.md](CONFIGURATION.md)                   | policy and integration configuration examples                            |
| [SECURITY.md](SECURITY.md)                             | secrets, trust, ACP permissions, network and observability privacy       |
| [DEPLOYMENT.md](DEPLOYMENT.md)                         | oracle2-oriented service topology and operational model                  |
| [MIGRATION.md](MIGRATION.md)                           | V2 → V3 migration and rollback strategy                                  |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)       | phased execution plan and vertical slices                                |
| [VERIFICATION.md](VERIFICATION.md)                     | acceptance criteria and failure tests                                    |
| [RISKS-AND-TRADEOFFS.md](RISKS-AND-TRADEOFFS.md)       | known compromises, failure modes and escape hatches                      |
| [OPEN-SOURCE-REUSE.md](OPEN-SOURCE-REUSE.md)           | reuse matrix and verified upstream capabilities                          |
| [adr/](adr/)                                           | architecture decision records                                            |

## 6. Architecture principles

1. **Use upstream features first.** Add custom code only where Hermes-specific semantics are not supplied upstream.
2. **Thin adapters, stable ports.** OpenHands/LiteLLM/Langfuse are dependencies behind tiny interfaces so they can be upgraded or replaced.
3. **One owner per lifecycle.** No dual schedulers and no duplicate execution state machines.
4. **Business routing above infrastructure routing.** AI Office chooses a capability/model class; LiteLLM chooses an eligible physical deployment.
5. **Provider selection is per invocation, not an employee identity.** One execution can use multiple physical deployments after retry/fallback.
6. **Fresh review.** Post-implementation verification/review defaults to a fresh agent conversation.
7. **Isolation for writers.** Parallel write-capable executions never share the same mutable working tree.
8. **Correlate, do not copy.** AI Office stores IDs and minimal metadata, then queries authoritative systems.
9. **No raw provider secret in Hermes prompt context.** Secrets remain in LiteLLM/OpenHands/agent credential stores.
10. **Prefer reversible migration.** V2 stays available until the V3 vertical slice is proven in production-like use.

## 7. Upstream facts verified for this design

As of 2026-08-21, upstream documentation confirms:

- OpenHands Agent Server exposes remote execution over HTTP/WebSocket and manages isolated workspaces.
- OpenHands `ACPAgent` can delegate a conversation to an ACP-compatible coding agent while the external agent owns its tools, context, and LLM calls.
- OpenHands Agent Canvas documents first-class ACP presets for Claude Code, Codex and Gemini CLI, and supports custom ACP servers.
- OpenCode exposes `opencode acp`, so it can be attached through the custom ACP path.
- OpenHands directly documents using a LiteLLM Proxy as its LLM endpoint.
- LiteLLM Proxy provides a centralized gateway, multi-provider normalization, retry/fallback, auth, virtual keys, cost/spend tracking and budgets.
- LiteLLM supports Langfuse as an observability callback/integration.
- Langfuse tracks model usage, token types, cost, latency and metadata, and exposes a Metrics API suitable for AI Office summary views.

These capabilities are treated as upstream dependencies, not copied implementation ideas.

## 8. Current-vs-target rule

Until V3 cutover:

```text
V2 docs = current production behavior
V3 docs = target architecture and implementation contract
```

After cutover, the root documentation authority order should be changed explicitly; do not silently reinterpret V2 as historical before that point.
