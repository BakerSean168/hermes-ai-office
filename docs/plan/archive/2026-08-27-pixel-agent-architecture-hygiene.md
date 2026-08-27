# Pixel Agent Architecture Hygiene Refactor

Date: 2026-08-27
Status: COMPLETE
Archived: 2026-08-27
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


## Completion report

Completed on 2026-08-27 as four independently verified checkpoints.

### Wave 1 result — application state-machine boundaries

- `planOrchestrator.ts`: ~1780 -> 589 lines.
- Added `WorkItemCoordinator`, `BatchCoordinator`, `ExternalProgressReconciler`, and `PlanRecoveryCoordinator`.
- Moved orchestration/external-audit protocol parsing into pure protocol modules.
- Added architecture regression tests that fail if ticket, batch-repair, or external-sync internals regrow inside the plan-level orchestrator.
- Tracked the production-required AppArmor profile so the clean Git revision is self-contained.

### Wave 2 result — persistence and Git boundaries

- `plans.ts`: ~1180 -> 879 lines while keeping transaction/state mutations in one repository facade.
- Domain records/graph validation now live in `plan/model.ts`.
- SQLite schema and row mapping now live in `plan/sqlite.ts`; the database schema itself did not change.
- `workspace.ts`: ~570 -> 434 lines.
- Low-level Git helpers now live in `gitSupport.ts` and external continuation discovery/scoring in `repositoryProgress.ts`.
- Existing public type/interface imports remain compatible through re-exports.

### Wave 3 result — Hermes Python ownership

- Main Hermes plugin facade: ~1124 -> 715 lines.
- Tool protocol/schema moved to `protocol.py`; execution-enforcement policy moved to `policy.py`.
- Plugin tests now reproduce Hermes' real package-loader semantics instead of treating the plugin as an unsupported single-file module.
- Dashboard backend: ~1135-line `plugin_api.py` replaced by the native `plugin_api/` package with transport, execution, plan, audit/detail, config, and assembly owners; largest module is ~394 lines.
- The safe deploy classifier recognizes the package API path.

### Wave 4 result — dashboard frontend source authority

- `dashboard/dist/index.js` is no longer an editing surface.
- Added modular `dashboard/src/` source with separate runtime, i18n, formatting, primitives, plan detail/audit, overview, analytics, app, and entry modules; largest source module is ~316 lines.
- Added deterministic esbuild pipeline: `node hermes-ai-office/scripts/build-dashboard.mjs`.
- `--check` mode fails when the checked-in browser bundle is stale or edited independently of source.
- Hermes continues to load the same classic browser entry `dashboard/dist/index.js`; no Plugin SDK/runtime contract changed.

### Final verification

- Control Plane: 77/77 tests PASS.
- Control Plane TypeScript build: PASS.
- Hermes plugin/dashboard: 48/48 tests PASS.
- Dashboard generated-bundle freshness: PASS.
- Python compile, dashboard JS syntax, deployment script syntax, and `git diff --check`: PASS.

The remaining larger files (`DevelopmentExecutionService`, transaction-heavy `PlanRepository`, correlation/delivery adapters) are now bounded by explicit ownership and are not current patch hotspots. Future extraction should be driven by a concrete ownership split rather than arbitrary line-count targets.
