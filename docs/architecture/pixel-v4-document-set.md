# V4 Greenfield Supersession

The Greenfield rebuild is now the governing direction. Read `docs/adr/ADR-002-v4-greenfield-rebuild.md` and `docs/architecture/pixel-v4-greenfield-kernel.md` first. For model/provider execution routing, ADR-003 and its companion architecture documents are also governing decisions. For project concurrency and Git workspace ownership, ADR-004 governs normal V4 execution: one active root Plan per project, queued later tasks, and Plan-owned literal Git worktrees. Older additive documents remain historical reference where a newer decision explicitly supersedes them.

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
10. **Single-active-plan/worktree decision** — `docs/adr/ADR-004-single-active-plan-worktree-execution.md`
11. **Single-active-plan worktree architecture** — `docs/architecture/pixel-v4-single-active-plan-worktree-execution.md`
12. **Plan queue/worktree lifecycle** — `docs/architecture/pixel-v4-plan-queue-and-worktree-lifecycle.md`
13. **Worktree migration/operations** — `docs/architecture/pixel-v4-worktree-migration-and-operations.md`
14. **Autonomous maintenance, Jules, PR governance** — `docs/architecture/autonomous-improvement-programs-and-external-pr-governance.md`
15. **Resource and safety policy** — `docs/architecture/pixel-v4-resource-policy-and-safety-budgets.md`
16. **Migration/operations** — `docs/architecture/pixel-v4-migration-rollout-and-operations.md`
17. **Supervisor implementation plan** — `docs/plan/active/2026-08-31-pixel-v4-durable-supervisor-and-autonomous-improvement.md`
18. **Routing/provider implementation plan** — `docs/plan/active/2026-09-03-pixel-v4-routing-and-provider-governance.md`
19. **Single-active-plan/worktree implementation plan** — `docs/plan/active/2026-09-04-pixel-v4-single-active-plan-worktree-refactor.md`

## One-sentence architecture

A persistent supervisor proposes bounded actions; the deterministic Pixel kernel validates them, serializes top-level work behind one active root Plan per project, runs only DAG-safe WorkItems concurrently in Plan-owned Git worktrees, selects a durable model-agent-resource execution profile, and owns exact review, single-writer integration, delivery, recovery, and rollback.

## First implementation gate

Do not enable literal V4 worktree provisioning until the current reliability patch is committed/released, the project single-active-plan lease and durable queue are in place, no in-flight legacy writer for the canary project requires clone-only recovery, and the real OpenHands UID passes the production-shaped worktree/common-Git-dir smoke defined by ADR-004.
