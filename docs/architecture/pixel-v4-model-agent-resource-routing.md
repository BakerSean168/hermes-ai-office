# Pixel V4 Model, Agent, and Resource Routing

## Purpose

This document defines the runtime routing architecture accepted by ADR-003. It replaces the current V4 assumption that a short ordered list of model route names is sufficient to select an implementation/review worker.

The target is intentionally deterministic:

```text
Phase
  -> Capability
  -> Executable profile candidates
  -> Resource tier/order
  -> Selected model + agent + resource + transport
  -> OpenHands/provider-native execution
```

## 1. Separate the four dimensions

### Phase

The workflow phase describes what the execution is allowed to do:

```text
ORCHESTRATE / PLAN
IMPLEMENT
IMPLEMENT_FIX
REVIEW
FINALIZE
```

### Capability

The model requirement is deliberately coarse:

```text
IMPLEMENTATION
REASONING
```

Mapping:

| Phase                  | Capability       |
| ---------------------- | ---------------- |
| orchestration/planning | `REASONING`      |
| implementation         | `IMPLEMENTATION` |
| implementation fix     | `IMPLEMENTATION` |
| independent review     | `REASONING`      |
| deterministic finalize | no model         |

Review independence, exact-SHA binding, read-only behavior, and structured verdict requirements are phase constraints. They do not justify a separate `review-premium` model tier.

### Model family

The model family is the actual model identity selected before worker launch.

Approved initial automatic set:

```text
IMPLEMENTATION:
  deepseek-v4-flash
  glm-current
  gpt-5.6-luna

REASONING:
  gpt-5.6-sol
  claude-opus-5
  claude-opus-4-8
```

`glm-current` is a Control Plane concept, not a LiteLLM model alias. It resolves to exactly one approved physical GLM model at a time. The initial value remains the currently validated GLM model until a promotion ticket changes it.

### Resource

A resource is one consumable route to a model family. It is not synonymous with a provider brand.

Examples:

```text
OpenCode Go account #2 / gpt-5.6-luna
community relay A / deepseek-v4-flash
ORCAI / gpt-5.6-sol
ChatGPT Business / gpt-5.6-sol
Antigravity subscription / Gemini Pro
```

A provider with one shared API key can expose several model-resource bindings while sharing one provider-level quota/auth state.

## 2. Executable profile

The unit selected by V4 is an `ExecutableProfile`:

```ts
type ExecutableProfile = {
  capability: 'IMPLEMENTATION' | 'REASONING';
  phase: ExecutionPhase;
  modelFamily: string;
  agentBackend: string;
  transport: 'LITELLM_MANAGED' | 'PROVIDER_NATIVE';
  resourceId: string;
  resourceTier: ResourceTier;
  modelRank: number;
  resourceSequence: number;
};
```

The exact durable schema may use normalized IDs instead of strings, but the selected execution must preserve all of these facts.

## 3. Model-agent affinity registry

The affinity registry is versioned configuration owned by Pixel, not by the LLM.

Initial policy:

```yaml
capabilities:
  IMPLEMENTATION:
    - modelFamily: deepseek-v4-flash
      modelRank: 10
      backend: dsh-acp
    - modelFamily: glm-current
      modelRank: 20
      backend: zcode-acp
    - modelFamily: gpt-5.6-luna
      modelRank: 30
      backend: codex-acp

  REASONING:
    - modelFamily: gpt-5.6-sol
      modelRank: 10
      backend: codex-acp
    - modelFamily: claude-opus-5
      modelRank: 20
      backend: claude-code-acp
    - modelFamily: claude-opus-4-8
      modelRank: 30
      backend: claude-code-acp
```

Provider-native profiles may override the transport/backend while preserving the same model-family rank. Example: `gpt-5.6-sol + ChatGPT Business` uses Codex provider-native auth rather than the LiteLLM-managed Codex profile.

## 4. Resource taxonomy

Reuse the existing orthogonal provider metadata:

```text
commercial_type:
  FREE | SPONSORED | SUBSCRIPTION | METERED | OTHER

supply_origin:
  COMMUNITY_RELAY | COMMERCIAL_RELAY | OFFICIAL | UNKNOWN

resource_lifecycle:
  STABLE | RECURRING | PROMOTIONAL
```

Derived routing tier:

```text
PROMOTIONAL                          -> tier 10
FREE or SPONSORED, non-promotional   -> tier 20
SUBSCRIPTION                         -> tier 30
METERED                              -> tier 40
OTHER                                -> tier 60
```

The lifecycle override intentionally makes a temporary/promotional resource outrank an ordinary free resource because expiring capacity should be consumed first.

## 5. Stable resource sequence

Each resource gets an immutable `resourceSequence` when it first enters the resource directory.

Properties:

- monotonic;
- never reused;
- shared by every model deployment backed by the same credential/resource when quota/auth is shared;
- not recomputed from health, latency, spend, or success rate;
- visible in the dashboard and audit projection.

Existing resources are backfilled deterministically during migration. Prefer provider/credential creation time when reliable; otherwise use an explicitly reviewed migration mapping. Do not infer a new order from recent request volume.

## 6. Selection algorithm

The selector does not ask an LLM to choose a model.

Given a phase:

1. map phase to `IMPLEMENTATION` or `REASONING`;
2. enumerate approved model-agent affinities for the capability;
3. project all `ACTIVE` resources that can serve each model family;
4. reject backends that fail runtime readiness;
5. reject resource/model bindings that are disabled or unsupported;
6. sort remaining candidates by `(resourceTierRank, modelRank, resourceSequence)`;
7. select the first candidate;
8. persist the full selected profile before creating the external execution session.

Pseudocode:

```ts
const candidates = affinities(capability)
  .flatMap((affinity) =>
    directory.resourcesFor(affinity.modelFamily).map((resource) => ({ affinity, resource })),
  )
  .filter(isBackendReady)
  .filter(isResourceActive)
  .filter(isPhaseAllowed)
  .sort(
    compareTuple(
      (x) => x.resource.tierRank,
      (x) => x.affinity.modelRank,
      (x) => x.resource.sequence,
    ),
  );

return candidates[0] ?? WAITING_FOR_RESOURCE;
```

There is no dynamic quality threshold or estimated provider cost in this algorithm.

## 7. Why resource tier sorts before model rank

This is intentional.

Example:

```text
promotional Luna + Codex
free DeepSeek + DSH
subscription DeepSeek + DSH
metered Luna + Codex
```

Selection chooses the promotional Luna resource first, then the free DeepSeek resource. This consumes expiring capacity before stable capacity while still preferring the lower-ranked implementation model inside the same economic tier.

## 8. OpenHands role

OpenHands is the execution host, not the hidden resource selector.

Preferred managed paths:

```text
Pixel -> OpenHands ACPAgent -> Codex -> LiteLLM Responses -> provider -> Luna/Sol
Pixel -> OpenHands ACPAgent -> DSH   -> LiteLLM            -> provider -> DeepSeek
Pixel -> OpenHands ACPAgent -> ZCode -> LiteLLM            -> provider -> GLM
Pixel -> OpenHands ACPAgent -> Claude Code -> LiteLLM/provider -> Claude Opus
```

Provider-native Business path:

```text
Pixel -> OpenHands ACPAgent/headless Codex -> ChatGPT Business auth -> Luna/Sol
```

Antigravity is a provider-native exception and can remain outside the OpenHands container when its security wrapper requires that boundary. It still participates in the same `ResourceDirectory` and selector.

`openhands-builtin` remains available only as a generic compatibility fallback when policy explicitly permits it and no approved model-native harness is available.

## 9. Planning and review

Planning and review both use `REASONING`, but their execution contracts differ.

Planning:

- may inspect the mutable problem context;
- may create/revise bounded plans;
- cannot self-approve resulting implementation revisions.

Review:

- must use an independent execution identity;
- must bind to the exact implementation SHA;
- is read-only;
- returns a structured PASS/FAIL/INVALID verdict and findings;
- cannot use the implementation worker's mutable session as its reviewer.

The same Sol or Claude Opus model family can satisfy both without duplicating model aliases.

## 10. Retry behavior

Retries do not advance through a hard-coded model-name list such as:

```text
Business Sol -> LiteLLM Sol -> codex-auto-review -> GLM
```

Instead, every new retry asks the deterministic selector for the next eligible resource under policy.

The selector may exclude the exact resource that produced a normalized resource failure for the current retry window, but it does not automatically lower the capability class.

Examples:

- ORCAI Sol quota exhausted -> disable ORCAI resource -> choose the next Sol/Opus reasoning resource by static order;
- Business Sol exhausted -> disable Business resource -> select the next allowed reasoning resource;
- `codex-auto-review` is not a default capability and therefore never appears simply because a review reaches attempt 3;
- DeepSeek provider unavailable -> another DeepSeek resource is preferred before moving to GLM in the same economic tier when the resource ordering makes that candidate earlier.

## 11. Provenance

Each execution must preserve:

```text
capability
phase
modelFamily
agentBackend
transport
resourceId
resourceTier
resourceSequence
provider/deployment correlation when LiteLLM-managed
source revision
result revision
retry parent
```

This makes a dashboard row answer both:

> Which model/agent was chosen?

and:

> Which actual resource paid for it, and why was it ahead of the alternatives?

## 12. Compatibility migration

Existing names remain temporarily supported while callers migrate:

```text
implementation-efficient
planning-premium
review-premium
implementation-glm
review-glm
codex-business-review
```

They must stop being the source of routing truth. The final system derives executions from capability + affinity + resource selection. Compatibility aliases may resolve to that new selector during rollout, then be removed after dashboard/API consumers no longer depend on them.
