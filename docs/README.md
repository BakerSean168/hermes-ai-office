# Hermes AI Office Documentation

This directory contains the product and architecture source of truth for the Hermes AI Office work.

## Start here

1. [`HERMES-AI-OFFICE-PRD.md`](HERMES-AI-OFFICE-PRD.md) — historical/current product intent.
2. [`implementation-v3-open-source-stack/README.md`](implementation-v3-open-source-stack/README.md) — **proposed North-Star direction**: Hermes + OpenHands + LiteLLM + Langfuse.
3. [`DOMAIN-MODEL-V2.md`](DOMAIN-MODEL-V2.md) — current deployed V2 business model and terminology until V3 cutover.
4. [`implementation-v2/README.md`](implementation-v2/README.md) — current deployed V2 engineering contracts and migration history.

## V3 target architecture package

V3 deliberately reduces custom platform ownership and composes mature upstream systems. It is the preferred future implementation direction, but **V2 remains production truth until an explicit V3 cutover**.

- [`implementation-v3-open-source-stack/ARCHITECTURE.md`](implementation-v3-open-source-stack/ARCHITECTURE.md)
- [`implementation-v3-open-source-stack/DOMAIN-BOUNDARIES.md`](implementation-v3-open-source-stack/DOMAIN-BOUNDARIES.md)
- [`implementation-v3-open-source-stack/DEVELOPMENT-WORKFLOW.md`](implementation-v3-open-source-stack/DEVELOPMENT-WORKFLOW.md)
- [`implementation-v3-open-source-stack/OPENHANDS-EXECUTION.md`](implementation-v3-open-source-stack/OPENHANDS-EXECUTION.md)
- [`implementation-v3-open-source-stack/LITELLM-GATEWAY.md`](implementation-v3-open-source-stack/LITELLM-GATEWAY.md)
- [`implementation-v3-open-source-stack/LANGFUSE-OBSERVABILITY.md`](implementation-v3-open-source-stack/LANGFUSE-OBSERVABILITY.md)
- [`implementation-v3-open-source-stack/AI-OFFICE-FACADE.md`](implementation-v3-open-source-stack/AI-OFFICE-FACADE.md)
- [`implementation-v3-open-source-stack/HERMES-INTEGRATION.md`](implementation-v3-open-source-stack/HERMES-INTEGRATION.md)
- [`implementation-v3-open-source-stack/API-CONTRACT.md`](implementation-v3-open-source-stack/API-CONTRACT.md)
- [`implementation-v3-open-source-stack/CONFIGURATION.md`](implementation-v3-open-source-stack/CONFIGURATION.md)
- [`implementation-v3-open-source-stack/SECURITY.md`](implementation-v3-open-source-stack/SECURITY.md)
- [`implementation-v3-open-source-stack/DEPLOYMENT.md`](implementation-v3-open-source-stack/DEPLOYMENT.md)
- [`implementation-v3-open-source-stack/MIGRATION.md`](implementation-v3-open-source-stack/MIGRATION.md)
- [`implementation-v3-open-source-stack/IMPLEMENTATION-PLAN.md`](implementation-v3-open-source-stack/IMPLEMENTATION-PLAN.md)
- [`implementation-v3-open-source-stack/VERIFICATION.md`](implementation-v3-open-source-stack/VERIFICATION.md)
- [`implementation-v3-open-source-stack/RISKS-AND-TRADEOFFS.md`](implementation-v3-open-source-stack/RISKS-AND-TRADEOFFS.md)
- [`implementation-v3-open-source-stack/OPEN-SOURCE-REUSE.md`](implementation-v3-open-source-stack/OPEN-SOURCE-REUSE.md)
- [`implementation-v3-open-source-stack/COMPATIBILITY-MATRIX.md`](implementation-v3-open-source-stack/COMPATIBILITY-MATRIX.md)
- [`implementation-v3-open-source-stack/adr/`](implementation-v3-open-source-stack/adr/) — V3 architecture decisions.

## V2 implementation package

- [`implementation-v2/ARCHITECTURE.md`](implementation-v2/ARCHITECTURE.md)
- [`implementation-v2/GATEWAY-STRATEGY.md`](implementation-v2/GATEWAY-STRATEGY.md)
- [`implementation-v2/TECH-STACK.md`](implementation-v2/TECH-STACK.md)
- [`implementation-v2/FIRST-VERTICAL-SLICE.md`](implementation-v2/FIRST-VERTICAL-SLICE.md)
- [`implementation-v2/PERSISTENCE.md`](implementation-v2/PERSISTENCE.md)
- [`implementation-v2/API-CONTRACT.md`](implementation-v2/API-CONTRACT.md)
- [`implementation-v2/EVENT-CONTRACT.md`](implementation-v2/EVENT-CONTRACT.md)
- [`implementation-v2/WORKFLOWS.md`](implementation-v2/WORKFLOWS.md)
- [`implementation-v2/PROJECTIONS.md`](implementation-v2/PROJECTIONS.md)
- [`implementation-v2/MIGRATION.md`](implementation-v2/MIGRATION.md)
- [`implementation-v2/ROADMAP.md`](implementation-v2/ROADMAP.md)
- [`implementation-v2/VERIFICATION.md`](implementation-v2/VERIFICATION.md)

## Historical implementation specs

Repository-root `SPEC-*` files and `hermes-office-bridge/SPEC-*` document earlier implementation phases. They remain useful implementation history but do not override Domain Model V2.

## Authority rule

When documents disagree **before V3 cutover**:

1. current production behavior -> V2 implementation package + Domain Model V2;
2. preferred future architecture -> V3 open-source-stack package;
3. product intent -> PRD, interpreted through the explicit V2/V3 status above;
4. historical `SPEC-*` -> evidence of past implementation only.

After V3 cutover, update this authority rule explicitly rather than silently treating target documents as already deployed.
