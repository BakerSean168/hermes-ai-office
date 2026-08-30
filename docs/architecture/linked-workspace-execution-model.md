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
2. inspect object-file ownership, mode, link count, device, readability, writability, and directory traversal without changing canonical metadata;
3. if the execution identity can write any canonical object, cannot read/traverse any required object entry, or the object tree is otherwise unsafe, fail closed to a private `--no-local` clone;
4. runtime provisioning never `chown`, `chgrp`, `chmod`, set ACLs, or rewrite repository config under the canonical object store;
5. repository sharing permissions are prepared only during an explicit quiescent maintenance boundary with no active source writer, then verified before workers resume; future objects must inherit the prepared group/mode policy rather than being repaired by request-time provisioning;
6. for implementation-to-review cloning where source and execution UID match, retain only already-readable/non-writable foreign-owned history as hardlinks and break links for owner-mutable or otherwise unsafe execution-created objects;
7. never transfer safely shared source object-file ownership or write permission to the execution user.

This grants read access to history already in scope for the execution without granting canonical ref/index ownership, and removes canonical object metadata mutation from the runtime request path.

### Execution clone

1. stage a `git clone --local --no-checkout` only when the inspected object tree is safe to share; otherwise use a physically private `git clone --no-local --no-checkout`;
2. checkout the required branch/detached revision;
3. for review cloned from an OpenHands-owned implementation workspace, have the root control plane create the local hardlinks from a service-private staging directory using a disposable protected Git config that trusts only the already-validated source path; retain hardlinks for pre-existing source-owned canonical objects but break hardlinks only for object files actually owned by the execution identity (normally the implementation's new loose objects/pack);
4. atomically rename the staged clone into the execution workspace when staging/workspace share a filesystem; cross-filesystem roots fall back to a private clone/copy;
5. for review, set `refs/ai-office/review-base` and overlay Git-visible working-tree state; reject absolute or relative symlinks whose lexical or resolved targets escape the staged workspace while preserving contained relative links;
6. atomically publish only a real managed directory; retry/resume paths with a durable `workspaceRef` revalidate `lstat`, `realpath`, Git top-level/common-dir identity, a regular-file/directory-only no-symlink/no-alternates private `.git` tree, and contained working-tree symlinks; if `provision()` finds a directory for an execution whose durable record still has no `workspaceRef`, that directory is treated as crash residue and is validated then recreated from the requested repository/base/mode rather than silently reused; privileged recursive object privatization, repository ownership normalization, and writer/read-only mode normalization all finish while the per-execution parent directory is still service-owned and inaccessible to the execution identity; transferring that parent directory to the worker is the final publication step, after which provisioning performs no privileged recursive pathname operation.
7. transfer execution-private files/directories and privatized object copies to the execution identity;
8. leave safely shared hardlinked object files source-owned;
9. apply writer/read-only permissions without chmod'ing shared object files; execution IDs must use the collision-free durable ID alphabet rather than lossy path sanitization.

Execution clone staging is service-private and lives beside the configured workspace root, not under `os.tmpdir()`. The production systemd unit uses `PrivateTmp=true`; staging under `/tmp` crosses that private mount namespace and can make an otherwise valid local hardlink clone fail with `EXDEV`. The provisioner also verifies source-object/staging device compatibility before enabling `--local`; an incompatible source safely uses `--no-local`. For a root-performed linked clone the staging root and disposable Git trust config remain root-owned; source-owner write access is granted only to a dedicated child used by the private-clone fallback.

### Durable workspace provisioning ownership

Workspace publication is coordinated in SQLite as well as by the in-process execution mutex. Every unattached execution workspace has at most one current `workspace_provision_token`. A process must win that claim before provisioning, and the workspace layer receives a publication fence that CAS-renews the same token before deleting proven crash residue, before placing the shared execution path, and before exposing the finalized directory to the worker. `attachWorkspace()` clears the claim only when the same token still owns it; provisioning failure can transition to `FAILED` only under the same token. If ownership changed, the stale process returns the newer durable record and may not delete or fail the winner.

The filesystem side mirrors the durable fence: a generic staging/publish error cleans only service-private staging. It never recursively removes the shared execution directory. Existing unattached workspace residue may be removed only after the current token successfully renews, which prevents a superseded service instance from deleting an artifact published by a newer owner.

### Durable host launch ownership

Workspace isolation is insufficient if two host conversations can be launched for one durable execution. Host launch therefore uses a SQLite-backed claim, not only an in-process mutex:

1. before any external launch, recover the execution host by durable `executionId`; OpenHands recovery scans conversations by the existing execution tag and fails closed if more than one match exists;
2. if no host execution exists, atomically acquire `host_launch_token` / `host_launch_claimed_at` while `status_cache=STARTING`; only the token owner may issue `createExecution`;
3. re-scan the host after winning the claim so a stale previous launch that became visible during the CAS window is adopted instead of duplicated;
4. after that potentially slow recovery scan, CAS-renew the same token immediately before POST. This is the launch fence: if another process took over while the scan was in flight, renewal fails and the superseded owner cannot create; the refreshed lease exceeds the bounded host-create timeout;
5. after a successful create, attach the conversation only when the same launch token still owns the durable claim; attach clears the claim atomically;
6. if the service crashes after host creation but before attach, restart/reconcile searches by `executionId`, adopts the single existing conversation, and clears the claim without another POST;
7. a fresh claim owned by another process returns durable `STARTING` and suppresses launch; only after the claim exceeds the bounded host-request recovery interval may another process CAS-take it, re-scan, and fail it retryably when the host still proves no execution exists.

Antigravity already has deterministic execution-local state and implements the same recovery contract. Routed execution hosts recover through the persisted backend selection, so recovery cannot silently switch execution host families.

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
7. Every Git command that inspects the worker-mutable implementation repository (`status`, `rev-parse`, `merge-base`) executes as the execution workspace owner with a minimal environment and command-line overrides disabling `core.fsmonitor`, hooks, and pagers. Bundle export runs under the same execution identity but writes only to stdout. The control plane streams that pipe into an `O_EXCL`/`O_NOFOLLOW` file descriptor opened in the source-owner integration directory, assigns ownership by descriptor before the worker starts, fsyncs it, and only then lets the canonical source owner fetch it. The worker never owns or receives the canonical-side bundle pathname or file descriptor.
8. Merge order matches the existing batch implementation order.
9. Conflicts remain `BATCH_INTEGRATION_CONFLICT:*` with actionable Git evidence.
10. On success, the exact integrated HEAD is stored under a collision-free durable integration ref: existing safe plan/batch identifiers keep their historical ref spelling, while unsafe components are injectively UTF-8 hex encoded.
11. The canonical source working tree HEAD/index/files never change.
12. The temporary integration worktree is removed in `finally`, including conflict cases.

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
