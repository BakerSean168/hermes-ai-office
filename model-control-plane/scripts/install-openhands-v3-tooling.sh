#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${OPENHANDS_V3_CONTAINER:-hermes-openhands-v3}"
TOOL_ROOT="${OPENHANDS_TOOL_ROOT:-/openhands-state/tooling}"
DSH_ROOT="${OPENHANDS_DSH_ROOT:-/openhands-state/dsh-cli}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.18.18}"
CODEX_ACP_VERSION="${CODEX_ACP_VERSION:-1.6.2}"
CLAUDE_ACP_VERSION="${CLAUDE_ACP_VERSION:-0.70.0}"
DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"
DSH_ACP_VERSION="${DSH_ACP_VERSION:-0.10.0}"
ZCODE_ACP_VERSION="${ZCODE_ACP_VERSION:-0.11.5}"

# Keep coding harness adapters in the persisted OpenHands state volume. The
# OpenHands image remains upstream-pinned; changing a harness does not rebuild it.
docker exec "$CONTAINER" sh -lc \
  "mkdir -p '$TOOL_ROOT' && npm install --prefix '$TOOL_ROOT' --no-audit --no-fund \
    'opencode-ai@$OPENCODE_VERSION' \
    '@agentclientprotocol/codex-acp@$CODEX_ACP_VERSION' \
    '@agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION' \
    'dsh-acp-server@$DSH_ACP_VERSION' \
    'zcode-acp-server@$ZCODE_ACP_VERSION' \
    >/tmp/ai-office-tooling-install.log 2>&1"

docker exec "$CONTAINER" sh -lc \
  "mkdir -p '$DSH_ROOT' && npm install --prefix '$DSH_ROOT' --no-audit --no-fund \
    '@deepseek-ai/dsh@$DSH_VERSION' >/tmp/dsh-cli-install.log 2>&1"

docker exec "$CONTAINER" test -x "$DSH_ROOT/node_modules/.bin/dsh"
printf '%-20s' "dsh"
docker exec "$CONTAINER" "$DSH_ROOT/node_modules/.bin/dsh" --version

for bin in opencode codex-acp claude-agent-acp dsh-acp-server zcode-acp-server; do
  docker exec "$CONTAINER" test -x "$TOOL_ROOT/node_modules/.bin/$bin"
  printf '%-20s' "$bin"
  docker exec "$CONTAINER" "$TOOL_ROOT/node_modules/.bin/$bin" --version 2>/dev/null \
    || docker exec "$CONTAINER" "$TOOL_ROOT/node_modules/.bin/$bin" --help 2>/dev/null | head -1 \
    || echo "installed"
done

# ZCode ACP is installed as a registered backend, but it requires the official
# ZCode desktop bundle/CLI and its own credentials. Production availability is
# controlled separately and stays disabled until that runtime probe succeeds.
