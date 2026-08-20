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

## Execution placement

Hermes can ask AI Office for an execution worker before choosing a coding harness:

```text
ai_office_resolve_execution(intent=IMPLEMENT|DEBUG|TEST|QUICK_FIX|PLAN|REVIEW|RESEARCH)
```

The policy is deliberately small and opinionated. `PLAN`, `REVIEW`, and `RESEARCH` select from the premium roster (current Claude Opus/Sonnet and GPT-5.6 Sol/Terra-class workers). Implementation intents select from GPT-5.6 Luna, DeepSeek V4 Flash, or GLM-5.2 workers. Intent determines only the work class; it never implies a fixed model or coding harness. The implementation roster uses a neutral model baseline so provider availability, reusable runtime access, official-harness compatibility, and explicit commercial rules can decide each execution. Provider availability and credential scope remain hard routing gates rather than prompt hints.

Harness preference follows the selected model family: Claude -> Claude Code, GPT -> Codex, DeepSeek -> DSH, and GLM -> ZCode when an explicitly enabled ZCode runtime is available. Otherwise AI Office returns the supported fallback, normally OpenCode. Existing native profiles are reused; missing API-key profiles are materialized from safe ProviderConnection metadata. The response contains only a credential reference, never credential material.

DeepSeek V4 Flash has one time-sensitive commercial rule: Asia/Shanghai 09:00-18:00 applies a peak-price penalty only to OpenCode Go and the DeepSeek official API. Third-party commercial or sponsored relay connections are not time-priced by this policy. This is evaluated at decision time; no cron job mutates the active model.

Before placement, AI Office reconciles only the fixed policy roster from Provider Hub into Employee/Employment records. Providers that do not expose a models endpoint may supply an explicit model list when they are added. This keeps large upstream catalogs out of the workforce model while allowing known endpoints such as limited contest/free APIs to participate.

A selected execution response includes the Employee, Employment, safe ProviderConnection metadata, preferred/selected harness, profile action, launch template, reasons, `decisionScope=PER_EXECUTION`, and a short usage instruction. Hermes should treat the returned command template as the launch contract and replace only the task placeholder. It must not generalize one selected model or harness into a permanent mapping such as `IMPLEMENT=DSH` or `REVIEW=CODEX`, and must not store such a mapping as a memory rule.

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

AI Office also consumes Hermes' request-scoped `post_api_request` and
`api_request_error` hooks. Successful main-Agent LLM calls provide sampled
operational evidence to the Provider Hub, while rate-limit/auth/quota/network/
timeout/server failures are recorded immediately. Request-specific failures
such as content-policy blocks, context overflow, bad payloads, and missing
models are excluded so they cannot degrade supplier availability. Prompt,
response, request-body, and provider secret content are never forwarded by
this telemetry path.

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
