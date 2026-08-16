#!/usr/bin/env bash
set -euo pipefail

DB_FILE="${MODEL_CP_DB:-/srv/hermes-personal/data/model-control-plane/control-plane.sqlite}"
ENV_FILE="${HERMES_LITELLM_ENV_FILE:-/srv/hermes-personal/secrets/litellm.env}"
GATEWAYCTL="${GATEWAYCTL:-/usr/local/sbin/gatewayctl}"
CPA_CHANNEL="${V2_REFERENCE_CPA_CHANNEL:-planner-pool}"
CPA_MODEL="${V2_REFERENCE_MODEL_KEY:-deepseek-v4-flash}"
EMPLOYMENT_ID="${V2_REFERENCE_EMPLOYMENT_ID:-}"
SERVICE="${LITELLM_SERVICE:-hermes-litellm.service}"
CONTAINER="${LITELLM_CONTAINER:-hermes-litellm}"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo --preserve-env=MODEL_CP_DB,HERMES_LITELLM_ENV_FILE,GATEWAYCTL,V2_REFERENCE_CPA_CHANNEL,V2_REFERENCE_MODEL_KEY,V2_REFERENCE_EMPLOYMENT_ID,LITELLM_SERVICE,LITELLM_CONTAINER "$0" "$@"
fi

[[ -f "$DB_FILE" ]] || { echo "missing Model Control Plane database: $DB_FILE" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "missing LiteLLM env file: $ENV_FILE" >&2; exit 1; }

old_route="$({ sed -n 's/^V2_REFERENCE_ROUTE=//p' "$ENV_FILE" || true; } | tail -n 1)"
if [[ -z "$EMPLOYMENT_ID" && "$old_route" == employment:* ]]; then
  EMPLOYMENT_ID="${old_route#employment:}"
fi
[[ -n "$EMPLOYMENT_ID" ]] || {
  echo "V2_REFERENCE_EMPLOYMENT_ID is required when no existing employment:* reference route is configured" >&2
  exit 1
}

EMPLOYMENT_ID="$EMPLOYMENT_ID" DB_FILE="$DB_FILE" python3 - <<'PY'
import os
import sqlite3

db = sqlite3.connect(f"file:{os.environ['DB_FILE']}?mode=ro", uri=True)
row = db.execute(
    "SELECT status,effective_to FROM v2_employments WHERE id=?",
    (os.environ['EMPLOYMENT_ID'],),
).fetchone()
if row is None:
    raise SystemExit('configured Employment does not exist in V2')
if row[0] != 'CURRENT' or row[1] is not None:
    raise SystemExit(f'configured Employment is not current: status={row[0]} effective_to={row[1]}')
PY

route="employment:${EMPLOYMENT_ID}"
"$GATEWAYCTL" set-model-alias "$CPA_CHANNEL" --alias "$route" --model "$CPA_MODEL" >/dev/null

ROUTE="$route" ENV_FILE="$ENV_FILE" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ['ENV_FILE'])
values = {}
order = []
for line in path.read_text().splitlines():
    if '=' not in line or line.lstrip().startswith('#'):
        continue
    key, value = line.split('=', 1)
    if key not in values:
        order.append(key)
    values[key] = value
for key, value in {
    'V2_REFERENCE_ROUTE': os.environ['ROUTE'],
    'V2_REFERENCE_UPSTREAM_MODEL': f"openai/{os.environ['ROUTE']}",
}.items():
    if key not in values:
        order.append(key)
    values[key] = value
path.write_text(''.join(f'{key}={values[key]}\n' for key in order))
path.chmod(0o600)
PY

systemctl restart "$SERVICE"
for _ in $(seq 1 120); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || true)"
  [[ "$health" == "healthy" ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")" == "healthy" ]] || {
  echo "LiteLLM did not become healthy" >&2
  exit 1
}

ROUTE="$route" ENV_FILE="$ENV_FILE" python3 - <<'PY'
import json
import os
import urllib.request
from pathlib import Path

values = {}
for line in Path(os.environ['ENV_FILE']).read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        values[key] = value
request = urllib.request.Request(
    'http://127.0.0.1:4000/v1/models',
    headers={'Authorization': f"Bearer {values['LITELLM_MASTER_KEY']}"},
)
with urllib.request.urlopen(request, timeout=10) as response:
    ids = {row.get('id') for row in json.load(response).get('data', [])}
if os.environ['ROUTE'] not in ids:
    raise SystemExit('configured Employment route is not visible through LiteLLM')
PY

if [[ -n "$old_route" && "$old_route" != "$route" && "$old_route" == employment:* ]]; then
  "$GATEWAYCTL" set-model-alias "$CPA_CHANNEL" --alias "$old_route" --remove >/dev/null || true
fi

printf 'configured employment=%s route=%s\n' "$EMPLOYMENT_ID" "$route"
