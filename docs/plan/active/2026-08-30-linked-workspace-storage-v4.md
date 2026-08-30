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
2. For configured execution identity, inspect the real canonical object tree, link count, ownership, mode, and filesystem boundary before enabling sharing; unsafe sources use a private fallback without metadata mutation.
3. Stage a `git clone --local --no-checkout` for safe sharing, or `git clone --no-local --no-checkout` for private fallback; atomically rename into the production workspace on the normal single filesystem.
4. Checkout the exact writer/review revision and reject tracked symlinks that escape the staged workspace.
5. Preserve review overlay semantics and privatize execution-owned objects before handing the review snapshot to the same execution identity.
6. Transfer only execution-private ownership/permissions; safely shared hardlinked object files remain source-owned and never worker-writable.
7. Revalidate existing workspace path components, real Git metadata, and top-level identity before reuse/retry/prune/integration; keep the public workspace-ref contract unchanged.

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
- **WS-1101 COMPLETE** — execution/review provisioning now uses linked local clones with private mutable Git metadata and hardlinked safe pre-existing objects. Service-private staging remains only as an atomic publication/security boundary; the legacy full-history staging-copy path is gone, and unsafe sources use `--no-local` private fallback.
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
- Second repair initially used `core.sharedRepository=0640` to keep future canonical objects group-readable under `UMask=0077`. Later trust-boundary hardening supersedes that persistent repository mutation: provisioning now inspects the real object tree each time, normalizes only unique unreadable inodes, and falls back to a private clone when link count/ownership/mode cannot be changed safely.
- Second repair focused verification: `v3Workspace.test.ts` **12/12 PASS**, retention **1/1 PASS**, typecheck PASS, build PASS, full model-control-plane **154/154 PASS**, `git diff --check` PASS.
- Production-shaped smoke using a `dev`-owned source repository, root control-plane code, the real OpenHands execution identity, and the real `/workspace` bind mount passed for the earlier shared-permission model. The final hardening keeps the same readability property but obtains it via per-provision inspection/normalization instead of a persistent `core.sharedRepository` setting; this exact final model requires a fresh smoke before deployment.
- Third independent review of `de0e00c` returned **FAIL** with one P1: a linked-worktree or redirected `.git` could resolve its common Git directory outside `repoRoot`, so permission normalization might touch another repository.
- Third repair resolves real paths and only enables sharing when the real common Git directory and object directory remain inside the real source repository root. Linked-worktree/external-gitdir sources fall back to a physically private `--no-local` clone and are explicitly regression-tested to leave the external canonical repository config/object ownership/modes unchanged.
- Third repair focused verification: `v3Workspace.test.ts` **13/13 PASS**, retention **1/1 PASS**, typecheck PASS, build PASS, full model-control-plane **155/155 PASS**, `git diff --check` PASS.
- Fourth independent review of `4e770d5` returned **FAIL** with one P1: review snapshots sourced from OpenHands-owned implementation workspaces would fall back to full-history clones and reintroduce disk amplification.
- Fourth repair introduces mixed object sharing for same-owner implementation→review cloning: source-owned canonical hardlinks remain shared, while only object files actually owned by the execution identity are broken into private clone inodes before review. Out-of-bound common gitdirs still use full private clones.
- The mixed-review clone is staged under `/tmp` and atomically renamed into the production workspace on the normal single filesystem. Hardlink creation is performed by the root control plane using a disposable `GIT_CONFIG_GLOBAL` that trusts only the already-validated source repo for that clone; this avoids both Git dubious-ownership failure and Linux `protected_hardlinks` failure without persisting a global trust exception. Cross-filesystem roots fall back to a private clone/copy.
- Production-shaped mixed-object smoke PASSED: dev-owned canonical pack, OpenHands-owned implementation, and read-only review all shared the same canonical pack inode with link count 3; the implementation's new OpenHands-owned commit object and the review copy had different inodes; review resolved the exact implementation commit and was clean; canonical HEAD/working tree were unchanged. The smoke workspaces were ~408 KiB and ~384 KiB for the small fixture rather than full-history copies.
- Final local verification after the mixed-review repair: `v3Workspace.test.ts` **13/13 PASS**, retention **1/1 PASS**, typecheck PASS, build PASS, full model-control-plane **155/155 PASS**, `git diff --check` PASS.
- A delayed exact-`7d5805b` Business audit surfaced four additional P1 trust-boundary patterns plus one P2 path-collision issue: symlinked canonical object directories, post-resolution integration roots outside the allowlist, pre-existing execution-path symlink/reuse, escaping tracked symlinks, and lossy execution-ID sanitization. Although later commits had already addressed part of the common-Git-dir surface, these findings are treated as a generalized security review rather than dismissed as stale.
- Current hardening validates common/object directories with `lstat/realpath`, rejects alternates/special/cross-device object trees, never changes metadata on an unreadable multiply-linked object inode, switches unsafe sources to `--no-local`, validates all existing/reused execution workspaces, rejects escaping tracked symlinks while preserving contained relative links, validates resolved integration roots and implementation workspace identities, and rejects lossy execution IDs.
- New focused regression coverage includes escaping/contained tracked symlinks, existing workspace symlink reuse, execution-ID collision prevention, symlinked canonical object-directory private fallback, and integration redirected outside the real allowlist.
- The next deployment candidate must pass focused/full verification and an independent Business re-review on the exact new commit; no previous PASS/FAIL result is transferable to that candidate.
- Current hardened candidate verification: `v3Workspace.test.ts` **22/22 PASS**, retention **1/1 PASS**, TypeScript typecheck PASS, production build PASS, full model-control-plane **164/164 PASS**, and `git diff --check` PASS.
- Production-shaped final-model smoke PASSED using the real workspace mount and execution identity: implementation and review shared the canonical history pack inode; the writer-created commit object and its review copy had different inodes; review was clean at the exact implementation HEAD; canonical HEAD/working tree were unchanged. The small fixture consumed ~340 KiB for implementation and ~316 KiB for review.
- Final self-hardening extends managed-workspace validation to every reuse/retry/prune/integration path: private `.git` metadata may not contain symlinks or object alternates, the common Git directory must remain the workspace-local `.git`, and an escaping working-tree symlink introduced after the first writer run blocks the next control-plane action. Focused regressions cover both post-provision object-directory redirection and late working-tree symlink escape.
- Exact-candidate Business review of `ff3503f` returned **FAIL** with three P1 findings and two P2 findings: canonical integration had not applied the full alternates/descendant-object-tree trust check; unattached existing execution directories could be structurally valid yet silently reused for a different repository/base; private `.git` validation still accepted special files; durable integration ref components were lossy-sanitized; and implementation `sourceRevision` ancestry was implicit rather than explicitly proven.
- Current repair closes all five findings: canonical integration reuses the complete object-tree trust validation; an existing directory encountered by `provision()` without a durable `workspaceRef` is treated as validated crash residue and recreated from the requested repository/base/mode; private Git metadata accepts only regular files/directories and rejects special filesystem nodes; unsafe durable-ref components use injective `%x<utf8-hex>` encoding while ordinary identifiers preserve existing ref names; and integration resolves/validates `sourceRevision^{commit}`, requires it to be an ancestor of HEAD, and verifies fetched HEAD equality before merge.
- New regressions cover crash-residue reprovision across two repositories, FIFO injection into private Git metadata, canonical object alternates, descendant object-tree symlinks, integration-ref collision resistance, and non-ancestor implementation source revisions.
- Post-repair verification: `v3Workspace.test.ts` **28/28 PASS**, retention **1/1 PASS**, TypeScript typecheck PASS, production build PASS, full model-control-plane **170/170 PASS**, and `git diff --check` PASS.
- A fresh exact-commit Business re-review is still mandatory; the prior `ff3503f` verdict is not transferable to the new candidate.
- Exact-candidate Business review of `01f373a` returned **FAIL** with two new P1 identity-binding defects. First, execution IDs still admitted Git/path-dangerous forms such as `.`, `..`, trailing-dot, repeated-dot, and `.lock` spellings; the same unsafe component flowed into workspace directories, writer branches, and baseline refs. Second, batch integration proved only that an implementation was a valid Pixel workspace, not that it was provisioned from the repository currently being integrated.
- Current repair unifies execution path and writer-baseline ref validation through one Git-safe grammar, rejects path aliases and `.lock` forms before any workspace path is constructed, and binds crash-residue removal to the exact validated execution directory.
- Repository identity is now durable control-plane provenance: `v3_execution_links` adds nullable `repository_root`, `WorkspaceProvisioner` returns the resolved canonical repository root, `attachWorkspace()` persists it, and `IMPLEMENT_FIX` inherits it when reusing the previous implementation workspace. Existing databases migrate additively and keep the column nullable for schema compatibility, but legacy execution evidence with a null value is deliberately **not** inferred from the Plan path. It blocks integration as `BATCH_INTEGRATION_EVIDENCE_MISSING`; all new provisions persist the resolved root.
- Batch integration now requires implementation `repositoryRoot` realpath equality with the target repository and independently requires the recorded `sourceRevision` to resolve to the same commit in the target canonical object database before ancestry/bundle import. Worker-controlled `.git/config`/origin values are not trusted for repository identity.
- New regressions cover strict execution-ID aliases, cross-repository implementation injection from two repositories sharing the same base commit, and SQLite `repository_root` round-trip persistence.
- Post-repair verification: workspace focused **29/29 PASS**, API focused **23/23 PASS**, retention **1/1 PASS**, TypeScript typecheck PASS, production build PASS, full model-control-plane **172/172 PASS**, and `git diff --check` PASS.
- A fresh exact-commit Business re-review is mandatory; the `01f373a` FAIL verdict is not transferable to the repaired candidate.
- Exact-candidate Business review of `f003e11` found one final P1 in the legacy compatibility path: `approvedImplementationEvidence()` still replaced a null persisted `repositoryRoot` with the current Plan repository path, which asserted the desired target rather than proving the historical workspace origin.
- The fallback is removed. A legacy execution with null repository provenance now fails closed before integration; `BatchCoordinator` catches evidence-construction failures and durably records `BATCH_INTEGRATION_BLOCKED` instead of letting reconcile throw. A dedicated regression creates a normal execution, nulls `repository_root` to simulate an old database record, completes the worker, and proves the Plan/batch block with `BATCH_INTEGRATION_EVIDENCE_MISSING` while integration invocation count remains zero.
- Deployment compatibility is explicit: the schema migration remains additive/nullable, but old workspace evidence is not trusted for a new integration. Production cutover waits until the currently in-flight legacy MemoFlow batch has reached a durable integrated boundary, or that work is safely re-executed after cutover.
- Final post-repair verification: workspace focused **29/29 PASS**, API focused **23/23 PASS**, legacy-evidence/batch focused **2/2 PASS**, retention **1/1 PASS**, TypeScript typecheck PASS, production build PASS, full model-control-plane **173/173 PASS**, and `git diff --check` PASS.
- One fresh exact-commit Business re-review remains mandatory; the `f003e11` FAIL verdict is not transferable to the final candidate.
- Exact-candidate Business review of `8920092` found one further P1 privilege-boundary defect: `integrateBatch()` still ran Git commands against the worker-mutable implementation repository as the control-plane/source identity. Because the worker owns `.git/config`, a malicious `core.fsmonitor` or similar Git helper could become a privileged command execution path during host integration.
- Current repair makes the implementation repository an explicitly untrusted Git surface. `status`, `rev-parse`, `merge-base`, required-ancestor checks, and `bundle create` all execute as the execution workspace owner; command-line Git config forces `core.fsmonitor=false`, `core.hooksPath=/dev/null`, and `core.pager=cat`. Bundle output is created in an execution-owned temporary directory, then ownership is transferred to the canonical source owner for fetch/merge; canonical Git mutations never run as the worker.
- A dedicated regression configures a worker-private executable `core.fsmonitor` that would create a marker if invoked. Integration completes and imports the expected commit while the marker remains absent and canonical HEAD is unchanged. A production-shaped smoke repeats this with root control-plane code, the real OpenHands UID/GID, and the real `/workspace` mount: integration succeeds, the malicious fsmonitor marker remains absent, the durable integration ref is exact, and canonical HEAD stays unchanged.
- Final post-repair verification before the next exact review: workspace focused **30/30 PASS**, API focused **23/23 PASS**, legacy-evidence/batch focused **2/2 PASS**, retention **1/1 PASS**, TypeScript typecheck PASS, production build PASS, full model-control-plane **174/174 PASS**, and `git diff --check` PASS.
- A fresh exact-commit Business re-review is mandatory; the `8920092` FAIL verdict is not transferable to the repaired candidate.
- Exact-candidate Business review of `0e47adc` returned **FAIL** with one P1 TOCTOU finding: the execution-owned temporary bundle pathname was later `chown(path)`ed and consumed by source-owner Git, so a concurrent execution-UID process could replace the pathname with a symlink or alternate file before the privileged handoff.
- The repair removes the pathname ownership transition entirely. Worker-mutable Git commands now use one sanitized execution-identity helper with a minimal environment (`HOME=/nonexistent`, system/global Git config disabled, terminal prompts disabled, fsmonitor/hooks/pager forced off). `git bundle create -` writes only to a pipe. The root control plane opens the canonical-side bundle with `O_CREAT|O_EXCL|O_NOFOLLOW`, sets owner/mode via the already-open FD before starting the worker Git process, streams stdout bytes into that FD, fsyncs/closes it, then source-owner Git fetches the trusted pathname. The worker never owns or receives that pathname/FD.
- The same helper now covers writer baseline preparation, writer completion verification, retention `git clean`, and all implementation inspection/ancestry commands, eliminating adjacent privileged Git-on-worker-repository paths. Integration also fails closed when a configured execution UID equals the canonical repository owner UID.
- Regression verification after this repair: workspace focused **31/31 PASS**, API focused **23/23 PASS**, legacy-evidence/batch focused **2/2 PASS**, retention **1/1 PASS**, TypeScript typecheck PASS, production build PASS, full model-control-plane **175/175 PASS**, and `git diff --check` PASS.
- Production-shaped FD/TOCTOU smoke PASSED with the real workspace mount and OpenHands UID/GID. A concurrent host process running as UID 10001 repeatedly attempted to replace both the old export pathname and the new integration bundle pathname with a symlink to a root-owned victim while integration ran. The victim owner/group/mode/device/inode/size remained byte-for-byte unchanged, the malicious fsmonitor marker remained absent, the integrated ref resolved exactly, and canonical HEAD stayed unchanged.
- A fresh exact-commit Business re-review is mandatory; the `0e47adc` FAIL verdict is not transferable to the repaired candidate.
- Exact-candidate Business review of `6ea72b5` returned **FAIL** with one P1 publication-order race: provisioning chowned the per-execution parent directory to the worker before running root recursive `find`-based ownership/mode normalization, allowing a worker to replace a checked entry with an external symlink between enumeration and `chown/chmod`.
- The repair moves the publication point to the end. After the staged repository enters the root-owned per-execution directory, object-link privatization, recursive repository ownership normalization, and writer/read-only mode normalization all complete while that parent remains inaccessible to the execution identity. The final operation is the parent-directory ownership/mode transition to OpenHands; no privileged recursive pathname operation occurs afterward.
- Production-shaped publication-race smoke PASSED with 3,500 tracked files and a real host process running as UID 10001. The attacker waited until it observed the execution directory owner become 10001, then successfully replaced a tracked file with a symlink to a root-owned victim. The swap therefore definitely occurred after publication, but the victim owner/group/mode/device/inode/size remained exactly unchanged after an additional delay, proving no privileged recursive traversal remained after exposure.
- Post-repair verification remains workspace focused **31/31 PASS**, API focused **23/23 PASS**, legacy-evidence/batch focused **2/2 PASS**, retention **1/1 PASS**, TypeScript typecheck PASS, production build PASS, full model-control-plane **175/175 PASS**, and `git diff --check` PASS.
- A fresh exact-commit Business re-review is mandatory; the `6ea72b5` FAIL verdict is not transferable to the repaired candidate.
- **Independent Business deployment gate PASS** on exact code candidate `6d41a75db82d67f97fcebc7944ce3c57f8d492fd`: no P0/P1 findings remain across publication ordering, FD/pipe handoff, worker Git config/environment, object sharing, repository provenance, legacy fail-closed behavior, integration lifecycle, retention/recovery, and deployment compatibility.
- Reviewer P2 note: the deliberately minimal read-only review snapshot did not contain `node_modules`, so the reviewer could not independently launch the TypeScript test commands inside that snapshot. The authoritative host-side verification for the exact code lineage remains workspace **31/31**, API **23/23**, legacy-evidence/batch **2/2**, retention **1/1**, full model-control-plane **175/175**, typecheck/build PASS, plus production-shaped FD/TOCTOU and publication-race smokes.
- Code SHA `6d41a75db82d67f97fcebc7944ce3c57f8d492fd` is the reviewed deployment candidate. Subsequent documentation-only commits do not invalidate that code review; any code change requires a new exact review.
- A provenance check found that `6d41a75...` is not reachable in the current branch object database, so that historical PASS is not accepted as the final deployable exact-commit gate. The reachable code candidate `b1ad175` was independently re-reviewed.
- Exact reachable-candidate Business review of `b1ad175` returned **FAIL** with three P1 findings: the worker could forge the writer-start ref and completion did not prove ancestry; concurrent starts for the same execution could race through provisioning and recreate an active workspace; and request-time provisioning still mutated canonical Git object metadata while source writers could be active.
- Current repair persists a write-once `writer_start_revision` in `v3_execution_links`, uses that durable value for completion, and requires `startRevision` to be an ancestor of clean `HEAD`; it serializes workspace provisioning and host launch per execution ID and re-reads durable state under the lock; and it makes canonical object-sharing eligibility strictly read-only at runtime, with `--no-local` fallback whenever the object tree is not already safely readable/non-writable.
- Regression coverage proves a forged worker ref cannot move the baseline, a clean unrelated history is rejected, and two concurrent idempotent starts provision and launch only once. Verification after repair: workspace **31/31 PASS**, API **24/24 PASS**, retention **1/1 PASS**, typecheck PASS, build PASS, full model-control-plane **176/176 PASS**, `git diff --check` PASS.
- Live MemoFlow read-only audit while the legacy writer is active found 4,536 regular canonical object files; 63 are currently unreadable by the OpenHands execution identity and none are writable by it. No metadata was changed. Therefore the first linked-storage cutover requires a quiescent repository-preparation step after the legacy writer reaches a durable safe boundary.
- A fresh exact-commit Business re-review is mandatory on the new repair commit; no earlier review verdict transfers.
- Exact-candidate Business review of `faca49b` returned **FAIL** with one P1 crash-window finding: the per-execution mutex was process-local, while OpenHands conversation creation and SQLite `openhands_conversation_id` attachment were not one durable/idempotent operation. A crash after successful POST but before attach could therefore launch a second writer on restart.
- Current repair adds additive durable `host_launch_token` / `host_launch_claimed_at` state and atomic CAS claim/takeover/expiry operations. Every real `ExecutionHostPort` now supports recovery by durable execution identity. OpenHands searches the authenticated `/api/conversations/search` surface by the existing execution tag, detects duplicates fail-closed, and bounds an absence scan by the durable execution creation timestamp; Antigravity recovers from its deterministic execution state; routed recovery stays on the persisted backend.
- Launch flow now performs recover → CAS claim → recover again → create → token-owned attach. Fresh claims suppress another POST across service instances. Post-success/pre-attach crash residue is recovered and attached without re-launch. Stale claims can be taken over only after the host is re-queried; claim expiry is token-CAS protected so a superseded owner cannot resurrect terminal state.
- New regressions cover SQLite fresh/stale claim ownership, stale-token attach rejection, fresh-claim duplicate suppression, post-success/pre-attach restart recovery with `createExecution=0`, OpenHands duplicate-tag rejection, routed-host recovery, and existing same-process idempotent start. Verification: workspace **31/31 PASS**, API **26/26 PASS**, OpenHands adapter **1/1 PASS**, Plan **34/34 PASS**, retention **1/1 PASS**, typecheck PASS, build PASS, full model-control-plane **178/178 PASS**, `git diff --check` PASS.
- The previous MemoFlow legacy integration-repair writer has now terminated `FAILED` because its upstream GLM deployment was unavailable; it was not a code failure. Global RUNNING/PAUSED executions are currently zero and MemoFlow is durably `BLOCKED / IMPLEMENT_FAILED`, so the old provisioner will not automatically create another writer before cutover.
- A fresh exact-commit Business re-review is mandatory on this crash-safe launch repair before merge/deployment.
- Exact-candidate Business review of `31cdf63` returned **FAIL** with one P1 lease-fencing race: an owner could begin a slow post-claim recovery scan, lose the stale claim to another process while the scan was in flight, then observe absence and still POST because ownership was not revalidated after the scan.
- Current repair adds atomic `renewHostLaunchClaim()` and requires the same launch token to CAS-renew immediately after the post-claim recovery scan and immediately before `createExecution()`. A superseded owner therefore cannot cross the POST boundary; a successful renewal refreshes the lease for longer than the supported host-create timeout.
- Dedicated regression reproduces that exact race: process A owns token1 and blocks in its second recovery, process B ages and CAS-takes the claim as token2, then process A resumes. The fenced owner returns `STARTING` and `createExecution` remains **0**. API focused is **27/27 PASS** and full model-control-plane is **179/179 PASS**; typecheck/build remain PASS.
- Another exact-commit Business re-review is mandatory before cutover.
- Exact-candidate Business re-review of `ae9651e` returned **PASS** with no remaining P0/P1. The reviewed commit was fast-forwarded to canonical `main`, built, pushed, and deployed after a zero-active-writer check and a durable SQLite backup.
- MemoFlow was prepared at the quiescent boundary: `git fsck --connectivity-only` passed, canonical HEAD/refs stayed unchanged, object-tree safety passed, and the execution identity received read/traverse but no write access. A production-shaped linked-clone smoke proved source/clone pack device+inode equality and container read access.
- The first post-cutover `reconcile(auto)` did **not** create a host worker and consumed essentially no disk, but provisioning failed in 69 ms with `git clone --local ... /tmp/...: Invalid cross-device link`. Root cause: the production unit has `PrivateTmp=true`; `/tmp` is a private mount namespace even though host-side device numbers appear equal. The old staging algorithm therefore crossed a mount boundary before publication.
- Current repair moves execution clone staging to a service-private sibling of `hostRoot` (`.model-control-plane-staging`), outside the OpenHands `/workspace` bind mount but on the publication mount. `--local` is additionally gated on source-object/staging device equality; incompatible sources fall back to `--no-local`. Root-linked staging and its disposable trust config remain root-owned; source-owner write access is limited to a child used only by private fallback. A deployment-boundary regression locks the `PrivateTmp=true` + non-`/tmp` staging contract.
- Production-shaped `systemd-run` smoke with **`PrivateTmp=yes` and `ProtectSystem=full`** passed against the real MemoFlow revision: source/clone pack inode matched, UID 10001 could read the clone, staging residue was empty, and actual filesystem allocation increased by only **131,194,880 bytes (~125 MiB)** while the workspace existed, then returned exactly to the pre-smoke free-space value after cleanup. This distinguishes physical allocation from misleading `du` accounting of shared hardlinks.
- Verification after the staging repair: workspace **31/31 PASS**, deployment-boundary **10/10 PASS**, typecheck PASS, build PASS, and full suite must pass again before the exact staging candidate is reviewed/deployed.

- A later exhaustive exact-`ae9651e` Business deployment review superseded the earlier PASS record and returned **FAIL** with two P1 concurrency findings: delayed recovery could attach a host conversation without proving ownership of the current launch token, and workspace provisioning was serialized only in-process so two service instances could race on the same execution path and a stale loser could delete/fail the winner.
- Host recovery attachment is now fenced end-to-end: every post-claim/post-POST recovery passes the expected launch token into `attachOpenHands()`, while tokenless attachment is SQL-CAS limited to rows with `host_launch_token IS NULL`. A superseded recovery therefore cannot attach or clear a newer claim even when it discovers a real conversation after takeover.
- Workspace provisioning now has additive durable `workspace_provision_token` / `workspace_provision_claimed_at` columns plus CAS claim/renew/fail operations. `DevelopmentExecutionService` claims before provisioning, passes a publication fence into `WorkspaceProvisioner`, and attaches `workspace_ref` only with the same token. The fence renews before crash-residue removal, before filesystem publication, and before worker exposure; losing ownership returns the newer durable record rather than failing it. Generic provision exceptions no longer recursively delete the shared execution directory.
- The PrivateTmp staging repair remains part of the same next candidate: staging is a service-owned sibling of `hostRoot`, local hardlinks are gated by source/staging/publication device compatibility, and private fallback grants source ownership only to its dedicated child.
- New regressions reproduce both reviewer races: two control-plane instances sharing one SQLite DB force a stale workspace-claim takeover and prove the loser performs no host launch and cannot overwrite the winner; a superseded host-recovery owner discovers a conversation after token takeover and is unable to attach it. A real `WorkspaceProvisioner` regression proves a lost publication fence cannot remove an already-published workspace.
- Verification after the combined staging + durable-fencing repair: API **30/30 PASS**, workspace **32/32 PASS**, Plan **34/34 PASS**, deployment-boundary **10/10 PASS**, retention PASS, TypeScript typecheck PASS, production build PASS, and full model-control-plane **184/184 PASS**. A fresh exact-commit Business re-review is mandatory before updating production or reconciling MemoFlow again.

- Exact-candidate Business review of `8ce2f99` returned **FAIL** with one remaining P1 crash/replay defect: a crash during filesystem placement/cross-device copy could leave an incomplete service-owned `hostPath`; replay required a fully valid managed Git workspace before deleting the residue, then marked the execution terminal non-retryable when that validation failed, permanently preventing reprovision.
- The repair distinguishes unpublished service-owned torn publication from worker/foreign artifacts under the existing durable publication token. Cleanup still renews the current token first; `hostPath`/execution-parent symlinks are rejected; if `.git` exists it must be a real directory whose private metadata tree contains no symlinks, alternates, or special nodes, and escaping working-tree symlinks remain forbidden. Security-boundary Git errors (redirected common dir/repository mismatch/out-of-root) remain fail-closed. A missing `.git` or ordinary incomplete Git files are treated as torn-copy evidence only while the execution parent is still service-owned. Worker/foreign-owned residue continues to require full `assertManagedGitWorkspace()` validation.
- Generic deletion remains token-fenced and `rm` is used only on the contained execution directory; a stale provision owner still cannot remove a winner. Dedicated regression creates an incomplete service-owned `repo` with no valid Git metadata and proves replay recreates the exact base, while the pre-existing redirected-`.git` rejection regression remains PASS.
- Verification after the partial-publication recovery repair: workspace **33/33 PASS**, API **30/30 PASS**, Plan **34/34 PASS**, deployment-boundary **10/10 PASS**, TypeScript typecheck PASS, production build PASS, full model-control-plane **185/185 PASS**, and `git diff --check` PASS. A fresh exact-commit Business re-review remains mandatory before production is advanced from `ae9651e` or MemoFlow is reconciled.

- Exact-candidate Business review of `e58b3f5` returned **FAIL** with one P1 lease-duration race: a durable workspace claim could expire while a synchronous recursive residue removal or post-placement ownership/privatization operation was still running; a new process could then take the claim and publish while the stale process continued mutating the same execution path.
- The repair adds a service-private per-execution OS `flock` under a root-owned sibling lock directory. `WorkspaceProvisioner.provision()` holds that lock across the entire execution-filesystem lifecycle: crash-residue inspection/removal, clone staging, filesystem placement, object privatization, permission normalization, and final worker exposure. Durable SQLite tokens remain semantic ownership/fencing across restarts; the kernel lock provides physical same-host serialization even if the database lease ages out during a long synchronous operation. The lock holder still revalidates the durable publication token at destructive/publication boundaries, so a process whose token was taken over while holding the flock cannot expose or attach stale output.
- The lock helper uses `/usr/bin/flock`; the service-private lock root is realpath/owner checked and mode `0700`. The lock-holder command waits on a pipe, so process/service death closes the pipe and releases the kernel lock automatically. No worker-mounted path contains the lock files.
- A dedicated regression blocks the first provisioner at its publication fence while holding the flock, starts a second provisioner for the same execution, and proves the second cannot even enter its fence until the first releases the OS lock; after release the stale contender is rejected by the durable fence and the winner workspace/HEAD remain intact.
- Verification after OS-level serialization: workspace **34/34 PASS**, API **30/30 PASS**, Plan **34/34 PASS**, deployment-boundary **10/10 PASS** before the explicit flock assertion update, TypeScript typecheck PASS, production build PASS, full model-control-plane **186/186 PASS**, and `git diff --check` PASS. A fresh exact-commit Business re-review is mandatory before deployment/reconcile.

- **Independent Business deployment gate PASS** on exact code candidate `511ef0897e5ceb829c958cb917997ce829dc8a9d`: no P0/P1 blockers remain after the per-execution kernel flock repair. The reviewed boundary includes durable workspace/host launch claims, stale-owner fencing, service-owned torn-publication recovery, PrivateTmp-safe staging, object sharing, repository provenance, review immutability, integration, and retention. Exact-lineage verification is typecheck/build PASS, deployment-boundary **10/10**, API **30/30**, workspace **34/34**, Plan **34/34**, full model-control-plane **186/186**, and `git diff --check` PASS.
- `511ef08` is the deployable code SHA. Any later commit before cutover must be documentation-only; any code change requires another exact Business review.

- First real post-PASS MemoFlow reconcile on production `a521be2` failed before host launch with `EXDEV` while renaming the service-private staging clone into the execution workspace. The new code consumed essentially no additional disk and no host worker started. Live mount inspection proved the remaining cause was deployment configuration: systemd `ReadWritePaths=/opt/data/hermes-ai-office-v3/workspaces` creates a separate bind mount for the workspace root, so VFS rejects hardlink/rename across the canonical/staging mount and workspace mount despite identical ext4 device numbers.
- Deployment-only repair removes the workspace root from `ReadWritePaths` in the GCP unit, generic unit, and production drop-in while retaining the database directory. `ProtectSystem=full` leaves `/opt` writable, so the workspace whitelist was redundant. `PrivateTmp=true`, `NoNewPrivileges=true`, and the rest of the service sandbox remain unchanged. Deployment-boundary regression now forbids reintroducing a workspace `ReadWritePaths` bind.
- Before persistent deployment, a transient `systemd-run` smoke with `PrivateTmp=yes` + `ProtectSystem=full` and no workspace `ReadWritePaths` must prove both hardlink inode sharing from MemoFlow and atomic rename from the service-private staging sibling into the workspace mount. This configuration change requires independent Business review before the unit is installed/restarted.

- **Independent Business deployment review PASS** on exact deployment candidate `ad2ed125a96ad1b3a8420ec1a7eaf6b1fbcb7f2e`: removing the redundant workspace `ReadWritePaths` bind does not weaken the configured `ProtectSystem=full` sandbox and is required to preserve one VFS mount identity for linked-object hardlinks and atomic staging publication. `PrivateTmp`, `NoNewPrivileges`, UMask, database write-path confinement, and all reviewed storage code remain unchanged.


Deployment gate:

- The legacy MemoFlow writer is terminal and the Plan is durably blocked; cutover may proceed only after the latest exact candidate passes independent Business review and a final zero-active-writer check.
- MemoFlow canonical object sharing additionally requires the documented quiescent permission-preparation audit; otherwise the new runtime will safely fall back to private clones.
- After deployment, resume the same MemoFlow Plan with plan-scoped `reconcile(auto)`; do not create a replacement Plan.

Remaining planned follow-up:

- **WS-1201 / WS-1202** — characterize and implement same-work-item transport retry workspace reuse. `IMPLEMENT_FIX` reuse already exists and remains unchanged.
- **WS-1301** — add disk-pressure-triggered GC in addition to timer GC.
- **WS-1302** — controlled MemoFlow canonical `git repack/gc` after legacy workspaces are safe; do not run while the current storage topology is still active.
- **WS-1303** — reduce OpenHands container writable-layer/cache growth.

## Review/repair protocol

Any P0/P1 finding in ownership, source mutation, review immutability, writer completion, or integration ancestry blocks deployment. Repair must be independently re-reviewed against this plan. Storage savings alone do not justify weakening those contracts.
