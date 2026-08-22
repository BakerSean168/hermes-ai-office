# ADR-001: Compose OpenHands, LiteLLM, and Langfuse Instead of Building a General AI Platform

- **Status:** Accepted for V3 target architecture
- **Date:** 2026-08-21

## Context

The previous North-Star design introduced a custom AI Office Control Plane with Execution Lease, Agent Bridge, event lifecycle, provider registry, token/cost ledger, health routing, workspace execution, and custom UI projections.

That architecture is internally coherent, but implementing it well requires solving many problems that mature open-source projects already solve and continuously maintain.

The actual product goal is narrower: improve software-development delegation inside Hermes.

## Decision

Adopt:

- OpenHands for agent execution/workspace/ACP lifecycle;
- LiteLLM for managed provider/model gateway behavior;
- Langfuse for observability/usage analytics.

Keep only Hermes-specific workflow semantics, thin policy, cross-system correlation, and a focused AI Office UI.

## Consequences

### Positive

- much less custom lifecycle code;
- faster path to real working development delegation;
- provider/token/cost functionality benefits from upstream maintenance;
- standard ACP integrations reduce per-agent adapters;
- native upstream UIs remain available for debugging/admin.

### Negative

- more upstream dependencies;
- version compatibility must be managed explicitly;
- not every behavior can be customized exactly;
- self-hosting all components can still be operationally non-trivial.

## Rejected alternative

Build the full ExecutionLease + AgentBridge + custom ledger architecture immediately.

It remains a documented historical fallback design if future upstream limitations justify reclaiming specific responsibilities.
