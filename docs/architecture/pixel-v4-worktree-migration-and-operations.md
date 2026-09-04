# Pixel V4 Worktree Migration and Operations

Date: 2026-09-04
Status: TARGET MIGRATION / OPERATIONS GUIDE

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

## 2. Feature gates

Introduce explicit gates:

```text
MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED=false
MODEL_CP_V4_WORKTREE_WORKSPACES_ENABLED=false
MODEL_CP_V4_WORKTREE_OPENHANDS_IDENTITY_MOUNT_REQUIRED=true
MODEL_CP_V4_WORKTREE_MAX_PARALLEL_WRITERS=<N>
```

Recommended rollout:

```text
queue gate first
-> worktree mechanics in shadow/fixture
-> one project canary
-> all new root Plans
-> retire legacy clone provisioning only after no old writer depends on it
```

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
-> disable WORKTREE_WORKSPACES
-> keep SINGLE_ACTIVE_PLAN queue semantics
-> use legacy clone workspace provider for subsequent Plan
```

The queue/single-active-plan model should remain even if worktree mechanics are rolled back; it is independently useful for correctness.
