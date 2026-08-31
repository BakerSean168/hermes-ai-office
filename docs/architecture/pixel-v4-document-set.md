# Pixel V4 Document Set

Pixel V4 adds a durable AI supervisor and autonomous maintenance programs over the V3 deterministic execution kernel.

Read in this order:

1. **Decision** — `docs/adr/ADR-001-durable-ai-supervisor-and-deterministic-kernel.md`
2. **Runtime architecture** — `docs/architecture/pixel-v4-durable-supervisor-runtime.md`
3. **Typed AI/kernel contract** — `docs/architecture/pixel-v4-supervisor-action-protocol.md`
4. **Autonomous maintenance, Jules, PR governance** — `docs/architecture/autonomous-improvement-programs-and-external-pr-governance.md`
5. **Anti-Gravity/resource and safety policy** — `docs/architecture/pixel-v4-resource-policy-and-safety-budgets.md`
6. **Migration/operations** — `docs/architecture/pixel-v4-migration-rollout-and-operations.md`
7. **Executable ticket plan** — `docs/plan/active/2026-08-31-pixel-v4-durable-supervisor-and-autonomous-improvement.md`

## One-sentence architecture

A persistent OpenHands supervisor observes and proposes typed actions; the deterministic Pixel kernel validates, executes, records, reviews, integrates, delivers, and rolls back those actions.

## First implementation gate

Do not begin V4 autonomous effects until the current exact result/review provenance P1 findings are fixed, independently re-reviewed, deployed, and validated on the existing MemoFlow plan.
