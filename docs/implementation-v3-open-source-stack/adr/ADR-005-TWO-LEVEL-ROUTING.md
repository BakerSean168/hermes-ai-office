# ADR-005: Separate Business Routing From Physical Provider Routing

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

The software-development workflow speaks in semantic requirements such as "premium review" or "efficient implementation." Provider infrastructure speaks in concrete deployments, API endpoints, rate limits, and cooldowns.

Combining both in one router either leaks provider details into Hermes workflow or forces LiteLLM to understand product-specific development semantics.

## Decision

Use two levels:

1. **AI Office business routing** chooses execution backend, logical model class, transport mode, and session/workspace policy.
2. **LiteLLM infrastructure routing** chooses the physical deployment/provider for each managed model request within the selected logical model class.

## Consequences

- Development Skill is stable while providers change;
- LiteLLM can fallback between business-equivalent deployments;
- physical provider is an invocation-level fact, not a durable employee identity;
- cross-tier fallback must return to business policy rather than happen silently inside one model group.
