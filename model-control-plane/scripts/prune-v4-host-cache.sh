#!/usr/bin/env bash
set -euo pipefail

state_file="${PIXEL_V4_HOST_CACHE_STATE_FILE:-/srv/hermes-personal/data/model-control-plane/host-cache-maintenance.json}"
control_plane_url="${PIXEL_V4_CONTROL_PLANE_URL:-http://127.0.0.1:8320}"
filesystem_path="${PIXEL_V4_HOST_CACHE_FILESYSTEM:-/}"
trigger_free_bytes="${PIXEL_V4_HOST_CACHE_TRIGGER_FREE_BYTES:-17179869184}"
target_free_bytes="${PIXEL_V4_HOST_CACHE_TARGET_FREE_BYTES:-25769803776}"
build_cache_age="${PIXEL_V4_HOST_CACHE_BUILD_AGE:-24h}"
image_age="${PIXEL_V4_HOST_CACHE_IMAGE_AGE:-168h}"
maintenance_lock="${PIXEL_V4_HOST_CACHE_LOCK:-/tmp/hermes-pixel-v4-host-cache.lock}"
release_lock="${PIXEL_V4_RELEASE_LOCK:-/tmp/hermes-pixel-v4-release.lock}"
test_mode="${PIXEL_V4_HOST_CACHE_TEST_MODE:-false}"

if [[ "$test_mode" != true && ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "host cache maintenance must run as root" >&2
  exit 1
fi
for value in "$trigger_free_bytes" "$target_free_bytes"; do
  [[ "$value" =~ ^[0-9]+$ ]] || { echo "invalid host cache byte threshold" >&2; exit 1; }
done
if (( target_free_bytes < trigger_free_bytes || trigger_free_bytes < 1073741824 )); then
  echo "invalid host cache high-watermark policy" >&2
  exit 1
fi
for tool in docker curl df python3 flock; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing host cache tool: $tool" >&2; exit 1; }
done

steps=()
free_bytes() {
  local line available_kb
  line="$(df -Pk "$filesystem_path" | tail -n 1)"
  # POSIX df -P fields: filesystem, blocks, used, available, capacity, mount.
  read -r _ _ _ available_kb _ _ <<<"$line"
  [[ "$available_kb" =~ ^[0-9]+$ ]] || { echo "unable to read host free space" >&2; return 1; }
  printf '%s\n' "$((available_kb * 1024))"
}

write_state() {
  local action=$1 reason=$2 before=$3 after=$4 active=$5
  local steps_csv=""
  if ((${#steps[@]} > 0)); then
    steps_csv="$(IFS=,; echo "${steps[*]}")"
  fi
  state_dir="$(dirname "$state_file")"
  if [[ ! -d "$state_dir" ]]; then
    install -d -m 0750 "$state_dir"
  fi
  python3 - "$state_file" "$action" "$reason" "$before" "$after" "$active" \
    "$trigger_free_bytes" "$target_free_bytes" "$steps_csv" <<'PY'
import datetime
import json
import os
import sys

(path, action, reason, before, after, active, trigger, target, steps_csv) = sys.argv[1:]
payload = {
    "version": 1,
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "action": action,
    "reason": reason,
    "freeBytesBefore": int(before),
    "freeBytesAfter": int(after),
    "activeExecutions": int(active),
    "triggerFreeBytes": int(trigger),
    "targetFreeBytes": int(target),
    "steps": [item for item in steps_csv.split(",") if item],
}
tmp = path + ".tmp-" + str(os.getpid())
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(tmp, 0o644)
os.replace(tmp, path)
parent = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent)
finally:
    os.close(parent)
PY
}

active_execution_count() {
  local payload
  payload="$(curl -fsS --max-time 5 "$control_plane_url/api/v4/executions?status=RUNNING&limit=1")" || return 1
  printf '%s' "$payload" | python3 -c '
import json,sys
value=json.load(sys.stdin)
count=value.get("count")
items=value.get("items")
if not isinstance(count,int) or not isinstance(items,list):
    raise SystemExit(2)
print(count)
'
}

exec 8>"$maintenance_lock"
flock -n 8 || exit 0
exec 9>"$release_lock"

before="$(free_bytes)"
if (( before >= trigger_free_bytes )); then
  write_state "NOOP_CAPACITY_OK" "FREE_SPACE_ABOVE_TRIGGER" "$before" "$before" 0
  exit 0
fi

if ! flock -n 9; then
  write_state "SKIPPED_RELEASE_ACTIVE" "RELEASE_LOCK_HELD" "$before" "$before" 0
  exit 0
fi

if ! active="$(active_execution_count)"; then
  write_state "SKIPPED_CONTROL_PLANE_UNAVAILABLE" "ACTIVE_EXECUTION_STATE_UNAVAILABLE" "$before" "$before" 0
  exit 0
fi
if (( active > 0 )); then
  write_state "SKIPPED_ACTIVE_EXECUTION" "PIXEL_EXECUTION_RUNNING" "$before" "$before" "$active"
  exit 0
fi

run_prune() {
  local step=$1
  shift
  steps+=("$step")
  if ! docker "$@" >/dev/null; then
    after="$(free_bytes)"
    write_state "PRUNE_FAILED" "$step" "$before" "$after" 0
    return 1
  fi
  return 0
}

after="$before"
run_prune "BUILDER_CACHE_OLDER_THAN_POLICY" builder prune -af --filter "until=$build_cache_age"
after="$(free_bytes)"
if (( after < target_free_bytes )); then
  run_prune "ALL_UNUSED_BUILDER_CACHE" builder prune -af
  after="$(free_bytes)"
fi
if (( after < target_free_bytes )); then
  run_prune "DANGLING_IMAGES" image prune -f
  after="$(free_bytes)"
fi
if (( after < target_free_bytes )); then
  run_prune "OLD_UNUSED_IMAGES" image prune -af --filter "until=$image_age"
  after="$(free_bytes)"
fi

if (( after >= target_free_bytes )); then
  write_state "PRUNED_TARGET_REACHED" "SAFE_RECLAIM_COMPLETED" "$before" "$after" 0
  exit 0
fi
if (( after >= trigger_free_bytes )); then
  write_state "PRUNED_PARTIAL" "ABOVE_TRIGGER_BELOW_TARGET" "$before" "$after" 0
  exit 0
fi
write_state "CAPACITY_STILL_LOW" "SAFE_RECLAIM_EXHAUSTED" "$before" "$after" 0
echo "host free space remains below trigger after safe cache pruning" >&2
exit 2
