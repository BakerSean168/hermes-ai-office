#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "bootstrap-dynamic-gateway.sh must run as root" >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=${HERMES_LITELLM_ENV_FILE:-/srv/hermes-personal/secrets/litellm.env}
RUNTIME_KEY_FILE=${HERMES_LITELLM_RUNTIME_KEY_FILE:-/srv/hermes-personal/data/secrets/litellm-runtime.key}
CONTAINER=${HERMES_LITELLM_CONTAINER:-hermes-litellm}

mkdir -p "$(dirname -- "$ENV_FILE")" "$(dirname -- "$RUNTIME_KEY_FILE")"

read_file_value() {
  local key=$1
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v key="$key" 'index($0,key "=")==1 {print substr($0,length(key)+2); exit}' "$ENV_FILE"
}

read_container_value() {
  local key=$1
  docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | awk -v key="$key" 'index($0,key "=")==1 {print substr($0,length(key)+2); exit}'
}

preserve_value() {
  local key=$1 value
  value=$(read_file_value "$key" || true)
  if [[ -z "$value" ]]; then
    value=$(read_container_value "$key" || true)
  fi
  printf '%s' "$value"
}

MASTER_KEY=$(preserve_value LITELLM_MASTER_KEY)
CPA_DATA_API_KEY=$(preserve_value CPA_DATA_API_KEY)
REFERENCE_ROUTE=$(preserve_value V2_REFERENCE_ROUTE)
REFERENCE_MODEL=$(preserve_value V2_REFERENCE_UPSTREAM_MODEL)
DB_PASSWORD=$(preserve_value POSTGRES_PASSWORD)

[[ -n "$MASTER_KEY" ]] || MASTER_KEY="sk-hermes-$(openssl rand -hex 32)"
[[ -n "$DB_PASSWORD" ]] || DB_PASSWORD=$(openssl rand -hex 32)

TEMP=$(mktemp "${ENV_FILE}.XXXXXX")
trap 'rm -f "$TEMP"' EXIT
{
  printf 'LITELLM_MASTER_KEY=%s\n' "$MASTER_KEY"
  [[ -n "$CPA_DATA_API_KEY" ]] && printf 'CPA_DATA_API_KEY=%s\n' "$CPA_DATA_API_KEY"
  [[ -n "$REFERENCE_ROUTE" ]] && printf 'V2_REFERENCE_ROUTE=%s\n' "$REFERENCE_ROUTE"
  [[ -n "$REFERENCE_MODEL" ]] && printf 'V2_REFERENCE_UPSTREAM_MODEL=%s\n' "$REFERENCE_MODEL"
  printf 'POSTGRES_USER=litellm\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$DB_PASSWORD"
  printf 'POSTGRES_DB=litellm\n'
  printf 'DATABASE_URL=postgresql://litellm:%s@127.0.0.1:54329/litellm\n' "$DB_PASSWORD"
} >"$TEMP"
chmod 0600 "$TEMP"
mv -f "$TEMP" "$ENV_FILE"
trap - EXIT

cd "$SCRIPT_DIR"
HERMES_LITELLM_ENV_FILE="$ENV_FILE" docker compose up -d

for _ in $(seq 1 60); do
  if python3 - <<'PY' >/dev/null 2>&1
import urllib.request
urllib.request.urlopen("http://127.0.0.1:4000/health/liveliness", timeout=2).read(1)
PY
  then
    break
  fi
  sleep 2
done

if ! python3 - <<'PY' >/dev/null 2>&1
import urllib.request
urllib.request.urlopen("http://127.0.0.1:4000/health/liveliness", timeout=3).read(1)
PY
then
  echo "LiteLLM did not become healthy" >&2
  exit 1
fi

if [[ ! -s "$RUNTIME_KEY_FILE" ]]; then
  LITELLM_MASTER_KEY="$MASTER_KEY" RUNTIME_KEY_FILE="$RUNTIME_KEY_FILE" python3 - <<'PY'
import json
import os
import pathlib
import urllib.request

request = urllib.request.Request(
    "http://127.0.0.1:4000/key/generate",
    data=json.dumps(
        {
            "key_alias": "hermes-ai-office-runtime",
            "metadata": {"owner": "hermes-ai-office", "purpose": "local-runtime"},
        }
    ).encode("utf-8"),
    headers={
        "Authorization": "Bearer " + os.environ["LITELLM_MASTER_KEY"],
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=10) as response:
    payload = json.load(response)
key = str(payload.get("key") or "").strip()
if not key:
    raise SystemExit("LiteLLM did not return a runtime key")
path = pathlib.Path(os.environ["RUNTIME_KEY_FILE"])
tmp = path.with_name(path.name + ".tmp")
tmp.write_text(key + "\n", encoding="utf-8")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
fi

chown 10000:10000 "$RUNTIME_KEY_FILE" 2>/dev/null || true
chmod 0600 "$RUNTIME_KEY_FILE"

echo "LiteLLM dynamic gateway is healthy; runtime key is stored in the protected data directory."
