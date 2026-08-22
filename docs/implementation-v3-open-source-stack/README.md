# AI Office V3

AI Office is a thin development-execution control plane. It does not model a company, employees, positions, appointments, or a second provider registry.

The production authority chain is:

```text
Hermes Brain
  -> hermes-ai-office facade
  -> AI Office V3 Control Plane
  -> OpenHands execution host
  -> LiteLLM model/provider gateway
```

- Hermes chooses the semantic phase and objective.
- The control plane owns causal execution state, workspace isolation, review/finalize gates, and correlation.
- OpenHands owns worker lifecycle.
- LiteLLM is the only provider/model/routing/health/spend authority.
- The dashboard is a read-only projection of execution history and LiteLLM usage.

## UI

AI Office exposes two views only:

1. **Overview** — active executions, full history, total token/cost/time/calls, readiness, runtime health.
2. **Analytics** — project, logical-model, physical-model, provider/channel, and phase aggregates.

Provider mutation is done in LiteLLM Admin.
