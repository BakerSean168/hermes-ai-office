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
expected_v3_workspace_repo="/workspace/executions/$execution_id/repo"
expected_v4_workspace_repo="/workspace/v4/executions/$execution_id/repo"
literal_worktree=false
if [[ "$workspace_repo" =~ ^/workspace/v4/plans/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/(items|reviews|repairs)/[A-Za-z0-9._-]+/repo$ ]]; then
  literal_worktree=true
fi
if [[ "$workspace_repo" != "$expected_v3_workspace_repo" && "$workspace_repo" != "$expected_v4_workspace_repo" && "$literal_worktree" != true ]]; then
  echo "agent-harness launch requires an execution-scoped workspace or an admitted V4 Plan worktree" >&2
  exit 2
fi
if [[ ! -d "$workspace_repo" ]]; then
  echo "agent-harness execution workspace is missing: $workspace_repo" >&2
  exit 2
fi
cd -- "$workspace_repo"
# Execution-scoped harness state must stay isolated even when IMPLEMENT_FIX reuses
# an earlier implementation/adoption workspace. Derive it only after the exact
# V3/V4 path admission above so arbitrary workspace roots remain rejected.
if [[ "$literal_worktree" == true ]]; then
  execution_root="${workspace_repo%/repo}/.executions/$execution_id"
else
  execution_root="${workspace_repo%/repo}"
fi
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
    ai_office_dsh_patch=/etc/hermes-ai-office-v3/dsh-acp-v3.patch.yml
    [[ -r "$ai_office_dsh_patch" ]] || {
      echo "dsh-acp launch requires the AI Office routing patch: $ai_office_dsh_patch" >&2
      exit 2
    }
    # The first overlay owns the immutable model/provider transport selected by
    # Pixel. Agent Harness is deliberately a second, capability-only overlay
    # for Skills/MCP/instructions; it must not become another routing authority.
    exec /openhands-state/tooling/node_modules/.bin/dsh-acp-server \
      --patch "$ai_office_dsh_patch" \
      --patch "$root/dsh/capabilities.patch.yml" "$@"
    ;;
  zcode-acp)
    root="$(prepare_root zcode)"
    # ZCode ACP reads provider credentials/models from ~/.zcode/v2/config.json
    # and MCP/skill state from ~/.zcode/cli/config.json. Agent Harness owns the
    # latter; this execution-scoped launcher writes only the selected LiteLLM
    # provider binding into the former.
    zcode_root="$root/zcode"
    zcode_home="$zcode_root/home"
    zcode_provider_dir="$zcode_home/.zcode/v2"
    zcode_provider_config="$zcode_provider_dir/config.json"
    mkdir -p "$zcode_home" "$zcode_provider_dir"
    chmod 0700 "$zcode_root" "$zcode_home" "$zcode_provider_dir"
    zcode_key="${AI_OFFICE_LITELLM_API_KEY:-${ZCODE_API_KEY:-}}"
    zcode_base="${AI_OFFICE_LITELLM_BASE_URL:-${ZCODE_BASE_URL:-}}"
    zcode_model="${AI_OFFICE_AGENT_MODEL:-${ZCODE_MODEL:-}}"
    zcode_model_family="${ZCODE_MODEL_FAMILY:-}"
    zcode_reasoning_effort="${ZCODE_REASONING_EFFORT:-high}"
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
    case "$zcode_model_family" in
      ""|*[!a-zA-Z0-9._:/-]*)
        [[ -z "$zcode_model_family" ]] || { echo "zcode-acp launch received an invalid model family" >&2; exit 2; }
        ;;
    esac
    case "$zcode_reasoning_effort" in
      low|medium|high|xhigh) ;;
      *) echo "zcode-acp launch received an invalid reasoning effort" >&2; exit 2 ;;
    esac
    unset ZCODE_AUTH_TOKEN ZCODE_OAUTH_TOKEN ZCODE_ACCESS_TOKEN ZCODE_USER_TOKEN
    unset OPENAI_API_KEY OPENAI_BASE_URL OPENAI_API_BASE ANTHROPIC_API_KEY
    export HOME="$zcode_home"
    export ZCODE_HOME="$zcode_home"
    export ZCODE_CONFIG="$zcode_provider_config"
    export ZCODE_CONFIG_PATH="$zcode_provider_config"
    export ZCODE_API_KEY="$zcode_key"
    export ZCODE_BASE_URL="$zcode_base"
    export ZCODE_MODEL="$zcode_model"
    export ZCODE_MODEL_FAMILY="$zcode_model_family"
    export ZCODE_REASONING_EFFORT="$zcode_reasoning_effort"
    export ZCODE_BIN="/openhands-state/zcode-cli/zcode.cjs"
    export ZCODE_NODE="/usr/local/bin/node"
    [[ -x "$ZCODE_BIN" ]] || { echo "zcode-acp backend runtime is missing: $ZCODE_BIN" >&2; exit 2; }
    /usr/local/bin/python3 - "$zcode_provider_config" <<'PY'
import json
import os
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
model = os.environ["ZCODE_MODEL"]
model_family = os.environ.get("ZCODE_MODEL_FAMILY", "")
reasoning_effort = os.environ.get("ZCODE_REASONING_EFFORT", "high")
model_config = {"name": model}
if model_family == "glm-current":
    # The physical LiteLLM route intentionally does not look like a native GLM
    # model id. Carry the logical family metadata separately so ZCode preserves
    # GLM-5.2's real reasoning levels instead of falling back to generic GLM
    # defaults while the wire model remains the exact selected route.
    thought = {
        "xhigh": "max",
        "high": "high",
        "medium": "high",
        "low": "nothink",
    }[reasoning_effort]
    model_config["reasoning"] = {
        "enabled": True,
        "variants": ["max", "high", "nothink"],
        "defaultVariant": thought,
    }
target.write_text(json.dumps({
    "provider": {
        "pixel-litellm": {
            "enabled": True,
            "kind": "openai-compatible",
            "name": "Pixel LiteLLM",
            "source": "custom",
            "options": {
                "baseURL": os.environ["ZCODE_BASE_URL"],
                "apiKey": os.environ["ZCODE_API_KEY"],
                "apiKeyRequired": True,
            },
            "models": {
                model: model_config,
            },
        },
    },
}, separators=(",", ":")) + "\n")
target.chmod(0o600)
PY
    exec /openhands-state/tooling/node_modules/.bin/zcode-acp-server "$@"
    ;;
  *)
    echo "unsupported Agent Harness launch mode: $mode" >&2
    exit 2
    ;;
esac
