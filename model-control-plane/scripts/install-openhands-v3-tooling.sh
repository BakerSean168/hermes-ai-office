#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${OPENHANDS_V3_CONTAINER:-hermes-openhands-v3}"
TOOL_ROOT="${OPENHANDS_TOOL_ROOT:-/openhands-state/tooling}"
DSH_ROOT="${OPENHANDS_DSH_ROOT:-/openhands-state/dsh-cli}"
HARNESS_RUNTIME_LOCK="${HARNESS_RUNTIME_LOCK:-/opt/agent-harness/runtime.lock.json}"
runtime_lock_version() {
  local name="$1"
  docker exec "$CONTAINER" node -e '
    const fs = require("node:fs");
    const [file, name] = process.argv.slice(1);
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    const version = lock?.runtimes?.[name]?.version;
    if (!version || typeof version !== "string") process.exit(1);
    process.stdout.write(version);
  ' "$HARNESS_RUNTIME_LOCK" "$name"
}
OPENCODE_VERSION="${OPENCODE_VERSION:-$(runtime_lock_version opencode)}"
CODEX_ACP_VERSION="${CODEX_ACP_VERSION:-1.6.2}"
CLAUDE_ACP_VERSION="${CLAUDE_ACP_VERSION:-0.70.0}"
ACP_SDK_VERSION="${ACP_SDK_VERSION:-1.4.0}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-$(runtime_lock_version codex)}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-$(runtime_lock_version claude)}"
DSH_VERSION="${DSH_VERSION:-$(runtime_lock_version dsh)}"
DSH_ACP_VERSION="${DSH_ACP_VERSION:-0.10.0}"
ZCODE_ACP_VERSION="${ZCODE_ACP_VERSION:-0.11.5}"
ZCODE_CLI_VERSION="${ZCODE_CLI_VERSION:-$(runtime_lock_version zcode)}"
ZCODE_DESKTOP_VERSION="${ZCODE_DESKTOP_VERSION:-3.10.2}"
ZCODE_APPIMAGE_SHA256="${ZCODE_APPIMAGE_SHA256:-6f4bad68aa1a69026e8a45d0a9df25f18683bc9a417af483105dcbef448bab3f}"
ZCODE_APPIMAGE_URL="${ZCODE_APPIMAGE_URL:-https://cdn-zcode.z.ai/zcode/electron/releases/${ZCODE_DESKTOP_VERSION}/linux-x64/ZCode-${ZCODE_DESKTOP_VERSION}-linux-x64.AppImage}"
ZCODE_CLI_ROOT="${OPENHANDS_ZCODE_CLI_ROOT:-/openhands-state/zcode-cli}"
ZCODE_CLI_BIN="$ZCODE_CLI_ROOT/zcode.cjs"
OPENHANDS_STATE_HOST_ROOT="${OPENHANDS_STATE_HOST_ROOT:-$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/openhands-state"}}{{.Source}}{{end}}{{end}}')}"
[[ -n "$OPENHANDS_STATE_HOST_ROOT" && -d "$OPENHANDS_STATE_HOST_ROOT" ]] || {
  echo "cannot resolve OpenHands persistent state host root" >&2
  exit 1
}
ZCODE_CLI_HOST_ROOT="$OPENHANDS_STATE_HOST_ROOT/zcode-cli"
CODEGRAPH_VERSION="${CODEGRAPH_VERSION:-1.5.0}"
MCP_REMOTE_VERSION="${MCP_REMOTE_VERSION:-0.7.0}"
NX_MCP_VERSION="${NX_MCP_VERSION:-0.25.0}"
COREPACK_PNPM_VERSIONS="${COREPACK_PNPM_VERSIONS:-10.32.1 11.17.0 11.20.0}"
GO_TOOLCHAIN_VERSION="${OPENHANDS_GO_TOOLCHAIN_VERSION:-1.26.0}"
GO_TOOLCHAIN_ROOT="${OPENHANDS_GO_TOOLCHAIN_ROOT:-/openhands-state/toolchains/go-${GO_TOOLCHAIN_VERSION}}"
GO_TOOLCHAIN_IMAGE="${OPENHANDS_GO_TOOLCHAIN_IMAGE:-golang:${GO_TOOLCHAIN_VERSION}-bookworm}"

# Persist the exact Go toolchain needed by BodySense inside the existing
# OpenHands state volume instead of mutating the upstream-pinned Agent image.
# The source image is version-pinned and the installed binary self-reports the
# expected version before the installer succeeds.
current_go="$(docker exec --user 10001:10001 "$CONTAINER"   "$GO_TOOLCHAIN_ROOT/bin/go" version 2>/dev/null || true)"
if [[ "$current_go" != "go version go${GO_TOOLCHAIN_VERSION} "* ]]; then
  docker run --rm -i --volumes-from "$CONTAINER" "$GO_TOOLCHAIN_IMAGE" \
    sh -s -- "$GO_TOOLCHAIN_ROOT" <<'SH'
set -eu
target="$1"
tmp="${target}.tmp.$$"
rm -rf "$tmp"
mkdir -p "$tmp"
cp -a /usr/local/go/. "$tmp/"
chmod -R a+rX "$tmp"
rm -rf "$target"
mv "$tmp" "$target"
SH
fi
actual_go="$(docker exec --user 10001:10001 "$CONTAINER" "$GO_TOOLCHAIN_ROOT/bin/go" version)"
case "$actual_go" in
  "go version go${GO_TOOLCHAIN_VERSION} "*) ;;
  *) echo "OpenHands Go toolchain expected go${GO_TOOLCHAIN_VERSION}, got: $actual_go" >&2; exit 1 ;;
esac
docker exec --user 10001:10001 "$CONTAINER" test -x "$GO_TOOLCHAIN_ROOT/bin/gofmt"
printf '%-20s%s\n' "go" "$actual_go"

# ZCode's ACP bridge is an adapter around the official desktop-bundled headless
# backend (`resources/glm/zcode.cjs`). Persist only that 12 MB backend entry in
# OpenHands state; do not install or launch the Electron desktop application.
# The source AppImage, SHA256 and backend version are all pinned so upstream
# replacement or incompatible CLI drift fails closed during release.
current_zcode="$(docker exec --user 10001:10001 "$CONTAINER" "$ZCODE_CLI_BIN" --version 2>/dev/null | head -1 || true)"
if [[ "$current_zcode" != "$ZCODE_CLI_VERSION" ]]; then
  zcode_appimage="$(mktemp /tmp/zcode-appimage.XXXXXX)"
  zcode_extract="$(mktemp -d /tmp/zcode-extract.XXXXXX)"
  cleanup_zcode() { rm -f "$zcode_appimage"; rm -rf "$zcode_extract"; }
  trap cleanup_zcode EXIT
  curl -fL --retry 3 --connect-timeout 10 --max-time 240 "$ZCODE_APPIMAGE_URL" -o "$zcode_appimage"
  printf '%s  %s\n' "$ZCODE_APPIMAGE_SHA256" "$zcode_appimage" | sha256sum -c -
  chmod 0755 "$zcode_appimage"
  (
    cd "$zcode_extract"
    "$zcode_appimage" --appimage-extract resources/glm/zcode.cjs >/dev/null
  )
  extracted="$zcode_extract/squashfs-root/resources/glm/zcode.cjs"
  [[ -s "$extracted" ]] || { echo "ZCode backend extraction failed" >&2; exit 1; }
  extracted_version="$(/usr/bin/node "$extracted" --version | head -1)"
  [[ "$extracted_version" == "$ZCODE_CLI_VERSION" ]] || {
    echo "ZCode backend expected $ZCODE_CLI_VERSION, got: $extracted_version" >&2
    exit 1
  }
  install -d -o 10001 -g 10001 -m 0755 "$ZCODE_CLI_HOST_ROOT"
  install -o 10001 -g 10001 -m 0755 "$extracted" "$ZCODE_CLI_HOST_ROOT/zcode.cjs.tmp"
  mv "$ZCODE_CLI_HOST_ROOT/zcode.cjs.tmp" "$ZCODE_CLI_HOST_ROOT/zcode.cjs"
  cleanup_zcode
  trap - EXIT
fi
docker exec --user 10001:10001 "$CONTAINER" /usr/local/bin/node -e "new (require('node:sqlite').DatabaseSync)(':memory:')"
actual_zcode="$(docker exec --user 10001:10001 "$CONTAINER" "$ZCODE_CLI_BIN" --version | head -1)"
[[ "$actual_zcode" == "$ZCODE_CLI_VERSION" ]] || { echo "ZCode backend version drift: $actual_zcode" >&2; exit 1; }
printf '%-20s%s\n' "zcode" "$actual_zcode"

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

# ZCode ACP receives execution-scoped provider/MCP state from the V4 launcher;
# the official headless backend above is version-governed by Agent Harness and
# no desktop credential/config is mounted.
