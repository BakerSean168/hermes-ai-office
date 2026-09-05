#!/usr/bin/env bash
set -euo pipefail

canonical_root="${PIXEL_V4_CANONICAL_ROOT:-/home/dev/projects/pixel-agents}"
release_ref="${PIXEL_V4_RELEASE_REF:-refs/pixel-v4/release-approved}"
release_worktree_root="${PIXEL_V4_RELEASE_WORKTREE_ROOT:-/home/dev/projects/.pixel-v4-release-worktrees}"
service="hermes-model-control-plane.service"
target_root="$canonical_root"
health_url="http://127.0.0.1:8320/api/health"
db_file="/srv/hermes-personal/data/model-control-plane/pixel-v4.sqlite"
backup_dir="/srv/hermes-personal/data/model-control-plane/backups"
release_lock=/tmp/hermes-pixel-v4-release.lock

release_outer() {
  exec 9>"$release_lock"
  flock -n 9 || { echo "refusing release: another V4 release is active" >&2; exit 1; }

  [[ "$release_ref" == refs/pixel-v4/* ]] || {
    echo "refusing release ref outside refs/pixel-v4" >&2
    exit 1
  }
  source_sha="$(git -C "$canonical_root" rev-parse "${release_ref}^{commit}")"
  git -C "$canonical_root" cat-file -e "${source_sha}^{commit}"

  # The bootstrap launcher may run from a developer checkout with unrelated
  # dirty files, but the launcher itself must exactly match the approved SHA.
  launcher_rel="model-control-plane/scripts/release-v4-gcp.sh"
  launcher_file="$canonical_root/$launcher_rel"
  approved_launcher_sha="$(git -C "$canonical_root" show "$source_sha:$launcher_rel" | sha256sum | awk '{print $1}')"
  current_launcher_sha="$(sha256sum "$launcher_file" | awk '{print $1}')"
  [[ "$approved_launcher_sha" == "$current_launcher_sha" ]] || {
    echo "refusing release: launcher differs from approved release SHA" >&2
    exit 1
  }

  command -v setfacl >/dev/null 2>&1 || { echo "refusing release: setfacl is required for literal V4 worktree ACLs" >&2; exit 1; }
  git -C "$canonical_root" config core.fsync committed
  [[ "$(git -C "$canonical_root" config --get core.fsync)" == committed ]] || {
    echo "refusing release: canonical repository must use core.fsync=committed" >&2
    exit 1
  }

  # With the process lock held, any prior release worktree is residue from a
  # crashed/preempted release. Remove only paths under the dedicated root.
  mkdir -p "$release_worktree_root"
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      "$release_worktree_root"/*)
        git -C "$canonical_root" worktree unlock -- "$path" >/dev/null 2>&1 || true
        git -C "$canonical_root" worktree remove --force -- "$path" >/dev/null 2>&1 || true
        ;;
    esac
  done < <(git -C "$canonical_root" worktree list --porcelain | sed -n 's/^worktree //p')
  git -C "$canonical_root" worktree prune --expire now

  release_worktree="$release_worktree_root/${source_sha}-$$"
  git -C "$canonical_root" worktree add --detach "$release_worktree" "$source_sha"
  cleanup_release_worktree() {
    git -C "$canonical_root" worktree unlock -- "$release_worktree" >/dev/null 2>&1 || true
    git -C "$canonical_root" worktree remove --force -- "$release_worktree" >/dev/null 2>&1 || true
    git -C "$canonical_root" worktree prune --expire now >/dev/null 2>&1 || true
  }
  trap cleanup_release_worktree EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  [[ "$(git -C "$release_worktree" rev-parse HEAD)" == "$source_sha" ]] || {
    echo "refusing release: release worktree HEAD mismatch" >&2
    exit 1
  }
  [[ -z "$(git -C "$release_worktree" status --porcelain --untracked-files=no)" ]] || {
    echo "refusing release: release worktree is not clean" >&2
    exit 1
  }
  canonical_common="$(realpath "$(git -C "$canonical_root" rev-parse --path-format=absolute --git-common-dir)")"
  release_common="$(realpath "$(git -C "$release_worktree" rev-parse --path-format=absolute --git-common-dir)")"
  [[ "$release_common" == "$canonical_common" ]] || {
    echo "refusing release: release worktree does not share canonical Git common dir" >&2
    exit 1
  }

  [[ -d "$canonical_root/node_modules" ]] || {
    echo "refusing release: canonical dependency runtime is missing" >&2
    exit 1
  }
  ln -s "$canonical_root/node_modules" "$release_worktree/node_modules"

  PIXEL_V4_RELEASE_INNER=1 \
  PIXEL_V4_RELEASE_SOURCE_ROOT="$release_worktree" \
  PIXEL_V4_RELEASE_SOURCE_SHA="$source_sha" \
  PIXEL_V4_CANONICAL_ROOT="$canonical_root" \
  PIXEL_V4_RELEASE_REF="$release_ref" \
    /bin/bash "$release_worktree/model-control-plane/scripts/release-v4-gcp.sh"
}

if [[ "${PIXEL_V4_RELEASE_INNER:-0}" != 1 ]]; then
  release_outer
  exit $?
fi

repo_root="${PIXEL_V4_RELEASE_SOURCE_ROOT:?release source worktree required}"
source_sha="${PIXEL_V4_RELEASE_SOURCE_SHA:?release source SHA required}"
[[ -e /proc/$$/fd/9 ]] || { echo "refusing release: inherited release lock is missing" >&2; exit 1; }
flock -n 9 || { echo "refusing release: inherited release lock is not held" >&2; exit 1; }
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$source_sha" ]] || {
  echo "refusing release: inner source SHA mismatch" >&2
  exit 1
}
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ]] || {
  echo "refusing release: inner release source is not clean" >&2
  exit 1
}
canonical_common="$(realpath "$(git -C "$canonical_root" rev-parse --path-format=absolute --git-common-dir)")"
repo_common="$(realpath "$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)")"
[[ "$repo_common" == "$canonical_common" ]] || {
  echo "refusing release: inner source is not a canonical linked worktree" >&2
  exit 1
}
[[ "$(git -C "$canonical_root" rev-parse "${release_ref}^{commit}")" == "$source_sha" ]] || {
  echo "refusing release: approved ref moved during release" >&2
  exit 1
}

command -v setfacl >/dev/null 2>&1 || { echo "refusing release: setfacl is required for literal V4 worktree ACLs" >&2; exit 1; }
harnessctl=/home/dev/projects/agent-harness/bin/harnessctl.py
[[ -f "$harnessctl" ]] || { echo "refusing release: Agent Harness resolver is missing" >&2; exit 1; }
/usr/bin/python3 "$harnessctl" --help >/dev/null

expected_single_active=false
expected_literal=false
if grep -q '^Environment=MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED=true$' \
  "$repo_root/model-control-plane/deploy/gcp/hermes-model-control-plane.service"; then
  expected_single_active=true
fi
if grep -q '^Environment=MODEL_CP_V4_LITERAL_WORKTREES_ENABLED=true$' \
  "$repo_root/model-control-plane/deploy/gcp/hermes-model-control-plane.service"; then
  expected_literal=true
fi
if [[ "$expected_literal" == true && "$expected_single_active" != true ]]; then
  echo "refusing release: literal worktrees require single-active Plan scheduling" >&2
  exit 1
fi

release_build_root="$target_root/model-control-plane/.release-candidates"
candidate_dist="$release_build_root/$source_sha-$$"
# The release lock proves no live candidate belongs to a concurrent release.
# Remove residue from a prior Spot preemption before allocating this build.
rm -rf "$release_build_root"
install -d "$release_build_root"
# Build away from the live dist directory. A Spot preemption during tsc can
# destroy only this ignored candidate, never the last-known-good runtime.
(cd "$repo_root/model-control-plane" && npm run check-types && npm test)
(cd "$repo_root/model-control-plane" && npm exec -- tsc -p tsconfig.json --outDir "$candidate_dist")
test -s "$candidate_dist/main.js"
if [[ "$expected_literal" == true ]]; then
  sudo env PIXEL_V4_DIST_ROOT="$candidate_dist" \
    /usr/bin/node "$repo_root/model-control-plane/scripts/smoke-v4-literal-worktree.mjs"
fi
openhands_compose="$repo_root/model-control-plane/deploy/openhands-v3/docker-compose.yml"
sudo docker compose -f "$openhands_compose" up -d --remove-orphans --wait --wait-timeout 120
sudo "$repo_root/model-control-plane/scripts/install-openhands-v3-tooling.sh"
sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 \
  "$repo_root/model-control-plane/scripts/run-antigravity-v4-unit.mjs" \
  /usr/local/libexec/hermes-antigravity-v4-unit.mjs
sudo install -m 0644 \
  "$repo_root/model-control-plane/deploy/gcp/hermes-antigravity-v4@.service" \
  /etc/systemd/system/hermes-antigravity-v4@.service
sudo install -d -o root -g root -m 0700 \
  /srv/hermes-personal/data/model-control-plane/antigravity-v4
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/hermes-antigravity-v4@.service
sudo test -s /home/dev/.gemini/antigravity-cli/antigravity-oauth-token
sudo -u dev env HOME=/home/dev /home/dev/.local/bin/agy models \
  | grep -q '^gemini-3.8-flash-high'
sudo -u dev env HOME=/home/dev /home/dev/.local/bin/agy models \
  | grep -q '^gemini-3.1-pro-high'
sudo docker exec --user 10001:10001 -e CODEX_HOME=/openhands-state/codex-business hermes-openhands-v3 \
  /openhands-state/tooling/node_modules/.bin/codex login status >/dev/null
dist_manifest_sha() {
  local root=$1
  (cd "$root" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
}
artifact_sha="$(dist_manifest_sha "$candidate_dist")"

sudo install -d -o root -g root -m 0711 \
  /opt/data/hermes-ai-office-v3/workspaces/v4 \
  /opt/data/hermes-ai-office-v3/workspaces/v4/executions

probe_id="$$-$(date -u +%s)"
probe_unit="pixel-v4-release-probe-$probe_id"
probe_dir="/opt/data/hermes-ai-office-v3/workspaces/v4/executions/.pixel-v4-release-$probe_id"
memo_probe="/home/dev/projects/memoflow-platform-1003/.pixel-v4-release-$probe_id"
memo_git_probe="/home/dev/projects/memoflow/.git/pixel-v4-release-$probe_id"
digital_probe="/home/dev/projects/digital-biome/.pixel-v4-release-$probe_id"
body_probe="/home/dev/projects/bodysense/.pixel-v4-release-$probe_id"
body_git_probe="/home/dev/projects/bodysense/.git/pixel-v4-release-$probe_id"
probe_script="$repo_root/model-control-plane/scripts/probe-v4-service-sandbox.sh"
cleanup_probe() {
  sudo rm -rf "$probe_dir" "${digital_probe}.repository-owner"
  sudo rm -f "$memo_probe" "$memo_git_probe" "$digital_probe" "$body_probe" "$body_git_probe"
}
trap cleanup_probe EXIT
sudo systemd-run --wait --pipe --collect --unit="$probe_unit" \
  -p User=root \
  -p WorkingDirectory="$target_root" \
  -p NoNewPrivileges=yes \
  -p PrivateTmp=yes \
  -p PrivateDevices=yes \
  -p ProtectSystem=strict \
  -p ProtectHome=read-only \
  -p ProtectKernelTunables=yes \
  -p ProtectKernelModules=yes \
  -p ProtectControlGroups=yes \
  -p ProtectClock=yes \
  -p ProtectHostname=yes \
  -p RestrictRealtime=yes \
  -p LockPersonality=yes \
  -p RestrictSUIDSGID=yes \
  -p 'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID' \
  -p 'AmbientCapabilities=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID' \
  -p ReadWritePaths=/srv/hermes-personal/data/model-control-plane \
  -p ReadWritePaths=/opt/data/hermes-ai-office-v3/workspaces \
  -p ReadWritePaths=/home/dev/projects/memoflow-platform-1003 \
  -p ReadWritePaths=/home/dev/projects/memoflow/.git \
  -p ReadWritePaths=/home/dev/projects/digital-biome \
  -p ReadWritePaths=/home/dev/projects/bodysense \
  "$probe_script" \
  "$candidate_dist/main.js" \
  "$probe_dir" \
  "$memo_probe" \
  "$memo_git_probe" \
  "$digital_probe" \
  "$body_probe" \
  "$body_git_probe" \
  10001 \
  10001
sudo docker exec --user 10001:10001 hermes-openhands-v3 \
  /bin/sh -c 'test -d "$1" && test -w "$1" && touch "$1/container-write" && rm -f "$1/container-write"' \
  sh "/workspace/v4/executions/.pixel-v4-release-$probe_id"
openhands_node_major="$(sudo docker exec --user 10001:10001 hermes-openhands-v3 node -p 'process.versions.node.split(".")[0]')"
if [[ "$openhands_node_major" != "24" ]]; then
  echo "OpenHands coding runtime must use Node 24, got major $openhands_node_major" >&2
  exit 1
fi
openhands_go_path="$(sudo docker exec --user 10001:10001 hermes-openhands-v3 /bin/sh -c 'command -v go')"
if [[ "$openhands_go_path" != "/openhands-state/toolchains/go-1.26.0/bin/go" ]]; then
  echo "OpenHands Agent PATH must resolve persisted Go 1.26.0 first, got $openhands_go_path" >&2
  exit 1
fi
openhands_go_version="$(sudo docker exec --user 10001:10001 hermes-openhands-v3 /bin/sh -c 'go version')"
if [[ "$openhands_go_version" != *"go1.26.0"* ]]; then
  echo "OpenHands Agent PATH must expose Go 1.26.0, got $openhands_go_version" >&2
  exit 1
fi
sudo docker exec --user 10001:10001 hermes-openhands-v3 /bin/sh -lc '
  test "$COREPACK_HOME" = /openhands-state/corepack
  test "$COREPACK_ENABLE_DOWNLOAD_PROMPT" = 0
  test -d "$COREPACK_HOME/v1/pnpm/10.32.1"
  test -d "$COREPACK_HOME/v1/pnpm/11.17.0"
  test -d "$COREPACK_HOME/v1/pnpm/11.20.0"
'
for version in 10.32.1 11.17.0 11.20.0; do
  manager_probe="/opt/data/hermes-ai-office-v3/workspaces/v4/executions/.pixel-v4-pnpm-$probe_id-$version"
  sudo install -d -o 10001 -g 10001 -m 0750 "$manager_probe"
  printf '{"packageManager":"pnpm@%s"}\n' "$version" | sudo tee "$manager_probe/package.json" >/dev/null
  sudo chown 10001:10001 "$manager_probe/package.json"
  actual_version="$(sudo docker exec --user 10001:10001 hermes-openhands-v3 /bin/sh -lc 'cd "$1" && pnpm --version' sh "/workspace/v4/executions/.pixel-v4-pnpm-$probe_id-$version")"
  if [[ "$actual_version" != "$version" ]]; then
    echo "OpenHands Corepack probe expected pnpm $version, got $actual_version" >&2
    exit 1
  fi
  sudo rm -rf "$manager_probe"
done
cleanup_probe
trap - EXIT

if sudo test -f "$db_file"; then
  sudo install -d -m 0700 "$backup_dir"
  backup_path="$backup_dir/pixel-v4-release-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  sudo /usr/bin/node --input-type=module - "$db_file" "$backup_path" <<'NODE'
import { DatabaseSync, backup } from 'node:sqlite';
const [, , source, target] = process.argv;
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, target);
} finally {
  db.close();
}
NODE
  sudo chmod 0600 "$backup_path"
fi

current_dist="$target_root/model-control-plane/dist"
# Flush every completed candidate file before publishing it. The following
# renameat2 exchange is one atomic metadata operation on the same filesystem:
# after a preemption, dist is therefore either the previous complete build or
# this complete candidate, never a half-written directory.
sync -f "$candidate_dist"
if [[ -d "$current_dist" ]]; then
  /usr/bin/python3 "$repo_root/model-control-plane/scripts/atomic-exchange-directories.py" \
    "$candidate_dist" "$current_dist"
  # candidate_dist now names the old complete build after the exchange.
  rm -rf "$candidate_dist"
else
  mv --no-copy "$candidate_dist" "$current_dist"
  sync -f "$(dirname "$current_dist")"
fi
deployed_artifact_sha="$(dist_manifest_sha "$current_dist")"
if [[ "$deployed_artifact_sha" != "$artifact_sha" ]]; then
  echo "refusing release: atomic dist artifact hash mismatch" >&2
  exit 1
fi
sudo install -m 0644 "$repo_root/model-control-plane/deploy/gcp/hermes-model-control-plane.service" "/etc/systemd/system/$service"
sudo systemctl daemon-reload
sudo systemctl restart "$service"

for _ in $(seq 1 30); do
  if health="$(curl -fsS --max-time 2 "$health_url" 2>/dev/null)"; then
    if HEALTH_JSON="$health" EXPECTED_SINGLE_ACTIVE="$expected_single_active" EXPECTED_LITERAL="$expected_literal" /usr/bin/node - <<'NODE'
const payload = JSON.parse(process.env.HEALTH_JSON ?? '{}');
const runtime = payload.executionRuntime ?? {};
const scheduling = payload.planScheduling ?? {};
const storage = payload.workspaceStorage ?? {};
if (payload.status !== 'ok' || payload.apiVersion !== 4) process.exit(1);
if (storage.lowCapacity !== false) process.exit(1);
if (!Number.isFinite(Number(storage.freeBytes)) || !Number.isFinite(Number(storage.minimumFreeBytes))) process.exit(1);
if (Number(storage.freeBytes) < Number(storage.minimumFreeBytes)) process.exit(1);
if (runtime.enabled !== true || runtime.autonomousPolling !== true) process.exit(1);
if (runtime.resourceSelectorEnabled !== true || Number(runtime.resourceCount) < 1) process.exit(1);
if (Array.isArray(runtime.compatibilityReviewRoutes) && runtime.compatibilityReviewRoutes.includes('codex-auto-review')) process.exit(1);
if (Array.isArray(runtime.reviewRoutes) && runtime.reviewRoutes.includes('codex-auto-review')) process.exit(1);
if (runtime.requireDelivery !== true) process.exit(1);
if (JSON.stringify(runtime.automationProjectKeys) !== JSON.stringify(['memoflow', 'digital-biome', 'bodysense'])) process.exit(1);
const expectedSingle = process.env.EXPECTED_SINGLE_ACTIVE === 'true';
const expectedLiteral = process.env.EXPECTED_LITERAL === 'true';
if (Boolean(scheduling.singleActivePlanEnabled) !== expectedSingle) process.exit(1);
if (Boolean(scheduling.literalWorktreesEnabled) !== expectedLiteral) process.exit(1);
const expectedLiteralProjects = expectedLiteral ? ['bodysense'] : [];
if (JSON.stringify(runtime.literalWorktreeProjectKeys) !== JSON.stringify(expectedLiteralProjects)) process.exit(1);
NODE
    then
      openhands="$(curl -fsS --max-time 2 http://127.0.0.1:18000/health)"
      resources="$(curl -fsS --max-time 10 http://127.0.0.1:8320/api/v4/resources)"
      if ! RESOURCES_JSON="$resources" /usr/bin/node - <<'NODE'
const payload = JSON.parse(process.env.RESOURCES_JSON ?? '{}');
if (!Array.isArray(payload.items) || payload.items.length < 1) process.exit(1);
const antigravity = payload.items.find((item) => item.resourceId === 'antigravity-primary');
if (!antigravity || antigravity.state !== 'ACTIVE') process.exit(1);
if (!Array.isArray(antigravity.modelBindings)) process.exit(1);
if (!antigravity.modelBindings.some((item) => item.modelFamily === 'gemini-3.8-flash-high' && item.enabled === true)) process.exit(1);
if (payload.items.some((item) => item.modelBindings?.some((binding) => binding.modelFamily === 'codex-auto-review'))) process.exit(1);
NODE
      then
        sleep 1
        continue
      fi
      probe_status="$(curl -sS -o /tmp/pixel-v4-release-probe.json -w '%{http_code}' --max-time 2 http://127.0.0.1:8320/api/v4/plans/__release_probe__)"
      if [[ "$probe_status" == "404" ]] && grep -q 'PLAN_NOT_FOUND' /tmp/pixel-v4-release-probe.json; then
        printf 'V4 release healthy; source_sha=%s artifact_sha=%s\n%s\n%s\n%s\n' "$source_sha" "$artifact_sha" "$health" "$openhands" "$resources"
        exit 0
      fi
    fi
  fi
  sleep 1
done

sudo systemctl --no-pager --full status "$service" >&2 || true
echo "V4 release health check failed; source_sha=$source_sha artifact_sha=$artifact_sha" >&2
exit 1
