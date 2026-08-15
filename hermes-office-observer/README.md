# Hermes Office Observer

A tiny Hermes plugin that emits orchestration telemetry to the local
`hermes-office-bridge` at `http://127.0.0.1:8787/api/observer`.

It observes:

- `subagent_start` / `subagent_stop` for exact Hermes parent-child lineage.
- `pre_tool_call` / `post_tool_call` only when `terminal` launches Codex or OpenCode.

The plugin intentionally does **not** persist raw Codex/OpenCode prompts or raw tool
results. Runtime commands are reduced to labels such as `codex exec …` and
`opencode run --model provider/model …`.

## Install

Copy or symlink this directory to:

```text
~/.hermes/plugins/hermes-office-observer/
```

For the Hermes container used by this project, `~/.hermes` resolves under
`/opt/data/.hermes`. Restart the relevant gateway process after installation.

Override the bridge endpoint with `HERMES_OFFICE_OBSERVER_URL` if needed.
