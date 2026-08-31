#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
service="hermes-model-control-plane.service"
target_root="/home/dev/projects/pixel-agents"
target_dist="$target_root/model-control-plane/dist"
health_url="http://127.0.0.1:8320/api/health"

if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
  echo "refusing release from dirty worktree" >&2
  exit 1
fi

(cd "$repo_root/model-control-plane" && npm run check-types && npm test && npm run build)
artifact_sha="$(find "$repo_root/model-control-plane/dist" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
install -d "$target_dist"
rsync -a --delete "$repo_root/model-control-plane/dist/" "$target_dist/"
sudo install -m 0644 "$repo_root/model-control-plane/deploy/gcp/hermes-model-control-plane.service" "/etc/systemd/system/$service"
sudo systemctl daemon-reload
sudo systemctl restart "$service"

for _ in $(seq 1 30); do
  if health="$(curl -fsS --max-time 2 "$health_url" 2>/dev/null)" && grep -q '"apiVersion":4' <<<"$health"; then
    printf 'V4 release healthy; artifact_sha=%s\n%s\n' "$artifact_sha" "$health"
    exit 0
  fi
  sleep 1
done

sudo systemctl --no-pager --full status "$service" >&2 || true
echo "V4 release health check failed; artifact_sha=$artifact_sha" >&2
exit 1
