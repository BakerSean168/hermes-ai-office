# Hermes AI Office

AI Office is the Hermes-facing development execution facade.

```text
Hermes -> AI Office V3 -> OpenHands Supervisor -> isolated coding workers -> LiteLLM
```

The Hermes plugin is intentionally thin: it has no parallel provider database and does not poll or manually chain ticket phases. Hermes submits one durable plan; workspace admission, lineage, automatic review/fix transitions, dependency unlocks, integration, and explicitly authorized remote delivery remain deterministic in the Control Plane.

## Tools

- `ai_office_create_plan`
- `ai_office_get_plan`
- `ai_office_list_plans`
- `ai_office_run_phase`
- `ai_office_get_execution`
- `ai_office_continue_execution`
- `ai_office_cancel_execution`
- `ai_office_list_active`
- `ai_office_list_providers`

The only hook is `pre_llm_call`, which tells the Hermes Brain to use `ai_office_create_plan` for complete work, retain the returned `planId`, and recover with plan-scoped reads or reconcile instead of replaying phase calls.

## Development protocol

- `ORCHESTRATE`
- `INVESTIGATE_PLAN`
- `IMPLEMENT`
- `VERIFY_REVIEW`
- `IMPLEMENT_FIX`
- `FINALIZE`

Reviewers should put `PASS` or `FAIL` on the first non-empty line. The parser prefers that strict contract and otherwise accepts only one unique standalone verdict token in the whole result; ambiguous results fail closed as `UNKNOWN`. A blocking review enters `IMPLEMENT_FIX`; an approved plan work item enters deterministic batch integration. When `ai_office_create_plan` explicitly sets `delivery.auto_merge=true`, AI Office continues through pull-request checks, bounded reviewed CI repair, merge, and post-merge verification before reporting plan success.

`ORCHESTRATE` runs in a read-oriented Supervisor workspace. It may use OpenHands `task_tool_set` for internal analysis and `ai_office_worker` to launch multiple isolated workers. External ACP backends currently include OpenCode, DSH, Codex, Claude Code, and ZCode. Runtime readiness is separate from registration: only smoke-proven workers are enabled by default.

## Dashboard

AI Office exposes two views:

- **Overview** — active tasks, full execution history, start time, live elapsed time, duration, token usage, cost, route, readiness, and runtime health.
- **Analytics** — aggregates by project, logical model, physical model, provider/channel, and phase.

Provider configuration is managed in LiteLLM Admin. AI Office reads the LiteLLM registry and spend logs but never duplicates provider mutation.

### Dashboard contract

`contracts/dashboard.schema.json` is the single backend-to-frontend DTO contract for the console. `dashboard/plugin_api.py` produces that shape and `dashboard/dist/index.js` consumes it. Field aliases and compatibility fallbacks are intentionally unsupported: a shape change must update the producer, contract, consumer, and contract tests together.

Provider/channel attribution is produced by the Control Plane and persisted with execution route evidence. The dashboard consumes `providerKey` directly; it does not infer a provider from model names or reinterpret historical deployments against the current registry.
