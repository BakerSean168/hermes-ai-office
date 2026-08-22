# V3 Configuration Model

## 1. Configuration goals

Configuration should express business policy separately from upstream infrastructure details.

Three configuration authorities:

```text
AI Office policy config  -> development semantics/economics
LiteLLM config/database  -> models/deployments/keys/routing
OpenHands settings       -> execution backend/workspace/ACP settings
```

Do not merge all three into one giant custom YAML schema.

## 2. AI Office development policy

Proposed file:

```text
config/development-policy.yaml
```

Example:

```yaml
version: 1

phases:
  INVESTIGATE_PLAN:
    backend_candidates:
      - codex-acp
      - opencode-acp
      - openhands-builtin
    model_class: planning-premium
    transport_preference:
      - LITELLM_MANAGED
      - NATIVE_SUBSCRIPTION
    workspace_mode: read_oriented
    session_policy: fresh

  IMPLEMENT:
    backend_candidates:
      - opencode-acp
      - openhands-builtin
      - codex-acp
    model_class: implementation-efficient
    transport_preference:
      - LITELLM_MANAGED
      - NATIVE_SUBSCRIPTION
    workspace_mode: isolated_write
    session_policy: fresh

  IMPLEMENT_FIX:
    backend_candidates:
      - opencode-acp
      - codex-acp
      - openhands-builtin
    model_class: implementation-efficient
    workspace_mode: reuse_implementation_workspace
    session_policy: resume_preferred

  VERIFY_REVIEW:
    backend_candidates:
      - codex-acp
      - claude-code-acp
      - opencode-acp
    model_class: review-premium
    transport_preference:
      - LITELLM_MANAGED
      - NATIVE_SUBSCRIPTION
    workspace_mode: review_snapshot
    session_policy: fresh_required
```

## 3. Complexity override rules

```yaml
complexity_rules:
  high:
    IMPLEMENT:
      model_class: implementation-premium

risk_rules:
  high:
    VERIFY_REVIEW:
      require_fresh_backend_family: true
```

Keep policy simple and deterministic initially.

## 4. Execution backend registry

```yaml
backends:
  openhands-builtin:
    kind: openhands
    enabled: true
    supports:
      litellm_managed: true
      native_subscription: false
      write: true

  codex-acp:
    kind: acp
    enabled: true
    command:
      - npx
      - -y
      - '@zed-industries/codex-acp'
    supports:
      litellm_managed: conditional
      native_subscription: true
      write: true

  opencode-acp:
    kind: acp
    enabled: true
    command:
      - opencode
      - acp
    supports:
      litellm_managed: true
      native_subscription: true
      write: true

  claude-code-acp:
    kind: acp
    enabled: true
    command:
      - npx
      - -y
      - '@agentclientprotocol/claude-agent-acp'
    supports:
      litellm_managed: conditional
      native_subscription: true
      write: true

  dsh:
    kind: external_adapter
    enabled: false
```

The exact executable/version must be pinned during implementation. Do not run floating `npx -y` versions in production without a reproducibility decision.

## 5. Provider economics overlay

```yaml
provider_economics:
  provider-a-free:
    litellm_ref: provider-a
    commercial_class: FREE
    priority: 100
    enabled: true

  provider-b-subscription:
    litellm_ref: provider-b
    commercial_class: SUBSCRIPTION
    priority: 80
    enabled: true
    quota:
      kind: credit
      reset: monthly

  provider-c-payg:
    litellm_ref: provider-c
    commercial_class: PAYG
    priority: 20
    enabled: true
```

No API keys appear here.

## 6. LiteLLM logical model groups

Production no longer stores provider deployments or API keys in `config.yaml`.
LiteLLM Credential Store + PostgreSQL-backed model deployments are the runtime source
of truth. The checked-in config keeps only router policy and stable aliases:

```yaml
model_list: []
router_settings:
  routing_strategy: simple-shuffle
  num_retries: 1
  max_fallbacks: 2
  allowed_fails: 1
  cooldown_time: 30
  model_group_alias:
    planning-premium: gpt-5.6-sol
    review-premium: gpt-5.6-sol
    implementation-efficient: deepseek-v4-flash
```

Provider credentials and endpoint URLs are created/edited in LiteLLM Admin/API, not
in AI Office. Physical deployments carry `order` plus safe economics/protocol metadata.
The router selects the lowest healthy order and advances after retryable failure or
cooldown. This keeps provider choice beneath the stable V3 logical model boundary.

## 7. LiteLLM observability

Current oracle2 V3 uses LiteLLM's own spend log as the exact operational usage and
physical-route source. It does **not** pretend that this is Langfuse.

Correlation contract:

```text
V3 execution_id
  -> OpenAI-compatible request user
  -> LiteLLM spend end_user
  -> exact usage + model + provider + deployment_id
```

Built-in OpenHands sets `litellm_extra_body.user = executionId`. Managed OpenCode
ACP receives `HERMES_V3_EXECUTION_ID` through OpenHands SecretRegistry and maps it
through model `options.user`. AI Office queries `/spend/logs/v2` server-side with
`end_user=<executionId>`; it never joins by timestamp.

Control-plane-only environment:

```text
MODEL_CP_V3_LITELLM_OBSERVABILITY=1
MODEL_CP_V3_LITELLM_ADMIN_ENV_FILE=/srv/hermes-personal/secrets/litellm.env
MODEL_CP_V3_LITELLM_ADMIN_URL=https://<tailnet-host>:10446/ui/
```

The host-specific Admin URL is loaded from `/srv/hermes-personal/secrets/model-control-plane-v3.env` in production so real internal DNS names do not need to be committed. The admin/master credential is root-only and is never injected into OpenHands or OpenCode. Workers keep using the scoped LiteLLM client key.

Langfuse remains an optional deeper analytics/trace plane. If enabled later, its
credentials stay outside source control:

```text
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
LANGFUSE_HOST
```

`sourceHealth.observability` and `sourceHealth.langfuse` are separate fields. On
current oracle2 the expected state is `observability=OK`, `langfuse=UNCONFIGURED`.

## 8. OpenHands built-in Agent -> LiteLLM

Expected configuration concept:

```text
model: litellm_proxy/<logical-model-class>
base_url: http://litellm:4000
api_key: <scoped LiteLLM virtual key>
```

The concrete OpenHands SDK/settings representation must be validated against the pinned OpenHands version.

## 9. ACP managed-lane configuration

For ACP backends, gateway use is backend-specific.

Example intent:

```text
OPENAI_BASE_URL=http://litellm:4000
OPENAI_API_KEY=<scoped LiteLLM key>
```

or the environment variables expected by the specific ACP server.

Do not assume one environment contract works for all agents. The backend registry adapter translates the logical `LITELLM_MANAGED` mode into tested backend-specific settings.

## 10. Native subscription configuration

Native logins remain in the execution host's protected user/home/secret boundary:

```text
Codex subscription login
Claude Code subscription login
OpenCode provider auth
```

AI Office only stores:

```text
backend has native auth: yes/no
last validated at
```

It does not copy OAuth tokens into its database.

## 11. Project policy override

Optional repository file:

```text
.ai-office.yaml
```

Safe fields only:

```yaml
project_key: memoflow
observability:
  privacy: METADATA_ONLY

development:
  review:
    require_fresh_backend_family: true
  parallelism:
    max_writers: 3
```

Do not permit a repository-controlled config file to inject secrets or arbitrary host commands into Agent Server configuration.

## 12. Version pinning

Production composition must pin:

```text
OpenHands Agent Server/SDK version
LiteLLM version
Langfuse integration/client version
ACP server package versions
OpenCode/Codex/Claude CLI versions as applicable
```

Upgrades happen one boundary at a time with contract tests.
