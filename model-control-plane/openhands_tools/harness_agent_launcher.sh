#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
if [[ -z "$mode" ]]; then
  echo "usage: harness_agent_launcher.sh <opencode|codex-acp|claude-acp|dsh-acp> [agent args...]" >&2
  exit 2
fi
shift

case "$PWD" in
  /workspace/executions/*/repo) ;;
  *)
    echo "agent-harness launch requires an isolated /workspace/executions/<id>/repo workspace" >&2
    exit 2
    ;;
esac

execution_root="$(dirname -- "$PWD")"
harness_home="$execution_root/.agent-harness/home"
harness_state="$execution_root/.agent-harness/state"
harness_share="$execution_root/.agent-harness/share"
harnessctl="/opt/agent-harness/bin/harnessctl.py"

if [[ ! -f "$harnessctl" ]]; then
  echo "agent-harness controller is not mounted: $harnessctl" >&2
  exit 2
fi

mkdir -p "$harness_home" "$harness_state" "$harness_share"
chmod 0700 "$execution_root/.agent-harness" "$harness_home" "$harness_state" "$harness_share" 2>/dev/null || true

export HOME="$harness_home"
export AGENT_HARNESS_STATE="$harness_state"
export AGENT_HARNESS_SHARE="$harness_share"
export PATH="/openhands-state/tooling/node_modules/.bin:/openhands-state/dsh-cli/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"

prepare_root() {
  local host="$1" payload
  payload="$(/usr/local/bin/python3 "$harnessctl" \
    --state-root "$harness_state" \
    prepare "$PWD" --profile openhands --host "$host" --execution --json)"
  printf '%s' "$payload" | /usr/local/bin/python3 -c \
    'import json,sys; p=json.load(sys.stdin); assert p["admission"]["status"]=="READY"; print(p["environment"]["root"])'
}

case "$mode" in
  opencode)
    # AI Office owns provider/model routing; Agent Harness owns Skills, MCP and
    # project instructions. Use the fixed provider config as the base layer and
    # materialize the effective project capabilities over it for this execution.
    mkdir -p "$HOME/.config/opencode"
    cp /etc/hermes-ai-office-v3/opencode.json "$HOME/.config/opencode/opencode.json"
    chmod 0600 "$HOME/.config/opencode/opencode.json"
    unset OPENCODE_CONFIG
    root="$(prepare_root opencode)"
    export XDG_CONFIG_HOME="$root/xdg"
    exec /openhands-state/tooling/node_modules/.bin/opencode "$@"
    ;;
  codex-acp)
    root="$(prepare_root codex)"
    export CODEX_HOME="$root/codex"
    exec /openhands-state/tooling/node_modules/.bin/codex-acp "$@"
    ;;
  claude-acp)
    root="$(prepare_root claude)"
    export HOME="$root/claude/home"
    export CLAUDE_CONFIG_DIR="$root/claude/home/.claude"
    exec /openhands-state/tooling/node_modules/.bin/claude-agent-acp "$@"
    ;;
  dsh-acp)
    root="$(prepare_root dsh)"
    export DSH_HOME="$root/dsh/home"
    export DSH_BIN="/openhands-state/dsh-cli/node_modules/.bin/dsh"
    # dsh-acp-server can bootstrap its profile lazily, but doing that inside the
    # ACP stdio process races the client initialize handshake in fresh execution
    # environments. Materialize the profile first, then exec a pure ACP server.
    if [[ ! -d "$DSH_HOME/profiles/acp" ]]; then
      "$DSH_BIN" plugin --profile acp add /openhands-state/tooling/node_modules/dsh-acp-server \
        >/dev/null
    fi
    exec /openhands-state/tooling/node_modules/.bin/dsh-acp-server \
      --patch "$root/dsh/capabilities.patch.yml" "$@"
    ;;
  *)
    echo "unsupported Agent Harness launch mode: $mode" >&2
    exit 2
    ;;
esac
