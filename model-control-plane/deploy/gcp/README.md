# GCP development execution plane

GCP Dev is the mutable AI Office execution host. It owns the V3 Control Plane, OpenHands Agent Server, ACP tooling, execution database, and isolated workspaces. Oracle2 remains the Hermes ingress and LiteLLM provider authority.

## Runtime boundary

```text
Hermes on Oracle2
  -> 127.0.0.1:8321 (private SSH tunnel)
  -> GCP Control Plane 127.0.0.1:8320
  -> OpenHands 127.0.0.1:18000
  -> isolated ACP worker workspace
  -> Oracle2 LiteLLM over tailnet HTTPS
```

Do not run a second mutable AI Office execution plane on Oracle2. Workspace provisioning and OpenHands must remain colocated.

## Backend readiness

A backend can be present in `config/development-policy.yaml` without being production-enabled. `MODEL_CP_V3_ENABLED_BACKENDS` is the runtime readiness gate. Enable a coding harness only after an end-to-end smoke verifies startup, model routing, repository operations, terminal completion, and review semantics where applicable.

Current production review order is `codex-review-headless -> claude-code-review-headless -> openhands-builtin`, all on the `gpt-5.6-sol` logical model. The headless adapters deliberately keep OpenHands/ACP as the worker contract while invoking the native Codex/Claude one-shot CLIs so a third-party interactive ACP wrapper cannot leave a completed review turn hanging. Premium review is fail-closed: `gpt-5.6-sol` must not cross-fallback to an implementation-tier model such as GLM.

The initial cutover enables OpenCode, DSH, and OpenHands builtin. Codex, Claude Code, and ZCode remain registered candidates until their ACP/runtime compatibility smoke is fully green.

## Install

Build the Control Plane and OpenHands image, install ACP tooling, provide the root-owned runtime env files under `/srv/hermes-personal/secrets`, then run:

```bash
sudo bash model-control-plane/deploy/gcp/install-gcp-execution-plane.sh
```

The installer intentionally does not copy provider credentials. GCP needs only the scoped LiteLLM execution key and the minimal admin key used for registry/usage projection.
