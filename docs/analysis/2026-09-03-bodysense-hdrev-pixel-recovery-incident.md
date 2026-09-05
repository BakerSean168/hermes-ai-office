# BodySense HDREV Pixel V4 Recovery Incident — 2026-09-03

Status: P0 CLOSED / P1 PARTIALLY OPEN (Pixel reliability). BodySense containment is CLOSED: direct operator development completed PR #165 and merged it to `main` as `a82da464f109c407e66328d9f9aff94a01589629` after all required CI checks passed. Pixel remains the subject of this incident until the residual P1 items below are closed.

## 2026-09-04 verification and remediation status

The incident was re-verified against the current V4 source and production architecture rather than closed from historical intent. The important distinction is that several findings had already been fixed by the routing/resource convergence, while several others were still reproducible in current code and were fixed in this remediation batch.

| #          | Finding                                                                                           | Status after re-verification              | Evidence / remediation                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1          | BodySense integration outside sandbox allowlist                                                   | CLOSED                                    | Existing `9fdf316` plus release sandbox probe covers BodySense repo and Git common dir.                                                                                                                                                                                                                                                                             |
| 2 / 11     | Declared Go runtime not proven from the Agent-visible PATH                                        | CLOSED                                    | Release now reconciles/recreates OpenHands from the reviewed Compose definition before tooling install, then proves `command -v go` resolves `/openhands-state/toolchains/go-1.26.0/bin/go` as the worker user and `go version` is 1.26.0. This closes the observed config-present/runtime-stale gap.                                                               |
| 3          | Provider failures consume product attempts                                                        | CLOSED                                    | Product and infrastructure attempt budgets are now separate; provider/transport/workspace infrastructure failures do not consume product implementation/review attempts and have a bounded infrastructure-attempt ceiling.                                                                                                                                          |
| 4 / 12     | Valid repo/evidence completion can be stranded behind provider finalization                       | CLOSED                                    | The worker verifies exact completion evidence while the provider is still non-terminal, interrupts the stuck turn, preserves the real provider state, and finalizes the durable execution from repository facts.                                                                                                                                                    |
| 5          | Heartbeat is not meaningful progress                                                              | CLOSED                                    | V4 now persists meaningful provider/repository progress fingerprints separately from liveness heartbeats, applies a bounded stall window, replaces a stalled provider session at most within the configured recovery budget, and fails retryably after exhaustion. Terminal races during stall recovery now finalize through the same durable result/evidence path. |
| 6          | Worker/reviewer starts in the wrong workspace                                                     | CLOSED                                    | Current OpenHands launch passes the exact `LocalWorkspace.working_dir` and recovery validates the execution workspace path.                                                                                                                                                                                                                                         |
| 7 / 8 / 13 | Operator/evidence completion provenance is not accepted consistently by review/replay/integration | CLOSED                                    | `ReviewRepository` now owns a canonical completion-origin gate: exact verified workspace + exact result revision + provider success or an evidence-verified recovery origin. Downstream integration no longer re-imposes a contradictory provider-status requirement.                                                                                               |
| 9          | INVALID/infrastructure review attempts consume review quality budget                              | CLOSED                                    | INVALID/STALE and infrastructure reviewer failures use the separate infrastructure budget; genuine product review outcomes use the product budget.                                                                                                                                                                                                                  |
| 10         | Release requires the canonical checkout HEAD                                                      | OPEN (P1)                                 | A dedicated reviewed release worktree/ref remains desirable; the current release still intentionally fails closed unless canonical source and release SHA match.                                                                                                                                                                                                    |
| 14         | Provider `SUCCEEDED` + no product change is terminal non-retryable                                | CLOSED                                    | `WORKSPACE_IMPLEMENTATION_NOOP` is retryable, is classified as provider/resource quality failure, and can reselect another execution resource.                                                                                                                                                                                                                      |
| 15         | ENOSPC / unbounded workspace cache growth                                                         | PARTIAL (P1 residual)                     | V4 now has an 8 GiB production free-space preflight, typed `WORKSPACE_CAPACITY_*` / `WORKSPACE_STORAGE_EXHAUSTED`, health/storage accounting, release low-capacity gate, and high-watermark pruning of Git-ignored caches for terminal execution workspaces only. Global Docker/build-cache accounting and pruning remain open.                                     |
| 16         | Commit governance is discovered only after push/PR                                                | CLOSED for the observed BodySense failure | When a required check is commit-lint/commitlint and the repository declares commitlint, delivery runs the repository's own `pnpm commitlint --from <target> --to <reviewed>` contract before push; failure enters delivery repair without publishing the bad head.                                                                                                  |
| 17         | Required CI failure has no bounded repair path                                                    | CLOSED                                    | Required-check failure is durable `CHECKS_FAILED` and creates a bounded FOLLOW_UP delivery-repair plan with the same delivery contract and independent exact-SHA review.                                                                                                                                                                                            |
| 18 / 20    | Repeated delivery repair restarts from stale product SHA / stale parent delivery                  | CLOSED                                    | FOLLOW_UP repair bases on the durable delivery `headSha`; `SUPERSEDED_PENDING_CHILD` delegates delivery ownership to the repair child; child→grandchild repairs therefore advance from the latest PR head and supersede back up the chain after verified delivery.                                                                                                  |
| 19         | Resource admission can select a route whose ACP/tool runtime is unusable                          | CLOSED                                    | Runtime admission now executes a production-shaped, per-binding model-native ACP probe in an isolated Git workspace, requires repository tool activity and an unchanged clean HEAD, records typed readiness/error state, and hard-gates ResourceSelector on a positive admission record.                                                                            |

Additional regression coverage added by this remediation includes: queued capacity failure becomes durable retryable failure; unrecovered provider launch failure cannot leave an orphan RUNNING execution; live evidence can finalize implementation and independent review without falsifying provider success; chained CI repair uses successive delivery heads; ignored terminal caches are the only workspace paths eligible for automatic pruning; and commitlint failure occurs before any push.

The remaining incident work is therefore narrower P1 hardening, not a BodySense product defect: a dedicated reviewed release worktree/ref and host-wide Docker/build-cache lifecycle governance remain open. Meaningful-progress tracking and full per-binding ACP runtime admission are now closed.

## 2026-09-05 recovery-state-machine closure

The later exact-SHA recovery of already-merged PR #165 exposed four additional Pixel control-plane defects, all now closed on the deployed V4 source:

- `cd1a79d` — a retryable transient review transport failure no longer permanently excludes a recovered READY review binding; authentication/quota-class failures remain excluded and implementation failover semantics are unchanged.
- `97f03d5` — execution leases are non-reentrant even for the same worker owner, preventing concurrent automation/API calls from launching two provider sessions for one Execution.
- `24a6b51` — provider-session CAS/infrastructure races remain retryable but no longer poison provider resource health.
- `32fad95` — continuation, provider-session replacement, and meaningful-stall terminal races all converge on one terminal finalizer that verifies the exact workspace, persists result revision/evidence, records terminal failure, and persists independent review verdicts in the same lease/call.

The current full model-control-plane suite is **218/218 PASS** with typecheck and build passing. The old Pixel development worktrees and superseded V3/V4 side branches were removed after their relevant behavior was verified as either present or superseded on `main`; only the canonical `main` worktree remains.

The remaining BodySense recovery gate is external review supply, not missing product history or a Pixel retry-state defect. The exact implementation revision `a53052129a95ab017be3bd8b427ab4cc0b95d028` remains durably preserved and the next review remains PENDING. Production single-active/literal-worktree gates stay off until the legacy BodySense lineage closes.

## Scope

This incident records Pixel V4 execution/review failures observed while implementing the existing BodySense durable plan `plan_260fec90-e0a7-4289-98f9-8f7e46a2db92` (HDREV-001..003). It is a Pixel reliability incident, not a rollback of accepted BodySense product work.

BodySense durable facts at the time of this record:

- HDREV-001 accepted at `d11e48d4e1ba3103fa4091cca17fdcd6120f469e`.
- HDREV-002 was independently reviewed, accepted and integrated at `7d250eb667080b5f4c46284ddd9dca588969b08a`.
- HDREV-002 verification performed during operator-assisted recovery included AI full tests 475/475, Assessment evidence qualification 13/13, Ruff/Pyright, and Go test/vet/build; the recovered candidate later received an independent PASS before integration.
- HDREV-003 was subsequently implemented, independently reviewed, repaired for 8-number RapidOCR quadrilateral bbox support, independently re-reviewed PASS, and integrated at `4d69acd05d3e242d90164e418e38b0c234e0dfb6`.
- OCR v20 Champion promotion remains a separate gate and is not changed by this incident.

## What failed

### 1. BodySense was initially outside the service sandbox write allowlist

The V4 service could execute BodySense work but could not create the canonical integration lock under the BodySense Git directory. A reviewed candidate therefore failed during integration with a workspace lock error.

Correction:

- add the BodySense repository and Git lock locations to the exact systemd sandbox probe and release contract;
- prove the permissions in the release probe rather than assuming project onboarding implies integration write access.

Implemented previously in `9fdf316`.

### 2. Coding runtime toolchain assumptions were incomplete

BodySense requires the repository-declared Go toolchain. The OpenHands image initially did not carry the exact supported Go runtime, so a valid worker could not prove the Go gates.

Correction:

- persist and release-gate the BodySense Go toolchain in the OpenHands runtime;
- treat missing declared toolchains as execution-environment failure, never as a product workaround opportunity.

### 3. Provider failures consumed attempts without product signal

Observed independent infrastructure failures included:

- implementation Luna route: upstream LiteLLM/OrcAI HTTP 500 with an invalid HTML response;
- review Business Codex route: review transport failure;
- review GPT-5.6 Sol route: quota reservation HTTP 403;
- Codex automatic review route: provider session heartbeat without useful completion.

These failures contain no BodySense product verdict and must remain distinguishable from a reviewer `FAIL` finding.

### 4. Valuable implementation work was rejected only because finalization did not complete

The second HDREV-002 implementation attempt produced a substantial Assessment v5 / `assessment-evidence-contract-v4` draft, but the provider left the workspace dirty and did not create valid completion evidence. Pixel correctly refused to accept the result, but its only normal continuation was to start the next implementation attempt from the last accepted revision, risking a complete rewrite of valuable work.

Correction:

- add strict operator-assisted workspace adoption for a still-owned paused execution;
- require deterministic verification, exact committed HEAD, clean status, completion evidence, and a real paused provider session;
- record `RECOVERY` evidence instead of fabricating provider success.

Implemented in `f9cc8af`.

### 5. Heartbeat was incorrectly treated as sufficient progress

Several OpenHands sessions remained `RUNNING` and continued heartbeating while no repository file changed and no completion evidence appeared. A heartbeat proves transport liveness, not engineering progress.

Correction:

- add a safe operator abort for a paused stalled attempt;
- preserve the execution/workspace and immutable recovery reason;
- never convert a stalled provider into an invented success.

Implemented in `5c74e5a`.

Follow-up: progress detection should become first-class and use bounded signals such as last meaningful event, repository mutation, tool action, evidence mutation, and provider phase rather than heartbeat alone.

### 6. Builtin reviewer did not reliably operate from the provisioned repository workspace

The fourth HDREV-002 reviewer was provisioned an exact snapshot whose HEAD was `7d250eb...` and which contained both `apps/api/go.mod` and `apps/ai-service`. However, the OpenHands builtin reviewer operated from the default `/workspace` context and searched unrelated repositories and remote GitHub for BodySense. It then returned `INVALID` claiming the repository and commit were absent.

This was a false environment diagnosis caused by reviewer working-directory context, not by the BodySense candidate.

Correction in `fe58a20`:

- include the exact repository workspace path in the phase prompt;
- for reviews, explicitly require `git -C <exact-workspace> rev-parse --verify HEAD^{commit}` before any other repository discovery;
- explicitly prohibit searching sibling `/workspace` directories or remote repositories to rediscover the project.

Long-term requirement: the terminal tool should enforce the conversation workspace as its effective cwd rather than relying only on prompt compliance.

### 7. Operator-assisted implementation success was incompatible with review completion invariants

Operator adoption intentionally leaves the provider session as `PAUSED`; Pixel records implementation `SUCCEEDED` from deterministic workspace evidence without claiming the provider succeeded. The review repository previously required `implementation.provider_status == SUCCEEDED`, so a later reviewer could not persist any verdict for an operator-adopted implementation.

Correction in `fe58a20`:

A review may accept an implementation session that is provider-`PAUSED` only when all of the following durable facts agree:

- implementation execution status is `SUCCEEDED`;
- implementation result revision equals the reviewed SHA;
- `verified-workspace` evidence is clean, descendant-of-source, and has the reviewed HEAD;
- `result-revision` evidence names the same reviewed SHA;
- immutable `RECOVERY` evidence has mode `operator-assisted-workspace-adoption`;
- the recovery evidence binds the same paused provider session and result revision.

This keeps provider truth and product-execution truth separate without weakening review provenance.

### 8. Terminal reviewer completion was not replay-safe if verdict persistence failed

The fourth reviewer execution and provider session both reached `SUCCEEDED` and exact review evidence was persisted, but the review aggregate remained `RUNNING` because verdict persistence failed on the invariant above. The automation loop then reported `REVIEW_ACTIVE` forever even though the reviewer was terminal.

Correction in `fe58a20`:

- add `recoverCompletedReviewVerdict` / `POST /api/v4/executions/:executionId/recover-review-verdict`;
- only permit recovery for an exact terminal `REVIEW` execution whose provider is `SUCCEEDED` and whose workspace/evidence independently verifies the reviewed SHA;
- persist immutable recovery evidence and replay the original PASS/FAIL/INVALID verdict idempotently.

The BodySense fourth review was recovered from `RUNNING` to its original `INVALID -> STALE` state using this path; no verdict was changed or invented.

### 9. Infrastructure-invalid reviews can exhaust ordinary review attempts

After the fourth review was correctly restored as `STALE`, the normal review-attempt budget was exhausted even though the latest `INVALID` was caused by Pixel environment context rather than product quality.

The existing explicit `retry_review` recovery path is appropriate for operator recovery and preserves the same implementation candidate. It was used to create a fifth independent review at exact SHA `7d250eb...` after the workspace-pinning fix.

Follow-up: review resource/environment failures should be classified before consuming the same budget used for substantive independent reviews.

### 10. Canonical-only release provenance conflicts with active parallel canonical edits

The standard V4 release script correctly refuses to release a source SHA that is not the canonical repository HEAD. During this incident, the canonical Pixel repository contained a separate active uncommitted change set touching overlapping control-plane files. Stashing or moving canonical HEAD would have interfered with another writer.

For the immediate recovery, `fe58a20` was built and fully tested in an isolated clean worktree, the durable DB was backed up, and only its verified `dist` artifact was synchronized into the already-configured service root before restart. This is an emergency assisted hotfix, not the desired steady-state release procedure.

Follow-up design:

- support a dedicated clean release worktree/ref whose reviewed source SHA is explicitly attested;
- keep canonical dirty-state protection;
- preserve source-SHA/artifact-SHA/DB-backup provenance without requiring the developer's mutable canonical checkout to be moved.

## Design lessons

1. Provider liveness, execution completion, workspace evidence, review verdict, integration, and delivery are separate durable facts.
2. A provider session must never be marked `SUCCEEDED` merely to satisfy downstream invariants.
3. Exact workspace identity is part of the execution contract. Reviewer discovery outside it is a provenance failure.
4. `INVALID` means review infrastructure/tooling was inconclusive; it is not a product `FAIL` and must not trigger product repair findings.
5. Valuable dirty work should be recoverable in the same owned workspace, but only through deterministic clean-commit/evidence gates.
6. Every transition after an external side effect must be replayable. Terminal provider completion followed by a persistence interruption must not create a permanent `RUNNING` aggregate.
7. Review/provider route health should influence attempt accounting so quota/auth/transport failures do not masquerade as review effort.
8. Emergency deployment from an isolated worktree needs a first-class provenance-safe release mechanism; manual artifact copy must remain exceptional and auditable.

## Implemented Pixel fixes during this BodySense closure

- `9fdf316` — allow and probe BodySense canonical integration in the service sandbox.
- `f9cc8af` — adopt deterministic verified work from a paused owned implementation workspace.
- `5c74e5a` — safely abort a paused stalled provider attempt without fabricating completion.
- `fe58a20` — pin exact review workspace, accept evidence-backed operator-adopted implementations in review invariants, and recover terminal review verdict persistence.

## Remaining follow-ups

These should be converted into focused Pixel tickets after the BodySense plan is delivered:

- enforce tool cwd at runtime, not only in prompts;
- add meaningful-progress/stall detection distinct from heartbeat;
- classify provider/auth/quota/transport/environment failures separately from product review attempts;
- model completion origin (`provider` vs `operator-adoption`) explicitly instead of deriving it only from recovery evidence;
- make terminal review verdict replay automatic during plan reconciliation;
- add provenance-safe release from a dedicated clean release worktree/ref;
- add route-health preflight so known-broken review resources are skipped before a review attempt is created;
- add a production regression fixture reproducing a reviewer conversation whose metadata has the correct workspace while its terminal begins outside that workspace.

## Closure criteria for this incident

Closure status as of the direct-operator handoff:

1. HDREV-002 conclusive independent review at exact candidate SHA: **DONE / PASS**.
2. HDREV-002 integration: **DONE** at `7d250eb667080b5f4c46284ddd9dca588969b08a`.
3. HDREV-003 implementation, blocking bbox repair, independent re-review and integration: **DONE** at `4d69acd05d3e242d90164e418e38b0c234e0dfb6`.
4. BodySense delivery PR #165: **DONE**. Direct follow-up `a53052129a95ab017be3bd8b427ab4cc0b95d028` aligned the stale Assessment-v5 E2E/current docs; all required GitHub checks passed and PR #165 merged to `main` as `a82da464f109c407e66328d9f9aff94a01589629`.
5. This Pixel incident remains **OPEN** until the P0 reliability items above are converted into implementation work and verified independently of BodySense delivery.

## Additional failures discovered during final HDREV-003 and delivery closure

### 11. Persisted Go toolchain was not guaranteed to be discoverable by Agent PATH

The Go 1.26 toolchain remained present under the persistent OpenHands state volume, but a rebuilt/running OpenHands container did not expose it on the builtin reviewer's effective `PATH`. Earlier installation probes only proved the absolute toolchain path existed, not that an Agent terminal could execute `go` normally.

Required correction:

- release probes must execute `command -v go` and `go version` through the same runtime path used by Agent terminal tools;
- Compose/runtime configuration drift must be detected and converged, not assumed from checked-in configuration;
- container recreation must be blocked while unrelated Pixel executions are active unless explicitly coordinated.

### 12. Reviewer/provider can finish engineering work but omit the final completion transition

This incident reproduced the same finalization failure in both implementation and independent review:

- code/tests or review evidence were complete;
- the workspace/evidence was clean and exact;
- the provider session kept heartbeating `RUNNING` because it never invoked the expected FinishTool/final completion transition.

`855c61c` added strict adoption of already-written independent review evidence. This is a recovery mechanism, not a substitute for fixing provider finalization reliability.

Required correction:

- detect `evidence-complete + no meaningful provider action` and request finalization automatically;
- after a bounded grace period, transition through an evidence-verified completion path rather than heartbeat forever;
- never synthesize review content or provider success.

### 13. Review provenance rules were duplicated downstream and drifted apart

After review persistence correctly accepted an operator-adopted implementation, `PlanAutomationRuntime.acceptReviewedCandidate()` independently re-applied the older `providerStatus === SUCCEEDED` rule. A real independent PASS therefore still could not integrate.

`3765c4e` corrected this path. The broader lesson is that provenance acceptance must have one canonical invariant; downstream orchestration should consume that decision rather than reimplementing an older subset of it.

### 14. Provider `SUCCEEDED` with zero implementation was initially treated as terminal product failure

An implementation provider returned `SUCCEEDED` without changing the workspace. Workspace verification correctly emitted `WORKSPACE_IMPLEMENTATION_NOOP`, but the orchestration layer initially treated this as unrecoverable and failed the plan instead of trying the next route.

`58023b7` made no-op implementation outcomes retryable while retaining fail-closed behavior for invalid revision/provenance failures.

Required correction beyond the patch: route health/quality telemetry should penalize providers that repeatedly report successful no-op work.

### 15. Terminal execution dependency caches exhausted the host and blocked reviewed integration

During HDREV-003 closure the GCP Dev root filesystem reached 100%. The immediate contributors included terminal BodySense execution workspaces retaining roughly 0.9-1.3 GiB each of `node_modules` + `.venv`, plus about 13.4 GiB of Docker build cache.

The integration failure presented as generic `WORKSPACE_GIT_COMMAND_FAILED`; an exact reproduction of the bundle handoff exposed the real error: `No space left on device`.

Safe recovery removed only ignored dependency/build caches from terminal executions plus Docker build cache, preserving Git repositories, exact candidate objects and completion evidence. The host recovered to about 13 GiB free, after which the already-reviewed `4d69acd...` candidate integrated without any product change.

Required correction:

- disk-capacity preflight before workspace provisioning, dependency sync, review snapshot and integration bundle creation;
- terminal-workspace retention tiers that preserve Git/evidence while aggressively pruning `node_modules`, Python venvs, build outputs and report artifacts;
- typed `ENOSPC` propagation instead of collapsing it into `WORKSPACE_GIT_COMMAND_FAILED`;
- host-level high-watermark GC for Docker/build caches with active-execution protection.

This incident should be read together with `docs/analysis/2026-08-30-workspace-storage-forensics.md`.

### 16. Delivery governance was not preflighted before opening the PR

The reviewed HDREV-002 commit used the valid domain-oriented message:

```text
feat(assessment): admit reviewed document evidence
```

but repository `commitlint.config.ts` did not yet allow the `assessment` scope. Pixel only discovered the mismatch after PR #165 was opened and GitHub `commit-lint` failed.

The fix was intentionally additive (`assessment` only) and did not rewrite independently reviewed Health Document SHAs. A separate reviewed follow-up commit `3f9b51b...` updated commitlint governance.

Required correction:

- execute repository-required commit/message governance against the exact delivery range before PR creation;
- when a required check can be reproduced locally, fail delivery preflight with the concrete rule and command;
- avoid forcing a choice between rewriting reviewed SHA history and creating an extra delivery follow-up.

### 17. Required CI failure did not automatically become a bounded repair objective

After PR #165, `Browser longitudinal health E2E child` failed because its Assessment contract assertions still pinned the historical v4 configuration (`assess-config-e579030c2b8b540c` / `assessment-evidence-contract-v3`) while the reviewed product correctly served Assessment v5 (`assess-config-617534e4b17c512a` / `assessment-evidence-contract-v4`).

Pixel recorded `DELIVERY_REQUIRED_CHECK_FAILED` but did not turn the concrete CI failure into a bounded implementation/review repair loop. Operator intervention was required.

Required correction:

- retrieve and classify required-check failure evidence;
- create a delivery-repair execution scoped to the exact failing check and current delivery head;
- independently review the repair, then rerun delivery checks;
- distinguish infrastructure CI failure from code/test-contract failure.

### 18. FOLLOW_UP lineage cannot naturally compose multiple delivery repairs on the latest delivery head

The first delivery follow-up advanced PR #165 to `3f9b51b...`, but the original parent plan's `currentRevision` remained `4d69acd...`. A second child created from the original parent therefore based itself on `4d69acd...` rather than the already-reviewed `3f9b51b...` delivery head.

This makes chained delivery repairs awkward: a later follow-up can accidentally omit an earlier follow-up unless an operator manually chooses a different parent or reconstructs lineage.

Required correction:

- model a durable `deliveryHeadRevision` separately from the parent's product `currentRevision`;
- allow a delivery follow-up to base on the current verified/pending delivery head;
- make child supersession composable and linear without rewriting previously reviewed product revisions.

### 19. Resource-directory routing selected unhealthy/inappropriate implementation resources

A later bounded E2E follow-up was routed through resource-directory entries that failed before product work:

- two ACP routes failed during initialization with `ACPInitError: Connection closed`;
- a third route returned provider success but produced `WORKSPACE_IMPLEMENTATION_NOOP`.

No product code was produced, yet the child plan exhausted its implementation attempts and failed terminally.

Required correction:

- resource admission must include executable health probes for ACP startup, workspace attachment and minimal tool action;
- unhealthy resources should be quarantined before consuming a plan attempt;
- project/task capability matching must prevent semantically unrelated resource classes from being selected solely because they are nominally available.

### 20. Parent/child delivery projections can become stale after a shared branch advances

Once a delivery follow-up moved the shared PR branch head from `4d69acd...` to `3f9b51b...`, the original parent delivery retained its older immutable head and reported `DELIVERY_LOCAL_HEAD_STALE`, while the child owned the new head and CI state. This is logically understandable but operationally noisy and makes status reporting ambiguous.

Required correction:

- parent delivery status should explicitly project `SUPERSEDED_PENDING_CHILD` (or equivalent) once a follow-up owns the shared branch;
- status APIs should identify the authoritative delivery plan/head directly;
- automation must not repeatedly attempt stale parent delivery work while a child owns that delivery lineage.

## Updated implemented fixes observed during this incident

In addition to the earlier entries:

- `855c61c` — finalize independently written review evidence without inventing reviewer output.
- `3765c4e` — accept independently reviewed operator-adopted implementation candidates in plan integration.
- `58023b7` — treat provider-success/workspace-noop as a retryable implementation outcome.

## Priority follow-up backlog

### P0 — reliability / correctness

1. Single canonical provenance invariant shared by review, integration and delivery.
2. Automatic evidence-complete finalization recovery for implementation and review.
3. Delivery-head-aware chained repair/supersession.
4. Required-CI failure -> typed delivery repair -> independent re-review loop.
5. ENOSPC/capacity preflight and typed storage failures before integration.

### P1 — execution resource quality

1. Meaningful-progress detector distinct from heartbeat.
2. Route-health admission/quarantine for auth/quota/transport/ACP-init failures.
3. Runtime-enforced exact workspace cwd.
4. Agent-visible toolchain convergence probe (`command -v`, version, execution), not file-exists probes.
5. Retry budgets that do not charge infrastructure-invalid attempts as product attempts.

### P1 — storage and lifecycle

1. Terminal workspace cache pruning while preserving Git/evidence.
2. Docker/build-cache high-watermark GC with active-execution protection.
3. Workspace storage accounting exposed in runtime status/alerts.

## Operator decision on 2026-09-03

After the failures above, BodySense PR #165 closure was intentionally removed from Pixel execution. The stale Assessment-v5 E2E contract and current architecture documentation were completed directly on GCP Dev in `a53052129a95ab017be3bd8b427ab4cc0b95d028`. Local validation included Web typecheck/lint/build, 212/212 Web unit tests, targeted production-shaped Assessment Playwright 2/2 PASS, and full PR-range commitlint. GitHub CI then passed every required lane, including the 10-test Browser longitudinal health E2E child, Experience Oracle, Quality Oracle, Database Oracle, Governance Oracle, Delivery Observation and commit-lint. PR #165 merged as `a82da464f109c407e66328d9f9aff94a01589629`.

This is an operational containment decision: accepted/reviewed BodySense product revisions were preserved, while Pixel's defects remain open here instead of being allowed to keep consuming the product delivery loop.
