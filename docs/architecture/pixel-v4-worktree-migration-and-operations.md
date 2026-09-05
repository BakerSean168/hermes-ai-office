# Pixel V4 Worktree Migration and Operations

Date: 2026-09-04
Status: PRODUCTION OPERATIONS GUIDE

## 1. Migration objective

Move normal new V4 work from:

```text
Execution -> private full Git clone
```

to:

```text
Project -> one Active Root Plan -> Plan-owned Git worktrees
```

without invalidating existing durable executions, reviews, delivery evidence, or crash recovery.

## 2. Production feature gates

Current GCP production policy:

```text
MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED=true
MODEL_CP_V4_LITERAL_WORKTREES_ENABLED=true
MODEL_CP_V4_LITERAL_WORKTREE_PROJECTS=bodysense
MODEL_CP_V4_MAX_PARALLEL_WORK_ITEMS=2
```

The single-active constraint is **per `projectKey`**, not global. Each automated project may own one active root Plan while later root Plans for that same project remain durably queued. Internal child/recovery Plans remain in the owning root Plan family.

Literal worktrees are currently scoped to BodySense. MemoFlow and Digital Biome continue using their existing workspace provider until separately admitted; enabling the global literal-worktree gate does not implicitly migrate those projects.

The production rollout completed on 2026-09-05 after:

```text
queue/single-active canary
-> literal worktree implementation/review/integration smoke
-> exact BodySense recovery review and verified delivery
-> zero non-terminal legacy BodySense Plans
-> production gates enabled
```

Legacy execution workspaces are still recoverable and are never converted in place.

## 3. Do not convert in-flight workspaces

Legacy clone execution:

```text
workspaceKind=LEGACY_CLONE
```

remains on its existing path and recovery logic until terminal.

Never turn an existing clone into a linked worktree in place.

## 4. Repository preflight

Before enabling literal worktrees for a project:

- canonical repository path resolves inside allowlisted project roots;
- canonical working tree is clean or its state is explicitly accepted as human-owned baseline;
- Git common directory is local and valid;
- no unexpected alternates/redirections;
- worktree list is readable and structurally valid;
- active Pixel legacy writer count for project is zero;
- current Git version/capabilities recorded;
- OpenHands mount topology can resolve both worktree and common Git administrative paths;
- Agent UID can perform the permitted Git operations on a disposable plan branch;
- protected-ref baseline can be captured.

Preflight failure keeps the project on legacy clone mode; do not partially enable worktrees.

## 5. OpenHands production-shaped smoke

Before cutover, create a disposable local fixture and prove from the real OpenHands container/UID:

1. Controller creates integration and WorkItem worktrees.
2. Agent-visible path resolves correct worktree top-level/common dir.
3. `git status` works.
4. Agent edits fixture and runs verification.
5. Agent commits only to plan-scoped branch.
6. Controller observes exact SHA.
7. Canonical checkout HEAD/index/files remain unchanged.
8. Protected refs remain unchanged.
9. Review detached worktree opens exact SHA and is clean.
10. Controller removes all worktrees and `git worktree list --porcelain` has no residue.

This gate is mandatory in `release-v4-gcp.sh` before enabling normal production worktrees.

## 6. Recovery operations

### Stale worktree metadata

Controller may run:

```text
git worktree prune --expire=now
```

only when:

- no durable worktree record points to the pruned path;
- no provider session uses it;
- project active-plan lease is held by the current Controller or no active Plan exists.

### Orphan filesystem worktree

Do not immediately delete.

Classify:

```text
durable + Git registry match     -> recover
Git registry only                -> quarantine then reconcile
filesystem only                  -> inspect; remove only if Pixel-owned residue proven
conflicting durable identities   -> SAFETY_HOLD
```

### Protected ref drift

Do not automatically force-reset unless the expected old SHA and ownership are proven and policy explicitly permits it. Default behavior is safety hold and operator evidence.

## 7. Cleanup policy

Worktree cleanup is event-driven first, timer-driven second.

Immediate cleanup candidates:

- exact-SHA review worktree after durable review terminal state;
- WorkItem writer after accepted SHA is integrated and no repair/resume lease remains;
- delivery-repair worktree after repaired head is durably adopted;
- all remaining Plan worktrees after terminal root Plan cleanup.

Periodic reconciler cleans stale Pixel-owned administrative metadata, not active worktrees.

## 8. Dependency/cache policy

Worktrees share Git history, not dependency trees.

Use shared download/build caches where toolchains support them:

```text
pnpm store
npm cache
Go module cache
Go build cache
uv/pip wheel cache
Corepack
```

Keep project-local dependency trees in the WorkItem worktree when necessary:

```text
node_modules
.venv
build output
```

Same-WorkItem retry/fix worktree reuse preserves those local caches and is preferred over recreation.

Disk-pressure cleanup may remove only known ignored cache paths from quiescent/terminal worktrees; never delete `.git` administrative files or tracked project data.

## 9. Git maintenance

Do not run `git gc` per Plan.

Common object maintenance is a project-level operation and requires:

```text
no active root Plan
queue activation paused
no Pixel worktrees
protected refs captured
fsck baseline
maintenance
fsck after
```

This is an operational maintenance action, not Worker behavior.

## 10. Rollback

Rollback conditions include:

- OpenHands cannot reliably resolve linked worktree Git metadata;
- Agent UID permissions require unsafe broad host access;
- protected-ref drift cannot be reliably detected;
- repeated worktree corruption/residue;
- crash recovery cannot prove single writer ownership.

Rollback sequence:

```text
stop activating new worktree Plans
-> finish/cancel active root Plan safely
-> clean Plan worktrees
-> set MODEL_CP_V4_LITERAL_WORKTREES_ENABLED=false
-> keep MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED=true
-> use legacy clone workspace provider for subsequent Plan
```

The queue/single-active-plan model should remain even if worktree mechanics are rolled back; it is independently useful for correctness.

## 11. Spot-safe release publication

`gcp-dev-01` is a Spot/preemptible VM, so a release must assume power loss can occur between any two filesystem writes. The canonical release path therefore never compiles into the live `model-control-plane/dist` directory.

`release-v4-gcp.sh` now performs:

```text
flock single-release lock
-> require canonical clean source SHA
-> git core.fsync=committed
-> build into ignored .release-candidates/<sha>-<pid>
-> validate non-empty entrypoint
-> run literal-worktree production smoke against candidate dist
-> flush candidate files
-> atomically exchange candidate and live dist with renameat2(RENAME_EXCHANGE)
-> verify a path-independent relative artifact manifest
-> install/reload systemd unit
-> restart and verify V4 health/resources
```

The atomic exchange is regression-tested with two real directories. If the VM is preempted before exchange, the old live `dist` remains intact. If it is preempted after exchange, the new complete `dist` is already the live directory. A partially written candidate is ignored and removed by the next single-owner release.

Git repository integrity is also treated as part of release safety. `core.fsync=committed` is enforced locally on the canonical Pixel checkout, and post-incident validation uses `git fsck --full` plus a zero-length loose-object check before accepting a repaired repository.

## 12. Runtime admission after rollout

A statically ACTIVE resource is not executable until its execution-shaped runtime probe is READY. OpenHands startup failures and `RUNTIME_PROBE_TRANSPORT_ERROR` use a short transient negative-cache TTL so recovered relays are re-tested on subsequent resource-refresh cycles rather than remaining blocked by the normal admission TTL.

Reviewer scarcity is therefore a normal fail-closed state: when `reviewReady=0`, implementation/review automation waits for an admitted reasoning resource. Production gate enablement never relaxes exact-SHA review requirements.
