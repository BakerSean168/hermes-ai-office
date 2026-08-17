# Hermes AI Workforce Control Plane

The Model Control Plane is the V2 business authority for the Hermes AI company. The authoritative domain model is [`../docs/DOMAIN-MODEL-V2.md`](../docs/DOMAIN-MODEL-V2.md), with deployed engineering status in [`../docs/implementation-v2/IMPLEMENTATION-STATUS.md`](../docs/implementation-v2/IMPLEMENTATION-STATUS.md).

## Responsibilities

The service owns four business boundaries:

- **Organization:** WorkScope, RoleDefinition, PositionTemplate, Position and PositionRelation.
- **Workforce supply:** Supplier, SupplierModel, Plan, ModelOffering, SupplyAgreement, Employment, Employee, Channel and CapacityPool.
- **Staffing:** capability evidence, requirements, qualification, StaffingRule, Appointment, StaffingConstraint, DispatchDecision and StaffingSegment.
- **Execution and evidence:** Run, DutySession, RuntimeSession, ModelInvocation, InvocationAttempt, UsageEntry, Evaluation, Incident and projection checkpoints.

The identity rules are strict:

```text
Position != Employee != RuntimeSession != Gateway/Channel
Appointment != actual work
DutySession + open StaffingSegment = actual work now
Employee identity = Supplier x SupplierModel
Employment = one concrete commercial access period
```

Runtime model hints never create Employee identity. Gateway health changes routability, not durable workforce identity.

## Gateway boundary

Model transport is delegated through gateway ports. The current adapters are:

- **LiteLLM Gateway** as the reference generic gateway.
- **CPA Gateway** as an adapter for subscription/provider routes that are already managed through CPA/gatewayctl.

The MCP reads gateway route/health/usage evidence through adapters. It does not persist provider credentials in the workforce database. Explicit supplier onboarding may pass secret material ephemerally to a provisioning-capable adapter; the LiteLLM adapter stores it in LiteLLM Credential Store and returns only safe route/deployment references.

Gateway discovery records technical evidence only. Commercial Supplier/SupplierModel/Agreement identity is created through explicit V2 catalog registration, never inferred solely from a Channel name. Unclassified routes remain visible in the Supply projection until an operator supplies business identity.

CPA operational changes such as adding a channel, changing a secret, enabling/disabling a route, quarantine, or manual alias surgery belong to `gatewayctl` / the dedicated model-gateway management workflow. They are intentionally not exposed through Pixel Office.

The durable CPA gateway id remains `cpa-compat` for existing V2 binding continuity. The name is an external reference, not a V1 Worker compatibility model.

## API

The public control-plane surface is V2 only.

Primary reads include:

- `GET /api/health`
- `GET /api/v2/health`
- `GET /api/v2/projections/workforce`
- `GET /api/v2/projections/supply`
- `GET /api/v2/projections/office`
- `GET /api/v2/projections/positions/:positionId/dossier`
- `GET /api/v2/projections/runs/:runId/dossier`
- `GET /api/v2/employees`
- `GET /api/v2/employments`
- `GET /api/v2/appointments`
- `GET /api/v2/positions`
- `GET /api/v2/gateways`
- `GET /api/v2/channels`
- `GET /api/v2/runtime-sessions`
- `GET /api/v2/incidents`
- `GET /api/v2/events` (SSE)

V2 commands cover organization, staffing, lifecycle, run/duty dispatch, invocation, finance/evaluation, gateway discovery/reconciliation, incident operations and safe maintenance. The internal Employment gateway-provisioning endpoint deliberately bypasses the generic persisted idempotency request cache so secret material cannot be retained there; provisioning itself is naturally idempotent by Employment route and gateway credential identity.

`/api/v1/*` was retired in the V1-removal release. Pixel Office exposes only explicit `/api/model/v2/*` read/SSE facade routes.

## Hermes execution projection

HermesProvider/OrgStore normalizes Bridge observations and sends latest-wins snapshots to:

```text
POST /api/v2/internal/hermes/sync
```

The projection maps runtime facts without fabricating workforce identity:

```text
ProfileController -> WorkScope + standing Profile Lead Position
Run               -> V2 Run
ExecutionNode     -> run-scoped Position + DutySession + RuntimeSession
ExecutionEdge     -> RuntimeEdge and valid PositionRelation
```

A transiently missing runtime closes its current DutySession but preserves RuntimeSession history. Reappearance can open a new Duty without creating a new Employee.

## Persistence

SQLite schema ownership is exclusively through checksum-verified additive migrations under `src/v2/migrations/`.

`openDb()` only opens SQLite and applies database pragmas; it no longer creates the retired V1 Provider/Worker/Assignment schema. Existing production V1 tables are intentionally left in the current database as historical evidence and rollback archaeology, but no running code reads or writes them and a fresh database does not create them.

Core business history is retained. Automatic maintenance is limited to explicitly ephemeral replay-cache cleanup and repair of stale operational sync records.

## Background jobs

The V2 service runs:

- gateway discovery reconciliation;
- gateway usage reconciliation;
- incident projection;
- safe maintenance;
- CPA route health probes when the CPA gateway adapter is enabled.

There is no V1 CPA synchronization loop and no `position:*` alias reconciliation loop.

## Pixel Office

Pixel Office consumes purpose-built V2 projections and V2 SSE only. It does not join SQLite tables, read gateway secrets, expose V1 workers/assignments, or forward CPA administration requests.

The AI Workforce panel therefore shows durable Employees, current Appointments/work and gateway binding summaries rather than legacy Channel x Model workers.

## Deployment

Production on oracle2 uses `deploy/hermes-model-control-plane.service`, binds to `127.0.0.1:8320`, and stores SQLite state at:

```text
/srv/hermes-personal/data/model-control-plane/control-plane.sqlite
```

The release process performs a SQLite online backup before a control-plane cutover, rebuilds MCP/Office artifacts, restarts services, then verifies V2 health, Hermes execution sync, workforce identity counts, retired-route 404s, SQLite integrity and foreign keys.
