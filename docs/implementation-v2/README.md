# Hermes AI Office V2 — Implementation Documentation

**Status:** implementation-preparation package  
**Authority:** subordinate to [`../DOMAIN-MODEL-V2.md`](../DOMAIN-MODEL-V2.md) for domain semantics and [`../HERMES-AI-OFFICE-PRD.md`](../HERMES-AI-OFFICE-PRD.md) for product goals.

This directory translates Domain Model V2 into concrete engineering contracts. It is intentionally split by concern so implementation work can change one boundary without redefining the whole product.

## Document map

| Document                                             | Purpose                                                                        | Primary consumers            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                 | service boundaries, ownership, control/data flow, protected contracts          | architects, implementers     |
| [`GATEWAY-STRATEGY.md`](GATEWAY-STRATEGY.md)         | gateway-neutral ports, LiteLLM reference adapter, CPA compatibility boundary   | gateway/runtime implementers |
| [`TECH-STACK.md`](TECH-STACK.md)                     | concrete language, database, API, gateway, deployment and test stack decisions | implementation owners        |
| [`FIRST-VERTICAL-SLICE.md`](FIRST-VERTICAL-SLICE.md) | smallest execution-ready V2 business spine and batch sequence                  | implementation agents        |
| [`PERSISTENCE.md`](PERSISTENCE.md)                   | V2 logical schema, temporal records, indexes, retention, compatibility mapping | backend/database work        |
| [`API-CONTRACT.md`](API-CONTRACT.md)                 | `/api/v2` commands, queries, errors, idempotency, compatibility                | MCP + Pixel backend          |
| [`EVENT-CONTRACT.md`](EVENT-CONTRACT.md)             | business event envelope, ordering, replay, correlation, SSE semantics          | MCP + UI + observers         |
| [`WORKFLOWS.md`](WORKFLOWS.md)                       | end-to-end business flows and failure behavior                                 | product + engineering        |
| [`PROJECTIONS.md`](PROJECTIONS.md)                   | read models, dashboards, employee/position pages, Office animation semantics   | frontend + projection layer  |
| [`MIGRATION.md`](MIGRATION.md)                       | legacy-to-V2 migration, dual-read/write strategy, rollback                     | migration owners             |
| [`ROADMAP.md`](ROADMAP.md)                           | phased execution plan and ticket boundaries                                    | implementation agents        |
| [`VERIFICATION.md`](VERIFICATION.md)                 | acceptance evidence and regression matrix                                      | reviewers + release checks   |

## Authority rules

1. Domain identity and lifecycle rules come from `DOMAIN-MODEL-V2.md`.
2. Product goals and user-facing outcomes come from `HERMES-AI-OFFICE-PRD.md`.
3. This package may make engineering decisions only where they do not contradict those two documents.
4. Existing `/api/v1`, Pixel Office routes, bridge SSE, current CPA/gatewayctl behavior, and current service ports are protected **migration compatibility contracts**, not north-star dependencies.
5. Gateway-neutral V2 boundaries and the LiteLLM reference strategy are defined in `GATEWAY-STRATEGY.md`.
6. Existing data is evidence. Migration must preserve observed history rather than invent precision that was never captured.

## Current-system baseline

The deployed control plane currently uses SQLite tables centered on:

```text
providers
channels
model_definitions
workers                  // legacy Channel x Model business identity
profiles
positions
assignments
quotas
contracts
prices
runs
usage_ledger
events
external_usage_snapshots
```

The deployed HTTP surface is `/api/v1/*`, including workforce snapshot, worker/assignment CRUD, resolve, CPA sync, usage sync, stats, events, and channel actions. This is the **current-state baseline only**. V2 core contracts name generic gateway concepts rather than CPA-specific ones.

The V2 documents therefore assume a compatibility period in which:

```text
legacy V1 model + projections
          coexist with
V2 domain tables + /api/v2 + V2 events
```

The migration plan decides when each read/write path becomes authoritative.

## Definition of implementation-ready

The project is ready to begin V2 code work when this package is internally consistent on:

- canonical IDs and state ownership;
- table/record boundaries and temporal semantics;
- command/query/API responsibilities;
- event ordering and replay;
- complete vertical workflow for one Position and one Employee;
- compatibility strategy for V1 clients;
- rollback and verification evidence.
