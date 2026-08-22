# ADR-006: Persist Only a Minimal Cross-System Correlation Index

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

The AI Office UI needs to connect a Hermes task to an OpenHands conversation, a Langfuse trace, Git workspace, and model-routing metadata.

Persisting complete copies of upstream lifecycle/usage state would recreate the V2 platform and introduce consistency problems.

## Decision

Persist only `ExecutionLink` correlation metadata keyed by a stable `execution_id`.

Authoritative status remains in OpenHands, managed request routing/usage in LiteLLM, analytics in Langfuse, and code state in Git.

Cached projection fields are allowed only when they can be reconciled/rebuilt.

## Consequences

- database remains small and understandable;
- cross-system UI remains possible;
- partial upstream outage produces partial UI rather than contradictory fake truth;
- historical queries depend on upstream retention and trace tags, so retention policy must be deliberate.
