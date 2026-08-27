# GCP development execution plane

GCP Dev is the mutable AI Office execution host. It owns the V3 Control Plane, OpenHands Agent Server, ACP tooling, execution database, and isolated workspaces. Oracle2 remains the Hermes ingress and LiteLLM provider authority.

## Runtime boundary

```text
Hermes on Oracle2
  -> 127.0.0.1:8321 (private SSH tunnel)
  -> GCP Control Plane 127.0.0.1:8320
  -> OpenHands 127.0.0.1:18000
  -> isolated ACP worker workspace
  -> optional provider-native Antigravity worker (mount namespace + consumer auth)
  -> Oracle2 LiteLLM over tailnet HTTPS
```

Do not run a second mutable AI Office execution plane on Oracle2. Workspace provisioning and OpenHands must remain colocated.

## Backend readiness

A backend can be present in `config/development-policy.yaml` without being production-enabled. `MODEL_CP_V3_ENABLED_BACKENDS` is the runtime readiness gate. Enable a coding harness only after an end-to-end smoke verifies startup, model routing, repository operations, terminal completion, and review semantics where applicable.

Current trusted-plan review order starts with `codex-business-review-headless` using the authenticated ChatGPT/Codex provider-native session, then falls back to the LiteLLM-managed `codex-review-headless -> claude-code-review-headless -> openhands-builtin` ladder. Managed review starts at `review-premium` and may fall back only to the explicitly bounded premium-compatible routes (`codex-auto-review`, then `gpt-5.4`); it never degrades to an implementation-tier model such as GLM. The headless adapters deliberately keep OpenHands/ACP as the worker contract while invoking native one-shot CLIs so a third-party interactive ACP wrapper cannot leave a completed review turn hanging. `EXTERNAL_CHANGE` plans never receive the consumer ChatGPT OAuth session: `codex-business-review-headless` is marked `untrusted_external: false`, and those plans start from the managed review candidates instead.

The Business Codex login is persisted by the OpenHands data bind mount. Inside the execution container its `CODEX_HOME` is `/openhands-state/codex-business`, backed by `/opt/data/hermes-ai-office-v3/openhands/codex-business` on GCP. Authenticate or refresh it with `docker exec -u openhands -e CODEX_HOME=/openhands-state/codex-business hermes-openhands-v3 /openhands-state/tooling/node_modules/.bin/codex login --device-auth`, then verify with the same command ending in `login status`. The provider-native reviewer removes API-key environment variables and uses only this ChatGPT login; it does not route Business usage through LiteLLM or treat a ChatGPT subscription as API credit.

The initial cutover enables OpenCode, DSH, and OpenHands builtin. Codex, Claude Code, and ZCode remain registered candidates until their ACP/runtime compatibility smoke is fully green.

Antigravity is a deliberate provider-native exception to the LiteLLM-managed model path. It is registered as an opt-in external adapter for **trusted task input only**; ordinary task routing is unchanged, while `EXTERNAL_CHANGE` plans reject both Antigravity backends before persistence (`untrusted_external: false`) and use the normal Codex/Claude/OpenHands governance path. Review uses `gemini-3.1-pro-high`, repair uses `gemini-3.7-flash-high`, and both remain disabled at runtime until explicitly added to `MODEL_CP_V3_ENABLED_BACKENDS`. The adapter sends objectives over stdin using Antigravity stream-JSON, constrains review results with JSON Schema, stores only durable execution metadata/output, and runs the CLI as the authenticated `dev` identity inside private mount and PID namespaces that hide unrelated homes and sibling AI Office workspaces. The wrapper copies only the minimum consumer-auth/config files into short-lived private tmpfs state, so host auth, prior conversations, brain state, and caches are not mounted writable or exposed to sibling workspaces. However, current `agy` 1.1.21 keeps provider auth and model-controlled file tools in the same process; adversarial probes confirmed those tools can read the private OAuth copy, so provider-native Antigravity is intentionally **not** considered secret-safe for untrusted PR/repository input. Native launches require the configured consumer home to live strictly below `/home`, use a fixed `/bin/bash`, a root-safe PATH, `unshare --pid --fork --kill-child=SIGKILL --mount-proc`, and an OpenHands-compatible shared workspace GID; the root control plane re-normalizes terminal writer trees to group-writable permissions before handoff. A real `setsid` escape smoke confirmed delayed descendants do not survive cancellation.

GitHub PR governance uses the canonical repository owner's `gh` authentication. Immutable intake and repair publication require normal repository access; the aggregate `Hermes / PR Governance` commit-status reporter additionally requires commit-status write permission (`repo`/`repo:status` for classic OAuth, or fine-grained Commit statuses: write). Check Runs are intentionally not used in this rollout because GitHub restricts Check Run writes to GitHub Apps. Status publication is durable and retried from plan state. The reporter re-reads PR head state after each candidate status write; a synchronize racing the POST revokes stale green, marks the newly observed head fail-closed, and refuses to persist a fingerprint while the head is still unstable. Branch-protection enforcement remains an explicit rollout step.

The control plane also exposes a normalized GitHub PR event bridge for trusted ingress only. Set `MODEL_CP_V3_GITHUB_EVENT_TOKEN` on the execution plane and send it as `x-hermes-event-token`; the comparison is constant-time. This is not a substitute for verifying GitHub webhook signatures at the public ingress. The bridge accepts only `pull_request` actions `opened`, `reopened`, and `synchronize`, then re-resolves GitHub state through the immutable intake adapter before creating or reusing a governance plan.

Jules REST integration is optional and remains behind `JulesApiPort` because the upstream API is alpha. To enable Hermes-created sessions, provision a root-owned env file containing `JULES_API_KEY` and set `MODEL_CP_V3_JULES_ENV_FILE`; otherwise Jules routes return 503 and no credential is read. Session creation never requests `AUTO_CREATE_PR` implicitly: callers must set `autoCreatePullRequest: true`. Jules Scheduled Tasks do not require this adapter; their resulting GitHub PRs can enter governance through the event bridge independently.

## Install

Build the Control Plane and OpenHands image, install ACP tooling, provide the root-owned runtime env files under `/srv/hermes-personal/secrets`, then run:

```bash
sudo bash model-control-plane/deploy/gcp/install-gcp-execution-plane.sh
```

The installer intentionally does not copy provider credentials. GCP needs only the scoped LiteLLM execution key and the minimal admin key used for registry/usage projection.
