# Pixel Agent V4 Greenfield Control Plane

This service is the V4 control plane. It is a deliberate greenfield cutover: V3 tables, APIs, coordinators, and recovery compatibility are not runtime contracts.

## Runtime boundary

The deterministic V4 kernel owns state transitions, immutable event history, leases, exact execution/review lineage, resource gates, graph revisions, and delivery gates. AI supervisors receive bounded projections and emit versioned typed actions. The supervisor has no workspace, shell, credential, merge, or deployment authority.

## Persistence

The service bootstraps a fresh SQLite WAL database from the V4 schema. Existing non-V4 databases fail closed unless PIXEL_V4_ALLOW_DATA_RESET=true is explicitly set. Production reset is always refused by default, and reset is never part of ordinary startup for an existing V4 database.

## API

- GET /api/health
- POST /api/v4/plans
- GET /api/v4/plans/:planId
- GET /api/v4/supervisors/:supervisorId/projection
- POST /api/v4/supervisors/:supervisorId/decisions

No route starts a worker or performs a real merge/deployment.
