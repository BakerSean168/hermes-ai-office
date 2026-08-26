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

### P3 — GitHub governance checks

Status: NEXT

- Publish one exact-head aggregate check first: `Hermes / PR Governance`.
- Project durable plan/review state into queued/in-progress/success/failure/neutral conclusions.
- Include bounded findings/evidence links without exposing secrets or raw prompts.
- Never mark a stale head SHA green after a synchronize event.
- Keep branch protection activation as a separate operator decision.

### P4 — Event ingestion and Jules adapter

Status: PENDING

- Add signed GitHub webhook ingestion or an equivalent authenticated event bridge.
- Map `pull_request.opened`, `reopened`, and `synchronize` to the same P2 intake contract.
- Detect/record Jules provenance without trusting its problem statement.
- Keep Jules REST API behind an adapter because the API is versioned independently.

### P5 — Governed rollout

Status: PENDING

- Pilot on Digital Biome in review-only/check-reporting mode.
- Measure problem precision, false positives, first-pass approval, repair rounds,
  reviewer disagreement, CI regressions, and rollback rate.
- Enable branch-protection requirements only after reliability evidence is sufficient.
- Consider auto-merge only as a later, separately authorized policy.
