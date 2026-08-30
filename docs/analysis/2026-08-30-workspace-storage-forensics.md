# Pixel Workspace Storage Forensics

Date: 2026-08-30
Status: VERIFIED
Scope: GCP Dev execution plane, MemoFlow workload

## Executive finding

The disk exhaustion was not caused primarily by Git branch count or project source size. It was caused by an execution-storage amplification loop:

1. MemoFlow's canonical `.git` object database had grown to about 3 GiB even though the checked-out product source was only about 595 MiB excluding `.git` and `.nx`.
2. Each Pixel execution used `git clone --local --no-hardlinks`, physically copying the full Git object database into an isolated execution workspace.
3. Some writer workspaces then installed another ~2.1 GiB of `node_modules`.
4. Batch integration created `bundle --all`, cloned that bundle, then bundled the integrated HEAD and fetched it back into the canonical repository.
5. Repeated integration produced many highly overlapping ~118 MiB pack files in the canonical object store.
6. The larger canonical object store was then copied into every subsequent execution workspace, creating a positive feedback loop.

The remedy is to preserve workspace isolation without copying immutable Git history.

## Measured evidence

### Host capacity during incident

- root filesystem: 145 GiB
- observed peak: 139 GiB used / 5.5 GiB free / 97%
- after safe Docker image cleanup and retention: temporarily 16–19 GiB free before new execution workspaces grew again

### Project/worktree footprint

MemoFlow had 11 registered Git worktrees. After inode-level deduplication:

- all MemoFlow worktrees: ~11 GiB
- worktrees excluding the canonical `.git`: ~7.6 GiB
- all worktree `node_modules` unique blocks: ~3.9 GiB
- `.git/worktrees` metadata: ~7.6 MiB
- `.git/refs`: ~348 KiB

Therefore the number of branches/worktree metadata was not the primary storage problem. Materialized dependencies contributed several GiB, but not tens of GiB.

### Execution workspace footprint

`/opt/data/hermes-ai-office-v3/workspaces` reached roughly 57 GiB, with ~55 GiB under `executions/` and 131 execution directories observed.

Representative MemoFlow execution workspaces:

- implementation workspace: ~3.0 GiB total, ~2.8 GiB `.git`
- aggregate-review workspace: ~3.1 GiB total, ~2.9 GiB `.git`
- writer with dependencies: ~5.7 GiB total = ~2.9 GiB `.git` + ~2.1 GiB `node_modules` + ~0.38 GiB Agent Harness state

The product source under `apps/` + `packages/` was only on the order of 100–200 MiB in those workspaces.

### Canonical Git object amplification

MemoFlow canonical repository evidence:

- tracked files: ~5,611
- reachable Git objects: ~138,912
- packed object entries reported by `git count-objects -v`: ~3,298,978
- pack files: 29
- pack storage: ~2.9 GiB

Two recent ~118 MiB packs contained 138,153 and 138,105 object IDs respectively. Every object in the smaller pack also appeared in the larger pack: 100% overlap relative to the smaller set.

This proves that repeated integration imported highly redundant object packs instead of only new objects.

## Root causes

### RC-1 — Physical full-history execution clones

Current provisioning used:

```text
git clone --local --no-hardlinks <canonical> <execution>
```

`--no-hardlinks` intentionally defeats local object sharing. It preserved isolation, but multiplied immutable history by the number of executions.

### RC-2 — Full-history bundle integration

Current batch integration performed the equivalent of:

```text
git bundle create source.bundle --all
git clone --no-hardlinks source.bundle integrationRepo
...
git bundle create integrated.bundle HEAD
git fetch integrated.bundle +HEAD:<durable-ref>
```

This repeatedly repackaged the same reachable history and imported overlapping packs back into the canonical repository.

### RC-3 — Retention preserves heavy Git repositories

Retention correctly protects recoverable plan state, but `pruneExecutionArtifacts()` only runs `git clean -ffdX`. That removes ignored dependencies/build caches but leaves the execution `.git`, which was often ~3 GiB by itself.

### RC-4 — Dependency materialization

Some workspaces install ~2 GiB of `node_modules`. pnpm's store/hardlink behavior means host-level deduplicated usage is lower than apparent directory totals, but execution-local materialization still adds meaningful pressure.

### RC-5 — Docker/OpenHands growth

Docker/containerd consumed a second major share of the disk. The `hermes-openhands-v3` writable layer alone was observed around 13.7 GiB before cleanup. This is a separate capacity concern, but it amplified the workspace incident rather than causing the Git duplication itself.

## Verified safe sharing prototype

A production-shaped prototype was run using the real OpenHands UID/GID and the real `/workspace` bind mount:

1. canonical repository objects remained source-owned;
2. canonical object files were group-readable by the OpenHands execution GID;
3. `git clone --local --no-checkout` created hardlinks to existing canonical pack files;
4. execution working tree and private Git metadata were transferred to OpenHands ownership while shared object files were not chowned;
5. the same pack inode appeared in source and execution clone with link count 2;
6. inside `hermes-openhands-v3`, the OpenHands user successfully ran `git status`, modified a file, `git add`, and committed;
7. canonical HEAD and working tree remained unchanged.

This validates physical object sharing without exposing canonical refs/index for model mutation.

## Implications

The right invariant is not “one full repository per execution.” It is:

> Each concurrent writer gets an isolated working tree and private mutable Git metadata; immutable pre-existing Git objects are shared physically whenever the host filesystem permits it.

For host-controlled integration, the control plane can use a real temporary Git worktree directly because no model process receives the canonical Git common directory.

For OpenHands execution, a literal linked worktree would require exposing canonical `.git` metadata into the long-lived container. That would broaden the trust boundary and is therefore not the first migration step. A linked local clone with hardlinked objects provides the same storage benefit while retaining private refs/index/new objects.
