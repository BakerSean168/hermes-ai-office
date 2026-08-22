#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${OPENHANDS_V3_CONTAINER:-hermes-openhands-v3}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.18.18}"
TOOL_ROOT="${OPENHANDS_TOOL_ROOT:-/openhands-state/tooling}"

# The tooling directory is on the persisted OpenHands state volume. Installing
# here keeps the upstream Agent Server image unmodified and makes the ACP binary
# available to all conversations without downloading it on every execution.
docker exec "$CONTAINER" sh -lc \
  "mkdir -p '$TOOL_ROOT' && npm install --prefix '$TOOL_ROOT' --no-audit --no-fund 'opencode-ai@$OPENCODE_VERSION' >/tmp/opencode-install.log 2>&1"

docker exec "$CONTAINER" "$TOOL_ROOT/node_modules/.bin/opencode" --version
