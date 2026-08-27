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

The plugin uses two enforcement hooks. `pre_llm_call` classifies the current turn and marks **software-development/coding work only** as requiring `ai_office_delegate` in enforced project profiles. `pre_tool_call` then blocks direct source/Git mutation and direct coding-agent launches only for that coding turn. Ordinary SSH setup, secret/credential storage, deployment and service administration, operational file changes, backups, and other non-coding work remain directly executable by Hermes. Read-only inspection and bounded verification remain available during coding turns. `ai_office_create_plan` remains available only when an operator intentionally supplies the full graph.

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

- **Overview** — active tasks, portfolio-sorted fixed-size plan cards, project running/completed/blocked statistics, execution history, usage/cost, provider health, and runtime health.
- **Analytics** — aggregates by project, logical model, physical model, provider/channel, and phase.

Provider configuration is managed in LiteLLM Admin. AI Office reads the LiteLLM registry and spend logs but never duplicates provider mutation.

### Dashboard contract

The dashboard keeps the overview payload compact and loads an on-demand plan timeline only when a plan card is opened. The timeline projects per-batch business/system work, model executions, usage, failures, mechanical integration events, and delivery events without mutating plan state.
The plan detail also exposes a read-only engineering audit projection: failure-to-repair chains, per-batch duration/token/cost/failure/repair totals, and the durable policy evidence explaining every strong-model decision.
The audit also assigns deterministic P0/P1/P2/P3 priorities and a deterministic 0–100 health score; plan cards expose the current score and highest-priority unresolved issue without loading full history.
Audit findings and strong-model decisions are directly navigable to their timeline executions. Client-side filters can isolate failures, repairs/retries, strong-model executions, or one batch without issuing new control-plane requests or mutating plan state.
Blocked plan cards now treat normal Agent-to-Agent ownership transfer and disaster recovery as different operations. **Resume from handoff** is the default path: the operator pastes an `AI_OFFICE_HANDOFF_V1` packet produced by ChatGPT, Codex, Claude, or another coding agent. The packet pins `planId`, the durable `baseRevision`, exact committed `headRevision`, optional Git ref, attested completed work-item keys/evidence, and an optional recommended next item. The Control Plane launches no model audit; it mechanically verifies that the base still equals the durable plan revision, the head/ref resolve exactly, and the head is a committed Git descendant, then transactionally adopts the attested checkpoint and resumes normal plan progression. The handoff is recorded as operator-submitted provenance rather than being confused with independent model verification.

**Scan external progress** remains the expensive fallback for lost-context/disaster recovery. It discovers descendant repository refs with durable-ticket evidence and starts one premium read-only `INVESTIGATE_PLAN` audit at the pinned candidate revision. The request returns immediately instead of holding a 12-minute coordinator wait; periodic reconciliation harvests the same durable audit execution when it eventually succeeds, so a slow audit is not duplicated and a late success is not discarded. Only model-verified completed work and dependency-valid batches are adopted; immediately before adoption the candidate ref is re-discovered and a moved candidate is rejected fail-closed. Commit subjects are discovery hints only and can never mark a ticket complete by themselves.

A minimal handoff packet is:

```text
AI_OFFICE_HANDOFF_V1
{
  "schemaVersion": 1,
  "planId": "plan_...",
  "baseRevision": "<40-hex durable revision>",
  "headRevision": "<40-hex committed descendant>",
  "ref": "feature/agent-continuation",
  "completedWorkItems": [
    { "key": "TASK-123", "evidence": ["focused checks passed"] }
  ],
  "recommendedNextWorkItem": "TASK-124"
}
```

`contracts/dashboard.schema.json` is the single backend-to-frontend DTO contract for the console. `dashboard/plugin_api/` produces that shape and the modular `dashboard/src/` frontend consumes it. `dashboard/dist/index.js` is a generated browser bundle, not an editing surface. Build it with `node scripts/build-dashboard.mjs`; CI/tests use `node scripts/build-dashboard.mjs --check` so direct edits to `dist/index.js` or stale bundles fail closed. Field aliases and compatibility fallbacks are intentionally unsupported: a shape change must update the producer, contract, source consumer, generated bundle, and contract tests together.

Plan cards project the durable workflow state rather than guessing from batch names. Business progress excludes synthetic control-plane work, while `currentActivity` exposes integration repair, aggregate `BATCH_VERIFY`, delivery repair, post-merge repair, backend/model, attempt, revision, and blocking reason as a stable read-only dashboard contract.

Provider/channel attribution is produced by the Control Plane and persisted with execution route evidence. The dashboard consumes `providerKey` directly; it does not infer a provider from model names or reinterpret historical deployments against the current registry.
