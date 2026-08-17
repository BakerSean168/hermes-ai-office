# Hermes AI Office V2 — Implementation Documentation

**Status:** deployed V2-only production architecture; V1 runtime compatibility retired on 2026-08-16
**Authority:** subordinate to [`../DOMAIN-MODEL-V2.md`](../DOMAIN-MODEL-V2.md) for domain semantics and [`../HERMES-AI-OFFICE-PRD.md`](../HERMES-AI-OFFICE-PRD.md) for product goals.

This directory records both the current engineering contracts and the historical migration plan that produced them. Statements in migration/first-slice sections that say “V1 remains authoritative” describe completed migration phases, not current production behavior.

## Document map

| Document                                               | Purpose                                             | Current interpretation                             |
| ------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------- |
| [`IMPLEMENTATION-STATUS.md`](IMPLEMENTATION-STATUS.md) | deployed capabilities and release evidence          | **current production truth**                       |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                   | service boundaries, ownership and control/data flow | current, with historical migration notes           |
| [`GATEWAY-STRATEGY.md`](GATEWAY-STRATEGY.md)           | gateway-neutral ports and CPA/LiteLLM boundaries    | current                                            |
| [`TECH-STACK.md`](TECH-STACK.md)                       | language, database, API, deployment and test stack  | current decisions + completed migration notes      |
| [`PERSISTENCE.md`](PERSISTENCE.md)                     | V2 schema, temporal records, retention              | current                                            |
| [`API-CONTRACT.md`](API-CONTRACT.md)                   | `/api/v2` commands, queries, errors, idempotency    | current                                            |
| [`EVENT-CONTRACT.md`](EVENT-CONTRACT.md)               | event envelope, ordering, replay and SSE            | current                                            |
| [`WORKFLOWS.md`](WORKFLOWS.md)                         | end-to-end business flows and failure behavior      | current                                            |
| [`PROJECTIONS.md`](PROJECTIONS.md)                     | Office/workforce read models and dossiers           | current                                            |
| [`MIGRATION.md`](MIGRATION.md)                         | legacy-to-V2 migration and rollback plan            | historical plan + completed cutover record         |
| [`FIRST-VERTICAL-SLICE.md`](FIRST-VERTICAL-SLICE.md)   | first implementation slice                          | historical implementation plan                     |
| [`ROADMAP.md`](ROADMAP.md)                             | phased execution plan                               | completed V1-retirement milestone + future V2 work |
| [`VERIFICATION.md`](VERIFICATION.md)                   | acceptance and regression evidence                  | current release gate                               |

## Current production baseline

The running control plane is V2-only:

```text
Hermes Bridge / OrgStore
        │ normalized latest-wins execution snapshots
        ▼
AI Workforce Control Plane
        ├── Organization
        ├── Workforce Supply
        ├── Staffing
        ├── Execution + Usage
        ├── Finance + Evaluation
        └── Incident / Maintenance projections
        │
        ├── LiteLLM Gateway port
        └── CPA Gateway port (route/health/usage evidence only)

Pixel Office
        └── explicit /api/model/v2/* read + SSE facade
```

Production has no V1 HTTP routes, V1 Office facade, V1 CPA synchronization loop, V1 `position:*` alias reconciliation loop, or `ControlPlaneStore` runtime. Fresh databases are created exclusively by checksum-verified V2 migrations.

The pre-V2 tables still physically exist in the long-lived production SQLite file as historical evidence. They are not dropped, read, written, or created for a fresh V2 database.

## Protected operational boundaries

- Hermes Bridge SSE and normalized OrgStore execution facts remain the runtime observation source.
- `/api/v2/*` is the business/control API.
- `/api/model/v2/*` is the Office read/SSE facade.
- Provider/gateway credentials remain outside the business domain. LiteLLM credentials live in its protected credential boundary; CPA compatibility credentials remain behind `gatewayctl` while that adapter exists.
- Existing durable V2 gateway/binding IDs are preserved across adapter refactors.
- Historical business evidence is retained rather than destructively normalized.

## Release rule

A production batch is complete only after tests/build, secret scan, commit/push, SQLite backup when persistence/cutover risk exists, service restart, live V2 checks, identity invariants, retired-route assertions where relevant, and SQLite integrity/foreign-key verification.
