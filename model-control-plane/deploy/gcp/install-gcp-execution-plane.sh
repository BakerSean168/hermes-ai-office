#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
unit_src="$repo_root/model-control-plane/deploy/gcp/hermes-model-control-plane.service"
unit_dst="/etc/systemd/system/hermes-model-control-plane.service"
harness_mcp_unit_src="$repo_root/model-control-plane/deploy/gcp/hermes-agent-harness-mcp.service"
harness_mcp_unit_dst="/etc/systemd/system/hermes-agent-harness-mcp.service"
secrets_dir="/srv/hermes-personal/secrets"
data_dir="/srv/hermes-personal/data/model-control-plane"
apparmor_src="$repo_root/model-control-plane/deploy/openhands-v3/hermes-openhands-codex.apparmor"
apparmor_dst="/etc/apparmor.d/hermes-openhands-codex"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi

install -d -m 0700 "$secrets_dir" "$data_dir"


install -m 0644 "$unit_src" "$unit_dst"
systemctl daemon-reload
systemctl enable hermes-model-control-plane.service
systemctl restart hermes-model-control-plane.service

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8320/api/health >/dev/null; then
    echo "hermes-model-control-plane: healthy on GCP"
    exit 0
  fi
  sleep 1
done

systemctl --no-pager --full status hermes-model-control-plane.service >&2 || true
exit 1
