# ADR-002: OpenHands Is the Coding Execution Authority

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

Hermes needs to delegate development phases to Codex, OpenCode, Claude Code, OpenHands, and possibly DSH while supporting long-running work, cancellation, isolated workspaces, and result retrieval.

Implementing an independent worker lifecycle plus ACP client/runtime would duplicate OpenHands Agent Server and `ACPAgent` capabilities.

## Decision

Use OpenHands Agent Server/Software Agent SDK as `ExecutionHostPort`'s primary implementation.

External coding agents are attached through OpenHands ACPAgent whenever a compatible ACP server exists.

OpenHands owns conversation/run/workspace lifecycle. AI Office stores only cross-system references and queries OpenHands for authoritative execution state.

## Consequences

- no Hermes Profile per coding worker;
- no Hermes Kanban as the main development worker scheduler;
- no custom heartbeat/process manager for ACP workers;
- DSH may retain a narrow separate adapter only if ACP is unavailable and DSH remains valuable.

## Guardrail

Do not fork OpenHands core until a documented extension point has been proven insufficient for a hard requirement.
