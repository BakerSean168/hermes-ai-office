# Operations

## Services

- Model control plane: `hermes-model-control-plane.service`, port `8320`
- OpenHands V3: loopback `18000`
- LiteLLM: loopback `4000`
- LiteLLM Admin: host-specific Tailnet URL stored outside Git

## Deployment

1. Build and test the repository.
2. Install the repository-owned systemd unit/drop-in.
3. Restart only `hermes-model-control-plane.service`.
4. Verify `/api/v3/health`, model registry, readiness, and execution list.
5. Deploy the Hermes plugin/dashboard through the safe AI Office deploy script.

The GCP execution host must have authenticated `git` and `gh` access for any
plan that explicitly requests remote delivery. Verify `gh auth status` before
starting such a plan. A missing or rejected credential leaves the durable plan
running and retryable; it does not make an observer timeout authoritative.

The Hermes Gateway is not a dependency of the model-control-plane restart.

## Historical database

Older SQLite tables can remain on disk as inert data. Current code creates, reads, and writes only the V3 execution correlation schema.
