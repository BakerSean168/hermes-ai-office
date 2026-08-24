#!/usr/bin/env bash
set -euo pipefail

# Safe deployment path for the Hermes AI Office plugin on oracle2.
#
# Invariants:
#   * Static dashboard assets hot-sync without restarting any service.
#   * Dashboard Python API changes restart only the supervised Dashboard process.
#   * Runtime plugin changes are staged while a turn is active.
#   * Runtime activation uses Hermes' own drain + restart API, never
#     `docker compose ... --force-recreate hermes`.
#   * Dashboard lifecycle changes never restart the Gateway.

MODE="${1:---deploy}"
SOURCE="${AI_OFFICE_SOURCE:-/home/ubuntu/projects/pixel-agents/hermes-ai-office}"
LIVE="${AI_OFFICE_LIVE:-/srv/hermes-personal/data/plugins/hermes-ai-office}"
STATE_DIR="${AI_OFFICE_DEPLOY_STATE_DIR:-/srv/hermes-personal/data/runtime/ai-office-deploy}"
STAGE="${STATE_DIR}/staged"
PENDING="${STATE_DIR}/pending.json"
LOCK_FILE="${STATE_DIR}/deploy.lock"
STATUS_URL="${HERMES_DASHBOARD_STATUS_URL:-http://127.0.0.1:9119/api/status}"
DASHBOARD_BASE="${HERMES_DASHBOARD_BASE_URL:-http://127.0.0.1:9119}"
CONTAINER="${HERMES_CONTAINER:-hermes-personal}"
IDLE_WAIT_SECONDS="${AI_OFFICE_IDLE_WAIT_SECONDS:-15}"
RESTART_WAIT_SECONDS="${AI_OFFICE_RESTART_WAIT_SECONDS:-90}"
LIVE_UID="${AI_OFFICE_LIVE_UID:-10000}"
LIVE_GID="${AI_OFFICE_LIVE_GID:-1001}"

log() {
  printf '[ai-office-deploy] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

for cmd in curl docker flock python3 rsync; do
  need "$cmd"
done

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  if [[ "$MODE" == "--reconcile" ]]; then
    log "another deployment holds the lock; reconcile deferred"
    exit 0
  fi
  fail "another AI Office deployment is already running"
fi

status_json() {
  curl -fsS --max-time 3 "$STATUS_URL"
}

dashboard_token() {
  docker exec "$CONTAINER" printenv HERMES_DASHBOARD_SESSION_TOKEN 2>/dev/null
}

api_post() {
  local path="$1"
  local body="$2"
  local token
  token="$(dashboard_token)" || return 1
  [[ -n "$token" ]] || return 1
  curl -fsS --max-time 8 \
    -H "X-Hermes-Session-Token: ${token}" \
    -H 'Content-Type: application/json' \
    -X POST \
    -d "$body" \
    "${DASHBOARD_BASE}${path}"
}

api_get_auth() {
  local path="$1"
  local token
  token="$(dashboard_token)" || return 1
  [[ -n "$token" ]] || return 1
  curl -fsS --max-time 8 \
    -H "X-Hermes-Session-Token: ${token}" \
    "${DASHBOARD_BASE}${path}"
}

status_summary() {
  python3 -c '
import json, sys
s=json.load(sys.stdin)
print("state=%s running=%s busy=%s active_agents=%s active_sessions=%s drainable=%s pid=%s" % (
    s.get("gateway_state"), s.get("gateway_running"), s.get("gateway_busy"),
    s.get("active_agents"), s.get("active_sessions"), s.get("gateway_drainable"),
    s.get("gateway_pid")))
'
}

is_idle_status() {
  python3 -c '
import json, sys
s=json.load(sys.stdin)
ok=(
    s.get("gateway_running") is True
    and s.get("gateway_state") == "running"
    and not bool(s.get("gateway_busy"))
    and int(s.get("active_agents") or 0) == 0
    and int(s.get("active_sessions") or 0) == 0
    and bool(s.get("gateway_drainable", True))
)
raise SystemExit(0 if ok else 1)
'
}

is_quiescent_status() {
  python3 -c '
import json, sys
s=json.load(sys.stdin)
ok=(
    s.get("gateway_running") is True
    and s.get("gateway_state") in {"running", "draining"}
    and not bool(s.get("gateway_busy"))
    and int(s.get("active_agents") or 0) == 0
    and int(s.get("active_sessions") or 0) == 0
)
raise SystemExit(0 if ok else 1)
'
}

status_field() {
  local field="$1"
  python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$field"
}

classify_changes() {
  python3 - "$SOURCE" "$LIVE" <<'PY'
from __future__ import annotations
import hashlib
import os
import re
import sys
from pathlib import Path

src = Path(sys.argv[1])
live = Path(sys.argv[2])

EXCLUDED_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo"}

def ignored(rel: str) -> bool:
    parts = Path(rel).parts
    return any(p in EXCLUDED_DIRS for p in parts) or Path(rel).suffix in EXCLUDED_SUFFIXES

def snapshot(root: Path):
    out = {}
    if not root.exists():
        return out
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
        basep = Path(base)
        for name in files:
            p = basep / name
            rel = p.relative_to(root).as_posix()
            if ignored(rel):
                continue
            if p.is_symlink():
                out[rel] = ("link", os.readlink(p))
            else:
                h = hashlib.sha256()
                with p.open("rb") as f:
                    for chunk in iter(lambda: f.read(1024 * 1024), b""):
                        h.update(chunk)
                out[rel] = ("file", h.hexdigest())
    return out

s = snapshot(src)
l = snapshot(live)
changed = sorted(k for k in set(s) | set(l) if s.get(k) != l.get(k))
legacy_backups = sorted(live.parent.glob("hermes-ai-office.bak-*"))

def non_runtime(path: str) -> bool:
    if path.startswith("dashboard/") or path.startswith("contracts/") or path.startswith("scripts/") or path.startswith("deploy/"):
        return True
    if path in {"README.md", ".gitignore"}:
        return True
    if re.fullmatch(r"test_.*\.py", Path(path).name):
        return True
    return False

runtime = any(not non_runtime(p) for p in changed) or bool(legacy_backups)
dashboard = any(p.startswith("dashboard/") for p in changed)
dashboard_backend = any(
    p == "dashboard/plugin_api.py" or p == "dashboard/manifest.json" or p.startswith("contracts/")
    for p in changed
)
if runtime:
    kind = "runtime"
elif dashboard_backend:
    kind = "dashboard_backend"
elif dashboard:
    kind = "dashboard"
elif changed:
    kind = "metadata"
else:
    kind = "none"

print(f"class={kind}")
print(f"changed_count={len(changed)}")
for p in changed:
    print(p)
for p in legacy_backups:
    print(f"legacy-backup:{p.name}")
PY
}

sync_tree() {
  local from="$1"
  local to="$2"
  mkdir -p "$to"
  rsync -rlpt --delete \
    --exclude='__pycache__/' \
    --exclude='*.pyc' \
    --exclude='.pytest_cache/' \
    "$from/" "$to/"
}

rescan_dashboard() {
  if api_get_auth '/api/dashboard/plugins/rescan' >/dev/null; then
    log "dashboard plugin cache rescanned"
  else
    log "WARNING: dashboard rescan failed; files are synced but the manifest cache may refresh later" >&2
  fi
}

dashboard_pid() {
  docker exec "$CONTAINER" sh -lc 'ps -eo pid,args | awk '"'"'/[h]ermes dashboard --host/{print $1; exit}'"'"'' 2>/dev/null
}

restart_dashboard_supervised() {
  local old_pid new_pid gateway_before gateway_after deadline
  old_pid="$(dashboard_pid || true)"
  gateway_before="$(status_json 2>/dev/null | status_field gateway_pid || true)"

  docker exec "$CONTAINER" /command/s6-svc -r /run/service/dashboard >/dev/null
  deadline=$((SECONDS + 30))
  while (( SECONDS <= deadline )); do
    new_pid="$(dashboard_pid || true)"
    if [[ -n "$new_pid" && "$new_pid" != "$old_pid" ]] && status_json >/dev/null 2>&1; then
      gateway_after="$(status_json | status_field gateway_pid)"
      if [[ -n "$gateway_before" && "$gateway_after" != "$gateway_before" ]]; then
        fail "dashboard restart unexpectedly changed gateway pid ${gateway_before} -> ${gateway_after}"
      fi
      log "dashboard backend restarted under s6 without gateway restart: pid ${old_pid:-unknown} -> ${new_pid}"
      return 0
    fi
    sleep 1
  done
  fail "dashboard backend did not return healthy after supervised restart"
}

sync_profile_links() {
  if docker exec "$CONTAINER" /opt/data/plugins/hermes-ai-office/scripts/sync-multiplex-profiles.sh >/dev/null 2>&1; then
    log "multiplex profile plugin links reconciled"
  else
    log "WARNING: profile plugin-link reconciliation failed" >&2
    return 1
  fi
}

quarantine_legacy_plugin_backups() {
  local plugin_dir backup quarantine_dir
  plugin_dir="$(dirname "$LIVE")"
  quarantine_dir="${STATE_DIR}/legacy-plugin-backups"
  shopt -s nullglob
  for backup in "${plugin_dir}"/hermes-ai-office.bak-*; do
    mkdir -p "$quarantine_dir"
    mv "$backup" "${quarantine_dir}/$(basename "$backup")"
    log "quarantined legacy plugin backup outside discovery root: $backup"
  done
  shopt -u nullglob
}

write_pending() {
  local commit="unknown"
  commit="$(git -C "$(dirname "$SOURCE")" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$commit" ]] || commit="unknown"
  local tmp="${PENDING}.tmp.$$"
  python3 - "$tmp" "$commit" <<'PY'
import json, sys
from datetime import datetime, timezone
path, commit = sys.argv[1:]
with open(path, "w", encoding="utf-8") as f:
    json.dump({
        "version": 1,
        "reason": "runtime-plugin-change",
        "source_commit": commit,
        "staged_at": datetime.now(timezone.utc).isoformat(),
    }, f, indent=2)
    f.write("\n")
PY
  mv "$tmp" "$PENDING"
}

stage_runtime() {
  local tmp="${STAGE}.new.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  sync_tree "$SOURCE" "$tmp"
  rm -rf "$STAGE"
  mv "$tmp" "$STAGE"
  write_pending
  log "runtime change staged at $STAGE"
}

wait_until_quiescent() {
  local deadline=$((SECONDS + IDLE_WAIT_SECONDS))
  local s
  while (( SECONDS <= deadline )); do
    if s="$(status_json 2>/dev/null)" && printf '%s' "$s" | is_quiescent_status; then
      return 0
    fi
    sleep 1
  done
  return 1
}

begin_drain() {
  local s state
  s="$(status_json)" || return 1
  state="$(printf '%s' "$s" | status_field gateway_state)"
  if [[ "$state" != "running" ]]; then
    log "gateway is not in running state ($state); deferring deployment"
    return 1
  fi
  api_post '/api/gateway/drain' '{"action":"drain","suppress_notification":true}' >/dev/null
  local deadline=$((SECONDS + 10))
  while (( SECONDS <= deadline )); do
    s="$(status_json 2>/dev/null || true)"
    state="$(printf '%s' "$s" | status_field gateway_state 2>/dev/null || true)"
    [[ "$state" == "draining" ]] && return 0
    sleep 1
  done
  return 1
}

cancel_drain() {
  api_post '/api/gateway/drain' '{"action":"cancel"}' >/dev/null 2>&1 || true
}

restart_gateway_officially() {
  local before after new_pid state deadline
  before="$(status_json)" || return 1
  local old_pid
  old_pid="$(printf '%s' "$before" | status_field gateway_pid)"

  api_post '/api/gateway/restart' '{}' >/dev/null || return 1
  deadline=$((SECONDS + RESTART_WAIT_SECONDS))
  while (( SECONDS <= deadline )); do
    after="$(status_json 2>/dev/null || true)"
    if [[ -n "$after" ]]; then
      new_pid="$(printf '%s' "$after" | status_field gateway_pid 2>/dev/null || true)"
      state="$(printf '%s' "$after" | status_field gateway_state 2>/dev/null || true)"
      if [[ -n "$new_pid" && "$new_pid" != "$old_pid" && ( "$state" == "running" || "$state" == "draining" ) ]]; then
        log "gateway restarted without container recreation: pid ${old_pid} -> ${new_pid}"
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

apply_pending_runtime() {
  [[ -f "$PENDING" ]] || return 0
  [[ -d "$STAGE" ]] || fail "pending marker exists but stage directory is missing"

  local s
  if ! s="$(status_json 2>/dev/null)"; then
    log "dashboard/gateway status unavailable; keep deployment pending"
    return 75
  fi
  if ! printf '%s' "$s" | is_idle_status; then
    log "gateway busy; keep deployment pending ($(printf '%s' "$s" | status_summary))"
    return 75
  fi

  # Close the race between the idle check and restart: once draining, Hermes
  # refuses new turns while the staged runtime is activated.
  if ! begin_drain; then
    log "could not acquire gateway drain; keep deployment pending"
    return 75
  fi
  trap cancel_drain EXIT

  if ! wait_until_quiescent; then
    log "gateway did not become idle after drain; keep deployment pending"
    return 75
  fi

  sync_tree "$STAGE" "$LIVE"
  chown -R "${LIVE_UID}:${LIVE_GID}" "$LIVE"
  quarantine_legacy_plugin_backups
  sync_profile_links
  rescan_dashboard

  if ! restart_gateway_officially; then
    log "gateway restart did not complete; pending marker retained for retry" >&2
    return 75
  fi

  cancel_drain
  trap - EXIT

  local deadline=$((SECONDS + 15)) state
  while (( SECONDS <= deadline )); do
    s="$(status_json 2>/dev/null || true)"
    state="$(printf '%s' "$s" | status_field gateway_state 2>/dev/null || true)"
    [[ "$state" == "running" ]] && break
    sleep 1
  done
  [[ "$state" == "running" ]] || fail "gateway did not return to running state after drain cancel"

  # A runtime-class staged tree may also contain Dashboard Python/manifest
  # changes. Reload only the supervised Dashboard process after the Gateway is
  # healthy; the helper asserts that this step cannot change Gateway PID.
  restart_dashboard_supervised
  rescan_dashboard

  rm -f "$PENDING"
  log "runtime deployment activated safely"
}

case "$MODE" in
  --plan)
    [[ -d "$SOURCE" ]] || fail "source directory not found: $SOURCE"
    classify_changes
    ;;
  --guard-only)
    s="$(status_json)" || fail "cannot read Hermes status"
    printf '%s\n' "$s" | status_summary
    printf '%s' "$s" | is_idle_status || exit 75
    ;;
  --reconcile)
    if [[ ! -f "$PENDING" ]]; then
      exit 0
    fi
    apply_pending_runtime
    ;;
  --deploy)
    [[ -d "$SOURCE" ]] || fail "source directory not found: $SOURCE"
    plan="$(classify_changes)"
    kind="$(printf '%s\n' "$plan" | sed -n 's/^class=//p' | head -n 1)"
    log "change class: $kind"
    case "$kind" in
      none)
        log "live plugin already matches source"
        ;;
      dashboard|metadata)
        sync_tree "$SOURCE" "$LIVE"
        chown -R "${LIVE_UID}:${LIVE_GID}" "$LIVE"
        sync_profile_links
        rescan_dashboard
        log "$kind deployment completed without service restart"
        ;;
      dashboard_backend)
        sync_tree "$SOURCE" "$LIVE"
        chown -R "${LIVE_UID}:${LIVE_GID}" "$LIVE"
        sync_profile_links
        restart_dashboard_supervised
        rescan_dashboard
        log "dashboard backend deployment completed without gateway restart"
        ;;
      runtime)
        stage_runtime
        if apply_pending_runtime; then
          :
        else
          rc=$?
          if [[ $rc -eq 75 ]]; then
            log "deployment deferred; reconcile timer will activate it when the gateway is idle"
            exit 0
          fi
          exit "$rc"
        fi
        ;;
      *)
        fail "unknown change class: $kind"
        ;;
    esac
    ;;
  *)
    cat >&2 <<USAGE
Usage: $(basename "$0") [--deploy|--plan|--guard-only|--reconcile]
USAGE
    exit 2
    ;;
esac
