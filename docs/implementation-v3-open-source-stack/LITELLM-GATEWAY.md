# LiteLLM Gateway Strategy

## 1. Decision

Use **LiteLLM Proxy as the managed model gateway** for development-agent model traffic that can be routed through an API-key/custom-base-url path.

This is a deliberate change from the previous idea of returning provider credentials to agents and asking every agent adapter to report usage independently.

The extra network hop is accepted in exchange for reusing mature provider normalization, routing, retries, spend tracking, budgets, auth, and observability integration.

## 2. What LiteLLM owns

In the managed lane LiteLLM owns:

- provider API normalization;
- model/deployment configuration;
- actual deployment selection;
- retry/fallback/cooldown/load balancing;
- gateway authentication;
- virtual keys and model access controls where configured;
- request-level usage/cost evidence;
- gateway-level provider errors/latency;
- logging callbacks to Langfuse.

AI Office does not duplicate these mechanisms.

## 3. What AI Office still owns

LiteLLM is infrastructure-generic. It does not know the user's software-development semantics.

AI Office retains:

- phase -> logical model class policy;
- execution backend selection;
- transport preference;
- user-specific commercial ranking such as `FREE > SUBSCRIPTION > PAYG`;
- capability/risk requirements that should exclude a candidate before calling LiteLLM;
- cross-system execution correlation metadata.

## 4. Logical model classes

Hermes and Development Skill should never depend on concrete provider model IDs.

Initial aliases:

```text
planning-premium
implementation-efficient
implementation-premium
review-premium
fast-general
```

LiteLLM maps these names to one or more physical deployments.

Illustrative topology:

```text
planning-premium
  ├─ premium-model-A @ provider-1
  └─ premium-model-A @ provider-2

implementation-efficient
  ├─ efficient-model-A @ provider-3
  └─ efficient-model-B @ provider-4
```

A model group should contain only deployments that are acceptable substitutes for the business meaning of that alias.

Do **not** put materially different quality/capability tiers into one group merely to obtain fallback.

## 5. Two-level routing

### AI Office business policy

Chooses:

```text
model_class = implementation-efficient
transport = LITELLM_MANAGED
backend = opencode-acp
```

### LiteLLM infrastructure policy

Chooses among eligible physical deployments within `implementation-efficient`.

This separation lets AI Office remain small while LiteLLM handles fast-changing provider mechanics.

## 6. Commercial policy

User economics are not identical to provider list price.

Recommended AI Office metadata per deployment/source:

```text
commercial_class: FREE | SUBSCRIPTION | PAYG
quota_kind: none | request | token | credit | time-window
expires_at: optional
preference_weight: integer
business_enabled: boolean
```

Default business ranking:

```text
usable FREE
  > usable expiring SUBSCRIPTION quota
  > PAYG
```

This policy is evaluated before or while constructing the eligible model pool. LiteLLM then handles routing inside that eligible pool.

## 7. Provider health

Do not build an independent AI Office provider-health state machine if LiteLLM already has the necessary routing/cooldown evidence.

AI Office UI may expose:

```text
healthy / degraded / unavailable
last error class
last observed latency
cooldown if available
```

but these are projections of LiteLLM data.

User/operator overrides may remain AI Office policy:

```text
enabled = false
```

or be written through LiteLLM's own administration API/config where appropriate.

## 8. Usage and cost

For every LiteLLM-managed request, capture/forward at least:

```text
logical model alias
actual model
provider/deployment identifier
input tokens
output tokens
cache usage if present
reasoning usage if present
request duration
response cost when known
error class
```

LiteLLM's usage response/callback is preferred over client-side token estimation.

Langfuse should receive the same request as a generation observation so historical analytics are not reimplemented in AI Office.

## 9. Correlation metadata

Every managed request should carry sufficient metadata to connect it to the enclosing development execution.

Target fields:

```text
execution_id
project_key
phase
hermes_profile
hermes_session_id
openhands_conversation_id
execution_backend
logical_model_class
transport_mode
```

The exact LiteLLM mechanism may use supported metadata/tags/headers depending on the client/backend path; the adapter must preserve the semantic fields even if transport syntax changes across upstream versions.

## 10. Virtual keys

Prefer scoped LiteLLM virtual keys over exposing the master gateway key to every execution environment.

Candidate scopes:

```text
openhands-builtin
codex-acp-managed
opencode-acp-managed
review-worker
```

Where feasible apply:

- model access restriction;
- budget/rate limits;
- environment/project labels;
- revocation without rotating provider secrets.

Provider API keys remain inside LiteLLM's protected deployment configuration/database boundary.

## 11. Secret rule

Hermes Brain never receives provider API keys.

Managed path:

```text
Hermes
  -> AI Office policy
  -> OpenHands gets scoped LiteLLM key/base URL
  -> LiteLLM stores/uses actual provider credentials
```

This is materially safer than returning arbitrary provider `api_key + base_url` to the LLM and asking it to configure its own agent.

## 12. Native subscription exceptions

LiteLLM cannot be declared authoritative for a request that never passes through it.

For a native subscription execution:

```text
transport_mode = NATIVE_SUBSCRIPTION
```

AI Office must display:

- route is native, not LiteLLM-managed;
- provider selection/fallback is not controlled by LiteLLM;
- usage source is ACP/OpenHands/native telemetry;
- provider cost may be `UNKNOWN` or economically represented as subscription usage rather than PAYG charge.

Never merge these metrics with managed-lane cost as if their accuracy were identical.

## 13. Example LiteLLM configuration shape

This is conceptual and must be validated against the pinned LiteLLM version before deployment:

```yaml
model_list:
  - model_name: planning-premium
    litellm_params:
      model: <provider>/<model-a>
      api_key: os.environ/PROVIDER_A_KEY
      api_base: os.environ/PROVIDER_A_BASE

  - model_name: planning-premium
    litellm_params:
      model: <provider>/<model-a>
      api_key: os.environ/PROVIDER_B_KEY
      api_base: os.environ/PROVIDER_B_BASE

  - model_name: implementation-efficient
    litellm_params:
      model: <provider>/<efficient-model>
      api_key: os.environ/PROVIDER_C_KEY

litellm_settings:
  success_callback:
    - langfuse
  failure_callback:
    - langfuse
```

Do not commit real credentials.

## 14. Database requirement

A trivial LiteLLM config can run without a large custom database layer, but the V3 feature set expects gateway capabilities such as virtual keys/spend management that typically require LiteLLM's supported persistence configuration.

Use LiteLLM's own database schema and migrations. AI Office must not mirror provider secrets or gateway spend tables.

## 15. Failure semantics

### rate limit / transient provider failure

LiteLLM handles retry/fallback according to configured policy.

### all deployments for logical model fail

Return a normalized gateway failure to the coding agent. The outer workflow can then decide whether to retry with another model class or stop.

### auth failure

Treat as an operator/provider configuration incident, not a reason for infinite model fallback unless an explicitly equivalent healthy deployment exists.

### context overflow / bad request

Do not degrade provider health for request-specific failures. The caller/agent must correct the request or choose a different model capability.

## 16. Avoid over-configuring routing initially

Start with simple, explainable routing:

```text
hard eligibility
  -> business preference pool
  -> LiteLLM default/least-busy/simple strategy
  -> fallback on transient failure
```

Do not begin with an opaque learned router. Historical usage in Langfuse can later justify more sophisticated policy.

## 17. Escape hatch

`ModelGatewayPort` should expose only what AI Office actually needs:

```text
resolve/logical model configuration
health summary
usage/spend summary
admin links or narrow operator commands
```

If LiteLLM is replaced later, Development Skill and OpenHands execution semantics should remain unchanged.
