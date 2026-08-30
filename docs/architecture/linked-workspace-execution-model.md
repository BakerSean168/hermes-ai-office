# Linked Workspace Execution Model

Date: 2026-08-30
Status: TARGET ARCHITECTURE

## Ownership map

```text
/home/dev/projects/<project>                 canonical project repository
  ├── working tree                           human/deployment control surface
  └── .git/objects                           authoritative pre-existing object store
          ^
          | local hardlinks, read-only from worker perspective
          |
/opt/data/hermes-ai-office-v3/workspaces/executions/<execution>/repo
  ├── working tree                           execution-private, worker writable/read-only by phase
  ├── .git/HEAD/index/refs/config             execution-private
  └── .git/objects
      ├── pre-existing objects                hardlinked to canonical, source-owned, worker-readable
      └── new execution objects               execution-owned

Control Plane only:
canonical repo
  -> temporary detached integration worktree
  -> fetch execution HEADs
  -> merge
  -> durable refs/ai-office/plans/.../batches/...
  -> remove temporary worktree
```

## Why not expose canonical worktrees to OpenHands directly?

A Git linked worktree stores its private administrative files under the canonical repository's common Git directory. The OpenHands container currently sees `/workspace` only. Mounting canonical `.git` read-write into the model container would let worker commands influence shared refs and maintenance state. The linked-clone boundary retains private Git metadata while sharing only immutable object bytes.

## Provisioning invariants

### Source resolution

1. Resolve `repositoryPath` to its top-level Git root as the source owner.
2. Validate the root against `MODEL_CP_V3_REPOSITORY_ROOTS`.
3. Resolve the requested base revision before creating the execution directory.

### Object sharing preparation

When an execution owner is configured:

1. identify the source common Git object directory;
2. refuse hardlink sharing when the source repository/object inode is already owned by the execution UID; such repositories fall back to a private `--no-hardlinks` clone;
3. configure `core.sharedRepository=0640`, which keeps future Git object files group-readable but group-not-writable even under production `UMask=0077`;
4. before every linked clone, reassert the canonical object tree's group to the execution GID and group-readable/traversable modes; this is the authoritative step because newly-created Git objects may temporarily retain the source owner's primary group;
5. enable setgid on object directories as an inheritance aid, but do not rely on it as the sole future-object guarantee;
6. never transfer shared source object-file ownership to the execution user.

This grants read access to history already in scope for the execution without granting canonical ref/index ownership.

### Execution clone

1. clone directly into the execution workspace with `git clone --local --no-checkout`;
2. checkout the required branch/detached revision;
3. for review, set `refs/ai-office/review-base` and overlay Git-visible working-tree state;
4. transfer execution-private files/directories to the execution identity;
5. leave hardlinked shared object files source-owned;
6. apply writer/read-only permissions without chmod'ing shared object files.

### Cleanup

Removing an execution directory unlinks its hardlinks only. Canonical object files survive because they retain the canonical directory link. Old pack blocks can be reclaimed after all linked clones referencing them are removed.

## Batch integration invariants

1. The integration worktree is host-controlled and never mounted as a model workspace.
2. It starts detached from the exact batch base revision.
3. Each implementation workspace must be clean and its HEAD must advance beyond its source revision.
4. Required ancestor revisions are verified in the implementation workspace before import.
5. Fetch uses the exact implementation HEAD and imports only objects missing from canonical.
6. Merge order matches the existing batch implementation order.
7. Conflicts remain `BATCH_INTEGRATION_CONFLICT:*` with actionable Git evidence.
8. On success, the exact integrated HEAD is stored under the existing durable integration ref.
9. The canonical source working tree HEAD/index/files never change.
10. The temporary integration worktree is removed in `finally`, including conflict cases.

## Retention interaction

A nonterminal Plan does **not** imply every historical work-item workspace remains recoverable forever. Once a batch reaches `SUCCEEDED` or `CANCELLED`, its durable integrated revision/ref becomes the recovery boundary and historical implementation/repair clones from that batch may expire normally. Active/blocked batches continue to protect the latest successful implementation artifact per work item, and causal workspace leases still dominate cleanup.

Terminal execution `.agent-harness` state is execution-scoped and may be removed while a protected repository workspace remains available for repair/review continuity.

Linked clones dramatically reduce the baseline cost of retaining a recoverable implementation workspace, but retention remains necessary for:

- node_modules/build caches;
- Agent Harness state;
- new execution-local Git objects;
- old review/failed execution directories.

A later capacity-hardening ticket should add a disk-free-space trigger in addition to the timer-based GC.

## Cross-host future

If Pixel later runs writers on multiple machines, direct local object sharing is no longer sufficient. At that point introduce a repository cache/mirror on each execution host or a fetch-based remote cache. Do not add that authority on the current single-host system before it is required.
