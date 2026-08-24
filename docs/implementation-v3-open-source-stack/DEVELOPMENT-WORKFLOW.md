# Development workflow

## Normal path

1. Start `INVESTIGATE_PLAN` when repository investigation is needed.
2. Start `IMPLEMENT` in an isolated writable workspace. Pass the plan execution as causal parent when applicable.
3. Start a fresh `VERIFY_REVIEW` over a read-only snapshot of the implementation workspace.
4. Review output must start with exactly `PASS` or `FAIL`.
5. `PASS` can transition only to deterministic batch integration.
6. `FAIL` can transition only to `IMPLEMENT_FIX`, reusing the implementation workspace with a single-writer lease.
7. Review the fix with a new `VERIFY_REVIEW`.
8. If the plan explicitly authorizes delivery, push the integrated revision,
   create or reuse its pull request, and wait for remote checks.
9. Failed pre-merge checks create a bounded `delivery-fix-N` batch which must
   pass the same independent review gate before the pull request is updated.
10. Merge through branch protection and verify checks on the merge revision.

Implementation is asynchronous by default. The Hermes Brain preserves `executionId` and recovers state through the AI Office execution tools.

## Invariants

- Review snapshots are read-only evidence.
- FINALIZE never starts a model worker.
- Polling timeout is observer state, never execution or plan state.
- A delivery plan cannot become `SUCCEEDED` without merge and post-merge check
  evidence.
- Post-merge check failure blocks the plan for operator incident handling; it
  never triggers an unbounded sequence of automatic main-branch changes.
- A caller cannot forge review meaning with `previousResult`.
- Provider/model selection is not encoded as a permanent worker identity.
