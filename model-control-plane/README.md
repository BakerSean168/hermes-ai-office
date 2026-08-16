# Hermes Model Control Plane

> **Domain migration note:** This README describes the currently deployed Model Control Plane implementation. The authoritative north-star business model is [`../docs/DOMAIN-MODEL-V2.md`](../docs/DOMAIN-MODEL-V2.md). In V2, the legacy `Worker = Channel × ModelDefinition` identity becomes a compatibility projection; the durable employee identity is `Employee = SupplyAgreement × ModelOffering`, while `Channel` is only an access route. Existing APIs remain protected during migration.

The Model Control Plane is the source of truth for model workforce identity, routing policy, accounting, quota, and events. It is deliberately separate from both the model data plane (currently CLIProxyAPI/CPA) and Pixel Agents visualization.

## Domain model

```text
Provider (external company)
  └─ Channel (account / contract / API route)
       ├─ Contract (free / subscription / metered / sponsored)
       ├─ Quota
       └─ Worker = Channel × ModelDefinition (external employee)

Profile (team / workflow)
  └─ Position (stable job: Hermes Brain, Codex Developer, Reviewer...)
       └─ Assignment (Worker candidate/current employee, priority + status)
            └─ Run (one concrete task/session)
                 └─ UsageLedger (tokens + actual/allocated/market cost)

Price -> ModelDefinition or Worker
Health -> Channel/Worker discovery state
Event -> every relevant control-plane change
```

Identity invariant: a model name is not a Worker. `deepseek-v4-flash` through two channels creates two Workers because cost, quota, reliability, and contract differ.

## Ownership boundaries

- **CPA / future gateways (data plane):** forward model requests, provider protocol adaptation, provider-specific retry/session behavior.
- **Model Control Plane:** registry, contracts, quotas, health, assignments, policy scoring, usage attribution, event history, dashboard projection.
- **Pixel Agents:** visualization plus a thin management facade. It consumes the dashboard projection/SSE and forwards explicit admin actions to the Control Plane; it never reads CPA secrets or the SQLite database.
- **Hermes/Codex/OpenCode clients:** should converge on stable logical Positions/aliases rather than duplicating provider credentials.

The CPA integration is an adapter, not a core dependency. A future LiteLLM/New API adapter can implement the same discovery/usage boundary without changing Pixel Agents. CPA lifecycle mutations remain behind `gatewayctl`, including audited logical-model alias binding.

## Scheduling

Resolution follows:

1. Eligibility: channel/worker enabled, acceptable health, required capabilities/context, non-exhausted quota.
2. Assignment priority (dominant).
3. Weighted quality, reliability, cost efficiency, latency, and quota efficiency.
4. Quota reset pressure can raise utilization of prepaid capacity near reset.
5. Reconciliation marks exactly one candidate `active` per Position and other eligible candidates `standby`.
6. A Position can declare `routeProtocol`; incompatible workers remain visible but are not eligible for that ingress.
7. The selected worker is published to CPA as an audited logical alias such as `position:hermes-brain`, so clients depend on the job rather than a provider/model.

Default Positions currently seeded: `hermes-brain`, `codex-general`, `coding-review`.

## Accounting

Three cost concepts are intentionally separate:

- `actualCost`: amount actually charged by a metered provider/gateway.
- `allocatedCost`: share of a subscription/fixed contract allocated to a run/position.
- `marketValue`: counterfactual value calculated from configured per-model/worker price data.

CPA's CAP Token Usage Tracker is imported as an idempotent 30-day aggregate snapshot. Subscription fixed cost is allocated across usage (tokens by default, requests optionally), and configured worker/model prices revalue historical snapshots as `marketValue`. Request/run-specific attribution is recorded through `POST /api/v1/usage`; logical `position:*` calls provide the stable identity needed for future position-level attribution.

## API

Read:

- `GET /api/health`
- `GET /api/v1/dashboard/workforce`
- `GET /api/v1/providers|channels|workers|profiles|positions|assignments|quotas|contracts|prices`
- `GET /api/v1/stats/:dimension`
- `GET /api/v1/events/history`
- `GET /api/v1/events` (SSE)

Write/control:

- `POST /api/v1/providers|channels|models|workers|profiles|positions|assignments|quotas|contracts|prices`
- `POST /api/v1/resolve/:positionId`
- `POST /api/v1/usage`
- `POST /api/v1/adapters/cpa/sync`
- `POST /api/v1/adapters/cpa/channels` (safe channel onboarding; API key is streamed to gatewayctl stdin and not persisted by the Control Plane)
- `POST /api/v1/adapters/cpa/usage/sync`
- `POST /api/v1/assignments/reconcile`
- `PATCH /api/v1/channels/:id/policy` and `/assignments/:id/policy`
- `POST /api/v1/channels/:id/actions/:action` (`test`, `enable`, `disable`, `quarantine`)

The service binds to loopback by default. Pixel Agents exposes workforce/event reads plus an explicitly enabled management facade (`MODEL_CONTROL_PLANE_ADMIN=1`); secrets are forwarded only for channel onboarding and are never included in events or the Control Plane database.

## Events

Examples: `provider.changed`, `channel.changed`, `worker.changed`, `position.changed`, `assignment.changed`, `assignment.activated`, `quota.changed`, `price.changed`, `contract.changed`, `route.resolved`, `usage.recorded`, `usage.snapshot.synced`, `cpa.synced`, `assignments.reconciled`.

Consumers react to facts, not UI commands. Pixel Agents decides how an `assignment.activated` event is animated.

## Deployment

Production on oracle2 uses the tracked `deploy/hermes-model-control-plane.service`, listens on `127.0.0.1:8320`, and stores state at `/srv/hermes-personal/data/model-control-plane/control-plane.sqlite`. It refreshes CPA discovery/usage every 60 seconds and performs active health probes every 30 minutes. The Hermes Office bridge (`8787`) and Pixel Office (`3100`) are also persistent host systemd services, so rebuilding the Hermes container no longer removes the dashboard chain.
