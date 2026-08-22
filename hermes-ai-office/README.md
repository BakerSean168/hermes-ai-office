# Hermes AI Office

AI Office is the Hermes-facing development execution facade.

```text
Hermes Brain -> AI Office V3 -> OpenHands -> LiteLLM
```

The plugin intentionally has no parallel provider database and no direct coding-harness placement path.

## Tools

- `ai_office_run_phase`
- `ai_office_get_execution`
- `ai_office_continue_execution`
- `ai_office_cancel_execution`
- `ai_office_list_active`
- `ai_office_list_providers`

The only hook is `pre_llm_call`, which tells the Hermes Brain when to delegate development work and where provider authority lives.

## Development protocol

- `INVESTIGATE_PLAN`
- `IMPLEMENT`
- `VERIFY_REVIEW`
- `IMPLEMENT_FIX`
- `FINALIZE`

Review results must begin with exactly `PASS` or `FAIL`. A FAIL review can enter `IMPLEMENT_FIX`; a PASS review can enter `FINALIZE`.

## Dashboard

AI Office exposes two views:

- **Overview** — active tasks, full execution history, start time, live elapsed time, duration, token usage, cost, route, readiness, and runtime health.
- **Analytics** — aggregates by project, logical model, physical model, provider/channel, and phase.

Provider configuration is managed in LiteLLM Admin. AI Office reads the LiteLLM registry and spend logs but never duplicates provider mutation.
