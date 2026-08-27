# API contract

Base service: `http://127.0.0.1:8320`

Read APIs:

- `GET /api/health`
- `GET /api/v3/health`
- `GET /api/v3/development/runtime-summary`
- `POST /api/v3/development/delegations`
- `GET /api/v3/development/readiness`
- `GET /api/v3/development/model-registry`
- `GET /api/v3/development/executions?limit=5000&hydrate=1`
- `GET /api/v3/development/executions/:executionId`
- `GET /api/v3/development/plans?limit=100`
- `GET /api/v3/development/plans/:planId[?hydrate=true]`

Write APIs:

- `POST /api/v3/development/executions`
- `POST /api/v3/development/executions/:executionId/cancel`
- `POST /api/v3/development/plans`
- `POST /api/v3/development/plans/:planId/reconcile`
- `POST /api/v3/development/plans/:planId/cancel`

New execution and plan creation requests require an `Idempotency-Key`. Recovery and
cancellation are plan-scoped and idempotent; raw execution continuation is not part
of the public protocol.

Plan reads return the durable projection by default and therefore never wait on an
execution host. `hydrate=true` explicitly refreshes execution observations. Plan
reconcile returns `202 Accepted` with a pollable `statusUrl`; reconciliation runs in
the background, is serialized per plan, and does not block unrelated plans.

The execution list includes durable timing, aggregate usage, final physical route, and per-deployment route usage when observed. `hydrate=1` backfills missing historical LiteLLM usage into durable V3 correlation state.
