# Pixel V4 Greenfield Parallel Delivery Plan

## Workstreams

A Foundation: domain types, schema-v4, event store, repositories, leases and reset tests.
B Kernel: plan, graph, execution, review, recovery and delivery.
C Supervisor: projection, decision schema, validator, scheduler and OpenHands host.
D Maintenance: MaintenanceProgram, Jules, GitHub, Anti-Gravity and exact-SHA delivery.
E Verification: replay fixtures, concurrency tests, architecture tests, dashboards and runbooks.

## Dependency graph

A has no dependency. B and C depend on A interfaces. E starts with A test harness and completes with B/C/D. D depends on B and C. Canary depends on all streams.

A-001 || A-002 || E-001 || E-003
A-003 -> B-001 || C-001 || E-002
A-004 -> B-002 || C-002
B-002 || B-003 -> C-003
C-002 -> C-004
B-003 || C-003 -> D-001 -> D-002 -> D-003
A/B/C/D/E -> V4-014 shadow -> V4-015 canary

## Delivery rules

Each ticket uses a dedicated worktree and commit. No two agents edit the same worktree. Each ticket must state files, tests and non-goals. Sol or Terra reviews architecture and concurrency boundaries; Luna implements contract-frozen modules and tests.

## Cutover

Build a new V4 database, run replay and canary checks, stop the old service at a zero-writer boundary, start V4 with reset authorization, verify health, then enable external maintenance. Rollback means starting the last verified V4 build; old V3 data is not restored.
