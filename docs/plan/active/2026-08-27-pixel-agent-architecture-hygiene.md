# Pixel Agent Architecture Hygiene Refactor

Date: 2026-08-27
Status: ACTIVE
Baseline: `1ebdb2b` plus the production-required AppArmor profile that was previously untracked.

## Outcome

Refactor the current Pixel Agent / AI Office V3 implementation so future engineering work extends explicit ownership boundaries instead of adding more branches to large coordinator files. This wave is behavior-preserving: it changes code organization and dependency direction, not product semantics.

## Current evidence

- `model-control-plane/src/v3/planOrchestrator.ts`: ~1780 lines and currently owns orchestration parsing, work-item execution, review/fix transitions, batch integration repair, aggregate review, delivery, external-progress reconciliation, blocked recovery, and reconcile serialization.
- `model-control-plane/src/v3/plans.ts`: ~1180 lines and mixes plan validation, SQLite mapping, queries, state transitions, synthetic work-item creation, external adoption, and event persistence.
- `model-control-plane/src/v3/workspace.ts`: ~570 lines and mixes workspace provisioning, writer completion, integration, and external Git discovery.
- Hermes dashboard producer/consumer files exceed 1000 lines each.
- The production deployment boundary test referenced `hermes-openhands-codex.apparmor`, but the file was not tracked in the latest clean feature revision. Canonical tests only passed because that file existed untracked in the working tree.

## Protected contracts

This refactor MUST preserve:

- `/api/v3/development/*` routes and response semantics.
- recovery modes: `AUTO`, `RETRY_REVIEW`, `RETRY_DELIVERY`, `SYNC_EXTERNAL`.
- plan, batch, and work-item state transitions and durable event names.
- SQLite tables/schema and existing durable database compatibility.
- execution idempotency keys and causal `previousExecutionId` lineage.
- review verdict contract (`PASS`/`FAIL`, fail-closed UNKNOWN behavior).
- workspace isolation, writer completion gate, Git ancestry checks, integration refs, and external-progress candidate pinning.
- delivery PR/check/post-merge behavior.
- dashboard DTO schema and Hermes plugin routes.

## North-star ownership

```text
API adapter
  -> DevelopmentExecutionService
  -> DurablePlanOrchestrator           (plan-level lifecycle + serialization)
       -> WorkItemCoordinator          (IMPLEMENT / REVIEW / FIX lifecycle)
       -> BatchCoordinator             (Git integration / repair / BATCH_VERIFY)
       -> ExternalProgressReconciler   (external checkpoint audit/adoption)
       -> PlanRecoveryCoordinator      (explicit blocked-plan recovery policy)
       -> PlanDeliveryPort             (remote PR/check/merge delivery)

PlanRepository                         (durable plan state/event persistence)
WorkspaceProvisioningPort              (Git/workspace mechanics)
ExecutionLinkRepository                (execution correlation evidence)
```

`DurablePlanOrchestrator` should decide *which plan-level state machine step is next*. It should not contain prompt parsing, ticket retry rules, batch repair prompt construction, or external checkpoint audit implementation.

## Wave 1 — Control-plane application boundaries

1. Track the production-required AppArmor profile so a clean revision is self-contained.
2. Extract plan protocol parsing and synthetic work-item classification into `src/v3/plan/`.
3. Extract work-item execution/review/fix lifecycle into `WorkItemCoordinator`.
4. Extract batch integration/repair/aggregate review into `BatchCoordinator`.
5. Extract external progress audit/adoption into `ExternalProgressReconciler`.
6. Extract blocked-plan recovery policy into `PlanRecoveryCoordinator`.
7. Keep `DurablePlanOrchestrator` as the plan-level facade and reconciliation serializer.

Acceptance:
- existing V3 tests remain green without behavior changes;
- TypeScript build passes;
- clean worktree contains all production files required by tests/deployment;
- `planOrchestrator.ts` materially shrinks and no longer contains external-progress protocol parsing, ticket lifecycle, or batch repair implementation.

## Wave 2 — Persistence and Git boundaries

After Wave 1 is stable:

- split `plans.ts` into domain records/validation + SQLite repository + focused mutation helpers;
- split `workspace.ts` into execution workspace provisioning, Git batch integration, and repository progress discovery;
- preserve the existing interfaces while moving mechanics behind narrower collaborators.

## Wave 3 — Hermes plugin / dashboard projections

- split `hermes-ai-office/__init__.py` into policy hooks, tool definitions, and control-plane client;
- split dashboard Python projection into execution, plan/timeline, audit/health, and transport modules;
- introduce maintainable dashboard source modules rather than continuing to grow one `dist/index.js` implementation file;
- keep the current schema as the single frontend/backend contract.

## Verification

Focused first, then wider:

```bash
cd model-control-plane
npm test -- --test-name-pattern='durable plan|sync_external|batch|review'
npm test
npm run build

cd ../hermes-ai-office
python3 -m unittest test_dashboard.py test_plugin.py
node --check dashboard/dist/index.js
git diff --check
```
