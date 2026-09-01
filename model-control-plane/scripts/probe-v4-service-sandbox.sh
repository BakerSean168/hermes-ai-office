#!/usr/bin/env bash
set -euo pipefail

entry_file="${1:?entry file required}"
probe_dir="${2:?workspace probe directory required}"
memo_probe="${3:?MemoFlow probe file required}"
digital_probe="${4:?Digital Biome probe file required}"
owner_uid="${5:?workspace owner uid required}"
owner_gid="${6:?workspace owner gid required}"

cleanup() {
  rm -rf -- "$probe_dir"
  rm -f -- "$memo_probe" "$digital_probe"
}
trap cleanup EXIT

test -r "$entry_file"
mkdir -- "$probe_dir"
touch -- "$probe_dir/file"
chown -R "$owner_uid:$owner_gid" "$probe_dir"
test "$(stat -c %u "$probe_dir")" = "$owner_uid"
test "$(stat -c %g "$probe_dir")" = "$owner_gid"
/usr/bin/setpriv --reuid="$owner_uid" --regid="$owner_gid" --clear-groups \
  /bin/sh -c 'test -d "$1" && test -w "$1" && touch "$1/worker-write" && rm -f "$1/worker-write"' \
  sh "$probe_dir"
touch -- "$memo_probe" "$digital_probe"

cleanup
trap - EXIT
