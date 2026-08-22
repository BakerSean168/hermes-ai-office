# Hermes AI Workforce Control Plane

The service now hosts two deliberately separated planes: the retained V2 workforce/business domain and the production V3 development execution facade. The authoritative V2 domain model is [`../docs/DOMAIN-MODEL-V2.md`](../docs/DOMAIN-MODEL-V2.md); V3 execution policy is documented under [`../docs/implementation-v3-open-source-stack/`](../docs/implementation-v3-open-source-stack/).

For current AI Office V3, **LiteLLM is the single runtime authority for provider credentials, model deployments, routing, health, and spend**. The legacy V2 Provider Hub remains in SQLite only for rollback/forensic compatibility and migration evidence; the AI Office dashboard and V3 execution path do not use it for provider management.

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

## Runtime provider and gateway boundary

V3 coding Agents consume stable logical model classes through LiteLLM. Provider credentials live in LiteLLM Credential Store, model deployments live in its PostgreSQL-backed registry, and routing/fallback/health/spend are owned there. AI Office exposes a secret-free read-only projection at `GET /api/v3/development/model-registry`; mutations belong to LiteLLM Admin/API.

The control plane never echoes provider credential values. Its V3 registry adapter reads only safe names, deployment metadata, blocked state, order, aliases, and selected economics/protocol annotations. OpenHands/OpenCode workers receive only the scoped LiteLLM runtime key, never the LiteLLM master credential.

Native subscription transports that are not representable as an API-key provider remain execution-host capabilities rather than LiteLLM provider records. They do not make Provider Hub a second provider authority.

The older V2 workforce model (`Supplier`, `SupplierModel`, `Employment`, `RuntimeAccessProfile`, Provider Hub) is retained for business history and emergency rollback compatibility. New V3 provider/model administration must not be added there. CPA remains a compatibility/account-pool adapter for legacy V2 evidence; it is not the V3 model-provider control plane.

## API

The service exposes the retained V2 domain surface plus the V3 development facade. Current provider/model runtime authority is visible through V3.

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
- `GET /api/v2/runtime-access-profiles`
- `POST /api/v2/commands/execution/resolve` — per-execution intent-to-Employee placement; intent selects the work class, the chosen model family selects the preferred harness, and current compatibility selects the actual harness
- `GET /api/v2/incidents`
- `GET /api/v2/events` (SSE)

V2 commands cover organization, staffing, lifecycle, run/duty dispatch, runtime access, invocation, finance/evaluation, gateway discovery/reconciliation, incident operations and safe maintenance. Runtime-access commands contain only safe references and use normal persistent idempotency. The internal Employment gateway-provisioning endpoint remains an optional compatibility path and deliberately bypasses persisted idempotency request storage because it may carry ephemeral secret material.

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

Production on oracle2 uses `deploy/hermes-model-control-plane.service` plus `deploy/hermes-model-control-plane.service.d/v3-production.conf`, binds to `127.0.0.1:8320`, and stores retained V2 SQLite state at:

```text
/srv/hermes-personal/data/model-control-plane/control-plane.sqlite
```

The canonical checkout is `/home/ubuntu/projects/pixel-agents`. Install/update the systemd definition with `sudo ./model-control-plane/deploy/install-oracle2-systemd.sh`; the script restarts only the model control plane, not the Hermes Gateway. The V3 drop-in also publishes the tailnet-only LiteLLM Admin URL (`https://oracle.taile92a8e.ts.net:10446/ui/`) to the read-only AI Office registry projection.

A release rebuilds the control-plane artifact, restarts only `hermes-model-control-plane`, then verifies V2 health, V3 health, `GET /api/v3/development/model-registry`, LiteLLM health, Hermes execution sync, SQLite integrity, and foreign keys.
