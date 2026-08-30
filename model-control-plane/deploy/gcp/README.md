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

## Agent Harness capability boundary

OpenCode, Codex, Claude Code, and DSH coding/review harnesses must not be launched with a bare user configuration. The execution plane mounts `/home/dev/projects/agent-harness` read-only at `/opt/agent-harness`, resolves the execution repository back to its canonical project manifest, performs required-capability admission, and materializes a per-execution environment under `/workspace/executions/<id>/.agent-harness/`. New execution repositories are local linked clones: their working tree, refs, index, and newly-created objects remain execution-private while pre-existing canonical Git object files are hardlinked read-only to the worker identity. This avoids full-history duplication without mounting canonical `.git` read-write into OpenHands. AI Office continues to own backend/model/provider routing; Agent Harness owns the effective Skills, MCP, and project-instruction projection.

For OpenHands workers the `openhands` Harness profile keeps project-scoped CodeGraph/Nx MCP ownership while bridging the shared Context7 Docker MCP gateway over host-loopback streaming HTTP. `hermes-agent-harness-mcp.service` owns that loopback gateway on `127.0.0.1:18330`; the worker container uses host networking but receives no Docker socket. Missing required runtimes, MCP commands, Skills, or instruction sources fail admission before the coding harness starts.

The provider-native Business Codex planning, implementation, and review backends keep OAuth only in `/openhands-state/codex-business`. Harness materialization receives a symlink to that persisted `auth.json` plus the same per-project Skills/MCP/instructions; credentials are never copied into the repository or execution capability manifest. `codex-business-worker-headless` is write-capable only for trusted task plans, while all Business backends remain `untrusted_external: false`; external/untrusted-change policy never receives the consumer ChatGPT session.

## Backend readiness

A backend can be present in `config/development-policy.yaml` without being production-enabled. `MODEL_CP_V3_ENABLED_BACKENDS` is the runtime readiness gate. Enable a coding harness only after an end-to-end smoke verifies startup, model routing, repository operations, terminal completion, and review semantics where applicable.

Trusted-plan implementation defaults to the LiteLLM-managed worker ladder `dsh-acp -> opencode-acp -> openhands-builtin`, with readiness-gated ZCode/Claude routes behind the same policy. `codex-acp` is a managed implementation route in the same `implementation-efficient` capability class, but materializes that class as `gpt-5.6-luna` with `xhigh` reasoning; DSH/OpenCode/OpenHands continue to resolve the same capability through DeepSeek with GLM fallback at the gateway. `codex-business-worker-headless` is intentionally opt-in rather than part of automatic implementation fallback; when explicitly selected it uses the authenticated ChatGPT/Codex Business session with `gpt-5.6-luna` and `xhigh` reasoning. The opt-in Business planner and the default Business review route both use `gpt-5.6-sol` at `medium` reasoning; default orchestration remains managed so exhausted Business credits cannot block plan creation. Trusted-plan review starts with `codex-business-review-headless`, then falls back to the LiteLLM-managed `codex-review-headless -> claude-code-review-headless -> openhands-builtin` ladder. Batch integration repair remains bounded to three automatic attempts; when that safety limit is exhausted, operators may authorize exactly one additional repair at a time with plan reconcile mode `retry_integration_repair`, preserving the same plan, batch lineage, and independent re-review gate. Managed review starts at `review-premium` and may fall back only to explicitly bounded premium-compatible routes (`codex-auto-review`, then `gpt-5.4`); it never silently degrades to an implementation-tier model. The headless adapters deliberately keep OpenHands/ACP as the worker contract while invoking native one-shot Codex CLI turns, avoiding interactive ACP sessions that can remain open after useful work is already complete. `EXTERNAL_CHANGE` plans never receive the consumer ChatGPT OAuth session because both Business backends are `untrusted_external: false`.

The Business Codex login is persisted by the OpenHands data bind mount. Inside the execution container its `CODEX_HOME` is `/openhands-state/codex-business`, backed by `/opt/data/hermes-ai-office-v3/openhands/codex-business` on GCP. Authenticate or refresh it with `docker exec -u openhands -e CODEX_HOME=/openhands-state/codex-business hermes-openhands-v3 /openhands-state/tooling/node_modules/.bin/codex login --device-auth`, then verify with the same command ending in `login status`. Provider-native Business worker/reviewer turns delete API-key environment variables and use only this ChatGPT login; Business usage is not routed through LiteLLM and is not treated as API credit.

The current GCP cutover enables the opt-in provider-native Business Codex worker, the provider-native Business reviewer, and the managed OpenCode/DSH/OpenHands implementation paths. The older API-managed Codex/Claude/ZCode ACP routes remain independently readiness-gated.

Execution workspaces are ephemeral runtime artifacts rather than the durable audit log. The control plane prunes Git-ignored dependency/build caches and execution-scoped Agent Harness state from terminal executions, protects active causal chains and the latest successful implementation workspace for work items in still-recoverable batches, and garbage-collects superseded/failed plan artifacts after 1 hour. Once a batch is `SUCCEEDED` or `CANCELLED`, its durable integrated revision/ref is the recovery boundary and historical writer/repair workspaces from that batch are no longer pinned merely because a later batch keeps the Plan active. Standalone successful executions default to a 6-hour workspace TTL and standalone failed/cancelled executions to 1 hour; terminal-plan workspaces default to 1 hour. The intervals are configurable with `MODEL_CP_V3_WORKSPACE_*_TTL_MS` and `MODEL_CP_V3_WORKSPACE_GC_INTERVAL_MS`. Durable execution/result/usage/route evidence remains in SQLite after workspace release. Linked clones keep source-owned hardlinked object files until the execution directory is removed; deleting an execution only unlinks its copy and never removes the canonical object. Canonical Git GC/repack may therefore reclaim disk blocks only after all linked executions referencing an old pack have expired.

Antigravity is a deliberate provider-native exception to the LiteLLM-managed model path. It is registered as an opt-in external adapter for **trusted task input only**; ordinary task routing is unchanged, while `EXTERNAL_CHANGE` plans reject both Antigravity backends before persistence (`untrusted_external: false`) and use the normal Codex/Claude/OpenHands governance path. Review uses `gemini-3.1-pro-high`, repair uses `gemini-3.7-flash-high`, and both remain disabled at runtime until explicitly added to `MODEL_CP_V3_ENABLED_BACKENDS`. The adapter sends objectives over stdin using Antigravity stream-JSON, constrains review results with JSON Schema, stores only durable execution metadata/output, and runs the CLI as the authenticated `dev` identity inside private mount and PID namespaces that hide unrelated homes and sibling AI Office workspaces. The wrapper copies only the minimum consumer-auth/config files into short-lived private tmpfs state, so host auth, prior conversations, brain state, and caches are not mounted writable or exposed to sibling workspaces. However, current `agy` 1.1.21 keeps provider auth and model-controlled file tools in the same process; adversarial probes confirmed those tools can read the private OAuth copy, so provider-native Antigravity is intentionally **not** considered secret-safe for untrusted PR/repository input. Native launches require the configured consumer home to live strictly below `/home`, use a fixed `/bin/bash`, a root-safe PATH, `unshare --pid --fork --kill-child=SIGKILL --mount-proc`, and an OpenHands-compatible shared workspace GID; the root control plane re-normalizes terminal writer trees to group-writable permissions before handoff. A real `setsid` escape smoke confirmed delayed descendants do not survive cancellation.

### Overnight review-throughput mode

`MODEL_CP_V3_PLAN_REVIEW_STRATEGY` controls durable-plan review cadence. The default `PER_ITEM_AND_BATCH` preserves the strict historical flow: every implementation receives a fresh `VERIFY_REVIEW`, and multi-item integration receives `BATCH_VERIFY`. For long trusted overnight refactors, `BATCH_ONLY` shifts model time toward implementation without deleting the independent quality gate: each writer must inspect, implement, run focused plus appropriate wider tests, commit, and leave a clean workspace; the Control Plane then integrates the batch and launches one fresh provider-native `BATCH_VERIFY` for every batch, including one-ticket batches. A blocking batch verdict schedules a bounded implementation repair and requires another fresh batch review before promotion. `EXTERNAL_CHANGE` plans always retain per-change independent review regardless of this setting.

GitHub PR governance uses the canonical repository owner's `gh` authentication. Immutable intake and repair publication require normal repository access; the aggregate `Hermes / PR Governance` commit-status reporter additionally requires commit-status write permission (`repo`/`repo:status` for classic OAuth, or fine-grained Commit statuses: write). Check Runs are intentionally not used in this rollout because GitHub restricts Check Run writes to GitHub Apps. Status publication is durable and retried from plan state. The reporter re-reads PR head state after each candidate status write; a synchronize racing the POST revokes stale green, marks the newly observed head fail-closed, and refuses to persist a fingerprint while the head is still unstable. Branch-protection enforcement remains an explicit rollout step.

The control plane also exposes a normalized GitHub PR event bridge for trusted ingress only. Set `MODEL_CP_V3_GITHUB_EVENT_TOKEN` on the execution plane and send it as `x-hermes-event-token`; the comparison is constant-time. This is not a substitute for verifying GitHub webhook signatures at the public ingress. The bridge accepts only `pull_request` actions `opened`, `reopened`, and `synchronize`, then re-resolves GitHub state through the immutable intake adapter before creating or reusing a governance plan.

Jules REST integration is optional and remains behind `JulesApiPort` because the upstream API is alpha. To enable Hermes-created sessions, provision a root-owned env file containing `JULES_API_KEY` and set `MODEL_CP_V3_JULES_ENV_FILE`; otherwise Jules routes return 503 and no credential is read. Session creation never requests `AUTO_CREATE_PR` implicitly: callers must set `autoCreatePullRequest: true`. Jules Scheduled Tasks do not require this adapter; their resulting GitHub PRs can enter governance through the event bridge independently.

## Install

Build the Control Plane and OpenHands image, install ACP tooling, provide the root-owned runtime env files under `/srv/hermes-personal/secrets`, then run:

```bash
sudo bash model-control-plane/deploy/gcp/install-gcp-execution-plane.sh
```

The installer intentionally does not copy provider credentials. GCP needs only the scoped LiteLLM execution key and the minimal admin key used for registry/usage projection.

## Signed GitHub webhook ingress

The GitHub PR governance bridge remains loopback/private. Public GitHub delivery must terminate in the
separate `hermes-github-webhook-ingress.service`, which runs from a dependency-free compiled copy under `/usr/local/lib/hermes-github-webhook-ingress` with `ProtectHome=true`, verifies the raw `X-Hub-Signature-256` HMAC
before parsing JSON, allows only the configured repository, normalizes only governed `pull_request`
actions (`opened`, `reopened`, `synchronize`), and forwards them to the authenticated loopback V3 event
bridge. The public verifier never executes PR code and never exposes the control-plane listener.

Runtime files:

- `/srv/hermes-personal/secrets/model-control-plane-v3.env` owns `MODEL_CP_V3_GITHUB_EVENT_TOKEN`.
- `/srv/hermes-personal/secrets/github-webhook-ingress.env` owns `GITHUB_WEBHOOK_SECRET` plus the exact
  repository/project/path mapping. Start from `deploy/github-webhook-ingress.env.example` and keep it
  mode `0600`.

Install after the model-control-plane build is present:

```bash
sudo model-control-plane/deploy/gcp/install-github-webhook-ingress.sh
```

On GCP Dev, expose only the verifier on a dedicated Funnel port; keep the existing `:443 -> :8320`
Serve route tailnet-only:

```bash
tailscale funnel --bg --https=8443 http://127.0.0.1:8322
```

The GitHub repository webhook then targets
`https://<gcp-dev-tailnet-host>:8443/github/webhook` with content type `application/json`, the same
`GITHUB_WEBHOOK_SECRET`, and Pull request events enabled. Branch protection/required governance status
is a later rollout gate; the first pilot remains review/report-only and does not enable auto-merge.


## Linked workspace repository preparation

Runtime linked-workspace provisioning never changes canonical Git object ownership, group, mode, ACLs, or repository configuration. A repository whose object tree is not already readable/traversable and non-writable to the configured OpenHands execution identity uses the private `--no-local` fallback.

To opt a repository into physical object sharing, perform preparation only at a quiescent deployment boundary:

1. verify through the control plane that no RUNNING or PAUSED writer owns that repository and the relevant durable Plan is at an integrated/terminal checkpoint;
2. record source `HEAD`, refs, `git status`, `git fsck`, and object-tree ownership/modes;
3. configure the repository so future Git objects are group-readable but never group-writable, and normalize the existing `.git/objects` tree once for the execution group while no source writer is active;
4. re-run `git fsck`, source cleanliness, and a read-only access audit as the execution identity;
5. start one production-shaped execution and prove source/execution history objects share inodes while canonical HEAD and working tree remain unchanged.

If any precondition or post-check is ambiguous, do not normalize the repository. Leave it unprepared and allow the runtime to use its safe private-clone fallback.

The GCP service runs with `PrivateTmp=true`. Linked execution clone staging must not use `/tmp`; it lives in a service-private sibling of the workspace root. `--local` is enabled only when the inspected source object directory and staging path are device-compatible. Treat `EXDEV` from local clone creation as a staging/mount-boundary defect, not as a reason to weaken source trust checks.


## Crash-safe workspace provisioning

Execution workspace provisioning uses additive SQLite `workspace_provision_token` / `workspace_provision_claimed_at` claims. Only the current token owner may publish an execution path, attach `workspace_ref`, or mark provisioning failed. The workspace provisioner CAS-renews the token immediately before touching a pre-existing unattached workspace, immediately before filesystem publication, and immediately before worker exposure. A stale process must stop on failed renewal and must never recursively delete the shared execution directory.

Do not clear workspace-provision claim columns manually. A fresh claim intentionally suppresses another provisioner; stale takeover is handled by normal replay/reconciliation.
If a service crash leaves an incomplete repository before durable `workspace_ref` attachment, replay may clear it only when the current claim still owns the lifecycle and the execution parent remains service-owned. Redirected `.git`, special Git metadata, escaping symlinks, or worker/foreign-owned parents remain fail-closed; do not manually delete around those checks.
Production also requires util-linux `/usr/bin/flock`. The provisioner holds a per-execution kernel flock from before crash-residue handling through final worker exposure; the lock directory is a service-owned `0700` sibling of the workspace root and is not mounted into OpenHands. Do not replace this with a timer-only lease: SQLite ownership and the OS filesystem mutex are complementary.

## Crash-safe execution host launch

Execution-host creation is guarded by durable SQLite launch claims. A service instance must recover by durable execution ID before creating, win the launch claim atomically, recover once more after the claim, and attach the returned conversation with the same token. OpenHands recovery uses authenticated conversation search and the immutable execution tag; duplicate matches fail closed. A fresh claim held by another process suppresses a second POST. Expired claims are taken over only after host recovery proves the previous execution is absent. After any post-claim recovery scan, the owner must CAS-renew its own token immediately before POST; a failed renewal means ownership was superseded and launch is forbidden.

Do not clear launch-claim columns manually during recovery. Use normal execution/plan reconciliation so an already-created host conversation can be adopted.
