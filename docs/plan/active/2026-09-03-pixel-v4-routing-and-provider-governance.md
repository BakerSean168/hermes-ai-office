# Pixel V4 — Model/Agent/Resource Routing and Provider Governance Implementation Plan

Date: 2026-09-03

Governing decision: `docs/adr/ADR-003-static-model-agent-resource-routing.md`

Architecture:

- `docs/architecture/pixel-v4-model-agent-resource-routing.md`
- `docs/architecture/pixel-v4-provider-catalog-and-resource-lifecycle.md`

## 1. Outcome

Replace the current V4 hard-coded model route ladder with one deterministic selector that chooses an executable `model + agent + resource + transport` profile from a small approved model set.

The completed system must satisfy all of the following:

```text
IMPLEMENTATION:
  DeepSeek V4 Flash -> DSH
  GLM current       -> ZCode
  GPT-5.6 Luna      -> Codex

REASONING:
  GPT-5.6 Sol       -> Codex
  Claude Opus 5     -> Claude Code
  Claude Opus 4.8   -> Claude Code

Resource priority:
  PROMOTIONAL -> FREE/SPONSORED -> SUBSCRIPTION -> METERED -> OTHER

Tie-breaking:
  resource tier -> model rank -> immutable resource sequence
```

ChatGPT Business and Antigravity participate in the same resource selector through provider-native bindings.

OpenHands remains the execution/session/workspace host. Model-native ACP/headless agents perform implementation/reasoning work. OpenHands builtin becomes an explicit compatibility fallback rather than the primary harness for DeepSeek/GLM/Luna.

## 2. Protected contracts

The implementation must preserve:

- V4 durable execution IDs, parent lineage, exact source/result revision provenance, and leases;
- independent exact-SHA review;
- isolated linked workspaces and existing Git safety gates;
- no secret values in SQLite/events/dashboard;
- LiteLLM as authority for LiteLLM-managed credentials/deployments/telemetry;
- provider-native auth homes remaining outside LiteLLM;
- current Business Codex provider-native review behavior until the new selector fully replaces route aliases;
- current ORCAI native Responses configuration;
- no unreviewed automatic deletion of historical provider/model deployments.

## 3. Non-goals

This change does not add:

- dynamic LLM quality scoring;
- provider cost estimation based on unknown relay multipliers;
- autonomous model benchmarking during normal task execution;
- hidden OpenHands routing decisions;
- automatic activation of every newly advertised upstream model;
- automatic re-enable after explicit quota exhaustion in the first release.

# Phase 0 — Baseline, documentation, and migration inventory

## PVR-0001 — Freeze and inventory current routes

Capture a sanitized snapshot of:

- V4 implementation/review route configuration;
- current LiteLLM model groups/deployments;
- provider metadata (`commercial_type`, `supply_origin`, `resource_lifecycle`, `order`);
- provider-native Business/Antigravity backends;
- current blocked state;
- current active automatic aliases;
- recent route failures, especially `codex-auto-review`.

Acceptance:

- no credential/API-key material is stored;
- current route behavior can be reconstructed from the snapshot;
- rollback list contains every deployment/config changed by later phases.

## PVR-0002 — Backfill resource identity and sequence plan

Produce a dry-run mapping:

```text
credential/resource -> resourceId -> resourceSequence -> tier
```

Rules:

- one shared credential/account gets one resource sequence;
- sequence is immutable after migration;
- use trustworthy creation time where available;
- ambiguous historical order is resolved by an explicit checked-in migration mapping, not guessed at runtime.

Acceptance:

- every active automatic resource has exactly one sequence;
- no duplicate sequence inside the initial directory;
- provider-native resources have reserved explicit sequences.

# Phase 1 — V4 routing domain and deterministic selector

## PVR-1101 — Introduce capability and resource types

Add typed V4 domain records for:

```text
ExecutionCapability = IMPLEMENTATION | REASONING
ResourceTier
ResourceState = ACTIVE | SUSPENDED | DISABLED
ResourceTransport = LITELLM_MANAGED | PROVIDER_NATIVE
ModelAffinity
ExecutionResource
ExecutableProfile
```

The types must not contain secrets.

## PVR-1102 — Add versioned model-agent affinity policy

Move model/agent ranking into one versioned policy source.

Initial implementation policy:

```text
DeepSeek V4 Flash rank 10 -> DSH
GLM current rank 20       -> ZCode
GPT-5.6 Luna rank 30      -> Codex
```

Initial reasoning policy:

```text
GPT-5.6 Sol rank 10       -> Codex
Claude Opus 5 rank 20     -> Claude Code
Claude Opus 4.8 rank 30   -> Claude Code
```

Acceptance:

- duplicate ranks/model families fail configuration validation;
- a model cannot silently resolve to OpenHands builtin when a required affinity is missing;
- project policy may disallow an otherwise globally valid profile without mutating global ranks.

## PVR-1103 — Implement `ResourceDirectoryPort`

Define one read model that merges:

- LiteLLM-managed resources from `/model/info` and provider metadata;
- provider-native resources from versioned deployment configuration/readiness;
- durable state overrides/observations.

Directory output is sanitized and contains no auth material.

## PVR-1104 — Implement lexicographic selector

Selection key:

```text
(resourceTierRank, modelRank, resourceSequence)
```

Additional hard filters only:

- resource state must be `ACTIVE`;
- backend readiness must pass;
- model binding must be enabled;
- phase/project trust policy must allow the resource;
- review execution must satisfy independent-review constraints.

Acceptance tests must prove:

- promotional Luna beats free DeepSeek;
- free DeepSeek beats subscription DeepSeek;
- within the same tier DeepSeek beats GLM, then Luna;
- within the same model/tier earlier resource sequence wins;
- disabled/suspended resources are skipped;
- provider-native Business competes normally in `SUBSCRIPTION` tier;
- no candidate results in `WAITING_FOR_RESOURCE` rather than an unapproved fallback.

# Phase 2 — LiteLLM provider ordering and curated model import

## PVR-2101 — Replace coarse equal `order` with deterministic per-resource order

Update provider tooling so every deployment order encodes:

```text
tier base + resource sequence
```

All deployments for the same resource reuse the same sequence.

Acceptance:

- two metered providers no longer have an equal priority that permits random shuffle;
- an earlier provider stays preferred until unavailable;
- promotional resources remain ahead of all stable free/subscription/metered resources;
- existing provider metadata is preserved.

## PVR-2102 — Curate provider import

Deprecate broad automatic `--family gpt` activation for normal AI Office provider import.

Add explicit activation policy:

```text
discover catalog
intersect with automatic core allow-list
smoke exact credential/model/protocol
create passing deployments only
```

Acceptance:

- a provider advertising 50 models creates only approved automatic deployments;
- explicit `--model` remains available for manual/experimental activation;
- discover-only mode performs no write;
- image/audio/realtime models are not activated by the core coding policy;
- advertised but inactive models remain inspectable.

## PVR-2103 — Define automatic model allow-list

Initial active automatic target:

```text
deepseek-v4-flash
current approved GLM implementation model
gpt-5.6-luna
gpt-5.6-sol
claude-opus-5
claude-opus-4-8
```

Do not automatically route through:

```text
codex-auto-review
gpt-5.3 legacy families
gpt-5.4 legacy families
gpt-5.5 legacy families
gpt-5.6-terra without a declared role
```

Existing historical deployments are blocked/marked inactive first; deletion is a separate later cleanup after telemetry/history compatibility is proven.

## PVR-2104 — Remove `codex-auto-review` from the default review ladder

Current evidence shows the single WorldClaw `codex-auto-review` deployment has both successful historical runs and recent 429/cooldown/unknown-provider failures. It must stop being an automatic attempt-number fallback.

Acceptance:

- reaching review attempt 3 does not select `codex-auto-review` by name;
- reasoning retry goes back through `ResourceSelector`;
- optional manual/experimental activation can remain outside the default policy;
- dashboard historical executions remain readable.

# Phase 3 — Restore model-native agent execution

## PVR-3101 — Luna/Sol -> Codex

Complete and harden the current V4 managed Codex path:

- Codex is the coding/reasoning agent;
- LiteLLM-managed Codex uses Responses when supported;
- ORCAI remains native Responses;
- completion/review evidence is controller-verifiable;
- OpenHands finished-with-ACP-error is mapped to provider failure;
- Business Codex remains provider-native.

## PVR-3102 — DeepSeek -> DSH

Replace the V4 `implementation-efficient -> OpenHands builtin` behavior with an ACP DSH worker selected for `deepseek-v4-flash`.

Acceptance:

- real isolated repository implementation smoke;
- exact commit + clean workspace + test evidence;
- LiteLLM telemetry correlates execution ID to the selected resource;
- provider fallback within the DeepSeek model family does not change the DSH agent.

## PVR-3103 — GLM -> ZCode

Promote ZCode as the approved GLM implementation harness.

Before switching the canonical GLM model, benchmark/smoke the currently proven GLM version and the newer candidate through the same ZCode acceptance task. Promote exactly one canonical GLM model; disable the superseded one from automatic routing.

## PVR-3104 — Claude Opus -> Claude Code

Enable/validate Claude Code ACP for reasoning using:

```text
claude-opus-5
claude-opus-4-8 fallback
```

Acceptance:

- exact-SHA read-only review smoke;
- structured verdict bridge;
- no repository mutation;
- provider-specific protocol/auth differences remain inside the adapter/resource binding.

## PVR-3105 — OpenHands builtin fallback policy

Keep `openhands-builtin` available only when explicitly allowed as compatibility fallback.

It must not precede DSH/ZCode/Codex/Claude Code for their approved model families.

# Phase 4 — Provider-native resources in the same selector

## PVR-4101 — Register ChatGPT Business as resources

Project provider-native Business capabilities into `ResourceDirectory`:

```text
Luna implementation -> Codex Business worker
Sol reasoning/review -> Codex Business planner/reviewer
```

Economic class:

```text
SUBSCRIPTION + OFFICIAL + RECURRING
```

No Business OAuth/session secret enters LiteLLM or durable resource records.

## PVR-4102 — Register Antigravity as resources

Project approved Antigravity backends into the same directory with provider-native transport and existing trust restrictions.

Implementation model policy:

```text
gemini-3.8-flash-high  primary
gemini-3.7-flash-high  compatibility fallback
```

Current runtime evidence on 2026-09-03: GCP has authenticated `agy` 1.1.22, its model catalog exposes both 3.8 and 3.7 Flash variants, and a live `gemini-3.8-flash-high` print-mode smoke completed successfully. The existing V4 `AntiGravityReadinessAdapter` only gates readiness; implementation must still add the provider-native execution binding that launches the isolated Antigravity runner, captures durable execution evidence, and maps its terminal result into the normal V4 worker contract.

Headless permissions are part of acceptance. A smoke without an explicit permission policy can finish with no response after a command permission is auto-denied; the execution adapter must provide a bounded trusted-worker permission profile rather than depend on interactive approval.

Antigravity remains opt-in where current security policy requires trusted input. Normal model routing must not bypass those trust constraints just because the resource ranks highly.

## PVR-4103 — Cross-transport selection tests

Prove deterministic ordering across:

- LiteLLM promotional/free/subscription/metered;
- ChatGPT Business subscription;
- Antigravity subscription;
- disabled/exhausted native resources.

# Phase 5 — Resource failure state machine

## PVR-5101 — Normalize resource failure classes

Map sanitized provider errors to:

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

Unit tests must cover known real provider messages without persisting raw secrets.

## PVR-5102 — Disable exhausted/auth-rejected resources

On explicit quota exhaustion or credential rejection:

- mark resource `DISABLED` durably;
- block all LiteLLM deployments sharing that resource/credential when the failure is resource-wide;
- remove it from the selector immediately;
- preserve a sanitized reason and optional reset timestamp for visibility;
- require manual enable in the first release.

## PVR-5103 — Community/free 24-hour suspension

For recurring free/community relays:

```text
transient connectivity/rate-limit/server failure
  -> SUSPENDED 24h
  -> one probe
      -> pass: ACTIVE
      -> fail: DISABLED until manual enable
```

The scheduler must not retain a mutable writer or poll continuously while suspended.

## PVR-5104 — Paid transient cooldown

For subscription/metered resources, use a short bounded cooldown for generic 429/5xx/timeout failures and then re-admit automatically. Do not confuse this with explicit quota exhaustion.

## PVR-5105 — Manual resource controls

Expose authenticated operator controls in the existing management surface/API:

```text
enable resource
disable resource
suspend resource
enable/disable model binding
inspect state/sequence/tier/last normalized failure
```

# Phase 6 — Migrate V4 automation off route-name ladders

## PVR-6101 — Replace implementation route list

Retire `MODEL_CP_V4_IMPLEMENTATION_ROUTES` as the source of model/backend truth.

During compatibility rollout it may feed a shim, but new executions must derive their executable profile from `ResourceSelector`.

## PVR-6102 — Replace review route list

Retire attempt-indexed selection from `MODEL_CP_V4_REVIEW_ROUTES`.

Review retries re-run the reasoning resource selector with failed/unavailable resources excluded according to durable state/cooldown policy.

## PVR-6103 — Collapse capability aliases

Pixel capability becomes:

```text
IMPLEMENTATION
REASONING
```

Deprecate routing semantics embedded in:

```text
implementation-efficient
planning-premium
review-premium
implementation-glm
review-glm
```

LiteLLM continues to expose physical/canonical model-family groups such as `gpt-5.6-luna`, not one cross-family `implementation` group.

## PVR-6104 — Dashboard provenance update

Display for every V4 execution:

```text
capability
model family
agent backend
transport
resource/provider
economic tier
resource sequence
resource state
protocol
calls/tokens/cache/cost telemetry when available
```

Historical route-name executions remain readable.

# Phase 7 — Migration cleanup and rollout

## PVR-7101 — Disable obsolete automatic deployments

Dry-run and review all currently active model groups. Disable obsolete automatic groups first; do not delete them yet.

Explicitly review:

- GPT 5.3/5.4/5.5 families;
- `codex-auto-review`;
- Terra and other role-less GPT families;
- stale blocked providers;
- specialized image/audio/realtime groups that belong to other product capabilities.

## PVR-7102 — End-to-end acceptance matrix

Required real smokes:

1. DeepSeek + DSH + LiteLLM resource -> implementation commit/test/evidence.
2. GLM + ZCode + LiteLLM resource -> implementation commit/test/evidence.
3. Luna + Codex + LiteLLM Responses resource -> implementation commit/test/evidence.
4. Sol + Codex + LiteLLM/native Business -> exact-SHA review.
5. Claude Opus + Claude Code -> exact-SHA review when a healthy approved provider is available.
6. exhausted resource -> durable disable -> next resource selected without repeating the failed route.
7. community transient failure -> 24h suspension behavior in clock-controlled test.
8. same model/tier with two resources -> earlier sequence remains sticky/preferred.

### PVR-7102 acceptance evidence — 2026-09-05

Current status: **7 / 8 acceptance rows closed.** Row 5 remains explicitly blocked by the absence of a healthy approved Claude Opus resource; it is not waived and no synthetic PASS is permitted.

| Row                                                       | Status              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. DeepSeek V4 Flash + DSH + LiteLLM                      | PASS                | Real isolated coding execution selected `wechat-miniapp-free / deepseek-v4-flash / dsh-acp / route-wechat-miniapp-free-deepseek-v4-flash`, produced exact commit `40d5b8995d054d493f7ff55ac03a4efccece5bd6`, passed repository tests, left the execution workspace clean, preserved the canonical canary checkout, and persisted `REVISION`, `DIFF`, `TEST`, and `PROVIDER_OUTPUT` evidence. The DSH physical-route overlay fix shipped in `99da434`; verified test-evidence persistence shipped in `d3b81e3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2. GLM current + ZCode + LiteLLM                          | PASS                | Real isolated coding execution selected `wechat-miniapp-free / glm-current / zcode-acp / route-wechat-miniapp-free-glm-5.2`, produced exact commit `b6d0c4021cebd0537a11cf40ee3f8ee5e4fa54be`, passed repository tests, left the workspace clean, preserved the canonical canary checkout, and persisted `REVISION`, `DIFF`, `TEST`, and `PROVIDER_OUTPUT` evidence. Physical-route capability metadata shipped in `231d9eb`; the final ZCode `limit.context=1_000_000` adapter-contract fix shipped in `485f187`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3. GPT-5.6 Luna + Codex + LiteLLM Responses               | PASS                | Real isolated coding execution selected `orcai / gpt-5.6-luna / codex-acp / route-orcai-gpt-5.6-luna`, produced exact commit `295436bf107d2a0cef42c14daf147f06eae21a81`, passed repository tests, left the workspace clean, preserved the canonical canary checkout, and persisted controller evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4. GPT-5.6 Sol + Codex exact-SHA review                   | PASS                | Real independent review selected `orcai / gpt-5.6-sol / codex-acp / route-orcai-gpt-5.6-sol`, reviewed exact SHA `bb156ef4304fdbc62bb801578506b9f5158fe06e`, durably returned `PASS`, preserved exact review lineage and the canonical canary checkout, and persisted `REVISION`, `TEST`, `REVIEW`, and `PROVIDER_OUTPUT` evidence. The production BodySense recovery also independently closed through a Sol/Codex exact-SHA PASS and verified delivery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5. Claude Opus + Claude Code exact-SHA review             | BLOCKED_BY_RESOURCE | Two historical approved credential sources were recovered into resource-specific automatic-core bindings without opening their legacy aliases. `llm-pm-deepseek-opus` (`FREE`, sequence `113`) now has blocked Opus 5/4.8 routes whose live health checks fail because the upstream account lacks access to the pay-as-you-go group; `teamorouter-gpt-5-6` (`METERED`, sequence `122`) now has blocked Opus 5/4.8 routes whose live health checks fail because the upstream wallet is insufficient. ProviderAdmin commits `608c662`, `ad6d82e`, and `53121c7` make blocked-source recovery narrow, inherit established resource governance, and force automatic-core recovery through blocked-safe `/health/test_connection` before unblocking. Production re-probe completed `recovered=0 failed=2` for each credential, so all four routes remain `enabled=false / ready=false`. Keep this row open until one health probe succeeds; do not substitute Antigravity or fabricate review evidence. |
| 6. Exhausted resource -> durable disable -> next resource | PASS                | Explicit PVR regression `PVR-7102 exhausted resource is durably disabled and restart selects the next resource` proves `QUOTA_EXHAUSTED -> DISABLED`, durable SQLite persistence across restart, and deterministic failover to the next resource without reselecting the exhausted resource.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7. Community transient -> 24h suspension                  | PASS                | Clock-controlled regression `PVR-7102 community transient suspension lasts exactly 24h and re-enters only after expiry probe` proves exact `COMMUNITY_SUSPENSION_MS`, no pre-expiry probe/selection, and re-entry only after an expiry probe succeeds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8. Same model/tier -> sequence stickiness                 | PASS                | Regression `PVR-7102 resource sequence remains sticky across directory rebuild and source row reordering` reconstructs the LiteLLM resource directory with reversed provider API row order and still selects the lower immutable `resourceSequence`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The reusable real-runtime acceptance harness is `model-control-plane/scripts/smoke-v4-routing-profile.mts`. It prechecks production runtime admission, uses an isolated in-memory V4 database, binds an immutable target selection without inducing fake provider failures, verifies exact Git/test/review evidence, preserves the canonical `ai-office-smoke` checkout, and interrupts/deletes disposable OpenHands conversations plus execution workspaces in `finally`.

When an Opus upstream is funded or its entitlement changes, recover it without blind unblocking:

```bash
sudo /usr/local/sbin/hermes-litellm-providerctl \
  --reprobe-blocked-automatic \
  --credential-name <approved-credential> \
  --binding-model claude-opus-5 \
  --binding-model claude-opus-4-8
# inspect dry-run candidates first, then repeat with --apply
```

Generic `--unblock` is rejected for automatic-core bindings. The health check runs while the deployment remains blocked, reuses only the stored credential reference, and unblocks a route only after LiteLLM returns `status=success` and registry convergence is re-read successfully.

## PVR-7103 — Canary rollout

Status: **COMPLETE for selector rollout.** The production rollout is selector-authoritative for all trusted Pixel projects; the remaining Claude Opus acceptance row in PVR-7102 is an external resource-availability blocker, not a rollout blocker or a waived review.

The realized rollout sequence deliberately avoided a long-lived dual-routing shadow authority. Deterministic selector comparison and the isolated real-runtime acceptance harness were used before cutover, then one real product Plan became the production canary:

```text
deterministic selector comparison + isolated real-runtime acceptance
  -> BodySense production implementation canary
  -> exact-SHA independent review canary
  -> memoflow,digital-biome,bodysense enabled in trusted production scope
```

Production evidence on 2026-09-05:

- BodySense recovery Plan `plan_5e1ab84d-5eb1-4ed5-ba22-800f3bfc8fae` completed `SUCCEEDED` under immutable selector provenance. Its implementation Execution `execution_b4e7fcd50a83be0f61fbd324` selected `wechat-miniapp-free / deepseek-v4-flash / dsh-acp / route-wechat-miniapp-free-deepseek-v4-flash` and produced exact revision `a53052129a95ab017be3bd8b427ab4cc0b95d028`.
- The same Plan's final independent review Execution `execution_aa5e39eba1882076344630be` selected `cheaprouter / gpt-5.6-sol / codex-acp / route-cheaprouter-gpt-5.6-sol`, reviewed that exact SHA, and durably closed review `review_cb1a96d6031a5acd43658e36` as `PASSED / PASS`.
- The isolated matrix additionally proves DSH, ZCode, Luna/Codex and Sol/Codex runtime paths without mutating product repositories. The final ZCode canary produced exact commit `b6d0c4021cebd0537a11cf40ee3f8ee5e4fa54be` with repository tests passing after the GLM-5.2 `limit.context=1_000_000` capability mapping shipped in `485f187`.
- Production health reports `routingAuthority=RESOURCE_SELECTOR`, and `automationProjectKeys=[memoflow,digital-biome,bodysense]`. MemoFlow and Digital Biome had no nonterminal Plan at cutover; their most recent historical Plans predate selector cutover, so no legacy in-flight execution was rewritten. Their next new Plan is admitted through the selector authority.
- At rollout verification there are zero nonterminal Plans and zero project leases, so enabling the trusted-project scope does not hand an existing legacy writer to a different routing authority mid-execution.

## PVR-7104 — Remove compatibility routing

Remove old route-name selection only after:

- all required E2E smokes pass;
- dashboard understands new provenance;
- no active plan depends on old route-name attempt ordering;
- rollback can restore the previous service/config without database loss.

Cutover status: **TECHNICAL CUTOVER COMPLETE / FINAL ACCEPTANCE BLOCKED BY PVR-7102 ROW 5.** Selector-authoritative production routing shipped in `e5b534f`. Live `/api/health` reports `resourceSelectorEnabled=true`, `routingAuthority=RESOURCE_SELECTOR`, `compatibilityImplementationRoutes=[]`, and `compatibilityReviewRoutes=[]`; the release gate fails closed if dual routing authority reappears. Historical route-only executions remain readable.

Rollback is now covered explicitly rather than assumed: regression `selector-off rollback preserves durable selector provenance in the same V4 database` creates a selector-era Plan and immutable resource selection in a file-backed V4 database, closes the selector runtime, reopens the **same database** with `MODEL_CP_V4_RESOURCE_SELECTOR_ENABLED=false`, verifies `routingAuthority=LEGACY_ROUTE_LIST`, and proves the original Plan, Execution, and resource-selection provenance remain intact. This preserves the previous service/config rollback path without database reset or loss.

The only remaining PVR-7102 gap is the blocked Claude Opus resource row. Therefore the first PVR-7104 prerequisite (all required E2E smokes pass) is not yet satisfiable and the plan-level acceptance stays open. Compatibility routing is nevertheless not being re-enabled as a substitute for that missing provider because doing so would restore two routing authorities and would not create a healthy Claude reviewer. Once a healthy approved Opus resource passes Row 5, PVR-7104 needs only a final production health recheck; no further routing migration is expected.

## 4. Concrete code and persistence touchpoints

### `pixel-agents` model control plane

Expected new modules (names may change during implementation, responsibilities may not):

```text
model-control-plane/src/v4/domain/resourceRouting.ts
  capability/resource/profile value types and validation

model-control-plane/src/v4/orchestration/resourceSelector.ts
  deterministic lexicographic selector

model-control-plane/src/v4/adapters/liteLlmResourceDirectory.ts
  projects LiteLLM deployments/metadata/readiness into resources

model-control-plane/src/v4/adapters/providerNativeResourceDirectory.ts
  projects Business/Antigravity resources into the same shape

model-control-plane/src/v4/adapters/resourceState.ts
  durable state application + LiteLLM block/unblock effects
```

Expected existing files to change:

```text
model-control-plane/src/app.ts
  construct ResourceDirectory/Selector and stop constructing model-specific route ladders as the source of truth

model-control-plane/src/v4/orchestration/planAutomationRuntime.ts
  replace attempt-index route indexing with profile selection/re-selection

model-control-plane/src/v4/adapters/openHandsCoding.ts
  launch the selected ACP/backend/profile and persist/sanitize provider failures

model-control-plane/config/development-policy.yaml
  become the backend capability/readiness policy, not an independent competing model selector

model-control-plane/deploy/gcp/hermes-model-control-plane.service
  introduce selector feature flags; retire route-list env vars after cutover

model-control-plane/deploy/litellm/config.yaml
  keep compatibility aliases only during migration; remove cross-family fallback as routing truth
```

### Proposed durable V4 additions

Keep the selected executable profile immutable per execution:

```sql
CREATE TABLE execution_resource_selections (
  execution_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  model_family TEXT NOT NULL,
  agent_backend TEXT NOT NULL,
  transport TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_tier INTEGER NOT NULL,
  model_rank INTEGER NOT NULL,
  resource_sequence INTEGER NOT NULL,
  deployment_id TEXT,
  selected_at TEXT NOT NULL
);
```

Keep resource state independently mutable and CAS/version guarded:

```sql
CREATE TABLE resource_state_overrides (
  resource_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  reason_class TEXT,
  sanitized_reason TEXT,
  suspended_until TEXT,
  source TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

Requirements:

- schema migration is additive and fail-closed;
- no API key/base credential secret is stored;
- an execution selection never changes after its external session is launched;
- a retry is a new execution and therefore receives a new immutable selection;
- historical legacy executions without a selection row continue to render through their legacy `route` field.

### `my-infrastructure` ProviderAdmin

Primary implementation file:

```text
my-infrastructure/etc/server/oracle2/hermes/provideradmin/hermes-litellm-providerctl.py
```

Required changes:

1. add curated automatic-core model policy;
2. separate discovery from activation;
3. add/persist `resource_sequence` metadata;
4. compute unique LiteLLM deployment `order` from tier + resource sequence;
5. support dry-run sequence backfill for existing resources;
6. support bulk block/enable by credential/resource;
7. retain Responses-vs-chat protocol as a model-binding property;
8. preserve existing safe secret input rules;
9. add tests for deterministic order and curated model intersection.

The installed Oracle2 `/usr/local/sbin/hermes-litellm-providerctl` remains a deployment artifact. Source changes land in `my-infrastructure` first and are deployed from that source of truth.

### Dashboard/plugin

Expected DTO additions:

```text
capability
modelFamily
agentBackend
transport
resourceId
resourceTier
resourceSequence
resourceState
selectionReason = STATIC_POLICY
```

Do not remove existing route/provider telemetry fields until historical rows are proven backward compatible.

## 5. Feature flags and compatibility strategy

Introduce one top-level selector gate, for example:

```text
MODEL_CP_V4_RESOURCE_SELECTOR_ENABLED=false|true
```

Rollout semantics:

```text
false:
  legacy route arrays remain authoritative

shadow:
  if represented as a separate mode, compute new selection but execute legacy route

true:
  ResourceSelector is authoritative; route arrays are compatibility projection only
```

Do not let both systems independently create executions. Exactly one routing authority chooses each new execution.

Compatibility alias removal order:

1. make dashboard/API able to consume new selection provenance;
2. enable selector in shadow mode;
3. enable selector for one canary project;
4. remove `codex-auto-review` from default retry selection;
5. move all trusted projects to selector;
6. stop reading implementation/review route arrays;
7. remove compatibility aliases after no active caller depends on them.

## 6. Test strategy

### Unit

- capability mapping;
- affinity validation;
- lexicographic selection;
- tier derivation;
- resource sequence immutability;
- failure normalization;
- state transitions;
- model allow-list intersection;
- protocol-specific deployment payloads.

### Integration

- LiteLLM directory projection;
- provider-native directory projection;
- deterministic provider order;
- bulk block/enable by resource;
- selector + ExecutionWorker launch;
- exact telemetry/resource correlation.

### Fault injection

- explicit monthly usage limit;
- insufficient balance;
- generic 429;
- 401/403;
- connection timeout;
- provider 5xx;
- model-only 404/unsupported;
- expired promotion;
- resource disappears between selection and first provider call.

## 7. Rollback

Keep these independently reversible until final cutover:

- resource directory/selector feature flag;
- new provider order encoding;
- curated import policy;
- provider state automation;
- route-list compatibility shim;
- disabled historical model deployments.

Rollback must not delete resource sequence/state history or change historical execution provenance.

## 8. Definition of done

This routing refactor is complete only when:

- V4 no longer chooses implementation/review models by attempt-indexed hard-coded route lists;
- model-native agents are used for DeepSeek, GLM, Luna/Sol, and Claude Opus;
- OpenHands hosts ACP sessions instead of acting as the default coding harness for those families;
- provider-native Business/Antigravity resources participate in the same deterministic selector;
- LiteLLM provider ties are deterministic by resource sequence;
- explicit exhausted/auth-rejected resources stop receiving calls;
- free/community transient failures follow the 24-hour suspension policy;
- normal provider import activates only the curated model set;
- `codex-auto-review` is absent from the default automatic review path;
- old GPT generations are not automatically activated unless a future approved role requires them;
- dashboard provenance shows exactly which model, agent, resource, transport, and protocol executed each phase.
