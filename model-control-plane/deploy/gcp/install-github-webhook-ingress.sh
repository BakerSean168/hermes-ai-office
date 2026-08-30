#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
unit_src="$repo_root/model-control-plane/deploy/gcp/hermes-github-webhook-ingress.service"
unit_dst="/etc/systemd/system/hermes-github-webhook-ingress.service"
env_file="/srv/hermes-personal/secrets/github-webhook-ingress.env"
install_root="/usr/local/lib/hermes-github-webhook-ingress"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi
if [[ ! -s "$env_file" ]]; then
  echo "required runtime file missing: $env_file" >&2
  exit 1
fi
if ! grep -q '^MODEL_CP_V3_GITHUB_EVENT_TOKEN=.' /srv/hermes-personal/secrets/model-control-plane-v3.env; then
  echo 'MODEL_CP_V3_GITHUB_EVENT_TOKEN must be configured before ingress activation' >&2
  exit 1
fi

chmod 0600 "$env_file" /srv/hermes-personal/secrets/model-control-plane-v3.env
for artifact in githubWebhookIngress.js githubWebhookIngressMain.js; do
  if [[ ! -s "$repo_root/model-control-plane/dist/$artifact" ]]; then
    echo "required build artifact missing: model-control-plane/dist/$artifact" >&2
    exit 1
  fi
done
install -d -m 0755 "$install_root"
install -m 0644 "$repo_root/model-control-plane/dist/githubWebhookIngress.js" "$install_root/githubWebhookIngress.js"
install -m 0644 "$repo_root/model-control-plane/dist/githubWebhookIngressMain.js" "$install_root/githubWebhookIngressMain.js"
printf '%s\n' '{"type":"module","private":true}' > "$install_root/package.json"
chmod 0644 "$install_root/package.json"
install -m 0644 "$unit_src" "$unit_dst"
systemctl daemon-reload
systemctl enable --now hermes-github-webhook-ingress.service

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8322/health >/dev/null; then
    echo 'hermes-github-webhook-ingress: healthy on 127.0.0.1:8322'
    exit 0
  fi
  sleep 1
done
systemctl --no-pager --full status hermes-github-webhook-ingress.service >&2 || true
exit 1
