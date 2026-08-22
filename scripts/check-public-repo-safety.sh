#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

failed=0

check_pattern() {
  local label="$1"
  local pattern="$2"
  local matches
  matches="$(git grep -n -I -E "$pattern" -- . 2>/dev/null || true)"
  if [[ -n "$matches" ]]; then
    echo "::error::$label must not be committed to the public repository" >&2
    printf '%s\n' "$matches" >&2
    failed=1
  fi
}

# Real Tailscale MagicDNS names expose host/tailnet metadata even though they are
# not credentials. Documentation should use placeholders such as <tailnet-host>.
check_pattern "Tailscale MagicDNS hostnames" '[A-Za-z0-9-]+\.tail[A-Za-z0-9-]+\.ts\.net'

# Tailscale IPv4 node addresses use the carrier-grade NAT range. Keep concrete
# node addresses in deployment-local configuration rather than source control.
check_pattern "Tailscale IPv4 addresses" '100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}'

# A committed private-key body is always a release blocker.
check_pattern "private key material" 'BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY'

if (( failed != 0 )); then
  exit 1
fi

echo "public repository safety checks passed"
