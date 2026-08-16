# Technical Stack Decision V2

## 1. Decision summary

V2 should be implemented as a **modular monolith plus a replaceable external model gateway**.

The first implementation deliberately avoids new distributed infrastructure.

```text
Hermes / Codex / OpenCode
        |
        | runtime observations + route selection
        v
AI Workforce Domain Service
Node.js + TypeScript + Fastify
        |
        | SQLite facts/events
        +-------------------+
        |                   |
        v                   v
Gateway Ports          Projection API/SSE
        |
        v
LiteLLM Proxy (reference)
CPA adapter (compatibility)
        |
        v
Providers
```

Concrete choices:

| Concern                | Decision                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Domain service shape   | one Node.js process, modular monolith                                                              |
| Production Node        | keep pinned Node 24 runtime already used by systemd until an explicit runtime upgrade              |
| Domain language        | TypeScript for V2 and progressively for the existing control-plane package                         |
| HTTP/API               | Fastify 5                                                                                          |
| API validation/types   | JSON Schema through Fastify, with TypeBox type provider for V2 route contracts                     |
| Database               | SQLite, WAL, foreign keys                                                                          |
| SQLite driver          | `node:sqlite` behind a tiny database port; no ORM in the first phases                              |
| Migrations             | explicit ordered SQL migrations with checksums                                                     |
| Transactions           | explicit application-service transaction boundaries                                                |
| Events                 | append-only SQLite event table + SSE replay; no Kafka/NATS/Redis                                   |
| Gateway                | LiteLLM Proxy as reference adapter; CPA remains compatibility adapter                              |
| Gateway deployment     | isolated Docker container, loopback only, pinned tested image/digest                               |
| LiteLLM backing DB     | none for the first vertical slice                                                                  |
| LiteLLM Redis          | none for the first vertical slice                                                                  |
| Secrets                | gateway/environment/secret-manager owned; never stored in V2 business tables                       |
| Frontend               | existing React 19 + Vite + Tailwind; no new state library initially                                |
| Frontend data          | purpose-built projection endpoints + fetch/EventSource                                             |
| Unit/integration tests | Vitest for new TypeScript V2 code; retain V1 node:test tests until migrated                        |
| E2E/contract tests     | current Playwright where browser behavior matters; HTTP fixture servers for gateway contracts      |
| Observability          | Fastify structured logs + correlation IDs + V2 business events; no new telemetry backend initially |

The implementation goal is not to maximize architectural machinery. It is to make business identity and history correct while outsourcing generic model transport.

## 2. Why a modular monolith

The system is currently single-owner, single-host, and modest write volume. The domain objects need strong transactional relationships:

```text
DispatchDecision + StaffingSegment
Employment transition + business event
InvocationAttempt + UsageEntry
Appointment transition + business event
```

Putting these into separate services now would require distributed consistency, more deployment units, more failure modes, and message infrastructure without adding product value.

The internal module boundaries should still mirror the bounded contexts:

```text
model-control-plane/src/
  app/
  api/
  config/
  db/
  organization/
  workforce/
  staffing/
  execution/
  ledger/
  events/
  projections/
  gateways/
```

These are code ownership boundaries inside one process, not microservices.

A future split is allowed only when measured operational pressure appears.

## 3. TypeScript migration strategy

The deployed control plane is currently a small ESM JavaScript package. V2 adds enough identities, state transitions, API DTOs, and adapter contracts that TypeScript becomes worth the one-time conversion cost.

Recommended migration:

1. capture V1 endpoint/database behavior with characterization tests;
2. add a strict `model-control-plane/tsconfig.json`;
3. convert the small existing package from `.mjs` to `.ts` without changing behavior;
4. compile to `model-control-plane/dist/`;
5. switch systemd from `src/server.mjs` to `dist/server.js` only after fixture parity;
6. build V2 modules on that typed foundation.

Do not run TypeScript loaders in production. Production should run compiled JavaScript with the pinned Node runtime.

### Package/workspace cleanup

`model-control-plane` should become an explicit npm workspace/package rather than accidentally consuming dependencies from the repository root.

It should declare its own runtime dependencies, while npm may still hoist them physically.

This fixes an existing hidden coupling without creating a new service.

## 4. Fastify and API schemas

Keep Fastify 5. It is already used by both the repository server and control plane.

For V2 endpoints, use Fastify JSON Schema validation and the official Type Provider mechanism. TypeBox is preferred because one declaration can serve as:

- request/response JSON Schema;
- runtime validation input;
- TypeScript type source.

Rules:

1. every `/api/v2` command body has an explicit schema;
2. response schemas exist for stable public/projection endpoints;
3. domain entities are not exposed by serializing database rows directly;
4. adapter-specific payloads stop at the gateway adapter boundary;
5. unknown properties are rejected on security-sensitive commands.

No GraphQL or tRPC is needed. The product already has explicit command/query semantics and SSE.

## 5. SQLite decision

Continue SQLite for V2.

Reasons:

- current production already runs it successfully;
- one host is authoritative;
- write volume is small;
- business transitions benefit from local ACID transactions;
- backup/rollback is simple;
- introducing Postgres would not remove meaningful application code in the first phase.

### No ORM initially

Do **not** add Prisma/Drizzle/another ORM in the first implementation.

The V2 schema has temporal constraints and append-only facts where explicit SQL is easier to review:

- one open StaffingSegment per DutySession;
- closed temporal rows are not rewritten;
- events and state changes commit atomically;
- migration/reconciliation queries need precise legacy joins.

Use:

```text
SQL migration files
  -> migration runner
  -> small typed repositories
  -> application services
```

Do not allow route handlers to issue SQL directly.

### Isolate `node:sqlite`

The Node documentation still marks the built-in SQLite API below full stable status in current Node documentation. We already use it successfully, so replacing it now would add deployment/native-module work without product benefit.

Therefore:

```text
Domain/Application
      |
      v
DatabasePort / repositories
      |
      v
NodeSqliteDatabase
```

If the built-in API becomes problematic, a `better-sqlite3` or other SQLite adapter can replace only this infrastructure layer.

### Migration runner

Use a table similar to:

```text
v2_schema_migrations
- version
- name
- checksum
- applied_at
```

Migration files are immutable after merge. Startup validates checksums and applies missing migrations inside transactions.

## 6. State model: not full event sourcing

V2 should **not** be implemented as a full event-sourced system.

Canonical current/temporal state lives in normal tables. Business events are append-only audit/outbox facts committed in the same transaction.

Example:

```text
BEGIN
  INSERT dispatch_decision
  INSERT staffing_segment
  INSERT event(dispatch.decided)
  INSERT event(staffing_segment.started)
COMMIT
```

SSE reads the durable event table by sequence number and can replay after reconnect.

This gives auditability without event-sourcing reconstruction complexity.

## 7. Projection strategy

Start with SQL/query-service projections, not a second projection database.

```text
canonical V2 tables
      |
      v
projection query service
      |
      +-> /projections/office
      +-> /projections/workforce
      +-> /employees/:id/dossier
      +-> /positions/:id/dossier
```

Only materialize a projection table when profiling proves the joins are too expensive.

The browser must never reconstruct business truth by joining many raw endpoints.

## 8. Gateway deployment decision

LiteLLM should run outside the Node process.

Use the official Docker image, pinned to a tested release/digest, listening on loopback. Oracle2 is ARM64 and the current LiteLLM image manifest includes a Linux ARM64 image, so container isolation is practical on the target host.

Initial topology:

```text
127.0.0.1:8320  AI Workforce Domain Service
127.0.0.1:4000  LiteLLM reference gateway
127.0.0.1:8317  CPA compatibility gateway (while needed)
```

Suggested tracked deployment files:

```text
model-control-plane/deploy/litellm/
  config.yaml             # no secrets
  hermes-litellm.service  # or equivalent container unit
  README.md
```

Secrets live outside git, for example under a root-readable/user-readable host secret directory, and are injected as environment variables.

### No Postgres/Redis in the first slice

LiteLLM can run as a simple proxy from config/model definitions. Its richer proxy architecture can use PostgreSQL for persisted keys/teams/spend and Redis for rate-limit/cache/cooldown coordination, but those capabilities are not required for the first single-user vertical slice.

Do not add Postgres/Redis just because LiteLLM supports them.

First slice requirements are only:

- OpenAI-compatible model endpoint;
- Responses API for clients that need it;
- streaming;
- one Employment-scoped model group;
- retry/load balancing only across equivalent deployments;
- basic health/usage evidence sufficient for the adapter contract.

Add LiteLLM database/Redis infrastructure later only if a real feature requires virtual-key persistence, multi-user budget enforcement, shared multi-pod coordination, or other DB-backed gateway features.

## 9. Gateway route binding: avoid dynamic admin first

Do not make automatic LiteLLM configuration mutation a prerequisite for V2.

The first implementation should use an explicit safe binding:

```text
Employment
  -> GatewayBinding
       gatewayId
       externalRouteRef
       protocol
```

Example:

```text
Employment empl_123
  -> GatewayBinding bind_123
       gateway = litellm-reference
       externalRouteRef = opencode-go-deepseek
```

The LiteLLM model group can be created with its normal config tooling. V2 merely references it.

This is simpler than requiring the domain service to create/edit gateway models and avoids a secret-bearing GatewayAdminPort.

`employment:<id>` remains a useful naming convention, not a hard protocol requirement.

`GatewayBinding` is an infrastructure mapping, not a new business identity. It prevents an ambiguous join when one SupplyAgreement exposes several Employees/models.

Suggested persistence shape:

```text
v2_gateway_bindings
- id
- employment_id
- gateway_id
- external_route_ref
- protocol
- lifecycle
- priority
- metadata_json
```

Physical `Channel`/deployment records can be discovered later and attached to InvocationAttempt evidence. They are not required to configure the first slice.

## 10. Model request data path

The domain service should stay **out of the token streaming path**.

Do not implement an OpenAI-compatible reverse proxy inside the control plane.

Preferred flow for the first vertical slice:

```text
1. DutySession starts
2. domain Dispatch selects Employee
3. domain selects Employment + GatewayBinding
4. runtime session is launched/configured with:
     base URL = LiteLLM
     model = externalRouteRef
5. runtime calls LiteLLM directly
6. runtime/gateway adapter reports InvocationAttempt + Usage evidence back to V2
```

This is why the first real position should be a Codex/OpenCode-style execution position whose model/base URL can be selected at process/session launch, rather than the long-lived Hermes brain.

Later, long-lived runtimes can use a route-resolution plugin/lease mechanism if they need per-invocation Employment changes.

## 11. Invocation and usage correlation

Business correlation must not require the domain service to proxy model bytes.

Use a staged approach.

### Stage A — runtime-known correlation

When the launcher/runtime adapter knows the DutySession and selected Employment, it creates/records the ModelInvocation and reports usage after completion when the runtime exposes it.

### Stage B — gateway evidence

Add a LiteLLM adapter/callback only after the Gateway Contract proves the required correlation fields are observable. The adapter may normalize:

- gateway request ID;
- route/model group;
- physical deployment;
- token counts;
- latency;
- provider/gateway cost;
- status/error.

A small gateway callback/webhook is acceptable infrastructure code. It must remain optional and cannot define Employee identity.

### Correlation IDs

Use stable opaque IDs in request metadata/headers when a runtime/gateway supports them:

```text
runId
dutySessionId
invocationId
employmentId
```

Do not depend on model prompt contents for correlation.

## 12. Frontend stack

Keep the existing UI stack:

- React 19;
- Vite;
- Tailwind CSS;
- Vitest;
- existing pixel/animation code.

Do not add Redux/Zustand/React Query in the first V2 work.

The server owns the complex projections. The browser needs only:

```text
initial projection fetch
+ EventSource updates
+ targeted refetch after relevant event
```

Implement a small typed API client and a projection store/context using React primitives. Add a state/query library only if actual UI complexity proves it useful.

## 13. Testing stack

### V1 characterization

Keep current node:test tests while they protect existing behavior.

### V2 TypeScript

Use Vitest because it already exists in the repository and works directly with TypeScript.

Required layers:

1. pure domain tests;
2. repository tests against temporary SQLite databases;
3. command/application service transaction tests;
4. Fastify API integration tests via `app.inject()`;
5. gateway port contract tests against deterministic fake servers;
6. LiteLLM smoke/contract tests against the pinned container;
7. CPA compatibility contract tests;
8. browser tests only for projection rendering/interaction behavior.

No test should require real paid provider traffic unless explicitly marked as a manual/smoke test.

## 14. Configuration and feature flags

Use startup-validated configuration.

Examples:

```text
MODEL_CP_DB
MODEL_CP_HOST
MODEL_CP_PORT
MODEL_CP_V2_ENABLED
MODEL_CP_V2_POSITION_IDS
LITELLM_BASE_URL
LITELLM_INTERNAL_KEY_FILE
```

Secret values are read from files/environment and represented in logs only as redacted presence/absence.

Prefer persisted V2 cutover records for historical authority. Environment flags are operational kill switches, not business history.

## 15. Observability

Do not introduce a new observability stack initially.

Use:

- Fastify structured logs;
- request/correlation IDs;
- gateway adapter logs with secret redaction;
- V2 business event stream;
- explicit reconciliation reports;
- `/api/health` and gateway health summaries.

Later OpenTelemetry/Langfuse/etc. may be added for debugging model traffic, but they are not prerequisites for domain correctness.

## 16. Explicit non-choices

For the first V2 implementation, do not introduce:

- NestJS;
- GraphQL;
- tRPC;
- Prisma;
- Drizzle;
- Postgres for the Hermes business domain;
- Redis;
- Kafka/NATS/RabbitMQ;
- Kubernetes;
- separate services per bounded context;
- a new frontend state framework;
- a second model proxy inside Node;
- automatic LiteLLM admin/config mutation;
- full event sourcing.

Each may become valid later, but none currently removes more complexity than it adds.

## 17. Revisit triggers

Reconsider a choice only when one of these becomes true:

- SQLite write contention or database size becomes measurable;
- multiple hosts need concurrent authoritative writes;
- LiteLLM HA requires shared coordination;
- many human users require gateway virtual-key/team budgets;
- projections become too expensive for on-demand SQL;
- the control-plane process becomes operationally too coupled to split safely;
- runtime clients require a uniform per-request route resolver that cannot be integrated without a dedicated routing facade.

## 18. External technical references

Primary references used for this decision:

- [LiteLLM Getting Started](https://docs.litellm.ai/) — Proxy/SDK roles, OpenAI-compatible endpoints, streaming, routing and cost/usage capabilities.
- [LiteLLM Architecture](https://github.com/BerriAI/litellm/blob/litellm_internal_staging/ARCHITECTURE.md) — Proxy, Router, PostgreSQL/Redis-backed advanced infrastructure boundaries.
- [Fastify Type Providers](https://fastify.dev/docs/latest/Reference/Type-Providers/) — official TypeBox/JSON-Schema type-provider integration.
- [Fastify Validation and Serialization](https://fastify.dev/docs/v5.8.x/Reference/Validation-and-Serialization/) — JSON Schema/Ajv request and response validation behavior.
- [Node.js SQLite documentation](https://nodejs.org/api/sqlite.html) — built-in SQLite API and current stability designation.

External gateway behavior remains subject to contract tests against the exact pinned version used in deployment.
