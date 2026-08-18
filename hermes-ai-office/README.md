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

When Hermes is about to launch `opencode` or `codex` through the `terminal` tool,
the plugin asks the local AI Workforce Domain Service which appointed Employee
should fill the configured runtime Position. In `prefer` or `enforce` mode it can
inject the selected native runtime model:

```text
opencode run ...
  -> opencode run --model opencode-go/deepseek-v4-flash ...

codex exec ...
  -> codex --model gpt-5.6-sol --profile anyrouter exec ...
```

Raw prompts, raw tool results, and provider credentials are never sent to the
policy service or dashboard.

## Included surfaces

- Hermes dashboard tab: Overview, Organization, Workforce, Suppliers, Operations,
  Runtime Policy, and Incidents.
- `pre_tool_call` runtime staffing policy for OpenCode and Codex.
- `post_tool_call` runtime launch telemetry.
- `subagent_start` / `subagent_stop` lineage telemetry.
- Namespaced Hermes plugin settings for `observe`, `prefer`, or `enforce` mode.
- Local-only dashboard backend proxy to the AI Workforce Domain Service.

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
plugin is not a generic remote credential proxy.

## Development checks

```bash
python -m unittest hermes-ai-office/test_plugin.py hermes-ai-office/test_dashboard.py -v
node --check hermes-ai-office/dashboard/dist/index.js
hermes plugins doctor hermes-ai-office --ci
```
