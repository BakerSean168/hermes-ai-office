# Hermes Integration Contract

## 1. Role of Hermes

Hermes remains the persistent user-facing brain. V3 does not replace Hermes with OpenHands.

Hermes is valuable because it owns:

- the user's ongoing conversation;
- project intent and history available to the profile;
- memory and skills;
- the semantic decision to delegate;
- the semantic decision to continue from investigation to implementation or stop;
- the final synthesis back to the user.

OpenHands is a development execution service, not the user's primary conversational operating system.

## 2. Integration shape

The preferred integration is:

```text
Hermes Brain
  │
  │ Skill decides external phase is required
  ▼
Hermes AI Office plugin tool
  │
  ▼
AI Office V3 Facade
  │
  ▼
OpenHands Agent Server
```

The Brain should not manually orchestrate a sequence of low-level HTTP calls. One high-level tool call should create the execution and enforce required metadata/correlation.

## 3. Skill vs runtime tool

The Development Skill provides semantic guidance:

- when to delegate;
- which phase to request;
- when investigation+planning should stay together;
- when review must be fresh;
- when parallel work is safe.

The runtime plugin/tool provides deterministic mechanics:

- generate execution ID;
- apply AI Office policy;
- create/continue OpenHands conversation;
- record correlation;
- await or stream result;
- return normalized metadata.

This avoids relying on the LLM to remember "tell AI Office I started" and "tell AI Office I ended".

## 4. Minimal Hermes tools

Recommended tool surface:

```text
ai_office_run_phase
ai_office_get_execution
ai_office_continue_execution
ai_office_cancel_execution
ai_office_list_active
```

For the common path, `ai_office_run_phase` is sufficient.

## 5. `ai_office_run_phase`

Conceptual arguments:

```text
phase
objective
project_key
workspace/repository reference
complexity_hint
risk_hint
parallelism
quality_hint
budget_hint
preferred_backend?    # optional explicit user override
preferred_model_class? # optional explicit user override
continuation_execution_id? # for deliberate resume
```

The plugin automatically adds Hermes-scoped metadata:

```text
hermes_profile
hermes_session_id
hermes_turn_id
request timestamp
```

The model does not have to populate these itself.

## 6. Synchronous vs asynchronous behavior

V3 should support both modes.

### `await=true`

Use for ordinary investigation/review phases where Hermes intends to reason immediately over the result.

```text
Hermes tool call
  -> execution runs
  -> progress may stream
  -> final result returned into same Hermes turn
```

### `await=false`

Use for long implementation or explicitly parallel work.

```text
Hermes tool call
  -> returns execution IDs immediately
  -> Hermes may continue/notify user
  -> later query/automation resumes from results
```

Do not force every long coding run to hold one fragile tool request open indefinitely.

## 7. Brain decision model

Recommended semantic sequence:

```text
User request
  ↓
Is this software development?
  ├─ no -> normal Hermes behavior
  └─ yes
       ↓
Can Hermes safely answer/perform directly?
  ├─ yes -> direct path
  └─ no
       ↓
Choose DevelopmentPhase
       ↓
ai_office_run_phase(...)
       ↓
Interpret result
       ↓
Choose next DevelopmentPhase or stop
```

The Brain does not choose a provider endpoint or secret.

### Causal handoff IDs

`previous_execution_id` is a causal parent, not a generic workspace pointer:

```text
INVESTIGATE_PLAN -> IMPLEMENT              parent = plan execution
IMPLEMENT        -> VERIFY_REVIEW          parent = implementation
VERIFY_REVIEW    -> IMPLEMENT_FIX          parent = failed review
IMPLEMENT_FIX    -> VERIFY_REVIEW          parent = fix execution
VERIFY_REVIEW    -> FINALIZE               parent = approved review
```

For `IMPLEMENT_FIX`, the control plane follows the failed review's own parent back to
the implementation/fix workspace it inspected. Reviewer findings are taken from the
failed review result (the plugin normally supplies them; the control plane can hydrate
them itself). This preserves both semantic review evidence and mutable-workspace
lineage without reusing the reviewer conversation as the implementer.

### Profile execution authority

`plugins.entries.hermes-ai-office.settings.execution_mode` is one of `v3`, `v2`, or
`disabled`. In `v3`, the legacy terminal staffing hook is bypassed so there is only
one routing authority. In `v2`, `ai_office_run_phase` is blocked and legacy placement
remains the rollback path. Existing V3 executions remain queryable/cancellable/
resumable after a mode switch so rollback does not orphan work.

## 8. Explicit overrides

If the user says:

```text
"Use Codex for the review"
"Use OpenCode + DeepSeek for implementation"
```

Hermes should pass the request as a policy override, not bypass AI Office entirely.

AI Office validates whether the override is actually available/compatible and returns an explanation if it cannot honor it.

This keeps observability and execution correlation intact.

## 9. Prompt construction

The Hermes plugin should construct a bounded execution prompt from:

```text
phase instructions from Development Skill
user objective
project/workspace context
prior phase result if relevant
acceptance criteria
explicit constraints
```

Avoid dumping the entire Hermes conversation into OpenHands by default. Send only the context required for the development task.

Benefits:

- less token waste;
- less accidental disclosure;
- clearer coding-agent objective;
- more stable execution behavior.

## 10. Result returned to Hermes

The tool returns two layers:

### Semantic result

```text
final_text
```

This is what Hermes reasons over.

### Deterministic metadata

```text
execution_id
phase
status
backend
logical_model_class
transport_mode
started_at
ended_at
duration
workspace/branch ref
openhands conversation ref
usage summary + source
trace ref
```

Hermes should not infer these fields from the agent's prose.

## 11. Long-running execution recovery

For `await=false` work, the correlation index lets a later Hermes turn say:

```text
"continue the implementation"
"what is it doing now?"
"review the result"
```

without relying on conversational memory alone.

The plugin resolves the referenced `execution_id` and queries OpenHands for authoritative status.

## 12. Hermes profile strategy

Do not create one Hermes Profile per worker.

Profiles remain long-lived conversational/project identities, e.g.:

```text
default
memoflow
bodysense
```

Codex/OpenCode/OpenHands workers are execution backends, not Hermes profiles.

## 13. Hermes Gateway strategy

V3 does not require another Hermes Gateway for each coding worker.

Normal topology:

```text
one multiplexed Hermes Gateway
  -> multiple long-lived Profiles
  -> AI Office development tool
  -> external OpenHands service
```

OpenHands execution failures must not terminate the Hermes Gateway.

## 14. Hermes Kanban

Hermes official Kanban is not required for V3.

Reason:

- V3's development workflow is phase-oriented and directly delegated through OpenHands;
- OpenHands owns coding execution lifecycle;
- adding Hermes Kanban as another scheduler would reintroduce dual orchestration.

The Desktop Kanban plugin may remain disabled without affecting V3.

## 15. Plugin deployment safety on oracle2

Existing oracle2 rules still apply to Hermes plugin changes:

- do not recreate `hermes-personal` merely to load AI Office changes;
- hot-sync dashboard-only changes;
- stage runtime plugin changes while Hermes has active turns;
- activate through the safe deployment/drain/restart path.

V3 external services can be deployed independently of the Hermes Gateway whenever their network/API contracts remain compatible.
