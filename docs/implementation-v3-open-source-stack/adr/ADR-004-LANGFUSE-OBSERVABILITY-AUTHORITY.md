# ADR-004: Langfuse Is the Observability and Usage Analytics Authority

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

AI Office wants token usage, cost, latency, model/provider breakdown, trace history, and filters. Reimplementing this creates another ingestion/storage/query/dashboard subsystem.

LiteLLM already integrates with Langfuse, and Langfuse provides usage/cost model definitions, traces, metadata, dashboards, and Metrics API.

## Decision

Use Langfuse for detailed observability and historical analytics.

AI Office stores no duplicate raw generation ledger. It may query aggregate summaries and link to Langfuse detailed views.

## Consequences

- custom usage/cost code is greatly reduced;
- trace schema evolves with an observability-focused upstream project;
- prompt/code privacy must be configured deliberately;
- self-hosting Langfuse is optional and not required for the first V3 vertical slice.

## Availability rule

Langfuse outage should normally degrade observability without stopping OpenHands coding execution.
