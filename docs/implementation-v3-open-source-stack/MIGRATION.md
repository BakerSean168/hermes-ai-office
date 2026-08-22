# V2 → V3 Migration Strategy

## 1. Migration objective

Move from the current V2 AI Workforce control-plane architecture to the V3 open-source composition architecture without destabilizing Hermes or destroying historical evidence.

This is a **replacement of ownership boundaries**, not a schema refactor that must preserve every V2 entity.

## 2. Current baseline

At the start of this migration:

- V2 is the deployed production truth;
- AI Office has a custom workforce/control-plane service and V2 persistence;
- the Hermes plugin can observe/intercept Codex/OpenCode tool launches;
- provider/runtime placement logic already exists;
- dashboard projections are V2-oriented;
- oracle2 uses one multiplexed Hermes Gateway and has strict safe-deploy rules.

V3 must not pretend those mechanisms have already been retired.

## 3. Target ownership shift

```text
V2 custom ownership                  V3 owner
------------------------------------------------------------
worker/runtime placement       ->    AI Office policy + OpenHands
agent execution lifecycle      ->    OpenHands
provider protocol/routing      ->    LiteLLM
provider retry/cooldown         ->    LiteLLM
usage/cost trace storage        ->    LiteLLM + Langfuse
workspace execution runtime     ->    OpenHands
workforce identity metaphors    ->    UI projection only
cross-system execution link     ->    tiny AI Office V3 index
workflow phase semantics        ->    Hermes Development Skill
```

## 4. Non-destructive migration rule

Do not mutate or drop V2 tables as part of V3 introduction.

V2 storage becomes historical evidence only after cutover.

Preferred migration mechanism:

```text
new V3 correlation DB / schema
+ new upstream services
+ new V3 API namespace
```

rather than trying to reinterpret V2 Employee/Employment/Appointment rows as V3 executions.

## 5. Phase 0 — Freeze architecture and pin versions

Before implementation:

- commit this V3 documentation package;
- record exact OpenHands/LiteLLM/Langfuse versions selected for PoC;
- pin ACP server/CLI versions where practical;
- record current V2 production health and rollback command;
- do not add new V2 domain concepts unless needed for critical production maintenance.

Exit criterion:

> V3 can be implemented without further expanding V2 semantics.

## 6. Phase 1 — Stand up upstream services independently

Deploy/test:

```text
OpenHands Agent Server
LiteLLM Proxy
Langfuse integration target
```

No Hermes execution uses them yet.

Verify independently:

- OpenHands built-in Agent can execute a read-only test task;
- OpenHands can run an ACP backend;
- OpenCode works through `opencode acp` in a controlled test;
- Codex ACP preset/path works with selected auth mode;
- LiteLLM serves at least one logical model class;
- LiteLLM emits token/cost data to Langfuse;
- no provider secret enters V3 source/config committed to Git.

## 7. Phase 2 — Build thin V3 facade and correlation index

Implement only:

```text
ExecutionPolicy
ExecutionLink persistence
OpenHands adapter
LiteLLM read/admin adapter
Langfuse read adapter
/api/v3/development/executions
```

Do not build the full Desktop UI yet.

Exit criterion:

> one API call can create a correlated OpenHands execution and retrieve its final result/usage refs.

## 8. Phase 3 — Hermes shadow tool

Add a new Hermes tool, initially not the default path:

```text
ai_office_v3_run_phase
```

Use it manually in one test profile.

Do not modify existing V2 `pre_tool_call` placement behavior for ordinary users yet.

Test:

```text
Hermes -> V3 tool -> OpenHands -> LiteLLM -> Langfuse -> result -> Hermes
```

The first vertical slice is `INVESTIGATE_PLAN` with no source-code write requirement.

## 9. Phase 4 — Writable isolated implementation

Add:

- isolated Git worktree/workspace provisioning;
- `IMPLEMENT` phase;
- deterministic branch/diff metadata;
- cancel/timeout path;
- parallel writer isolation test.

Do not enable broad autonomous merging.

Exit criterion:

> a Hermes task can produce a verified isolated branch without touching the source checkout unexpectedly.

## 10. Phase 5 — Fresh review loop

Add:

```text
VERIFY_REVIEW
IMPLEMENT_FIX
fresh review session rule
```

Prove:

- reviewer conversation differs from implementer conversation;
- review sees actual diff/branch;
- failed review can drive a bounded fix loop;
- final status is surfaced to Hermes.

## 11. Phase 6 — AI Office V3 Desktop surface

Build only after execution works.

Initial UI:

```text
Active Work
History
Routing Policy
Models & Providers summary
Usage & Traces summary
```

Read from upstream systems; do not reintroduce V2 ledgers simply to populate UI.

## 12. Phase 7 — Controlled Hermes cutover

Introduce profile-level feature flag:

```text
plugins.entries.hermes-ai-office.settings.execution_mode = v2 | v3 | disabled
```

Recommended rollout:

```text
explicit test/approved profile -> selected development profiles -> default as appropriate
```

During this phase:

> MemoFlow is currently an explicit exception on oracle2: `.ai-office-disabled` is
> present and the profile has no AI Office plugin link. Keep that opt-out until an
> operator explicitly authorizes a MemoFlow V3 rollout.

- V2 remains rollback path;
- V3 development skill becomes default only for opted-in profiles;
- old V2 staffing interception is disabled for V3-controlled execution to avoid double selection.

## 13. Phase 8 — Retire V2 runtime ownership

Only after production-like validation:

- disable/remove V2 runtime placement hooks;
- stop V2 domain service writes;
- keep V2 database/history read-only for an agreed retention period;
- remove UI surfaces no longer meaningful;
- update root documentation authority order so V3 becomes production truth.

Do not immediately delete historical data.

## 14. Rollback

Rollback must be configuration-driven while V2 remains available.

```text
profile execution mode: v3 -> v2
```

Rollback does not require converting V3 OpenHands conversations into V2 DutySessions. In-flight V3 work can be allowed to finish or explicitly cancelled before changing default routing.

## 15. Data migration

### Must migrate

Very little.

Potentially retain as policy input:

- known provider names/URLs as operator references;
- preferred commercial class;
- known model preferences;
- explicit enable/disable choices.

### Must not blindly migrate

- V2 Employee identities;
- Appointments;
- DutySessions;
- StaffingSegments;
- legacy invocation/usage rows as if they were Langfuse traces.

Historical V2 usage stays historical.

## 16. Credential migration

Provider secrets should move into the chosen authoritative secret boundaries:

```text
API providers -> LiteLLM
native ACP subscriptions -> agent/CLI native credential store
Langfuse keys -> telemetry service env/secret store
```

Migration must be manual/explicit enough to avoid copying secrets into V3 SQLite or Git.

## 17. Deleting old code

V3 implementation should prefer a clean new module over layering compatibility into V2 internals.

Delete V2 runtime code only after:

- V3 acceptance gates pass;
- rollback window closes;
- no current plugin/UI references remain;
- documentation marks V2 historical.

## 18. Success condition

Migration is complete when:

```text
Hermes Development Skill
  -> V3 facade
  -> OpenHands
  -> LiteLLM/native transport
  -> Langfuse observability
```

is the only normal development delegation path and no V2 component remains an authoritative writer for worker/provider/execution state.
