# Pixel V4 Greenfield Kernel

## Shape

model-control-plane/src/v4 is a unified modular monolith:

- domain: plan, execution, review, supervisor, action, resource, errors
- kernel: plan, execution, review, recovery, delivery
- persistence: schema, event store, repositories, projections
- supervisor: projection, decision, validator, scheduler
- adapters: OpenHands, Jules, GitHub, Anti-Gravity
- api: V4 routes

## Event model

All durable changes append immutable events to events. Projections are rebuildable. Every event has eventId, aggregateId, aggregateType, sequence, type, payload, occurredAt and correlationId. No accepted history is overwritten.

## Runtime boundary

SupervisorDecision is read-only. SupervisorActionExecutor is the only supervisor effect entry point and delegates to V4 kernel ports. Kernel owns workspace, execution, review, resource, GitHub and deployment effects.

## Database

SQLite runs in WAL mode with foreign_keys=ON and busy_timeout. schema-v4.sql creates events, plans, work_items, executions, reviews, supervisors, supervisor_decisions, supervisor_actions, leases, resources and external_changes. reset-v4-database.ts requires explicit reset authorization.

## Non-goals

No V3 compatibility, V3 table preservation, legacy plan recovery, additive migration, hidden nested agents or autonomous production deployment in the first implementation wave.
