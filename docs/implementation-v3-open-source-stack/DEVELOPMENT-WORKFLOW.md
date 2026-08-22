# Development workflow

## Normal path

1. Start `INVESTIGATE_PLAN` when repository investigation is needed.
2. Start `IMPLEMENT` in an isolated writable workspace. Pass the plan execution as causal parent when applicable.
3. Start a fresh `VERIFY_REVIEW` over a read-only snapshot of the implementation workspace.
4. Review output must start with exactly `PASS` or `FAIL`.
5. `PASS` can transition only to deterministic `FINALIZE`.
6. `FAIL` can transition only to `IMPLEMENT_FIX`, reusing the implementation workspace with a single-writer lease.
7. Review the fix with a new `VERIFY_REVIEW`.

Implementation is asynchronous by default. The Hermes Brain preserves `executionId` and recovers state through the AI Office execution tools.

## Invariants

- Review snapshots are read-only evidence.
- FINALIZE never starts a model worker.
- A caller cannot forge review meaning with `previousResult`.
- Provider/model selection is not encoded as a permanent worker identity.
