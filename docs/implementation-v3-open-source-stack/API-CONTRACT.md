# API contract

Base service: `http://127.0.0.1:8320`

Read APIs:

- `GET /api/health`
- `GET /api/v3/health`
- `GET /api/v3/development/runtime-summary`
- `GET /api/v3/development/readiness`
- `GET /api/v3/development/model-registry`
- `GET /api/v3/development/executions?limit=5000&hydrate=1`
- `GET /api/v3/development/executions/:executionId`

Write APIs:

- `POST /api/v3/development/executions`
- `POST /api/v3/development/executions/:executionId/messages`
- `POST /api/v3/development/executions/:executionId/cancel`

All new execution POST requests require an `Idempotency-Key`.

The execution list includes durable timing, aggregate usage, final physical route, and per-deployment route usage when observed. `hydrate=1` backfills missing historical LiteLLM usage into durable V3 correlation state.
