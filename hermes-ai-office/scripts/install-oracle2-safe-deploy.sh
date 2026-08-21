#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
install -m 0755 \
  "${repo_root}/hermes-ai-office/scripts/deploy-oracle2-safe.sh" \
  /usr/local/sbin/hermes-ai-office-deploy
install -m 0644 \
  "${repo_root}/hermes-ai-office/deploy/hermes-ai-office-deploy-reconcile.service" \
  /etc/systemd/system/hermes-ai-office-deploy-reconcile.service
install -m 0644 \
  "${repo_root}/hermes-ai-office/deploy/hermes-ai-office-deploy-reconcile.timer" \
  /etc/systemd/system/hermes-ai-office-deploy-reconcile.timer
systemctl daemon-reload
systemctl enable --now hermes-ai-office-deploy-reconcile.timer
printf '%s\n' 'Installed /usr/local/sbin/hermes-ai-office-deploy and reconcile timer.'
