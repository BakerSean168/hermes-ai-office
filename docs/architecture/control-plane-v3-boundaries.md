# Control Plane V3 Ownership Boundaries

## Rule

One module owns one class of state transition. Cross-cutting helpers may expose evidence, but they do not decide another module's state machine.

| Boundary | Owns | Must not own |
| --- | --- | --- |
| `DurablePlanOrchestrator` | plan-level next-step selection, orchestration materialization, delivery handoff, per-plan reconciliation serialization | ticket retry policy, Git repair implementation, external audit parsing |
| `WorkItemCoordinator` | IMPLEMENT -> VERIFY_REVIEW -> IMPLEMENT_FIX transitions, retry/fix limits, work-item blocking, approved implementation evidence | batch promotion, delivery, external branch adoption |
| `BatchCoordinator` | deterministic integration, semantic integration repair, `BATCH_VERIFY`, promotion | ordinary ticket implementation lifecycle, remote delivery |
| `ExternalProgressReconciler` | discover pinned external checkpoint, premium read-only audit, candidate movement guard, adoption request | generic blocked recovery |
| `PlanRecoveryCoordinator` | explicit recovery-mode policy for blocked plans | normal plan progression |
| `PlanRepository` | durable state/event persistence | model prompts, Git operations, provider selection |
| `WorkspaceProvisioningPort` | filesystem/Git mechanics | plan semantics |
| `PlanDeliveryPort` | remote PR/check/merge mechanics | ticket or batch semantics |

## Dependency direction

Application coordinators may depend on repositories/ports. Repositories and ports must not import application coordinators. API adapters depend inward on application services.

## Extension rule

Before adding a new recovery/repair feature, identify its owner. If it is a new semantic phase, add it to the narrow coordinator that owns that transition and expose only the minimal orchestration hook. Do not add another multi-hundred-line branch to `DurablePlanOrchestrator`.
