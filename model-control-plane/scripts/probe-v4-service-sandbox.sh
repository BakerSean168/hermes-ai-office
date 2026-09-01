#!/usr/bin/env bash
set -euo pipefail

entry_file="${1:?entry file required}"
probe_dir="${2:?workspace probe directory required}"
memo_probe="${3:?MemoFlow probe file required}"
memo_git_probe="${4:?MemoFlow Git common-dir probe file required}"
digital_probe="${5:?Digital Biome probe file required}"
owner_uid="${6:?workspace owner uid required}"
owner_gid="${7:?workspace owner gid required}"

cleanup() {
  rm -rf -- "$probe_dir"
  rm -f -- "$memo_probe" "$memo_git_probe" "$digital_probe"
}
trap cleanup EXIT

test -r "$entry_file"
mkdir -- "$probe_dir"
touch -- "$probe_dir/file"
chown -R "$owner_uid:$owner_gid" "$probe_dir"
test "$(stat -c %u "$probe_dir")" = "$owner_uid"
test "$(stat -c %g "$probe_dir")" = "$owner_gid"
touch -- "$memo_probe" "$memo_git_probe" "$digital_probe"

# The control plane intentionally launches Git as the owning repository UID/GID so
# integration never leaves root-owned Git metadata behind. Prove the exact service
# sandbox retains only the capabilities required for that identity drop.
repo_path="$(dirname "$digital_probe")"
repo_uid="$(stat -c %u "$repo_path")"
repo_gid="$(stat -c %g "$repo_path")"
node --input-type=module - "$repo_uid" "$repo_gid" <<'NODE'
import { spawnSync } from 'node:child_process';
const [, , uidText, gidText] = process.argv;
const uid = Number(uidText);
const gid = Number(gidText);
const result = spawnSync('/usr/bin/id', ['-u'], { encoding: 'utf8', uid, gid });
if (result.status !== 0 || result.stdout.trim() !== String(uid)) {
  process.stderr.write(result.stderr || 'repository identity drop failed\n');
  process.exit(1);
}
NODE

trap - EXIT
