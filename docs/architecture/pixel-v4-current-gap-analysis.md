# Pixel V4 Current Gap Analysis

## Scope

This is the repository-grounded baseline for the V4 durable supervisor and Digital Biome autonomous-maintenance work.

## What already exists

### One-shot AI orchestration

- `DurablePlanOrchestrator` creates an `ORCHESTRATE` execution for delegated objectives.
- `ORCHESTRATE` uses an OpenHands read-oriented supervisor and materializes a dependency-aware graph.
- The prompt explicitly tells that execution not to launch coding workers. After graph materialization, the deterministic coordinators own progression.

### Deterministic engineering kernel

The current V3 system already has:

- durable plan/batch/work-item/execution records;
- implementation, review, fix, integration repair, aggregate review, and delivery phases;
- retry/fallback policies;
- exact workspace and Git gates;
- recovery coordinator and explicit recovery modes;
- GitHub PR intake and delivery adapters;
- Jules source/session adapter boundaries;
- OpenHands/ACP execution hosting;
- LiteLLM-managed and provider-native routes.

### Relevant external backends

The development policy declares:

- `antigravity-worker` as a write-capable provider-native backend;
- `antigravity-review` as a read-only provider-native backend;
- `codex-business-planner-headless`;
- `codex-business-worker-headless`;
- `codex-business-review-headless`;
- DSH, OpenCode, ZCode, Claude Code, Codex ACP, and OpenHands backends.

### Exact review/repair workflow

Per-item and batch review paths exist. A failed review can create a focused implementation fix and a later independent review. Integration conflict and aggregate-review failure can create integration repair work.

## Why current behavior does not match the intended autonomous system

### 1. No persistent plan-level supervisor

`ORCHESTRATE` ends after producing the initial graph. There is no durable AI actor observing later events and diagnosing novel blockers. `PlanRecoveryCoordinator` handles only pre-modeled recovery transitions.

Result: unknown migration, infrastructure, adapter, resource, or control-plane failures become generic `BLOCKED` states and require external diagnosis.

### 2. AI is inside workflow nodes, not above the workflow

Implementation and review workers are intelligent, but they receive bounded phase objectives. They do not own the complete plan, cannot safely replan remaining work, and cannot create system-repair child plans through typed durable actions.

### 3. Nested orchestration is intentionally disabled

Codex nested multi-agent configuration is disabled to prevent a second invisible orchestration layer. This is correct for provenance and concurrency, but it means OpenHands/Codex cannot simply spawn arbitrary untracked workers to recover the plan.

V4 must add Pixel-owned supervisor tools rather than re-enable invisible nested agents.

### 4. Anti-Gravity is declared but not part of the active default routes

The current phase candidate lists do not use `antigravity-worker` or `antigravity-review`. The production enabled-backend list must also explicitly include a backend before it is available. Merely defining Anti-Gravity in the policy therefore does not make Digital Biome maintenance use it.

There is also no durable quota/credit observation or `WAITING_FOR_RESOURCE` state. A resource-constrained program cannot currently express “use Anti-Gravity when available; otherwise pause.”

### 5. Jules is an adapter, not an end-to-end autonomous program

The existing Jules API boundary can find a source and create a session. It does not by itself provide:

- a recurring improvement candidate queue;
- exact candidate/plan/PR correlation;
- provider-budget waiting;
- independent problem validation and repository-style review;
- repair/re-review ownership;
- exact-SHA auto-merge and post-merge verification.

### 6. GitHub PR intake is not a complete maintenance lifecycle

PR intake and external-change review capabilities exist, but no long-lived `MaintenanceProgram` currently owns discovery, deduplication, resource policy, queue priority, autonomous scope, and post-merge learning for Digital Biome.

### 7. Self-repair is informal

When a product plan exposes a Pixel/control-plane defect, the product worker cannot safely patch the running control plane. Today an external operator/ChatGPT conversation typically diagnoses and repairs Pixel, then reconciles the original plan. There is no explicit parent `WAITING_FOR_SYSTEM_REPAIR` state or governed child-plan deployment loop.

### 8. Current provenance baseline still has known P1 work

Before V4 autonomous effects are enabled, the current result/review provenance repair must:

- re-run managed workspace verification for every legacy result attestation;
- bind an approved review to the exact implementation execution/revision it reviewed.

V4 action validation depends on these invariants.

### 9. V4 model-agent affinity is only partially migrated

The older development policy already declares DSH, ZCode, Codex ACP, Claude Code ACP, OpenCode ACP, and OpenHands backends. The current V4 automation path does not yet use that backend selector as its source of truth.

Current V4 behavior is still partly route-name driven:

```text
gpt-5.6-luna -> managed Codex path (being hardened)
implementation-efficient -> generic OpenHands builtin path
glm route -> generic OpenHands builtin path
```

The intended architecture is model-native:

```text
DeepSeek V4 Flash -> DSH
GLM current       -> ZCode
GPT-5.6 Luna/Sol  -> Codex
Claude Opus       -> Claude Code
```

OpenHands should host the ACP/session/workspace lifecycle, not silently replace the model-native coding harness.

### 10. V4 retries still encode model names instead of resource policy

The current automation indexes into configured implementation/review route arrays. Review attempts can therefore progress through a fixed ladder such as Business Sol, managed Sol, `codex-auto-review`, and GLM regardless of the current resource directory.

Recent `codex-auto-review` evidence demonstrates why this is brittle: its only active WorldClaw deployment has historical successes but also recent rate-limit, cooldown, and upstream `unknown provider` failures. Attempt number is not a valid resource selector.

ADR-003 replaces attempt-indexed model selection with a deterministic selector over:

```text
capability
+ model-agent affinity
+ resource tier
+ immutable resource sequence
+ current resource state/readiness
```

### 11. LiteLLM provider ordering is too coarse for stable cache locality

Provider tooling currently derives coarse economic orders such as promotional/free/subscription/metered. Multiple providers in one economic class can therefore share the same LiteLLM order, leaving same-tier selection free to shuffle.

The target policy assigns an immutable resource sequence and encodes unique same-tier order. Earlier configured resources remain preferred until unavailable, which makes provider use predictable and improves prompt-cache locality.

### 12. Provider discovery currently over-activates model catalogs

The current provider importer can select all advertised GPT text models for a provider family. This creates active deployments for old or unused GPT generations even when Pixel has no approved execution role for them.

Provider discovery must be separated from runtime activation. The automatic runtime should keep only the small approved set defined by ADR-003, while older/other advertised models remain discoverable or manually activatable.

### 13. Resource-wide exhaustion is not yet a durable routing fact

Promotional expiry can already block deployments, and LiteLLM provides transient cooldowns, but explicit quota/balance/usage exhaustion is not yet normalized into one durable provider-resource state that immediately removes all bindings sharing the exhausted credential/account.

The target lifecycle is deliberately simple:

```text
explicit quota/auth failure -> DISABLED
community transient failure -> SUSPENDED 24h -> one probe -> ACTIVE or manual-only DISABLED
subscription/metered transient failure -> bounded short cooldown
```

## Target delta

V4 does not discard current components. It adds the missing plan/program intelligence layer:

```text
Current:
  one-shot ORCHESTRATE
  -> deterministic workflow
  -> AI workers/reviewers at known nodes
  -> unknown failure = BLOCKED

V4:
  durable event-driven supervisor
  -> typed proposals
  -> deterministic validator/kernel
  -> IMPLEMENTATION / REASONING capability
  -> static model-agent affinity
  -> ordered LiteLLM/provider-native resource selection
  -> OpenHands/provider-native execution host
  -> exact review/integration/delivery
  -> graph revision or child repair for novel recoverable failures
  -> explicit resource/external/safety waiting states
```

## Digital Biome migration conclusion

Digital Biome should not receive another standalone cron/agent workflow. It should become the first `MaintenanceProgram` on the V4 substrate:

- discovery/Jules/PR webhooks create candidates;
- Anti-Gravity resource policy controls dispatch and waiting;
- the durable supervisor validates the problem and adapts the plan;
- existing V3 implementation/review/repair/integration/delivery mechanics execute the work;
- exact-SHA auto-merge and post-merge verification remain deterministic.

This preserves one governance and observability model across user-requested work and continuous autonomous improvement.
