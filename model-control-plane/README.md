# Hermes AI Office V3 Control Plane

The model control plane is a focused execution-state service for Hermes AI Office.

## Responsibilities

- phase policy and backend selection;
- causal execution lineage;
- isolated implementation workspaces and read-only review snapshots;
- strict PASS/FAIL review governance;
- single-writer leases;
- deterministic FINALIZE;
- durable execution timing, result, LiteLLM usage, and per-deployment route usage;
- readiness evidence.

OpenHands owns worker lifecycle. LiteLLM is the only provider/model/routing/health/spend authority.

## API

- `GET /api/health`
- `GET /api/v3/health`
- `GET /api/v3/development/runtime-summary`
- `GET /api/v3/development/readiness`
- `GET /api/v3/development/model-registry`
- `GET /api/v3/development/executions`
- `GET /api/v3/development/executions/:executionId`
- `POST /api/v3/development/executions`
- `POST /api/v3/development/executions/:executionId/messages`
- `POST /api/v3/development/executions/:executionId/cancel`

`GET /api/v3/development/executions?limit=5000&hydrate=1` backfills missing historical LiteLLM observations into durable execution correlation state.

## Local validation

```bash
npm run check-types -w model-control-plane
npm test -w model-control-plane
npm run build -w model-control-plane
```

## Production

The canonical checkout is `/home/ubuntu/projects/pixel-agents`. The service listens on `127.0.0.1:8320` and is installed from `deploy/hermes-model-control-plane.service` plus the V3 production drop-in.
