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
4. Antigravity is an opt-in provider-native backend for trusted task input only and never becomes a hidden default; untrusted `EXTERNAL_CHANGE` plans must reject it before persistence.
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
Commit: `fb13606`

- Add deterministic `ADOPT_CHANGE`.
- Persist additive `EXTERNAL_CHANGE` source metadata.
- Review first; start a writer only after a blocking review.
- `INVALID` rejects a false-positive change without repair.

### P1 — Provider-native Antigravity backend

Status: COMPLETE
Commit: `79e6580`

- Add explicit `PROVIDER_NATIVE` transport.
- Add opt-in Antigravity review/repair backends for trusted task input; GitHub/Jules external-change governance remains on untrusted-input-safe Codex/Claude/OpenHands paths.
- Stream objectives through stdin; constrain review output with JSON Schema.
- Persist normalized terminal status and reported usage.
- Run `agy` as the authenticated `dev` identity inside a private mount + PID namespace; sandbox construction rejects root, requires the configured consumer home to live strictly below `/home` (the tree actually masked by the wrapper), and rejects a UID/GID that does not match that home owner. `setpriv` clears bounding, inheritable, and ambient capability sets, the root launch PATH excludes user-writable directories, and after masking the workspace root the wrapper explicitly re-enters the rebound workspace path so inherited cwd cannot retain access to hidden sibling workspaces. `unshare --pid --fork --kill-child=SIGKILL --mount-proc` makes cancellation contain even `setsid` descendants.
- Copy only the minimum Antigravity consumer-auth/config files into a per-execution private tmpfs; host auth state, prior conversations, brain state, and caches are not mounted writable and sibling workspaces cannot access them. Current `agy` 1.1.21 keeps provider auth and model-controlled file tools in the same process, and attack probes confirmed those tools can read the private OAuth copy, so this is **not** treated as a secret-safe boundary for untrusted repository input.
- Use an OpenHands-compatible shared workspace GID for native writers and re-normalize the terminal writer tree to group-writable permissions before another backend may reuse it; recursive permission reconciliation runs asynchronously so large workspaces cannot block the control-plane event loop.
- Reject `supports.write=false` backends at policy selection time for `IMPLEMENT` / `IMPLEMENT_FIX`, including explicit operator overrides. Mark both Antigravity backends `untrusted_external: false`; `DevelopmentExecutionService` rejects them for `EXTERNAL_CHANGE` before durable plan persistence, at fresh execution selection, and again against the actual persisted selection on replay so pre-gate crash residue cannot bypass the trust boundary after upgrade. Every batch of an external plan carries `changeOrigin=EXTERNAL`; only the first batch is special for the `ADOPT_CHANGE` entry phase.
- Aggregate routed execution-host health: a healthy default OpenHands host plus an unavailable enabled Antigravity host reports `DEGRADED` rather than hiding the unavailable backend.
- Real reviewer/writer/cancellation smoke tests passed on GCP Dev: trusted native execution verified `UID=1001`, shared workspace `GID=10001`, successful Gemini execution, unchanged host OAuth/conversation state, terminal handoff files normalized to `1001:10001` with group-write permission, and a deliberately `setsid`-detached child could not survive cancellation or write its delayed sentinel. Separate adversarial probes established the trusted-input-only OAuth limitation above.

### P2 — GitHub PR immutable intake

Status: COMPLETE

- Resolve PR identity through GitHub and reject lookalike remotes; only canonical `github.com` HTTPS/SSH remote forms are accepted for GitHub-governed intake, and every persisted GitHub-origin external head is required to be an immutable 40-hex SHA.
- Fetch `refs/pull/<n>/head` and current base branch into dedicated AI Office refs.
- Verify PR head SHA, head ref, and head repository again after fetch, and verify the fetched current base branch against `ls-remote`.
- Reject races with `GITHUB_PR_CHANGED_DURING_INTAKE`.
- Use `repo + PR number + head SHA` as the natural durable idempotency key.
- Keep PR prose out of the reviewer objective.
- Real Digital Biome PR #31 intake smoke passed without changing its worktree.

### P2.5 — Publish reviewed repairs back to the PR head

Status: COMPLETE

- A passing re-review of `IMPLEMENT_FIX` is not enough by itself; the reviewed repair must be published back to the same PR branch before governance can pass.
- Require the repair HEAD to be a clean descendant of the previously governed PR head.
- Import the reviewed repair through a durable `refs/ai-office/external/.../repairs/...` audit ref.
- Push with an exact `--force-with-lease=<old head SHA>` so a concurrent Jules/user update is never overwritten; repair publication independently revalidates the canonical fetch URL and every configured push URL as the same `github.com` repository, and if the lease races after the API precheck it re-reads the remote head and classifies a third-party update as `GITHUB_PR_CHANGED_DURING_REPAIR_PUBLICATION`.
- Root-created repair bundle scratch is ownership-reconciled to the repository owner before the owner-scoped `git bundle create/fetch` path runs.
- Treat an already-visible exact reviewed repair as a successful crash replay, rebuilding the audit ref instead of misclassifying the control plane's own prior push as an external race.
- Fail closed for fork PR heads until a separately reviewed fork publication strategy exists.
- Persist the new externally visible PR head as `externalHeadRevision` for subsequent checks and event reconciliation.
- HARDENED: if GitHub PR metadata temporarily lags immediately after our repair push, defer the status write entirely and do not persist a terminal governance fingerprint until the PR API observes the repaired head; genuine third-party synchronize heads still close the stale plan with `error`.
- HARDENED: every fresh review in the external-change entry batch retains `PASS / FAIL / INVALID` semantics, including the review after `IMPLEMENT_FIX`, so a later reviewer can still overturn an unsupported problem claim.

### P3 — GitHub governance status

Status: COMPLETE

- Publish one exact-head aggregate commit-status context: `Hermes / PR Governance`.
- Map durable plan state to `pending / success / failure / error` without exposing prompts or secrets.
- Persist the last published `(head SHA, plan status)` fingerprint so restarts do not duplicate unchanged status updates.
- Keep terminal plans eligible for periodic reconciliation until their final GitHub status is durably published.
- Re-read the pull request before and after publishing because GitHub commit-status POST is not conditional on PR head. If the head races after the precheck, revoke any just-posted green status on the reviewed SHA, write fail-closed `error` on the newly observed head, and re-read once more; an unstable head leaves the durable fingerprint stale so periodic reconciliation retries.
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
