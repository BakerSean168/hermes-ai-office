#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
NODE_BIN="${NODE_BIN:-/opt/node-v24.18.0-linux-arm64/bin/node}"
DB_FILE="${MODEL_CP_DB:-/srv/hermes-personal/data/model-control-plane/control-plane.sqlite}"
ENV_FILE="${HERMES_LITELLM_ENV_FILE:-/srv/hermes-personal/secrets/litellm.env}"
GATEWAYCTL="${GATEWAYCTL:-/usr/local/sbin/gatewayctl}"
CPA_CHANNEL="${V2_REFERENCE_CPA_CHANNEL:-planner-pool}"
CPA_MODEL="${V2_REFERENCE_MODEL_KEY:-deepseek-v4-flash}"
SERVICE="${LITELLM_SERVICE:-hermes-litellm.service}"
CONTAINER="${LITELLM_CONTAINER:-hermes-litellm}"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo --preserve-env=MODEL_CP_DB,HERMES_LITELLM_ENV_FILE,GATEWAYCTL,V2_REFERENCE_CPA_CHANNEL,V2_REFERENCE_MODEL_KEY,LITELLM_SERVICE,LITELLM_CONTAINER,NODE_BIN "$0" "$@"
fi

[[ -x "$NODE_BIN" ]] || { echo "missing Node binary: $NODE_BIN" >&2; exit 1; }
[[ -f "$REPO_ROOT/model-control-plane/dist/v2/bootstrapReference.js" ]] || {
  echo "build model-control-plane before configuring the reference route" >&2
  exit 1
}
[[ -f "$ENV_FILE" ]] || { echo "missing LiteLLM env file: $ENV_FILE" >&2; exit 1; }

old_route="$({ sed -n 's/^V2_REFERENCE_ROUTE=//p' "$ENV_FILE" || true; } | tail -n 1)"
bootstrap="$({
  cd "$REPO_ROOT"
  MODEL_CP_DB="$DB_FILE" "$NODE_BIN" model-control-plane/dist/v2/bootstrapReference.js
})"
route="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["externalRouteRef"])' <<<"$bootstrap")"
employment_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["employmentId"])' <<<"$bootstrap")"
employee_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["employeeId"])' <<<"$bootstrap")"

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

printf 'configured employee=%s employment=%s route=%s\n' "$employee_id" "$employment_id" "$route"
