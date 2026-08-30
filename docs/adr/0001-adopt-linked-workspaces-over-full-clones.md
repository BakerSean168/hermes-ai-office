# ADR-0001: Adopt Linked Workspaces Over Full-History Execution Clones

Date: 2026-08-30
Status: ACCEPTED

## Context

Pixel V3 needs concurrent mutable writers, independent read-oriented review, durable repair/retry lineage, and a source repository that is not mutated by model workers.

The current implementation obtains isolation by physically cloning the repository for every execution with `--no-hardlinks`. In MemoFlow this made each otherwise-small execution consume roughly 3 GiB before dependencies, and repeated batch integration inflated the canonical Git object store with overlapping packs.

A literal `git worktree` is the most natural Git mechanism when all processes share one host namespace. However OpenHands runs in a long-lived container that currently mounts only `/workspace`, not `/home/dev/projects`. A linked worktree's `.git` file points back to the canonical common Git directory. Exposing that directory read-write to model processes would let them mutate canonical refs/object maintenance state and would weaken the existing source trust boundary, especially for external-change plans.

## Decision

Adopt a two-layer linked-workspace model.

### 1. Agent execution workspaces

Use a local linked clone:

```text
git clone --local --no-checkout <canonical> <execution>
```

Do **not** use `--no-hardlinks`.

Existing source Git objects are physically shared through hardlinks. The execution receives its own:

- HEAD/index/refs/config;
- working tree;
- new objects created by the worker;
- a control-plane-durable writer start revision; workers do not own the authoritative completion baseline.

The source object's owner remains unchanged. Runtime provisioning is read-only with respect to canonical Git object metadata: hardlink sharing is enabled only when the common Git/object directories, inode ownership, permissions, link counts, and filesystem boundary already pass a fail-closed inspection. If any canonical object is unreadable by the execution identity, writable by it, externally linked, redirected, special, or otherwise unsafe, provisioning uses a private `--no-local` clone. A repository may be prepared for sharing only during an explicit quiescent maintenance boundary with no active source writer; runtime provisioning never repairs canonical permissions in place. Execution-private directories and metadata are owned by the execution identity.

Review snapshots remain execution-private linked clones and become physically read-only after snapshot overlay. Object files created by the implementation identity are privatized before review; safe canonical history may remain linked. Tracked symlinks that escape the execution root are rejected rather than merely protected from chown/chmod. This preserves independent review without copying immutable history or exposing host-visible sibling paths.


Workspace publication follows the same privilege rule: the per-execution directory remains service-owned/inaccessible while root performs any recursive privatization, ownership, or mode normalization. Only after those operations finish is the directory itself chowned/chmodded to the execution identity. That ownership transition is the publication point; no privileged recursive pathname traversal may occur afterward.

Provisioning stages execution clones in a service-private sibling of the configured workspace root rather than `/tmp`. This preserves local hardlink semantics under the production `PrivateTmp=true` mount namespace. `--local` is permitted only when the inspected source object directory and staging directory are device-compatible; otherwise the private `--no-local` fallback is used. The root linked-clone staging root and disposable trust config remain root-owned; a source-owned staging child exists only for a clone that deliberately runs as the source identity.

### 1b. Crash-safe execution-host launch

Persist execution-host launch ownership in the control-plane database. `host_launch_token` and `host_launch_claimed_at` are additive nullable columns on execution links. A launch token is a short-lived lease, not a host identifier. The control plane must recover the host by durable `executionId` before issuing a create, atomically claim the right to create, re-check after claiming, CAS-renew that same token immediately before the external POST, and attach the returned host conversation only while that token still owns the claim. The post-recovery renewal fences a slow/stale owner that lost its claim while scanning the host; the refreshed lease exceeds the bounded host-create timeout.

OpenHands recovery uses the execution tag already written on every conversation. The search is ordered by creation time and bounded by the durable execution creation boundary; duplicate matches are an error rather than a best-effort choice. This closes both multi-process races and the post-success/pre-database-attach crash window without making the execution workspace itself the coordination authority. A recovery that runs after a launch claim exists must attach with that exact token; tokenless attachment is permitted only while no launch claim exists, so a delayed superseded recovery cannot clear a newer owner's lease.

### 1c. Crash-safe workspace provisioning

Workspace creation is also a cross-process durable lease. `workspace_provision_token` and `workspace_provision_claimed_at` are additive nullable execution-link columns. Before cloning/reusing an execution workspace, the service atomically claims provisioning ownership. Filesystem publication calls back into the control plane to CAS-renew the same token immediately before the shared execution path is created/replaced and again before the finalized directory is exposed to the worker. Only the token owner may attach `workspace_ref` or durably fail provisioning. A stale loser therefore cannot delete a newer workspace, publish after takeover, or mark the winner failed. Generic provision failure paths never recursively delete the shared execution directory.

### 2. Host-controlled batch integration

Replace bundle/full-clone integration with a temporary detached `git worktree` owned by the control plane:

```text
canonical repository
  -> temporary detached integration worktree at batch base
  -> fetch exact implementation HEAD from each execution workspace
  -> merge in order
  -> update durable refs/ai-office/plans/<plan>/batches/<batch>
  -> remove temporary integration worktree
```

The model never receives this integration worktree, so sharing the canonical common Git directory does not widen the model trust boundary.


Before creating the host worktree or updating a durable integration ref, the canonical repository must pass the full Git-object trust check: the resolved top-level/common Git/object directories stay in the configured repository boundary, object alternates and descendant symlinks/special/cross-device entries are rejected, and implementation source revisions are resolved and proven ancestors of the exact imported HEAD. Unsafe plan/batch ref components are injectively UTF-8 hex encoded while the existing spelling for normal durable identifiers is preserved.

Implementation workspaces are worker-controlled repositories. Host integration therefore treats their Git configuration as untrusted input: Git inspection/export runs under the execution identity with a minimal environment and fsmonitor/hooks/pager disabled by command-line configuration. Bundle bytes travel over stdout only; the privileged parent streams them into a source-owned descriptor created with exclusive/no-follow flags inside the trusted integration directory. There is no worker-owned bundle pathname and no privileged `chown(path)` handoff. Canonical fetch/merge/ref updates remain source-owner operations. Production also fails closed if the configured execution UID equals the canonical repository owner UID, because that topology would collapse the intended handoff boundary.

### 3. Work-item reuse

Keep existing `IMPLEMENT_FIX` workspace reuse. A later ticket will extend reuse to transport/backend retry attempts of the same work item after characterizing dirty/partial writer states. This is intentionally not coupled to the storage fix.

## Rejected alternatives

### Dedicated Pixel bare-repository mirror per project

Rejected for the current single-host topology. It adds synchronization and another repository authority when the original project repository is already local. Revisit only for cross-host execution or stronger zero-trust isolation.

### Literal canonical worktree for every OpenHands worker

Deferred. It is storage-efficient but would require exposing canonical Git common metadata inside the current OpenHands container or redesigning execution containers/mount namespaces. That is a larger trust-boundary change than needed to remove the current disk amplification.

### Continue full clones and rely on GC

Rejected. Retention cannot compensate for multiple 3–6 GiB workspaces created faster than GC, and it does not address duplicate canonical packs.

## Protected contracts

The migration must preserve:

- canonical working tree is not modified by execution/review/integration;
- existing `WorkspaceProvisioningPort` call sites and execution workspace refs;
- writer completion requires a clean committed advance from the durable baseline;
- review snapshots freeze Git-visible tracked/untracked/deleted state but exclude ignored caches;
- review snapshots are physically read-only to the worker;
- batch integration order, conflict classification, required-ancestor verification, and durable integration refs;
- external handoff/progress discovery;
- active-plan recovery and existing execution workspace compatibility during rollout;
- OpenHands `/workspace/executions/<id>/repo` contract.

## Consequences

Positive:

- immutable Git history consumes approximately one physical copy per canonical repository rather than one per execution;
- batch integration stops feeding full-history bundles back into canonical Git;
- no new Pixel repository mirror/object-pool authority;
- canonical source working tree remains untouched;
- OpenHands model processes still cannot mutate canonical refs/index through their workspace path.

Costs:

- canonical object sharing requires a per-provision read-only inode/permission/link-count inspection; repositories that are not pre-prepared at a quiescent maintenance boundary pay the cost of a private clone;
- cleanup code must distinguish shared hardlinked object files from execution-private files;
- old full-clone workspaces remain valid until retention removes them;
- Git GC/repack of canonical repositories must be coordinated with active linked clones because hardlinked old pack inodes remain alive until the clone disappears.

## Rollback

Provisioning remains behind `WorkspaceProvisioningPort`. If linked clone provisioning fails in production, revert the provisioner implementation to the previous full-clone path without changing durable plan data or API contracts. Existing linked execution clones are ordinary standalone repositories and remain readable after rollback.
