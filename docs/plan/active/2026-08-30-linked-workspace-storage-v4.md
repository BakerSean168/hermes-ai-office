# Pixel V3 Linked Workspace Storage Refactor

Date: 2026-08-30
Status: IMPLEMENTED / DEPLOYMENT GATED
Baseline: `a89ca77bf33616e401837d0d955070a3e4759b9d`
Branch: `refactor/workspace-storage-v4-20260830`
Worktree: `/home/dev/projects/pixel-agents-workspace-storage-v4`

## Executive decision

Replace full-history execution copies with storage-linked execution repositories and replace full-bundle batch integration with a host-only temporary Git worktree.

Do not introduce a second Pixel-owned project repository authority. The original project repository remains authoritative. Preserve the model trust boundary by keeping execution refs/index/new objects private instead of mounting canonical `.git` read-write into OpenHands.

## Current-system evidence

Verified on GCP Dev before implementation:

- MemoFlow canonical `.git`: ~3 GiB, mostly pack data.
- reachable objects: ~138.9k; packed entries including duplicates: ~3.3M.
- two recent ~118 MiB packs had 100% object-ID overlap relative to the smaller pack.
- execution workspace examples: ~3.0–3.1 GiB with ~2.8–2.9 GiB `.git` before dependencies.
- one active workspace: ~5.7 GiB including ~2.1 GiB `node_modules`.
- 131 execution directories and ~55 GiB under `workspaces/executions` were observed.
- the real OpenHands container mounts `/opt/data/hermes-ai-office-v3/workspaces` at `/workspace`; it does not mount `/home/dev/projects`.
- a real UID/GID prototype proved a local hardlink clone can be committed by OpenHands while canonical HEAD/working tree remain unchanged.

Source: `docs/analysis/2026-08-30-workspace-storage-forensics.md`.

## Protected contracts

The refactor MUST preserve:

1. `/workspace/executions/<executionId>/repo` as the execution-visible workspace path.
2. canonical source working tree remains unchanged.
3. source repository path/root allowlist enforcement and Git dubious-ownership handling.
4. writer baseline and clean committed completion gates.
5. `IMPLEMENT_FIX` reuse semantics.
6. review snapshot semantics for tracked modifications, deletions, non-ignored untracked files, and ignored-cache exclusion.
7. physical read-only review workspace behavior.
8. exact batch base, merge order, required ancestor checks, conflict classification, and durable integration ref.
9. external progress/handoff behavior.
10. durable Plan/Execution SQLite schema, event names, API routes, delivery contracts, and current active plans.
11. existing full-clone workspaces remain readable during rolling migration.

## Non-goals

- no cross-host repository mirror/cache in this wave;
- no API/schema migration;
- no change to review verdict policy;
- no change to delivery/PR behavior;
- no broad Docker/OpenHands cache cleanup refactor;
- no automatic deletion of user-created Git worktrees;
- no immediate transport-retry workspace reuse until partial/dirty retry semantics are characterized.

## Target architecture

See `docs/architecture/linked-workspace-execution-model.md` and ADR-0001.

### Execution

```text
canonical .git/objects
      ^ hardlinks (same inode / no duplicate blocks)
      |
execution repo
  private working tree
  private HEAD/index/refs
  private new objects
```

### Integration

```text
canonical repo
  -> temporary detached git worktree at batch base
  -> fetch implementation HEADs
  -> merge in order
  -> update existing durable integration ref
  -> remove integration worktree
```

## Phase 0 — Characterize and guard

### WS-1001 — Record disk/object amplification evidence

**Goal:** Preserve measured root-cause evidence and architecture decision before changing mechanics.

**Implementation:**
1. Add forensic report.
2. Add ADR and target architecture.
3. Add this Active Plan.

**Acceptance:** documents contain measured evidence, trust-boundary tradeoff, rollback, and protected contracts.

### WS-1002 — Add storage-sharing characterization tests

**Goal:** Tests fail if execution provisioning returns to physical full-history object copies or batch integration mutates the source worktree.

**Implementation:**
1. Force a packed source test repository.
2. Provision an execution workspace.
3. Assert a pre-existing pack is hardlinked (same device+inode, link count >1) when local sharing is supported.
4. Commit a new execution change and assert source HEAD/working tree remain unchanged.
5. Extend integration tests to assert temporary integration worktree cleanup and no source checkout mutation.

**Acceptance:** focused workspace tests cover storage sharing and existing behavioral contracts.

## Phase 1 — Remove the largest storage amplifiers

### WS-1101 — Linked local execution clone

**Goal:** Stop physically copying immutable Git history into every execution.

**Scope:** `model-control-plane/src/v3/workspace.ts`, focused tests, deployment docs.

**Implementation:**
1. Resolve canonical common object directory.
2. For configured execution identity, prepare source object group-read access without changing source object ownership.
3. Clone directly with `git clone --local --no-checkout`; remove `--no-hardlinks` and the staging-copy path.
4. Checkout exact writer/review revision.
5. Preserve review overlay semantics.
6. Transfer only execution-private ownership/permissions; shared hardlinked object files remain source-owned.
7. Keep old workspace refs/path contract unchanged.

**Acceptance:**
- physical source object sharing proven by test;
- worker can commit new objects without moving canonical HEAD;
- review remains read-only;
- focused tests and typecheck pass.

**Rollback:** restore the previous staging `--no-hardlinks` clone implementation. Durable data does not change.

### WS-1102 — Host worktree batch integration

**Goal:** Eliminate `bundle --all` / full integration clone / integrated bundle feedback loop.

**Implementation:**
1. Create a detached temporary integration worktree from canonical at exact batch base.
2. For each implementation, verify clean HEAD and required ancestors exactly as today.
3. Fetch exact implementation HEAD into the integration worktree without persistent incoming refs.
4. Merge in existing order with the same identity and conflict classification.
5. Update the existing `refs/ai-office/plans/<plan>/batches/<batch>` directly to integrated HEAD.
6. Force-remove temporary integration worktree in `finally` and prune administrative residue.

**Acceptance:**
- same integration result/ref contract;
- source worktree unchanged;
- conflict/ancestor tests pass;
- no `bundle create --all` remains in batch integration path.

## Phase 2 — Work-item lifecycle reuse

### WS-1201 — Characterize retry workspace state

**Goal:** Decide when backend/transport retries can safely reuse the same writer workspace.

**Required evidence:** distinguish provisioning failure, no-conversation failure, paused conversation, clean partial writer, dirty partial writer, and terminal execution with committed progress.

### WS-1202 — Reuse writer workspace for same-work-item transport retries

**Goal:** Make `work item -> writer workspace` the durable ownership unit where safe.

**Constraint:** never attach two active writers to one mutable workspace. Dirty/ambiguous state must be resumed or explicitly repaired, not silently reused by a second writer.

## Phase 3 — Capacity hardening

### WS-1301 — Disk-pressure workspace GC

Add a free-space threshold trigger in addition to the 15-minute timer, preserving active/recoverable protection rules.

### WS-1302 — Canonical Git duplicate-pack repair

After no old execution requires the legacy pack topology:

1. capture refs and `git fsck` baseline;
2. run controlled `git repack`/`git gc` on affected canonical repos;
3. re-run fsck and integration smoke;
4. verify actual `.git` reduction.

This must not run while an unsafe number of legacy hardlinked/full-clone executions are active without rollback evidence.

### WS-1303 — OpenHands writable-layer/caches

Separate cache/session/tooling growth from the container writable layer and set TTL/size policies. This is independent from Git workspace correctness.

## Verification matrix

### Focused

```bash
cd model-control-plane
npx tsx --test test/v3Workspace.test.ts
npx tsx --test test/v3WorkspaceRetention.test.ts
npm run check-types
```

### V3 regression

```bash
cd model-control-plane
npm test
npm run build
```

### Repository hygiene

```bash
git diff --check
git status --short
```

### Production-shaped smoke before deployment

- create packed local source repository owned by source UID;
- provision workspace under the real OpenHands bind mount;
- verify source/workspace pack inode sharing;
- run `git status/add/commit` as UID 10001 in `hermes-openhands-v3`;
- verify canonical HEAD/working tree unchanged;
- integrate via host worktree and verify durable ref/source worktree invariants.

## Rollout

1. Implement and commit on the dedicated Pixel code worktree without restarting production.
2. Run focused + full regression suites.
3. Wait until existing active executions created under the legacy provisioner are terminal or otherwise safely resumable.
4. Deploy control-plane code.
5. Existing workspaces continue to function; only newly provisioned workspaces use linked objects.
6. Observe disk usage, workspace size, integration pack growth, and plan progression.
7. Only after stability evidence, execute WS-1302 canonical repack.

## Implementation checkpoint — 2026-08-30

Completed in branch `refactor/workspace-storage-v4-20260830`:

- **WS-1001 COMPLETE** — forensic report, ADR, architecture document, and Active Plan created from measured GCP Dev evidence.
- **WS-1002 COMPLETE** — packed-object sharing regression test proves execution/source pack inode sharing while execution commits leave canonical HEAD/working tree unchanged.
- **WS-1101 COMPLETE** — execution/review provisioning now uses local linked clones with private mutable Git metadata and hardlinked pre-existing objects; `--no-hardlinks` staging/copy path removed.
- **WS-1102 COMPLETE** — batch integration now uses a host-only detached Git worktree; `bundle --all`, full integration clone, and integrated full-history bundle fetch were removed. Implementation transfer bundles contain only `HEAD ^sourceRevision`.
- **Retention hardening COMPLETE (pulled forward from Phase 3)** — completed/cancelled batches no longer pin the latest successful implementation workspace for every historical/synthetic work item while the overall Plan remains active. Terminal execution pruning also removes execution-scoped `.agent-harness` state even when the repository itself remains protected for recovery.

Verification:

- Initial independent Business Codex review of `018f35f` returned **FAIL** with one P1: root ownership/permission normalization could dereference a repository symlink and mutate an arbitrary host target.
- Repair restricts ownership/permission normalization to regular files/directories only; repository symlinks are never passed to `chown`/`chmod`. A hostile external-target symlink regression test now locks this trust boundary.
- `v3Workspace.test.ts`: 11/11 PASS.
- `v3WorkspaceRetention.test.ts`: 1/1 PASS.
- TypeScript `check-types`: PASS.
- production build: PASS.
- full model-control-plane suite after first repair: **153/153 PASS**.
- `git diff --check`: PASS.
- production-shaped UID/GID prototype against the real `hermes-openhands-v3` mount: source/execution pack same inode, OpenHands commit succeeds, canonical HEAD/working tree unchanged.
- First re-review of `8f4172c` returned **FAIL** with a second P1: future canonical Git objects could inherit service `UMask=0077` and become unreadable by linked workers.
- Second repair configures `core.sharedRepository=0640` before canonical sharing, preserving group-read/no-group-write for future loose/packed objects; a real Git prototype under `umask 077` produced mode `0440` for both loose and packed objects. Later review-specific work refined same-owner handling so only execution-owned new objects are privatized while source-owned canonical history remains shared.
- Second repair focused verification: `v3Workspace.test.ts` **12/12 PASS**, retention **1/1 PASS**, typecheck PASS, build PASS, full model-control-plane **154/154 PASS**, `git diff --check` PASS.
- Production-shaped smoke using a `dev`-owned source repository, root control-plane code, the real OpenHands UID/GID `10001:10001`, and the real `/workspace` bind mount passed: after initial provisioning set `core.sharedRepository=0640`, a later canonical commit created under `umask 077` produced an object at mode `0440`; the next provisioning reasserted gid `10001`, source/clone object paths had the same inode/link count, OpenHands could `git cat-file` the future commit and create a private commit, and canonical HEAD/working tree remained unchanged.
- Third independent review of `de0e00c` returned **FAIL** with one P1: a linked-worktree or redirected `.git` could resolve its common Git directory outside `repoRoot`, so permission normalization might touch another repository.
- Third repair resolves real paths and only enables sharing when the real common Git directory and object directory remain inside the real source repository root. Linked-worktree/external-gitdir sources fall back to `--no-hardlinks` and are explicitly regression-tested to leave the external canonical repository config/object ownership/modes unchanged.
- Third repair focused verification: `v3Workspace.test.ts` **13/13 PASS**, retention **1/1 PASS**, typecheck PASS, build PASS, full model-control-plane **155/155 PASS**, `git diff --check` PASS.
- Fourth independent review of `4e770d5` returned **FAIL** with one P1: review snapshots sourced from OpenHands-owned implementation workspaces would fall back to full-history clones and reintroduce disk amplification.
- Fourth repair introduces mixed object sharing for same-owner implementation→review cloning: source-owned canonical hardlinks remain shared, while only object files actually owned by the execution identity are broken into private clone inodes before review. Out-of-bound common gitdirs still use full private clones.
- The mixed-review clone is staged under `/tmp` and atomically renamed into the production workspace on the normal single filesystem. Hardlink creation is performed by the root control plane using a disposable `GIT_CONFIG_GLOBAL` that trusts only the already-validated source repo for that clone; this avoids both Git dubious-ownership failure and Linux `protected_hardlinks` failure without persisting a global trust exception. Cross-filesystem roots fall back to a private clone/copy.
- Production-shaped mixed-object smoke PASSED: dev-owned canonical pack, OpenHands-owned implementation, and read-only review all shared the same canonical pack inode with link count 3; the implementation's new OpenHands-owned commit object and the review copy had different inodes; review resolved the exact implementation commit and was clean; canonical HEAD/working tree were unchanged. The smoke workspaces were ~408 KiB and ~384 KiB for the small fixture rather than full-history copies.
- Final local verification after the mixed-review repair: `v3Workspace.test.ts` **13/13 PASS**, retention **1/1 PASS**, typecheck PASS, build PASS, full model-control-plane **155/155 PASS**, `git diff --check` PASS.
- Independent re-review is required on the fourth repaired exact branch before production deployment.

Deployment gate:

- Existing MemoFlow executions created by the legacy full-clone provisioner remain live. The control plane must not be restarted merely to activate this storage change while those writers are still running.
- New provisioning semantics activate only after the existing live writers become terminal/safely resumable and the production service is rebuilt/restarted from the reviewed revision.

Remaining planned follow-up:

- **WS-1201 / WS-1202** — characterize and implement same-work-item transport retry workspace reuse. `IMPLEMENT_FIX` reuse already exists and remains unchanged.
- **WS-1301** — add disk-pressure-triggered GC in addition to timer GC.
- **WS-1302** — controlled MemoFlow canonical `git repack/gc` after legacy workspaces are safe; do not run while the current storage topology is still active.
- **WS-1303** — reduce OpenHands container writable-layer/cache growth.

## Review/repair protocol

Any P0/P1 finding in ownership, source mutation, review immutability, writer completion, or integration ancestry blocks deployment. Repair must be independently re-reviewed against this plan. Storage savings alone do not justify weakening those contracts.
