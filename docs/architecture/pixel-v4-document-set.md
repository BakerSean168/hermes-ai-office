# V4 Greenfield Supersession

The Greenfield rebuild is now the governing direction. Read `docs/adr/ADR-002-v4-greenfield-rebuild.md` and `docs/architecture/pixel-v4-greenfield-kernel.md` first. For model/provider execution routing, ADR-003 and its companion architecture documents are also governing decisions. Older additive documents remain historical reference where a newer decision explicitly supersedes them.

# Pixel V4 Document Set

Pixel V4 adds a durable AI supervisor and autonomous maintenance programs over the V3 deterministic execution kernel.

Read in this order:

1. **Greenfield decision** — `docs/adr/ADR-002-v4-greenfield-rebuild.md`
2. **Greenfield kernel** — `docs/architecture/pixel-v4-greenfield-kernel.md`
3. **Durable supervisor decision** — `docs/adr/ADR-001-durable-ai-supervisor-and-deterministic-kernel.md`
4. **Runtime architecture** — `docs/architecture/pixel-v4-durable-supervisor-runtime.md`
5. **Current gap analysis** — `docs/architecture/pixel-v4-current-gap-analysis.md`
6. **Typed AI/kernel contract** — `docs/architecture/pixel-v4-supervisor-action-protocol.md`
7. **Routing decision** — `docs/adr/ADR-003-static-model-agent-resource-routing.md`
8. **Model/agent/resource routing** — `docs/architecture/pixel-v4-model-agent-resource-routing.md`
9. **Provider catalog/resource lifecycle** — `docs/architecture/pixel-v4-provider-catalog-and-resource-lifecycle.md`
10. **Autonomous maintenance, Jules, PR governance** — `docs/architecture/autonomous-improvement-programs-and-external-pr-governance.md`
11. **Resource and safety policy** — `docs/architecture/pixel-v4-resource-policy-and-safety-budgets.md`
12. **Migration/operations** — `docs/architecture/pixel-v4-migration-rollout-and-operations.md`
13. **Supervisor implementation plan** — `docs/plan/active/2026-08-31-pixel-v4-durable-supervisor-and-autonomous-improvement.md`
14. **Routing/provider implementation plan** — `docs/plan/active/2026-09-03-pixel-v4-routing-and-provider-governance.md`

## One-sentence architecture

A persistent supervisor proposes bounded actions; the deterministic Pixel kernel validates them, selects a durable model-agent-resource execution profile, uses OpenHands/provider-native adapters to run the selected agent, and owns review, integration, delivery, recovery, and rollback.

## First implementation gate

Do not begin V4 autonomous effects until the current exact result/review provenance P1 findings are fixed, independently re-reviewed, deployed, and validated on the existing MemoFlow plan.
