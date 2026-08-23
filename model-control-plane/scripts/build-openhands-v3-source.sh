#!/usr/bin/env bash
set -euo pipefail

REF="${OPENHANDS_AGENT_SDK_REF:-v1.39.1}"
EXPECTED_COMMIT="${OPENHANDS_AGENT_SDK_COMMIT:-bf57d16f3dde05b0b03fa0af3f7e0ae924043b80}"
CACHE_ROOT="${OPENHANDS_BUILD_CACHE_ROOT:-${HOME}/.cache/hermes-ai-office-v3/upstream}"
SOURCE_DIR="$CACHE_ROOT/software-agent-sdk-$REF"
IMAGE="${OPENHANDS_SOURCE_IMAGE:-hermes-openhands-agent-server:1.39.1-source}"
REPO="https://github.com/OpenHands/software-agent-sdk.git"

case "$(uname -m)" in
  x86_64|amd64) PLATFORM="linux/amd64" ;;
  aarch64|arm64) PLATFORM="linux/arm64" ;;
  *) echo "unsupported OpenHands build architecture: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$CACHE_ROOT"
if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  rm -rf "$SOURCE_DIR"
  git clone --filter=blob:none --no-checkout "$REPO" "$SOURCE_DIR"
fi

git -C "$SOURCE_DIR" fetch --depth 1 origin "refs/tags/$REF:refs/tags/$REF"
git -C "$SOURCE_DIR" checkout --detach --force "$REF"
ACTUAL_COMMIT=$(git -C "$SOURCE_DIR" rev-parse HEAD)
if [[ "$ACTUAL_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  echo "OpenHands source pin mismatch: expected $EXPECTED_COMMIT, got $ACTUAL_COMMIT" >&2
  exit 1
fi

docker build \
  --platform "$PLATFORM" \
  --file "$SOURCE_DIR/openhands-agent-server/openhands/agent_server/docker/Dockerfile" \
  --target source-minimal \
  --tag "$IMAGE" \
  --build-arg OPENHANDS_BUILD_GIT_SHA="$ACTUAL_COMMIT" \
  --build-arg OPENHANDS_BUILD_GIT_REF="$REF" \
  "$SOURCE_DIR"

echo "$IMAGE $ACTUAL_COMMIT $PLATFORM"
