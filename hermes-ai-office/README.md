# Hermes AI Office

AI Office is the Hermes-facing development execution facade.

```text
Hermes -> AI Office V3 -> OpenHands Supervisor -> isolated coding workers -> LiteLLM
```

The Hermes plugin is intentionally thin: it has no parallel provider database and does not poll or manually chain ticket phases. Hermes submits one durable plan; workspace admission, lineage, automatic review/fix transitions, dependency unlocks, integration, and explicitly authorized remote delivery remain deterministic in the Control Plane.

## Tools

- `ai_office_delegate` (default: Hermes supplies only objective/repository; OpenHands builds the graph)
- `ai_office_create_plan` (advanced: submit an already-decided graph)
- `ai_office_get_plan`
- `ai_office_cancel_plan`
- `ai_office_list_plans`
- `ai_office_run_phase`
- `ai_office_get_execution`
- `ai_office_cancel_execution`
- `ai_office_list_active`
- `ai_office_list_providers`

The plugin uses two enforcement hooks. `pre_llm_call` tells the Hermes Brain that `ai_office_delegate` is the mandatory execution boundary for enforced project profiles, while `pre_tool_call` blocks direct source/Git mutation and direct coding-agent launches outside AI Office. Read-only inspection and bounded verification remain available. `ai_office_create_plan` remains available only when an operator intentionally supplies the full graph.

## Development protocol

- `ai_office_delegate` is the default public orchestration boundary: Hermes submits the objective and repository, immediately receives a durable `planId` in `ORCHESTRATING`, and OpenHands inspects the repository to produce the batch graph. The Control Plane validates/materializes that graph before any writer starts.
- `ai_office_create_plan` remains the explicit-graph escape hatch for operator-authored plans.
- `INVESTIGATE_PLAN`
- `IMPLEMENT`
- `VERIFY_REVIEW`
- `IMPLEMENT_FIX`
- internal `BATCH_VERIFY` for multi-item aggregate semantic review
- `FINALIZE`

Reviewers should put `PASS` or `FAIL` on the first non-empty line. The parser prefers that strict contract and otherwise accepts only one unique standalone verdict token in the whole result; ambiguous results fail closed as `UNKNOWN`. A blocking review enters `IMPLEMENT_FIX`; approved work items enter deterministic batch integration. For multi-item batches, a clean Git merge is only an integration candidate: internal `BATCH_VERIFY` performs a premium aggregate semantic review before that revision is promoted. Aggregate FAIL creates a bounded premium integration-repair work item and the repaired candidate is reviewed again. When `ai_office_create_plan` explicitly sets `delivery.auto_merge=true`, AI Office continues through pull-request checks, bounded reviewed CI repair, merge, and post-merge verification before reporting plan success. If checks fail only after the PR has already merged, Pixel Agent schedules a premium follow-up repair on the merged target state, independently reviews it, mechanically requires the failed merge revision to remain in Git ancestry, and delivers the fix through a new PR rather than rewriting merged history.

The legacy single-execution phase tool does not expose `ORCHESTRATE`; it cannot
bypass durable graph validation. External ACP backends currently include OpenCode,
DSH, Codex, Claude Code, and ZCode. Runtime readiness is separate from registration:
only smoke-proven workers are enabled by default.

## Dashboard

AI Office exposes two views:

- **Overview** — active tasks, full execution history, start time, live elapsed time, duration, token usage, cost, route, readiness, and runtime health.
- **Analytics** — aggregates by project, logical model, physical model, provider/channel, and phase.

Provider configuration is managed in LiteLLM Admin. AI Office reads the LiteLLM registry and spend logs but never duplicates provider mutation.

### Dashboard contract

`contracts/dashboard.schema.json` is the single backend-to-frontend DTO contract for the console. `dashboard/plugin_api.py` produces that shape and `dashboard/dist/index.js` consumes it. Field aliases and compatibility fallbacks are intentionally unsupported: a shape change must update the producer, contract, consumer, and contract tests together.

Plan cards project the durable workflow state rather than guessing from batch names. Business progress excludes synthetic control-plane work, while `currentActivity` exposes integration repair, aggregate `BATCH_VERIFY`, delivery repair, post-merge repair, backend/model, attempt, revision, and blocking reason as a stable read-only dashboard contract.

Provider/channel attribution is produced by the Control Plane and persisted with execution route evidence. The dashboard consumes `providerKey` directly; it does not infer a provider from model names or reinterpret historical deployments against the current registry.
