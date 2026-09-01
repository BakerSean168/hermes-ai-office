#!/usr/bin/env bash
set -euo pipefail

UNIT_NAME="hermes-model-control-plane.service"
OPENHANDS_UNIT_NAME="hermes-openhands-v3.service"
ROOT="/srv/hermes-personal"
SOURCE_DIR="${MODEL_CP_SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TARGET_DIR="$ROOT/model-control-plane"
DATA_DIR="$ROOT/data/model-control-plane"
BACKUP_DIR="$DATA_DIR/backups"
SECRETS_DIR="$ROOT/secrets"
WORKSPACE_DIR="/opt/data/hermes-ai-office-v3/workspaces"
V4_DB="$DATA_DIR/pixel-v4.sqlite"
UNIT_SOURCE="$SOURCE_DIR/deploy/gcp/hermes-model-control-plane.service"
UNIT_TARGET="/etc/systemd/system/$UNIT_NAME"
OPENHANDS_UNIT_SOURCE="$SOURCE_DIR/deploy/gcp/hermes-openhands-v3.service"
OPENHANDS_UNIT_TARGET="/etc/systemd/system/$OPENHANDS_UNIT_NAME"
OPENHANDS_ENV_SOURCE="$SOURCE_DIR/deploy/gcp/openhands-v3.env"
OPENHANDS_ENV_TARGET="$SECRETS_DIR/openhands-v3.env"
OPENHANDS_DIR="/opt/hermes-openhands-v3"
OPENHANDS_VENV="$OPENHANDS_DIR/venv"
OPENHANDS_SERVER_REF_FILE="$OPENHANDS_DIR/agent-server-ref"
EXPECTED_OPENHANDS_REF="commit:88c7c49becdc63ec8386f0506ad970b3c5339d23"

if [[ $EUID -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

for required in "$SOURCE_DIR/package.json" "$UNIT_SOURCE" "$OPENHANDS_UNIT_SOURCE" "$OPENHANDS_ENV_SOURCE"; do
  if [[ ! -f "$required" ]]; then
    echo "required deployment file missing: $required" >&2
    exit 1
  fi
done

if grep -Eq '^(SESSION_API_KEY|LITELLM_V3_KEY|OH_SECRET_KEY)=change-me($|[-_])' "$OPENHANDS_ENV_SOURCE"; then
  echo "deploy/gcp/openhands-v3.env still contains placeholder secrets" >&2
  exit 1
fi
if ! grep -Eq '^LITELLM_V3_BASE_URL=https://[^[:space:]]+$' "$OPENHANDS_ENV_SOURCE"; then
  echo "deploy/gcp/openhands-v3.env must define a concrete HTTPS LITELLM_V3_BASE_URL" >&2
  exit 1
fi

install -d -m 0750 "$ROOT" "$DATA_DIR" "$BACKUP_DIR" "$SECRETS_DIR" "$OPENHANDS_DIR"
install -d -o 10001 -g 10001 -m 0750 "$WORKSPACE_DIR"
install -d -o root -g root -m 0711 "$WORKSPACE_DIR/v4" "$WORKSPACE_DIR/v4/executions"

if [[ -f "$V4_DB" ]]; then
  backup_path="$BACKUP_DIR/pixel-v4-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  /usr/bin/node --input-type=module - "$V4_DB" "$backup_path" <<'NODE'
import { DatabaseSync, backup } from 'node:sqlite';
const [, , source, target] = process.argv;
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, target);
} finally {
  db.close();
}
NODE
  chmod 0600 "$backup_path"
fi

if [[ -d "$TARGET_DIR" ]]; then
  rm -rf "$TARGET_DIR"
fi
install -d -m 0755 "$TARGET_DIR"
tar --exclude='./node_modules' --exclude='./dist' --exclude='./data' -C "$SOURCE_DIR" -cf - . | tar -C "$TARGET_DIR" -xf -
cd "$TARGET_DIR"
npm ci --omit=dev
npm run build

install -m 0600 "$OPENHANDS_ENV_SOURCE" "$OPENHANDS_ENV_TARGET"
set -a
# shellcheck disable=SC1090
source "$OPENHANDS_ENV_TARGET"
set +a
for required_name in SESSION_API_KEY LITELLM_V3_KEY LITELLM_V3_BASE_URL OH_SECRET_KEY; do
  if [[ -z "${!required_name:-}" ]]; then
    echo "$required_name is required in $OPENHANDS_ENV_TARGET" >&2
    exit 1
  fi
done

if [[ ! -x "$OPENHANDS_VENV/bin/openhands-agent-server" || ! -f "$OPENHANDS_SERVER_REF_FILE" || "$(cat "$OPENHANDS_SERVER_REF_FILE")" != "$EXPECTED_OPENHANDS_REF" ]]; then
  python3 -m venv "$OPENHANDS_VENV"
  "$OPENHANDS_VENV/bin/python" -m pip install --upgrade pip
  "$OPENHANDS_VENV/bin/pip" install \
    "git+https://github.com/OpenHands/software-agent-sdk@88c7c49becdc63ec8386f0506ad970b3c5339d23#subdirectory=agent-server"
  printf '%s\n' "$EXPECTED_OPENHANDS_REF" > "$OPENHANDS_SERVER_REF_FILE"
fi

install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
install -m 0644 "$OPENHANDS_UNIT_SOURCE" "$OPENHANDS_UNIT_TARGET"
systemctl daemon-reload
systemctl enable --now "$OPENHANDS_UNIT_NAME"

for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:18000/health >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:18000/health >/dev/null

systemctl enable --now "$UNIT_NAME"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:8320/api/health >/dev/null; then
    break
  fi
  sleep 1
done
health_json="$(curl -fsS http://127.0.0.1:8320/api/health)"
/usr/bin/node --input-type=module - "$health_json" <<'NODE'
const payload = JSON.parse(process.argv[2]);
if (payload.status !== 'ok' || payload.apiVersion !== 4 || payload.executionRuntime?.enabled !== true) {
  throw new Error('Pixel V4 execution runtime did not become healthy');
}
NODE
systemctl --no-pager --full status "$OPENHANDS_UNIT_NAME" "$UNIT_NAME"
