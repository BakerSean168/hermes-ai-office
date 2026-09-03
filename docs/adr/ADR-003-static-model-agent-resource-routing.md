# ADR-003: Static Model-Agent-Resource Routing

Date: 2026-09-03

Status: Accepted for V4 implementation

## Context

Pixel Agent currently spans three different concerns that were historically mixed together:

1. the engineering phase, such as implementation or independent reasoning/review;
2. the coding/reasoning harness, such as Codex, DSH, ZCode, Claude Code, or OpenHands builtin;
3. the actual compute resource, such as a LiteLLM relay, a promotional account, ChatGPT Business, or Antigravity.

V3 contained a richer backend policy and ACP backend inventory, while the current V4 automation path partially collapsed the model/backend decision into a short route list. That simplification made the V4 runtime easier to bootstrap, but it also caused several regressions:

- some implementations execute through the generic OpenHands builtin agent instead of the model-native coding harness;
- `codex-auto-review` is selected as a hard-coded review retry even when its only active relay is unhealthy;
- LiteLLM model groups and Pixel capability names overlap conceptually;
- provider economics, model choice, and provider-native subscriptions are not ranked through one deterministic resource policy;
- provider import can create many obsolete or unused model deployments simply because an upstream `/models` endpoint advertises them.

The operating environment also has several resource classes with materially different economics:

- promotional or temporary resources that should be consumed first;
- recurring free/sponsored community relays;
- already-paid subscriptions such as OpenCode Go or ChatGPT Business;
- metered commercial relays;
- provider-native resources such as ChatGPT Business and Antigravity that cannot or should not be forced through LiteLLM.

The system does not need a dynamic quality score or estimated cross-provider dollar cost. Model quality is already bounded by the small approved model set and by the phase capability. Commercial relay multipliers are often opaque. A deterministic static policy is easier to audit, test, and operate.

## Decision

Pixel V4 will use a deterministic four-stage routing model:

```text
task phase
  -> capability
  -> approved model family + model-native agent affinity
  -> ordered resource
  -> OpenHands execution host / provider-native adapter
```

### 1. Two capability classes

Pixel owns exactly two model capability classes:

- `IMPLEMENTATION`
- `REASONING`

Planning and review both use `REASONING`. Their safety and independence differences are execution-policy constraints, not separate model-quality tiers.

### 2. Small curated model set

The initial automatic model set is deliberately small.

Implementation:

| Rank | Model family                              | Preferred agent |
| ---: | ----------------------------------------- | --------------- |
|   10 | `deepseek-v4-flash`                       | DSH             |
|   20 | current approved GLM implementation model | ZCode           |
|   30 | `gpt-5.6-luna`                            | Codex           |

Reasoning:

| Rank | Model family      | Preferred agent |
| ---: | ----------------- | --------------- |
|   10 | `gpt-5.6-sol`     | Codex           |
|   20 | `claude-opus-5`   | Claude Code     |
|   30 | `claude-opus-4-8` | Claude Code     |

`claude-opus-4-8` is a compatibility fallback for providers that expose it but not Opus 5. It is not preferred over Opus 5.

The initial GLM production choice remains the already-proven model until a ZCode smoke/benchmark promotes a newer GLM version. Promotion replaces the previous canonical GLM implementation model; both versions are not kept in the automatic pool indefinitely.

### 3. Model-agent affinity is mandatory

Automatic routing chooses an executable profile, not a bare model name.

```text
DeepSeek V4 Flash -> DSH
GLM current       -> ZCode
GPT-5.6 Luna      -> Codex
GPT-5.6 Sol       -> Codex
Claude Opus       -> Claude Code
Gemini 3.8 Flash -> Antigravity when explicitly allowed by project policy
Gemini 3.7 Flash -> Antigravity compatibility fallback
```

OpenHands builtin remains a generic compatibility/fallback harness. It is not the preferred implementation harness for model families with an approved native agent.

Antigravity is a provider-native exception rather than a LiteLLM model family. On the current authenticated GCP runtime, `agy` 1.1.22 advertises and successfully smokes `gemini-3.8-flash-high`; V4 therefore treats 3.8 Flash High as the preferred Antigravity implementation model and `gemini-3.7-flash-high` as its compatibility fallback. These models do not enter the LiteLLM automatic allow-list merely because Antigravity can use them.

### 4. Static resource tiers

Every resource is assigned an economic/lifecycle class. Selection uses the following fixed tier order:

```text
PROMOTIONAL
  -> FREE / SPONSORED
  -> SUBSCRIPTION
  -> METERED
  -> OTHER
```

This order is independent of transport. A provider-native ChatGPT Business subscription and a LiteLLM-managed subscription resource participate in the same tier.

### 5. Deterministic selection key

For every eligible executable profile, Pixel selects by the lexicographic key:

```text
(
  resourceTierRank,
  modelRankWithinCapability,
  resourceSequence
)
```

`resourceSequence` is an immutable monotonic sequence assigned when a resource is added. It provides a stable tie-breaker and intentionally keeps traffic on the earlier configured provider until it becomes unavailable. This improves prompt-cache locality and makes provider usage predictable.

No dynamic quality score, cost estimator, or weighted composite ranking is used in the first implementation.

### 6. LiteLLM owns provider routing inside one model family

LiteLLM remains the authority for:

- credentials for LiteLLM-managed providers;
- deployments;
- protocol adaptation;
- model-family routing;
- request retries/cooldowns;
- usage/spend telemetry.

Pixel owns:

- the two capability classes;
- model-family preference;
- model-agent affinity;
- cross-resource economics;
- provider-native resource participation;
- durable disable/suspend decisions.

LiteLLM must not choose between DeepSeek, GLM, and Luna on behalf of Pixel because the agent must be selected before the execution session starts.

### 7. Provider-native resources participate in the same directory

ChatGPT Business and Antigravity are first-class execution resources even though they do not use LiteLLM credentials.

Examples:

```text
gpt-5.6-luna + Codex + ChatGPT Business + PROVIDER_NATIVE
gpt-5.6-sol  + Codex + ChatGPT Business + PROVIDER_NATIVE
Gemini 3.8 Flash + Antigravity + provider-native Google subscription
Gemini 3.7 Flash + Antigravity + provider-native Google subscription (compatibility fallback)
Gemini Pro + Antigravity + provider-native Google subscription
```

The selector sees the same economic class, lifecycle, sequence, availability, model capability, and backend affinity regardless of transport.

### 8. Curated provider import

Provider catalog discovery and active runtime deployment are separate concepts.

An upstream may advertise dozens of models. Provider import creates automatic runtime deployments only for the approved active model set. Old GPT generations, image/audio/realtime models, and provider-specific aliases are not automatically activated merely because they are advertised.

`codex-auto-review` is removed from the default V4 review ladder. It may remain discoverable or manually enabled for experiments, but it is not an automatic review capability.

### 9. Simple durable resource states

Resources use three operator-facing states:

```text
ACTIVE
SUSPENDED
DISABLED
```

Normalized failure classes drive simple transitions:

- explicit quota/balance/usage exhaustion -> `DISABLED`;
- authentication rejection -> `DISABLED`;
- promotional expiry -> `DISABLED`;
- community/free transient failure -> `SUSPENDED` for 24 hours, then one bounded probe; a failed probe becomes `DISABLED` until manual enable;
- subscription/metered transient rate-limit/5xx/timeout -> short bounded cooldown/suspension, then automatic re-entry;
- model-specific unsupported/model-unavailable errors disable only that model-resource binding unless the evidence proves the whole credential/resource is unusable.

## Consequences

### Positive

- routing is deterministic and explainable;
- model-native coding agents are restored as the primary implementation path;
- provider-native subscriptions and LiteLLM resources share one policy;
- promotional/free capacity is consumed before already-paid subscription capacity and metered relays;
- stable provider ordering improves cache locality;
- obsolete provider-advertised models no longer pollute the automatic runtime;
- planning and review no longer need duplicate logical model aliases;
- provider exhaustion produces durable state instead of repeated futile calls.

### Negative

- the selector must know resource availability before launching an execution;
- LiteLLM provider metadata must gain stable resource sequence/state information;
- provider-native resources need a projection into the same resource directory;
- migration must preserve compatibility aliases until all callers stop depending on them;
- provider catalog discovery still needs to retain enough information for later manual activation even when models are not deployed automatically.

## Rejected alternatives

### Dynamic quality and cost scoring

Rejected for the initial V4 routing layer. The approved model set already provides the quality boundary, and upstream commercial pricing multipliers are frequently opaque. A composite score would be harder to reason about and debug than a deterministic static order.

### One LiteLLM `implementation` model group containing DeepSeek, GLM, and Luna

Rejected. Pixel must know the model family before starting DSH, ZCode, or Codex. Cross-family fallback inside LiteLLM would hide the model-agent transition from durable execution provenance.

### Let OpenHands dynamically choose the coding agent

Rejected. OpenHands hosts the selected ACP/backend session; it does not own hidden second-layer routing. Pixel must persist the chosen executable profile before launch.

### Import every provider-advertised model

Rejected. Discovery is not authorization for automatic runtime use.
