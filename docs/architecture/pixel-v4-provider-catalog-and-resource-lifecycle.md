# Pixel V4 Provider Catalog and Resource Lifecycle

## Purpose

This document defines how providers are discovered, activated, ordered, suspended, disabled, and re-enabled across LiteLLM-managed and provider-native resources.

The design deliberately favors predictable operations over automatic optimization.

## 1. Provider catalog is not the runtime model set

An upstream `/models` response is discovery evidence only.

The system keeps two concepts separate:

```text
Advertised Catalog
  everything the provider claims to expose

Active Runtime Set
  only model families approved by Pixel policy and verified for this credential
```

A relay advertising GPT 5.3, 5.4, 5.5, 5.6, Claude, Gemini, image, audio, realtime, and domestic models does not cause all of those deployments to enter automatic routing.

## 2. Initial active automatic model allow-list

Implementation:

```text
deepseek-v4-flash
approved GLM implementation model (initially the currently validated version)
gpt-5.6-luna
```

Reasoning:

```text
gpt-5.6-sol
claude-opus-5
claude-opus-4-8
```

Excluded from default automatic routing unless explicitly re-approved:

```text
gpt-5.3-* legacy/compatibility families
gpt-5.4* legacy/compatibility families
gpt-5.5* legacy/compatibility families
gpt-5.6-terra unless a concrete role is approved
codex-auto-review
image/audio/realtime models
provider-specific aliases with no approved execution role
```

Existing deployments are disabled first, not immediately deleted. This preserves rollback and historical telemetry correlation.

## 3. Import flow

Provider import becomes a curated intersection:

```text
probe provider catalog
  -> normalize advertised names
  -> intersect with ActiveModelPolicy
  -> verify requested protocol
  -> per-model smoke with the actual credential
  -> create only passing active deployments
  -> persist provider/resource metadata and sequence
```

The importer should expose explicit modes:

```text
--model <exact>             # repeatable explicit activation
--policy automatic-core     # activate only the approved automatic set
--discover-only             # record/display catalog, create no deployment
```

The current broad `--family gpt` behavior is deprecated for normal AI Office imports because it imports obsolete model generations just because the provider advertises them.

## 4. Provider protocol is per model-resource binding

Provider identity and wire protocol are independent.

Examples:

```text
ORCAI gpt-5.6-luna -> openai-responses
WorldClaw gpt-5.6-luna -> openai-chat-completions
community DeepSeek -> openai-chat-completions
```

Responses-capable providers keep their native protocol. Codex should use Responses directly where the execution path supports it. Compatibility bridging exists for downstream clients that still call Chat Completions, but it is not a reason to rewrite the upstream provider as a chat provider.

## 5. Resource identity

The resource directory distinguishes provider brand, credential/account, and model binding.

Recommended identifiers:

```text
providerId        # supplier identity, e.g. orcai
resourceId        # credential/account/subscription identity
modelBindingId    # resource + model family + protocol deployment
```

Quota/auth state is normally resource-level because one API key/account may share quota across many models.

Model unsupported/unavailable state is normally binding-level.

## 6. Resource sequence

Every resource receives one immutable monotonic `resource_sequence`.

The sequence is assigned once at registration/import and copied into every LiteLLM deployment metadata record for that resource.

Example:

```text
resource_sequence=101  WorldClaw credential A
resource_sequence=102  ORCAI credential A
resource_sequence=103  ModelFlare credential A
```

All `WorldClaw credential A` model deployments keep sequence 101.

For provider-native resources, the same field is declared in the provider-native resource registry:

```text
ChatGPT Business workspace A
Antigravity account A
```

## 7. Deterministic LiteLLM deployment order

LiteLLM deployments should not share one coarse order such as `40` for every metered relay because equal-priority shuffling defeats cache locality.

Encode a unique deployment order from tier + sequence, for example:

```text
PROMOTIONAL base 100000
FREE/SPONSORED base 200000
SUBSCRIPTION base 300000
METERED base 400000
OTHER base 600000

litellm_order = tier_base + resource_sequence
```

The exact numeric ranges are an implementation detail, but these invariants are required:

- lower tier always wins;
- within one tier, lower resource sequence always wins;
- all deployments backed by the same resource preserve stable relative ordering;
- no random shuffle is required to choose between equal resources.

Pixel still owns cross-model selection. LiteLLM uses this order only among resources capable of serving the already-selected model family.

## 8. Resource states

Operator-facing state is intentionally small:

```text
ACTIVE
SUSPENDED
DISABLED
```

State records additionally carry:

```text
reasonClass
sanitizedReason
changedAt
suspendedUntil?  # only for SUSPENDED
source            # execution, probe, operator, expiry timer
```

## 9. Failure classification

Normalize common provider failures before applying lifecycle policy:

```text
AUTH_REJECTED
QUOTA_EXHAUSTED
RATE_LIMITED
TEMPORARY_PROVIDER_FAILURE
CONNECTION_UNAVAILABLE
MODEL_UNAVAILABLE
ROUTE_MISCONFIGURED
PROMOTION_EXPIRED
UNKNOWN_PROVIDER_FAILURE
```

Examples that count as explicit quota exhaustion include provider messages such as:

```text
monthly usage limit reached
quota exhausted
insufficient balance
credits exhausted
usage limit reached
```

Generic HTTP 429 without exhaustion semantics remains `RATE_LIMITED`.

## 10. State policy by resource class

### Explicit quota exhaustion

For all resource classes:

```text
QUOTA_EXHAUSTED -> DISABLED
```

Disable the whole credential/resource, not only the one model deployment, unless quota is proven to be model-specific.

The system may record a provider-advertised reset time for visibility, but the first implementation does not automatically re-enable exhausted resources. Operator enable is explicit and safe.

### Authentication rejection

```text
AUTH_REJECTED -> DISABLED
```

401/403 caused by provider policy, invalid/expired credentials, or revoked access should not be retried indefinitely.

### Promotional expiry

```text
PROMOTION_EXPIRED -> DISABLED
```

This keeps the existing expiry reconciliation behavior.

### Community/free transient failure

For `FREE`/`SPONSORED` community resources:

```text
RATE_LIMITED / 5xx / timeout / connection failure
  -> SUSPENDED for 24h
  -> one bounded probe after suspension
      -> success: ACTIVE
      -> failure: DISABLED until manual enable
```

Do not continuously poll a dead community relay.

### Subscription/metered transient failure

For paid/subscription resources:

```text
RATE_LIMITED / 5xx / timeout
  -> short bounded cooldown/suspension
  -> automatic re-entry after cooldown
```

The exact cooldown may reuse LiteLLM's runtime cooldown initially. Durable provider-level suspension is added only when repeated failures show that the gateway cooldown is insufficient.

### Model-specific failure

```text
MODEL_UNAVAILABLE
  -> disable/cooldown only the model binding
```

Do not disable a provider's Luna resource because its unrelated audio or legacy GPT model is unavailable.

## 11. Manual controls

Operators need explicit actions:

```text
disable resource
enable resource
suspend resource for duration
disable one model binding
enable one model binding
inspect sanitized last failure
inspect resource sequence/tier
```

Manual enable clears the durable disable state but does not overwrite provider metadata, sequence, or historical observations.

## 12. Provider-native resources

Provider-native subscriptions are projected into the same directory without copying credentials into LiteLLM.

Example registry entries:

```yaml
- resourceId: chatgpt-business-primary
  commercialType: SUBSCRIPTION
  supplyOrigin: OFFICIAL
  resourceLifecycle: RECURRING
  resourceSequence: 120
  transport: PROVIDER_NATIVE
  bindings:
    - modelFamily: gpt-5.6-luna
      backend: codex-business-worker-headless
    - modelFamily: gpt-5.6-sol
      backend: codex-business-review-headless

- resourceId: antigravity-primary
  commercialType: SUBSCRIPTION
  supplyOrigin: OFFICIAL
  resourceLifecycle: RECURRING
  resourceSequence: 121
  transport: PROVIDER_NATIVE
```

Secrets remain in their existing authenticated homes. The resource directory stores only non-secret routing facts and readiness state.

## 13. Dashboard expectations

Provider/resource UI should distinguish:

```text
Advertised models
Active automatic models
Disabled model bindings
Resource state
Resource tier
Resource sequence
Transport
Protocol
Last normalized failure
```

This makes it obvious why a provider exists but is not part of automatic routing.
