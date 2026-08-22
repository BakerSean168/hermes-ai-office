# Hermes AI Office Plugin

Hermes-native AI company dashboard and runtime staffing plugin.

The plugin adds an **AI Office** tab to the Hermes dashboard and participates in
Hermes tool execution through supported observer hooks. It keeps three identities
separate:

```text
Position       = the job
Employee       = Supplier x SupplierModel
RuntimeSession = Hermes / OpenCode / Codex technical execution
```

For normal software-development delegation, Hermes now calls the V3 phase tool
instead of launching a coding harness directly:

```text
Hermes Brain
  -> ai_office_run_phase(INVESTIGATE_PLAN | IMPLEMENT | IMPLEMENT_FIX | VERIFY_REVIEW | FINALIZE)
  -> AI Office V3 control plane
  -> OpenHands execution lifecycle
  -> OpenCode / other approved ACP backend
  -> LiteLLM logical model class
```

Hermes chooses the semantic phase and objective only. AI Office owns backend/model
selection, workspace isolation, fresh review snapshots, lifecycle correlation,
usage evidence, and deterministic finalization. The older terminal staffing hook
and `ai_office_resolve_execution` are active only when a profile is explicitly put in
`execution_mode=v2` for rollback; V3 rejects that second routing path.

Raw prompts, raw tool results, and provider credentials are never sent to the
dashboard. V3 forwards only the bounded phase objective/context required for the
selected development execution.

## Included surfaces

- Hermes dashboard tab: Overview, Organization, Workforce, **Models & Providers** (read-only LiteLLM registry), Operations, Runtime Policy, and Incidents.
- `ai_office_run_phase` V3 development delegation plus execution get/cancel/list tools.
- `pre_tool_call` legacy runtime staffing policy for direct OpenCode/Codex launches.
- `post_tool_call` runtime launch telemetry.
- `subagent_start` / `subagent_stop` lineage telemetry.
- Namespaced Hermes plugin settings for `observe`, `prefer`, or `enforce` mode.
- Local-only dashboard backend proxy to the AI Workforce Domain Service.

## V3 development execution

The primary development tool is:

```text
ai_office_run_phase(
  phase=INVESTIGATE_PLAN|IMPLEMENT|IMPLEMENT_FIX|VERIFY_REVIEW|FINALIZE,
  objective=...,
  repository_path=...,        # initial investigate/implement only
  previous_execution_id=...,  # phase handoff
)
```

The standard flow is:

```text
INVESTIGATE_PLAN
  -> IMPLEMENT
  -> VERIFY_REVIEW
      -> IMPLEMENT_FIX -> VERIFY_REVIEW  # only when review finds a real defect
  -> FINALIZE
```

`INVESTIGATE_PLAN` keeps repository investigation and planning in one OpenHands
conversation so model context/prompt-cache reuse is preserved. `IMPLEMENT` uses an
isolated writable Git branch and is asynchronous by default. `VERIFY_REVIEW`
freezes the implementation's complete Git-visible working tree into an independent,
physically read-only snapshot; build/test commands that need writes run in a
disposable `/tmp` copy. `IMPLEMENT_FIX` takes the **failed review execution** as its
causal parent, follows that review back to the implementation it inspected, and reuses
the exact implementation working tree/branch in a fresh execution conversation. This
keeps both the reviewer findings and mutable-workspace lineage explicit. `FINALIZE`
takes the approved review execution as its parent; it is deterministic control-plane
work and consumes no LLM tokens.

The plugin always creates V3 executions with a short `await=false` HTTP request. If
the caller requests synchronous semantics, the plugin waits using bounded short GET
polls. If the wait budget expires the execution remains durable and recoverable by
ID; it is not cancelled.

Related tools:

```text
ai_office_get_execution(execution_id=...)
ai_office_continue_execution(execution_id=..., message=...)  # PAUSED same-phase recovery only
ai_office_cancel_execution(execution_id=...)
ai_office_list_active(project_key=...)
```

Hermes profile/session/turn metadata and an idempotency key derived from the tool
call are added automatically. Handoff IDs are causal, not generic workspace pointers:
`VERIFY_REVIEW` points to the implementation/fix being reviewed; `IMPLEMENT_FIX`
points to the failed review; `FINALIZE` points to the approved review. Project identity
and previous semantic results are resolved automatically, so the Brain does not need
to copy workspace paths or large prior outputs through the prompt.

Backend/model/transport overrides are optional requests, not bypasses. AI Office
validates them against current policy and availability. Do not persist fixed rules
such as `IMPLEMENT=OpenCode/DeepSeek` or `REVIEW=Codex/GPT`; placement is per
execution.

### Profile execution mode and rollback

Each enabled Hermes profile has one execution authority:

```text
plugins.entries.hermes-ai-office.settings.execution_mode = v3 | v2 | disabled
```

- `v3` — `ai_office_run_phase` is the normal development path and the legacy terminal staffing hook is bypassed;
- `v2` — new V3 phase starts are rejected and legacy `ai_office_resolve_execution` / direct-harness placement is the rollback path;
- `disabled` — AI Office does not route software-development execution.

Existing V3 execution IDs remain get/list/continue/cancel capable after a mode change so
a rollback cannot orphan already-running work. The migration-safe default for an
installation without this setting is `v2`; V3 must be explicitly opted in.

On current oracle2, default, BodySense, Digital Biome, and Orchestrator are explicitly
`v3`. MemoFlow remains intentionally opted out with `.ai-office-disabled`; the deploy
sync helper preserves that marker and does not silently re-enable the plugin.

### Exact managed-lane observability

Managed OpenHands requests carry the V3 execution ID in the standard
OpenAI-compatible `user` field. LiteLLM persists it as spend-log `end_user`, allowing
AI Office to query exact per-execution token/cache/reasoning/cost facts plus the
observed physical model, provider, and deployment ID. Old executions without this
correlation stay unlinked rather than being matched by timestamp.

LiteLLM spend observability and Langfuse are separate health sources. Current oracle2
uses the former and reports Langfuse as `UNCONFIGURED`; the root-only LiteLLM admin
credential used for spend reads is never injected into OpenHands/OpenCode workers.

### Cutover readiness

`GET /api/v3/development/readiness` and the Development dashboard expose explicit
qualification gates. As of 2026-08-22, provider fallback, Gateway reconnect, V3/V2
rollback, workspace isolation, recovery controls, exact observability, and a real
seeded-defect fix loop are verified. Overall status remains `NOT_READY` because only
**1/10 representative real development workflows** are registered. Probe executions
and intentional failure injections do not count toward that gate.

### Legacy direct-harness placement

`ai_office_resolve_execution(intent=...)` and the terminal staffing hook remain only
as the explicit V2 rollback/direct-harness path. They are not the normal production
V3 development path and do not define current provider authority. LiteLLM owns V3
provider credentials, deployments, routing, health and spend; the V2 Provider Hub is
retained as compatibility/history for that legacy path.

## Runtime policy modes

| Mode      | Behavior                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `observe` | Record the policy decision but never modify or block the terminal call.                                                  |
| `prefer`  | Inject a selected Employee model; preserve unmatched explicit overrides; fail open if the policy service is unavailable. |
| `enforce` | Require an eligible Employee; replace unmatched model overrides or block when no valid staffing decision is possible.    |

Default settings:

```yaml
plugins:
  entries:
    hermes-ai-office:
      settings:
        runtime_policy:
          mode: prefer
          positions:
            opencode: coding-executor
            codex: codex-executor
```

The Runtime Policy tab edits the same namespaced settings. Hermes reads them for
each new tool call, so a dashboard change does not require a gateway restart.

## Install from this repository

Hermes supports plugin subdirectories in Git repositories:

```bash
hermes plugins install BakerSean168/hermes-ai-office/hermes-ai-office --enable
```

When the default gateway uses `multiplex_profiles`, each routed profile has an
isolated Hermes home and therefore its own plugin enablement. After installing
or updating AI Office in the default home, sync the same plugin source into the
existing profile homes:

```bash
./hermes-ai-office/scripts/sync-multiplex-profiles.sh
```

The script links the default AI Office plugin into each profile and enables it
there without copying credentials. This is required for profile-routed Telegram
threads such as `memoflow` to expose the `ai_office` toolset.

AI Office also retains Hermes' request-scoped `post_api_request` and
`api_request_error` hooks for the explicit **V2 rollback mode only**. In V3 they are
no-ops, so normal V3 traffic cannot shadow-write provider health into Provider Hub.
When a profile is deliberately rolled back to V2, those observations may refresh
legacy Provider Hub availability/capacity evidence. Prompt, response, request-body,
and provider secret content are never forwarded by this telemetry path.

For a local checkout:

```bash
cp -a hermes-ai-office "$HERMES_HOME/plugins/hermes-ai-office"
hermes plugins enable hermes-ai-office
hermes plugins doctor hermes-ai-office --ci
```

Restart long-running Hermes dashboard/gateway processes after the first install so
they discover the new Python hooks and dashboard manifest.

## Local service contracts

The plugin expects:

- AI Workforce Domain Service: `http://127.0.0.1:8320`
- Observer bridge: `http://127.0.0.1:8787/api/observer`

Optional environment overrides:

```text
HERMES_AI_OFFICE_CONTROL_PLANE_URL
HERMES_OFFICE_OBSERVER_URL
```

The control-plane override is intentionally restricted to loopback HTTP. The
plugin is not a generic remote credential proxy. Provider/model CRUD is intentionally
absent from the plugin surface: use the tailnet-only LiteLLM Admin UI exposed by the
control plane's `adminUrl` metadata.

## Development checks

```bash
python -m unittest hermes-ai-office/test_plugin.py hermes-ai-office/test_dashboard.py -v
node --check hermes-ai-office/dashboard/dist/index.js
hermes plugins doctor hermes-ai-office --ci
```

## Safe oracle2 deployment

The oracle2 production gateway multiplexes multiple Hermes profiles. Recreating
`hermes-personal` for an AI Office update interrupts unrelated in-flight turns
(such as MemoFlow), so plugin deployment is intentionally separated from
container deployment.

Install the host deployer once:

```bash
sudo ./hermes-ai-office/scripts/install-oracle2-safe-deploy.sh
```

Then deploy changes with:

```bash
sudo /usr/local/sbin/hermes-ai-office-deploy --deploy
```

`dashboard/**` changes are hot-synced and the dashboard plugin cache is
rescanned without restarting the Gateway. Runtime plugin changes are staged; if
Hermes is busy, a systemd timer keeps them pending. Once the Gateway is idle,
the deployer requests Hermes' native drain, activates the staged plugin,
reconciles multiplex profile links, calls the native Gateway restart endpoint,
and cancels the drain after the new Gateway is healthy. The
`hermes-personal` container is not recreated.

Useful diagnostics:

```bash
sudo /usr/local/sbin/hermes-ai-office-deploy --plan
sudo /usr/local/sbin/hermes-ai-office-deploy --guard-only
systemctl status hermes-ai-office-deploy-reconcile.timer
```

To keep AI Office disabled for one multiplex profile across later deployments,
create `${HERMES_HOME}/profiles/<profile>/.ai-office-disabled`. The sync helper
will disable the plugin for that profile and remove only its profile-local
symlink while leaving the shared plugin installed for other profiles. Remove
the marker when that profile should opt back in.
