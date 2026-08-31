# ADR-002: Pixel Agent V4 Greenfield Rebuild

- Status: Accepted
- Date: 2026-08-31
- Supersedes: ADR-001 compatibility and additive-migration assumptions

## Decision

Pixel Agent V4 is a greenfield control-plane rebuild. V3 data, tables, APIs and coordinator internals are disposable and are not compatibility contracts. V4 uses one unified kernel, one event model and one orchestration authority.

A fresh V4 database may discard all existing data only when PIXEL_V4_ALLOW_DATA_RESET=true is explicitly set. Default startup fails closed if reset is required but not authorized. Production reset and deployment remain separate gated operations.

## Architecture

V4 owns Plan, WorkGraph, Execution, Review, Recovery, Supervisor, Resource, Delivery and Audit domains. AI proposes typed actions; the deterministic V4 kernel validates and performs effects. There is no V3/V4 dual runtime and no second coordinator.

## Persistence

Use a fresh SQLite WAL database for the single control-plane deployment. Persist immutable events and build projections for plans, executions, supervisors, actions, resources and delivery. The schema is rebuilt from schema-v4.sql/bootstrap-v4.ts; additive V3 migration is not required.

## Safety

Data loss is explicit, observable and operator-authorized. Models never receive credentials or direct workspace, merge, deployment or arbitrary shell authority. Accepted review and delivery gates remain exact and fail closed.

## Consequences

The implementation is smaller and faster: no compatibility adapters, no legacy recovery path and no duplicate V3/V4 domain. The cost is a deliberate cutover and loss of old durable data.
