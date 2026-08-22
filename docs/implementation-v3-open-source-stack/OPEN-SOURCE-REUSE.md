# Open-Source Reuse Matrix

## 1. Goal

This document converts upstream research into implementation boundaries. It distinguishes **adopt directly**, **wrap with a thin adapter**, and **do not reuse as an owner**.

Research snapshot: 2026-08-21.

## 2. OpenHands Software Agent SDK / Agent Server

### Verified upstream capability

- software-agent SDK for code-oriented agents;
- local or remote execution;
- Agent Server over HTTP/WebSocket;
- isolated workspaces/container orchestration;
- Conversation abstraction;
- event streaming;
- ACPAgent delegation;
- ACP remote-conversation support.

### V3 decision

**Adopt directly.**

Custom code:

```text
OpenHandsExecutionHost adapter
workspace/repository provisioning glue
correlation metadata
```

Do not fork OpenHands core for ordinary V3 requirements.

## 3. OpenHands ACPAgent

### Verified upstream capability

- delegates to ACP-compatible subprocess over JSON-RPC/stdio;
- external ACP agent owns LLM/tools/context;
- can carry prompt-oriented AgentContext/skills;
- works with remote Agent Server conversations;
- captures token/cost metrics reported by ACP server into OpenHands metrics.

### V3 decision

**Adopt directly as the standard bridge to external coding agents.**

This replaces most of the previously proposed custom AgentBridge/ACP runtime.

## 4. Codex ACP

### Verified upstream capability

OpenHands Agent Canvas documents Codex as a supported ACP provider/preset using a Codex ACP package and supports native ChatGPT login or API-key style credentials depending on backend configuration.

### V3 decision

**Use through OpenHands ACP first.**

Do not maintain a bespoke Codex subprocess parser unless a proven ACP limitation blocks a required capability.

## 5. OpenCode ACP

### Verified upstream capability

OpenCode documents `opencode acp`, launching OpenCode as an ACP-compatible subprocess over stdio/JSON-RPC.

### V3 decision

**Use as an OpenHands custom ACP server.**

This is particularly attractive for implementation work because OpenCode remains provider-agnostic and owns its native coding loop.

## 6. Claude Code ACP

### Verified upstream capability

OpenHands documents a Claude Code ACP server preset and native/API-key auth modes.

### V3 decision

**Optional premium backend through OpenHands ACP.**

No custom Claude Code execution runtime in V3.

## 7. DSH

### Verified upstream capability

No ACP integration is assumed by this architecture without direct proof.

### V3 decision

**Keep behind a tiny external adapter only if still necessary.**

If ACP support becomes available, migrate immediately to the standard ACP path.

## 8. LiteLLM Proxy

### Verified upstream capability

- unified API over many LLM providers;
- OpenAI-compatible gateway usage;
- Router retry/fallback across deployments;
- centralized auth/virtual keys;
- spend tracking and budgets;
- rate limiting;
- observability callbacks including Langfuse;
- consistent usage fields across supported providers.

### V3 decision

**Adopt directly as managed LLM gateway.**

Custom code only handles:

- business model-class names;
- user-specific commercial preference;
- narrow health/usage read facade;
- correlation metadata.

Do not implement provider protocol adapters or generic retry/cooldown in AI Office.

## 9. OpenHands -> LiteLLM Proxy integration

### Verified upstream capability

OpenHands documents LiteLLM Proxy as a supported LLM configuration using a LiteLLM-proxy model prefix/custom model, proxy base URL, and API key.

### V3 decision

**Adopt for OpenHands built-in managed agents.**

For ACP agents, validate backend-specific base-URL/key behavior through the compatibility spike.

## 10. Langfuse

### Verified upstream capability

- traces/observations;
- model usage and multiple token usage types;
- cost ingestion/inference;
- model definitions/custom pricing;
- metadata and tags;
- dashboards/filters;
- Metrics API;
- LiteLLM integration.

### V3 decision

**Adopt directly for observability.**

AI Office should query summaries and provide deep links, not reimplement trace storage or detailed analytics.

## 11. Langfuse self-hosted stack

### Verified upstream capability/constraint

Modern self-hosting uses multiple application/storage components including Web/Worker, PostgreSQL, ClickHouse, Redis/Valkey, and blob/object storage.

### V3 decision

**Do not make self-hosting mandatory for the first implementation.**

Use managed Langfuse or a separately planned self-host deployment depending on privacy/cost requirements.

## 12. Hermes official Kanban

### Capability

Hermes Kanban is a durable task/scheduling mechanism for Hermes worker patterns.

### V3 decision

**Do not use as the authoritative software-development execution scheduler.**

Reason: OpenHands already owns execution lifecycle; layering Kanban dispatch on top would create duplicated orchestration semantics.

Kanban may remain available for unrelated manual task management.

## 13. Symphony

### Capability

Symphony is an engineering orchestration design/service around issues/workspaces/agents and provides useful architectural patterns.

### V3 decision

**Reference only for workflow/reconciliation ideas; do not run it in the initial V3 data path.**

Reason: it would add another orchestration owner above OpenHands/Hermes.

## 14. Reuse scorecard

| Component                 | Direct adoption |            Thin adapter |      Custom implementation |
| ------------------------- | --------------: | ----------------------: | -------------------------: |
| OpenHands Agent Server    |             yes |                     yes |                         no |
| OpenHands ACPAgent        |             yes |                     yes |                         no |
| Codex ACP                 |             yes |             config only |                         no |
| OpenCode ACP              |             yes | custom ACP registration |                         no |
| Claude Code ACP           |             yes |             config only |                         no |
| DSH                       |      no/unknown |                   maybe |           only if required |
| LiteLLM Proxy             |             yes |      policy/read facade |         no gateway rewrite |
| Langfuse                  |             yes |      query/link adapter |           no trace backend |
| Hermes Development Skill  |             n/a |                     n/a | **yes — our domain value** |
| AI Office business policy |             n/a |                     n/a | **yes — our domain value** |
| AI Office correlation/UI  |             n/a |                     n/a |          **yes — minimal** |

## 15. Upstream reference documents used

The design was checked against current upstream documentation including:

- OpenHands Software Agent SDK overview;
- OpenHands Agent Server overview/architecture;
- OpenHands ACP Agent guide;
- OpenHands Agent Canvas ACP Agents guide;
- OpenHands LiteLLM Proxy guide;
- OpenCode ACP support/CLI documentation;
- LiteLLM Getting Started/Proxy documentation;
- Langfuse Token & Cost Tracking documentation;
- Langfuse Metrics API documentation;
- Langfuse self-hosting architecture/deployment documentation.

The implementation phase must re-check exact APIs against the versions pinned in P0 rather than treating this research snapshot as an eternal contract.
