# Autonomous Pull Request Governance

Status: IN PROGRESS
Owner: Hermes AI Office V3 Control Plane
Base revision: `55c0d6f`
Project key: `pixel-agents`
Pilot project: `digital-biome`
Created: 2026-08-26

## Objective

Extend the existing AI Office execution closure into a proposer-verifier PR
governance loop without changing the normal task-first development path.
Externally authored changes (initially GitHub PRs, later Jules PRs) must be
adopted as immutable Git evidence, independently reviewed, repaired only when a
real blocking defect exists, and re-reviewed before GitHub governance reports a
passing result.

Pixel Agent is an optional observer/operator surface. The durable source of
truth remains the V3 control plane, execution links, plan events, Git revisions,
and GitHub checks.

## Protected compatibility boundary

The existing default path remains:

```text
TASK -> IMPLEMENT -> VERIFY_REVIEW -> IMPLEMENT_FIX? -> VERIFY_REVIEW -> delivery
```

The additive external path is:

```text
GitHub PR/Jules PR
  -> resolve exact Git evidence
  -> ADOPT_CHANGE
  -> VERIFY_REVIEW
     -> INVALID => block without writer
     -> FAIL    => IMPLEMENT_FIX -> fresh VERIFY_REVIEW
     -> PASS    => governance pass
```

No existing backend candidate order, normal task model routing, auto-merge
authorization, or production backend enablement may change as a side effect of
this plan.

## Acceptance criteria

1. Existing TASK plans remain IMPLEMENT-first and all existing regression tests pass.
2. External changes have first-class provenance instead of a fake IMPLEMENT execution.
3. External review distinguishes `INVALID` problem claims from valid problems with bad repairs.
4. Antigravity is an opt-in provider-native backend and never becomes a hidden default.
5. Consumer Antigravity auth is not copied into AI Office secrets or exposed to sibling workspaces.
6. Native review/repair is isolated to one bounded workspace and runs as the authenticated non-root user.
7. GitHub PR intake resolves the exact head revision and a current target-base revision without changing the canonical worktree.
8. PR text is metadata, not trusted instructions supplied to the reviewer.
9. Repeated intake of the same repository/PR/head revision returns the same durable plan.
10. GitHub checks expose the durable governance state for the exact PR head SHA.
11. A later PR synchronize event creates/reconciles governance for the new head SHA rather than approving stale evidence.
12. Webhook/Jules integration remains a thin event source over the same intake contract.
13. Auto-merge remains disabled until review/check reliability is separately proven.

## Batches

### P0 — Review-first external change state

Status: COMPLETE
Commit: `204c6f8`

- Add deterministic `ADOPT_CHANGE`.
- Persist additive `EXTERNAL_CHANGE` source metadata.
- Review first; start a writer only after a blocking review.
- `INVALID` rejects a false-positive change without repair.

### P1 — Provider-native Antigravity backend

Status: COMPLETE
Commit: `6ad0a88`

- Add explicit `PROVIDER_NATIVE` transport.
- Add opt-in Antigravity review/repair backends.
- Stream objectives through stdin; constrain review output with JSON Schema.
- Persist normalized terminal status and reported usage.
- Run `agy` as the authenticated `dev` identity inside a private mount namespace.
- Preserve OpenHands ownership while granting the bounded writer workspace group access when required.
- Real reviewer and writer smoke tests passed on GCP Dev.

### P2 — GitHub PR immutable intake

Status: COMPLETE

- Resolve PR identity through GitHub.
- Fetch `refs/pull/<n>/head` and current base branch into dedicated AI Office refs.
- Verify PR head again after fetch and verify current remote base with `ls-remote`.
- Reject races with `GITHUB_PR_CHANGED_DURING_INTAKE`.
- Use `repo + PR number + head SHA` as the natural durable idempotency key.
- Keep PR prose out of the reviewer objective.
- Real Digital Biome PR #31 intake smoke passed without changing its worktree.

### P2.5 — Publish reviewed repairs back to the PR head

Status: COMPLETE

- A passing re-review of `IMPLEMENT_FIX` is not enough by itself; the reviewed repair must be published back to the same PR branch before governance can pass.
- Require the repair HEAD to be a clean descendant of the previously governed PR head.
- Import the reviewed repair through a durable `refs/ai-office/external/.../repairs/...` audit ref.
- Push with an exact `--force-with-lease=<old head SHA>` so a concurrent Jules/user update is never overwritten.
- Treat an already-visible exact reviewed repair as a successful crash replay, rebuilding the audit ref instead of misclassifying the control plane's own prior push as an external race.
- Fail closed for fork PR heads until a separately reviewed fork publication strategy exists.
- Persist the new externally visible PR head as `externalHeadRevision` for subsequent checks and event reconciliation.
- HARDENED: if GitHub PR metadata temporarily lags immediately after our repair push, do not persist a terminal governance fingerprint until the PR API observes the repaired head; genuine third-party synchronize heads still close the stale plan with `error`.

### P3 — GitHub governance status

Status: COMPLETE

- Publish one exact-head aggregate commit-status context: `Hermes / PR Governance`.
- Map durable plan state to `pending / success / failure / error` without exposing prompts or secrets.
- Persist the last published `(head SHA, plan status)` fingerprint so restarts do not duplicate unchanged status updates.
- Keep terminal plans eligible for periodic reconciliation until their final GitHub status is durably published.
- Re-read the pull request before publishing; if its head moved, mark the reviewed SHA `error` rather than ever publishing stale `success`.
- Use commit statuses for the first rollout because current GitHub Check Run writes require GitHub App authentication; the reporter remains an adapter so a later GitHub App can replace this transport without changing plan truth.
- Keep branch protection activation as a separate operator decision.

### P4 — Event ingestion and Jules adapter

Status: IN PROGRESS

- COMPLETE: add a constant-time shared-token authenticated event bridge for a trusted ingress that has already normalized GitHub delivery.
- COMPLETE: map `pull_request.opened`, `reopened`, and `synchronize` to the exact same immutable P2 intake contract; duplicates are idempotent and stale event heads coalesce to the current GitHub head.
- COMPLETE: detect `google-labs-jules[bot]` from authoritative GitHub PR metadata and record `producer=JULES` only as provenance; PR prose remains untrusted metadata.
- COMPLETE: isolate the alpha Jules REST API behind a narrow adapter for source discovery, session creation, and session lookup; `AUTO_CREATE_PR` is sent only when explicitly requested.
- COMPLETE: expose optional local control-plane Jules routes that fail closed with `JULES_API_UNCONFIGURED` when no root-owned API-key env file is provisioned.
- PENDING DEPLOYMENT: connect a real GitHub webhook-verifying ingress to the normalized bridge and provision `MODEL_CP_V3_GITHUB_EVENT_TOKEN`.
- PENDING DEPLOYMENT: provision a Jules API key under `MODEL_CP_V3_JULES_ENV_FILE` only if Hermes should create Jules sessions directly; Jules-owned Scheduled Tasks can continue producing PRs without this credential.

### P5 — Governed rollout

Status: PENDING

- Pilot on Digital Biome in review-only/check-reporting mode.
- Measure problem precision, false positives, first-pass approval, repair rounds,
  reviewer disagreement, CI regressions, and rollback rate.
- Enable branch-protection requirements only after reliability evidence is sufficient.
- Consider auto-merge only as a later, separately authorized policy.
