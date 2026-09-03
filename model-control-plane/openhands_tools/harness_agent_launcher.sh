#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
if [[ -z "$mode" ]]; then
  echo "usage: harness_agent_launcher.sh <opencode|codex-acp|claude-acp|dsh-acp|zcode-acp> [agent args...]" >&2
  exit 2
fi
shift

execution_id="${HERMES_V3_EXECUTION_ID:-}"
case "$execution_id" in
  ""|*[!a-zA-Z0-9._-]*)
    echo "agent-harness launch requires a valid HERMES_V3_EXECUTION_ID" >&2
    exit 2
    ;;
esac

workspace_repo="${HERMES_V3_WORKSPACE_REF:-}"
expected_workspace_repo="/workspace/executions/$execution_id/repo"
if [[ "$workspace_repo" != "$expected_workspace_repo" ]]; then
  echo "agent-harness launch requires the execution-scoped HERMES_V3_WORKSPACE_REF" >&2
  exit 2
fi
if [[ ! -d "$workspace_repo" ]]; then
  echo "agent-harness execution workspace is missing: $workspace_repo" >&2
  exit 2
fi
cd -- "$workspace_repo"
# Execution-scoped harness state must stay isolated even when IMPLEMENT_FIX reuses
# an earlier implementation/adoption workspace.
execution_root="/workspace/executions/$execution_id"
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
  zcode-acp)
    # ZCode has no provider-native role in this path. Start it with a fresh,
    # execution-scoped home and an OpenAI-compatible LiteLLM configuration.
    # Deliberately discard inherited OAuth/session variables: this mode must
    # never discover or reuse a developer's ZCode credential store.
    zcode_root="$root/zcode"
    zcode_home="$zcode_root/home"
    zcode_config_home="$zcode_root/config"
    zcode_config="$zcode_config_home/config.json"
    mkdir -p "$zcode_home" "$zcode_config_home"
    chmod 0700 "$zcode_root" "$zcode_home" "$zcode_config_home"
    zcode_key="${AI_OFFICE_LITELLM_API_KEY:-${ZCODE_API_KEY:-}}"
    zcode_base="${AI_OFFICE_LITELLM_BASE_URL:-${ZCODE_BASE_URL:-}}"
    zcode_model="${AI_OFFICE_AGENT_MODEL:-${ZCODE_MODEL:-}}"
    if [[ -z "$zcode_key" || -z "$zcode_base" || -z "$zcode_model" ]]; then
      echo "zcode-acp launch requires LiteLLM key, base URL and model" >&2
      exit 2
    fi
    case "$zcode_base" in
      http://*|https://*) ;;
      *) echo "zcode-acp launch requires an HTTP(S) LiteLLM base URL" >&2; exit 2 ;;
    esac
    case "$zcode_model" in
      *[!a-zA-Z0-9._:/-]*) echo "zcode-acp launch received an invalid model" >&2; exit 2 ;;
    esac
    unset ZCODE_AUTH_TOKEN ZCODE_OAUTH_TOKEN ZCODE_ACCESS_TOKEN ZCODE_USER_TOKEN
    unset OPENAI_API_KEY OPENAI_BASE_URL OPENAI_API_BASE
    export HOME="$zcode_home"
    export XDG_CONFIG_HOME="$zcode_config_home"
    export ZCODE_HOME="$zcode_home"
    export ZCODE_CONFIG="$zcode_config"
    export ZCODE_CONFIG_PATH="$zcode_config"
    export ZCODE_API_KEY="$zcode_key"
    export ZCODE_BASE_URL="$zcode_base"
    export ZCODE_MODEL="$zcode_model"
    export OPENAI_API_KEY="$zcode_key"
    export OPENAI_BASE_URL="$zcode_base"
    /usr/local/bin/python3 - "$zcode_config" <<'PY'
import json
import os
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
target.write_text(json.dumps({
    "provider": "openai-compatible",
    "baseUrl": os.environ["ZCODE_BASE_URL"],
    "apiKey": os.environ["ZCODE_API_KEY"],
    "model": os.environ["ZCODE_MODEL"],
}) + "\n")
target.chmod(0o600)
PY
    exec /openhands-state/tooling/node_modules/.bin/zcode-acp-server "$@"
    ;;
  *)
    echo "unsupported Agent Harness launch mode: $mode" >&2
    exit 2
    ;;
esac
