#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
unit_src="$repo_root/model-control-plane/deploy/hermes-model-control-plane.service"
dropin_src="$repo_root/model-control-plane/deploy/hermes-model-control-plane.service.d/v3-production.conf"
unit_dst="/etc/systemd/system/hermes-model-control-plane.service"
dropin_dir="/etc/systemd/system/hermes-model-control-plane.service.d"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi

install -m 0644 "$unit_src" "$unit_dst"
install -d -m 0755 "$dropin_dir"
install -m 0644 "$dropin_src" "$dropin_dir/v3-production.conf"
# v3-shadow.conf was the pre-cutover host-only drop-in. The repository-owned
# production drop-in supersedes it so reinstall/upgrade behavior is deterministic.
rm -f "$dropin_dir/v3-shadow.conf"

systemctl daemon-reload
systemctl restart hermes-model-control-plane.service

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8320/api/v3/health >/dev/null; then
    curl -fsS http://127.0.0.1:8320/api/v3/development/model-registry >/dev/null
    echo "hermes-model-control-plane: V3 + LiteLLM registry healthy"
    exit 0
  fi
  sleep 1
done

systemctl --no-pager --full status hermes-model-control-plane.service >&2 || true
exit 1
