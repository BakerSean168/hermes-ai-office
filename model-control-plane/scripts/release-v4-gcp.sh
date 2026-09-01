#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
service="hermes-model-control-plane.service"
target_root="/home/dev/projects/pixel-agents"
target_dist="$target_root/model-control-plane/dist"
health_url="http://127.0.0.1:8320/api/health"
db_file="/srv/hermes-personal/data/model-control-plane/pixel-v4.sqlite"
backup_dir="/srv/hermes-personal/data/model-control-plane/backups"

if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
  echo "refusing release from dirty worktree" >&2
  exit 1
fi
source_sha="$(git -C "$repo_root" rev-parse HEAD)"
target_sha="$(git -C "$target_root" rev-parse HEAD)"
if [[ "$source_sha" != "$target_sha" ]]; then
  echo "refusing release: canonical source SHA $target_sha does not match release SHA $source_sha" >&2
  exit 1
fi

(cd "$repo_root/model-control-plane" && npm run check-types && npm test && npm run build)
artifact_sha="$(find "$repo_root/model-control-plane/dist" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"

if sudo test -f "$db_file"; then
  sudo install -d -m 0700 "$backup_dir"
  backup_path="$backup_dir/pixel-v4-release-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  sudo /usr/bin/node --input-type=module - "$db_file" "$backup_path" <<'NODE'
import { DatabaseSync, backup } from 'node:sqlite';
const [, , source, target] = process.argv;
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, target);
} finally {
  db.close();
}
NODE
  sudo chmod 0600 "$backup_path"
fi

install -d "$target_dist"
rsync -a --delete "$repo_root/model-control-plane/dist/" "$target_dist/"
sudo install -m 0644 "$repo_root/model-control-plane/deploy/gcp/hermes-model-control-plane.service" "/etc/systemd/system/$service"
sudo systemctl daemon-reload
sudo systemctl restart "$service"

for _ in $(seq 1 30); do
  if health="$(curl -fsS --max-time 2 "$health_url" 2>/dev/null)"; then
    if HEALTH_JSON="$health" /usr/bin/node - <<'NODE'
const payload = JSON.parse(process.env.HEALTH_JSON ?? '{}');
const runtime = payload.executionRuntime ?? {};
if (payload.status !== 'ok' || payload.apiVersion !== 4) process.exit(1);
if (runtime.enabled !== true || runtime.autonomousPolling !== true) process.exit(1);
if (!Array.isArray(runtime.implementationRoutes) || runtime.implementationRoutes[0] !== 'gpt-5.6-luna') process.exit(1);
if (!Array.isArray(runtime.reviewRoutes) || runtime.reviewRoutes[0] !== 'gpt-5.6-sol') process.exit(1);
NODE
    then
      openhands="$(curl -fsS --max-time 2 http://127.0.0.1:18000/health)"
      probe_status="$(curl -sS -o /tmp/pixel-v4-release-probe.json -w '%{http_code}' --max-time 2 http://127.0.0.1:8320/api/v4/plans/__release_probe__)"
      if [[ "$probe_status" == "404" ]] && grep -q 'PLAN_NOT_FOUND' /tmp/pixel-v4-release-probe.json; then
        printf 'V4 release healthy; source_sha=%s artifact_sha=%s\n%s\n%s\n' "$source_sha" "$artifact_sha" "$health" "$openhands"
        exit 0
      fi
    fi
  fi
  sleep 1
done

sudo systemctl --no-pager --full status "$service" >&2 || true
echo "V4 release health check failed; source_sha=$source_sha artifact_sha=$artifact_sha" >&2
exit 1
