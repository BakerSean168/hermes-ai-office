#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${OPENHANDS_V3_CONTAINER:-hermes-openhands-v3}"
TOOL_ROOT="${OPENHANDS_TOOL_ROOT:-/openhands-state/tooling}"
DSH_ROOT="${OPENHANDS_DSH_ROOT:-/openhands-state/dsh-cli}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.18.18}"
CODEX_ACP_VERSION="${CODEX_ACP_VERSION:-1.6.2}"
CLAUDE_ACP_VERSION="${CLAUDE_ACP_VERSION:-0.70.0}"
ACP_SDK_VERSION="${ACP_SDK_VERSION:-1.4.0}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.148.0}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.237}"
DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"
DSH_ACP_VERSION="${DSH_ACP_VERSION:-0.10.0}"
ZCODE_ACP_VERSION="${ZCODE_ACP_VERSION:-0.11.5}"
CODEGRAPH_VERSION="${CODEGRAPH_VERSION:-1.5.0}"
MCP_REMOTE_VERSION="${MCP_REMOTE_VERSION:-0.7.0}"
NX_MCP_VERSION="${NX_MCP_VERSION:-0.25.0}"
COREPACK_PNPM_VERSIONS="${COREPACK_PNPM_VERSIONS:-10.32.1 11.17.0 11.20.0}"

# Keep package-manager downloads deterministic and persistent across OpenHands
# container recreation. Each repository still selects its exact checked-in
# packageManager version; this only pre-populates Corepack's trusted cache.
docker exec --user 10001:10001 \
  -e COREPACK_HOME=/openhands-state/corepack \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e COREPACK_PNPM_VERSIONS="$COREPACK_PNPM_VERSIONS" \
  "$CONTAINER" sh -lc '
    set -eu
    mkdir -p "$COREPACK_HOME"
    for version in $COREPACK_PNPM_VERSIONS; do
      corepack install -g "pnpm@$version"
    done
  '

# Keep coding harness adapters in the persisted OpenHands state volume. The
# OpenHands image remains upstream-pinned; changing a harness does not rebuild it.
docker exec "$CONTAINER" sh -lc \
  "mkdir -p '$TOOL_ROOT' && npm install --prefix '$TOOL_ROOT' --no-audit --no-fund \
    'opencode-ai@$OPENCODE_VERSION' \
    '@agentclientprotocol/codex-acp@$CODEX_ACP_VERSION' \
    '@agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION' \
    '@agentclientprotocol/sdk@$ACP_SDK_VERSION' \
    '@openai/codex@$CODEX_CLI_VERSION' \
    '@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION' \
    'dsh-acp-server@$DSH_ACP_VERSION' \
    'zcode-acp-server@$ZCODE_ACP_VERSION' \
    '@colbymchenry/codegraph@$CODEGRAPH_VERSION' \
    'mcp-remote@$MCP_REMOTE_VERSION' \
    'nx-mcp@$NX_MCP_VERSION' \
    >/tmp/ai-office-tooling-install.log 2>&1"

current_dsh="$(docker exec "$CONTAINER" sh -lc \
  "'$DSH_ROOT/node_modules/.bin/dsh' --version 2>/dev/null | head -1" 2>/dev/null || true)"
if [[ "$current_dsh" != "$DSH_VERSION" ]]; then
  docker exec "$CONTAINER" sh -lc \
    "mkdir -p '$DSH_ROOT' && npm install --prefix '$DSH_ROOT' --no-audit --no-fund \
      '@deepseek-ai/dsh@$DSH_VERSION' >/tmp/dsh-cli-install.log 2>&1"
fi

docker exec "$CONTAINER" test -x "$DSH_ROOT/node_modules/.bin/dsh"
# DSH's DeepSeek adapter currently materializes a 256k request max_tokens when
# the deployment leaves maxTokens unset. LiteLLM owns provider/model output
# policy for AI Office, so omission must remain omission on the wire. Apply a
# version-pinned, drift-detecting vendor patch after every install/check.
docker exec "$CONTAINER" node \
  /opt/hermes-ai-office-tools/patch_dsh_no_default_max_tokens.mjs \
  "$DSH_ROOT/node_modules/@deepseek-ai/dsh-llm-deepseek"
docker exec "$CONTAINER" node \
  /opt/hermes-ai-office-tools/verify_dsh_no_default_max_tokens.mjs \
  "$DSH_ROOT/node_modules/@deepseek-ai/dsh-llm-deepseek"
printf '%-20s' "dsh"
docker exec "$CONTAINER" "$DSH_ROOT/node_modules/.bin/dsh" --version

for bin in opencode codex codex-acp claude claude-agent-acp dsh-acp-server zcode-acp-server codegraph mcp-remote nx-mcp; do
  docker exec "$CONTAINER" test -x "$TOOL_ROOT/node_modules/.bin/$bin"
  printf '%-20s' "$bin"
  docker exec "$CONTAINER" "$TOOL_ROOT/node_modules/.bin/$bin" --version 2>/dev/null \
    || docker exec "$CONTAINER" "$TOOL_ROOT/node_modules/.bin/$bin" --help 2>/dev/null | head -1 \
    || echo "installed"
done

# ZCode ACP is installed as a registered backend, but it requires the official
# ZCode desktop bundle/CLI and its own credentials. Production availability is
# controlled separately and stays disabled until that runtime probe succeeds.
