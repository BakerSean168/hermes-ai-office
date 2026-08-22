# ADR-003: LiteLLM Owns the Managed LLM Data Plane, With an Explicit Native-Subscription Exception

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

A direct-provider architecture avoids a proxy hop but forces every coding-agent adapter to solve provider configuration, availability, usage/cost collection, fallback, and reconciliation.

LiteLLM already provides a centralized multi-provider gateway and cost/spend/routing mechanisms.

At the same time, some coding agents have valuable native OAuth/subscription modes that should not be broken merely to centralize traffic.

## Decision

Define two transport modes:

```text
LITELLM_MANAGED
NATIVE_SUBSCRIPTION
```

For managed traffic, LiteLLM is authoritative for physical provider routing and request usage/cost evidence.

For native subscription traffic, the external coding agent/provider owns LLM transport and AI Office labels provider-level telemetry as partial/unknown unless reliable ACP/native metrics exist.

## Consequences

- most API-based providers are centralized;
- secrets can stay behind LiteLLM virtual-key/provider boundaries;
- native subscription economics remain available;
- UI and analytics must represent telemetry source quality honestly;
- LiteLLM does not become a mandatory dependency for ordinary Hermes Brain model calls.
