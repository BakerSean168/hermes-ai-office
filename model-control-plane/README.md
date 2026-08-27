# Hermes AI Office V3 Control Plane

The model control plane is a focused execution-state service for Hermes AI Office.

## Responsibilities

- `ORCHESTRATE` supervisor execution plus phase policy and backend selection;
- causal execution lineage;
- durable plans, validated dependency batches, and stable work-item identities;
- automatic IMPLEMENT → VERIFY_REVIEW → IMPLEMENT_FIX reconciliation;
- isolated implementation workspaces and read-only review snapshots;
- strict PASS/FAIL review governance;
- single-writer leases;
- deterministic reviewed batch integration into durable Git refs;
- explicitly authorized branch delivery, pull-request checks, merge, and
  post-merge verification;
- durable execution timing, result, LiteLLM usage, and per-deployment route usage;
- readiness evidence.

OpenHands owns repository-aware orchestration analysis while the durable Control Plane owns execution state transitions. The built-in OpenHands supervisor uses `task_tool_set` for bounded read-only investigation and produces a dependency-aware graph; only after validation does the Control Plane fan out isolated ACP coding workers. LiteLLM is the only provider/model/routing/health/spend authority.

Coding backends are defined in policy independently from runtime readiness. OpenCode and DSH are the proven default implementation workers. Codex, Claude Code, and ZCode are registered ACP backends but must pass runtime smoke before they are added to `MODEL_CP_V3_ENABLED_BACKENDS`. This keeps an installed adapter from being mistaken for a production-ready worker.

## API

- `GET /api/health`
- `GET /api/v3/health`
- `GET /api/v3/development/runtime-summary`
- `POST /api/v3/development/delegations` — create an `ORCHESTRATING` plan from a thin objective/repository request; OpenHands materializes the graph asynchronously.
- `GET /api/v3/development/readiness`
- `GET /api/v3/development/model-registry`
- `GET /api/v3/development/plans`
- `GET /api/v3/development/plans/:planId[?hydrate=true]`
- `POST /api/v3/development/plans`
- `POST /api/v3/development/plans/:planId/reconcile`
- `POST /api/v3/development/plans/:planId/cancel`
- `GET /api/v3/development/executions`
- `GET /api/v3/development/executions/:executionId`
- `POST /api/v3/development/executions`
- `POST /api/v3/development/executions/:executionId/cancel`

`GET /api/v3/development/executions?limit=5000&hydrate=1` backfills missing historical LiteLLM observations into durable execution correlation state.

Plan creation is the normal multi-step protocol. The coordinator persists the graph before launching work, retries transport failures once, applies strict independent review gates, integrates only clean committed implementations, and starts dependent batches from the preceding integrated revision. When plan creation explicitly authorizes delivery, the coordinator also pushes the integrated revision, creates or reuses a pull request, waits for checks, creates a bounded reviewed repair batch for failed pre-merge checks, merges through GitHub branch protection, and verifies checks on the merge revision. Explicit plan reconcile recovers a blocked infrastructure attempt after the underlying fault is repaired. It returns `202 Accepted`; clients poll the returned `statusUrl`. Plan reads use durable state by default, while `hydrate=true` explicitly refreshes host observations. Reconciliation is serialized per plan so a slow execution host cannot stall unrelated plans.

Delivery is opt-in and fail-closed. `delivery.autoMerge` must be explicitly true;
without that authorization AI Office never pushes or merges. A delivery plan is
not `SUCCEEDED` merely because implementation or local integration completed.

## Local validation

```bash
npm run check-types -w model-control-plane
npm test -w model-control-plane
npm run build -w model-control-plane
```

## Production

The development execution plane runs on GCP Dev from `/home/dev/projects/pixel-agents`. The Control Plane listens only on `127.0.0.1:8320` and is installed with `deploy/gcp/install-gcp-execution-plane.sh`; OpenHands and all mutable workspaces are colocated on that host.

Oracle2 remains the Hermes ingress plus LiteLLM provider authority. Hermes reaches GCP through the host-private `hermes-ai-office-gcp-tunnel.service` at `127.0.0.1:8321`; Oracle2 does not run a second Control Plane or OpenHands worker. This avoids split workspace ownership and keeps Hermes a thin delegation boundary.
