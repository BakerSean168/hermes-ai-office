# Control Plane V3 Ownership Boundaries

## Rule

One module owns one class of state transition. Cross-cutting helpers may expose evidence, but they do not decide another module's state machine.

| Boundary | Owns | Must not own |
| --- | --- | --- |
| `DurablePlanOrchestrator` | plan-level next-step selection, orchestration materialization, delivery handoff, per-plan reconciliation serialization | ticket retry policy, Git repair implementation, external audit parsing |
| `WorkItemCoordinator` | IMPLEMENT -> VERIFY_REVIEW -> IMPLEMENT_FIX transitions, retry/fix limits, work-item blocking, approved implementation evidence | batch promotion, delivery, external branch adoption |
| `BatchCoordinator` | deterministic integration, semantic integration repair, `BATCH_VERIFY`, promotion | ordinary ticket implementation lifecycle, remote delivery |
| `HandoffReconciler` | validate operator-submitted `AI_OFFICE_HANDOFF_V1`, verify exact Git ancestry/ref identity, adopt the attested checkpoint without a model audit | repository-wide discovery/audit, normal ticket progression |
| `ExternalProgressReconciler` | disaster-recovery discovery of a pinned external checkpoint, premium read-only audit, late-result harvesting, candidate movement guard, adoption request | normal Agent-to-Agent ownership transfer, generic blocked recovery |
| `PlanRecoveryCoordinator` | explicit recovery-mode policy for blocked plans | normal plan progression |
| `PlanRepository` | durable state/event persistence | model prompts, Git operations, provider selection |
| `WorkspaceProvisioningPort` | filesystem/Git mechanics | plan semantics |
| `PlanDeliveryPort` | remote PR/check/merge mechanics | ticket or batch semantics |

## Dependency direction

Application coordinators may depend on repositories/ports. Repositories and ports must not import application coordinators. API adapters depend inward on application services.

## Extension rule

Before adding a new recovery/repair feature, identify its owner. If it is a new semantic phase, add it to the narrow coordinator that owns that transition and expose only the minimal orchestration hook. Do not add another multi-hundred-line branch to `DurablePlanOrchestrator`.


## Hermes / dashboard boundaries

```text
Hermes plugin facade (__init__.py)
  -> protocol.py            tool schemas + stable V3 defaults
  -> policy.py              profile enforcement + read-only verification policy
  -> Control Plane HTTP     transport/tool handlers remain at the facade boundary

Dashboard API facade (dashboard/plugin_api/__init__.py)
  -> transport.py
  -> executions.py
  -> plans.py
  -> detail.py
  -> assembly.py

Dashboard browser source (dashboard/src/index.js)
  -> app.js
     -> overview.js
     -> plan-detail.js
     -> analytics.js
     -> shared runtime / formatting / primitives / i18n
  -> esbuild -> dashboard/dist/index.js
```

The browser bundle is generated output. New UI behavior belongs in `dashboard/src/`; direct feature edits to `dashboard/dist/index.js` are prohibited by the bundle-freshness check.
