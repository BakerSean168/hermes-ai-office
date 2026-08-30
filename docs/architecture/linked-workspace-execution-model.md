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

1. resolve the real source common Git directory and object directory and require both to remain inside the real repository root; terminal symlinks, alternates, special files, cross-device object trees, and out-of-bound common Git directories disable hardlink sharing;
2. inspect object-file ownership, mode, link count, and device before changing metadata; never recursively `chgrp/chmod` an unverified object tree;
3. if the execution identity can write any canonical object, or an unreadable object already has another hardlink, fail closed to a private `--no-local` clone;
4. an unreadable object may receive execution-group read permission only when its inode is unique to the canonical object tree; object directories may receive group traversal after the no-symlink/no-cross-device inspection because directories cannot be hardlinked;
5. future objects created under a restrictive umask are re-inspected and normalized on the next provisioning pass instead of persisting a repository-wide `core.sharedRepository` mutation;
6. for implementation-to-review cloning where source and execution UID match, retain only already-readable/non-writable foreign-owned history as hardlinks and break links for owner-mutable or otherwise unsafe execution-created objects;
7. never transfer safely shared source object-file ownership or write permission to the execution user.

This grants read access to history already in scope for the execution without granting canonical ref/index ownership or mutating metadata on an inode that may be linked outside the repository.

### Execution clone

1. stage a `git clone --local --no-checkout` only when the inspected object tree is safe to share; otherwise use a physically private `git clone --no-local --no-checkout`;
2. checkout the required branch/detached revision;
3. for review cloned from an OpenHands-owned implementation workspace, have the root control plane create the local hardlinks from a service-private staging directory using a disposable protected Git config that trusts only the already-validated source path; retain hardlinks for pre-existing source-owned canonical objects but break hardlinks only for object files actually owned by the execution identity (normally the implementation's new loose objects/pack);
4. atomically rename the staged clone into the execution workspace when staging/workspace share a filesystem; cross-filesystem roots fall back to a private clone/copy;
5. for review, set `refs/ai-office/review-base` and overlay Git-visible working-tree state; reject absolute or relative symlinks whose lexical or resolved targets escape the staged workspace while preserving contained relative links;
6. atomically publish only a real managed directory; retry/resume paths with a durable `workspaceRef` revalidate `lstat`, `realpath`, Git top-level/common-dir identity, a regular-file/directory-only no-symlink/no-alternates private `.git` tree, and contained working-tree symlinks; if `provision()` finds a directory for an execution whose durable record still has no `workspaceRef`, that directory is treated as crash residue and is validated then recreated from the requested repository/base/mode rather than silently reused;
7. transfer execution-private files/directories and privatized object copies to the execution identity;
8. leave safely shared hardlinked object files source-owned;
9. apply writer/read-only permissions without chmod'ing shared object files; execution IDs must use the collision-free durable ID alphabet rather than lossy path sanitization.

### Cleanup

Removing an execution directory unlinks its hardlinks only. Canonical object files survive because they retain the canonical directory link. Old pack blocks can be reclaimed after all linked clones referencing them are removed.


### Durable repository identity

Every newly provisioned execution records the real canonical `repositoryRoot` alongside its durable `workspaceRef`, source revision, and Git branch. Continuation/fix reuse carries that provenance forward. Batch integration accepts an implementation only when its durable repository root realpath equals the target canonical root and its recorded source revision resolves to the same commit in the target object database. This identity is control-plane-owned; worker-editable remotes or `.git/config` are not repository authority. Existing SQLite databases add the nullable `repository_root` column in place, but a legacy execution with a null provenance value is not eligible for a new batch integration. It fails closed as `BATCH_INTEGRATION_EVIDENCE_MISSING`; deployment must therefore occur only after any in-flight legacy batch has reached a durable integrated boundary or has been safely re-executed under the new provisioner.

## Batch integration invariants

1. The integration worktree is host-controlled and never mounted as a model workspace; the resolved canonical Git top-level must remain inside the configured real repository roots before any worktree/ref mutation.
2. Canonical common-Git/object metadata must pass the full object trust-boundary check before integration: no external common dir, object alternates, descendant symlinks, special files, or cross-device object entries.
3. It starts detached from the exact batch base revision.
4. Each implementation workspace must be clean, its source revision must resolve to a commit, and that source revision must be an ancestor of the exact implementation HEAD.
5. Required ancestor revisions are verified in the implementation workspace before import.
6. The implementation bundle excludes the validated source ancestry; after fetch, `FETCH_HEAD` must equal the intended implementation HEAD exactly before merge.
7. Merge order matches the existing batch implementation order.
8. Conflicts remain `BATCH_INTEGRATION_CONFLICT:*` with actionable Git evidence.
9. On success, the exact integrated HEAD is stored under a collision-free durable integration ref: existing safe plan/batch identifiers keep their historical ref spelling, while unsafe components are injectively UTF-8 hex encoded.
10. The canonical source working tree HEAD/index/files never change.
11. The temporary integration worktree is removed in `finally`, including conflict cases.

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
