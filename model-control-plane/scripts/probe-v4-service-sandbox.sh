#!/usr/bin/env bash
set -euo pipefail

entry_file="${1:?entry file required}"
probe_dir="${2:?workspace probe directory required}"
memo_probe="${3:?MemoFlow probe file required}"
memo_git_probe="${4:?MemoFlow Git common-dir probe file required}"
digital_probe="${5:?Digital Biome probe file required}"
owner_uid="${6:?workspace owner uid required}"
owner_gid="${7:?workspace owner gid required}"
repository_probe="${digital_probe}.repository-owner"

cleanup() {
  rm -rf -- "$probe_dir" "$repository_probe"
  rm -f -- "$memo_probe" "$memo_git_probe" "$digital_probe"
}
trap cleanup EXIT

test -r "$entry_file"
mkdir -- "$probe_dir"
touch -- "$probe_dir/file"
chown -R "$owner_uid:$owner_gid" "$probe_dir"
# The probe later drops to the repository owner (for example dev), which must be
# able to traverse this worker-owned parent without gaining read/list access.
chmod 0711 "$probe_dir"
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

# Exercise Git itself under the repository identity, then prove a root-owned
# observation with optional locks disabled cannot replace the owner-written index.
# The worker-managed workspace root intentionally blocks the source repository
# owner from traversing it. Exercise identity-dropped Git in the real source-repo
# boundary instead, where that owner is expected to have access.
mkdir -- "$repository_probe"
/usr/bin/git init -q -b main "$repository_probe"
printf 'probe\n' >"$repository_probe/README.md"
chown -R "$repo_uid:$repo_gid" "$repository_probe"
node --input-type=module - "$repository_probe" "$repo_uid" "$repo_gid" <<'NODE'
import { spawnSync } from 'node:child_process';
const [, , repository, uidText, gidText] = process.argv;
const uid = Number(uidText);
const gid = Number(gidText);
const env = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
};
for (const args of [
  ['-C', repository, 'config', 'user.name', 'Pixel V4 Probe'],
  ['-C', repository, 'config', 'user.email', 'pixel-v4-probe@local'],
  ['-C', repository, 'add', 'README.md'],
  ['-C', repository, 'commit', '-q', '-m', 'probe'],
  ['-C', repository, 'status', '--porcelain=v1'],
]) {
  const result = spawnSync('/usr/bin/git', args, { encoding: 'utf8', uid, gid, env });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'repository-owner Git probe failed\n');
    process.exit(1);
  }
}
NODE
test "$(stat -c %u "$repository_probe/.git/index")" = "$repo_uid"
test "$(stat -c %g "$repository_probe/.git/index")" = "$repo_gid"
touch -m -- "$repository_probe/README.md"
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 \
  /usr/bin/git -c safe.directory="$repository_probe" -C "$repository_probe" \
  status --porcelain=v1 >/dev/null
test "$(stat -c %u "$repository_probe/.git/index")" = "$repo_uid"
test "$(stat -c %g "$repository_probe/.git/index")" = "$repo_gid"

trap - EXIT
