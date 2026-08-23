# Hermes AI Office V3 Control Plane

The model control plane is a focused execution-state service for Hermes AI Office.

## Responsibilities

- `ORCHESTRATE` supervisor execution plus phase policy and backend selection;
- causal execution lineage;
- isolated implementation workspaces and read-only review snapshots;
- strict PASS/FAIL review governance;
- single-writer leases;
- deterministic FINALIZE;
- durable execution timing, result, LiteLLM usage, and per-deployment route usage;
- readiness evidence.

OpenHands owns supervisor and worker lifecycle. The built-in OpenHands supervisor may use `task_tool_set` for bounded analysis and the repository-owned `ai_office_worker` tool to fan out isolated ACP coding workers. LiteLLM is the only provider/model/routing/health/spend authority.

Coding backends are defined in policy independently from runtime readiness. OpenCode and DSH are the proven default implementation workers. Codex, Claude Code, and ZCode are registered ACP backends but must pass runtime smoke before they are added to `MODEL_CP_V3_ENABLED_BACKENDS`. This keeps an installed adapter from being mistaken for a production-ready worker.

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

The development execution plane runs on GCP Dev from `/home/dev/projects/pixel-agents`. The Control Plane listens only on `127.0.0.1:8320` and is installed with `deploy/gcp/install-gcp-execution-plane.sh`; OpenHands and all mutable workspaces are colocated on that host.

Oracle2 remains the Hermes ingress plus LiteLLM provider authority. Hermes reaches GCP through the host-private `hermes-ai-office-gcp-tunnel.service` at `127.0.0.1:8321`; Oracle2 does not run a second Control Plane or OpenHands worker. This avoids split workspace ownership and keeps Hermes a thin delegation boundary.
