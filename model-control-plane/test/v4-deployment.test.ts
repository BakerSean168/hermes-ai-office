import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = fs.readFileSync(
  path.join(root, 'deploy/gcp/hermes-model-control-plane.service'),
  'utf8',
);
const installer = fs.readFileSync(
  path.join(root, 'deploy/gcp/install-gcp-execution-plane.sh'),
  'utf8',
);
const releasePath = path.join(root, 'scripts/release-v4-gcp.sh');
const probePath = path.join(root, 'scripts/probe-v4-service-sandbox.sh');
const release = fs.readFileSync(releasePath, 'utf8');
const probe = fs.readFileSync(probePath, 'utf8');
const openHandsBuild = fs.readFileSync(path.join(root, 'scripts/build-openhands-v3-source.sh'), 'utf8');
const openHandsCompose = fs.readFileSync(path.join(root, 'deploy/openhands-v3/docker-compose.yml'), 'utf8');
const openHandsTooling = fs.readFileSync(path.join(root, 'scripts/install-openhands-v3-tooling.sh'), 'utf8');

test('V4 service enables durable execution with narrowly scoped writable paths', () => {
  assert.match(service, /Description=Hermes Pixel Agent V4 Durable Coding Control Plane/);
  assert.match(
    service,
    /MODEL_CP_DB=\/srv\/hermes-personal\/data\/model-control-plane\/pixel-v4\.sqlite/,
  );
  assert.match(service, /MODEL_CP_EXECUTION_RUNTIME_ENABLED=true/);
  assert.match(service, /MODEL_CP_AUTOMATION_RUNTIME_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_AUTOMATION_PROJECTS=memoflow,digital-biome/);
  assert.match(
    service,
    /MODEL_CP_V4_IMPLEMENTATION_ROUTES=gpt-5\.6-luna,implementation-efficient,implementation-glm=glm-5\.2/,
  );
  assert.match(
    service,
    /MODEL_CP_V4_REVIEW_ROUTES=gpt-5\.6-sol,codex-auto-review,review-glm=glm-5\.2/,
  );
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ProtectHome=read-only/);
  for (const writable of [
    '/srv/hermes-personal/data/model-control-plane',
    '/opt/data/hermes-ai-office-v3/workspaces',
    '/home/dev/projects/memoflow-platform-1003',
    '/home/dev/projects/memoflow/.git',
    '/home/dev/projects/digital-biome',
  ])
    assert.match(
      service,
      new RegExp('ReadWritePaths=' + writable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  assert.doesNotMatch(service, /ReadWritePaths=\/home\/dev\/projects\s*$/m);
  assert.match(service, /CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID/);
  assert.match(service, /AmbientCapabilities=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID/);
  assert.doesNotMatch(service, /(?:SESSION_API_KEY|LITELLM_V3_KEY|OH_SECRET_KEY)=\S+/);
});

test('V4 installer takes a SQLite backup and requires V4 execution health', () => {
  assert.match(installer, /from 'node:sqlite'/);
  assert.match(installer, /await backup\(db, target\)/);
  assert.match(installer, /pixel-v4-\$\(date -u/);
  assert.match(installer, /http:\/\/127\.0\.0\.1:8320\/api\/health/);
  assert.match(installer, /payload\.apiVersion !== 4/);
  assert.match(installer, /payload\.executionRuntime\?\.enabled !== true/);
  assert.match(
    installer,
    /install -d -o root -g root -m 0711 "\$WORKSPACE_DIR\/v4" "\$WORKSPACE_DIR\/v4\/executions"/,
  );
  assert.doesNotMatch(installer, /PIXEL_V4_ALLOW_DATA_RESET=true/);
});

test('V4 release deploys the reviewed canonical SHA and fails closed on partial health', () => {
  assert.match(service, /WorkingDirectory=\/home\/dev\/projects\/pixel-agents/);
  assert.match(service, /ExecStart=\/usr\/bin\/node model-control-plane\/dist\/main\.js/);
  assert.match(release, /target_root="\/home\/dev\/projects\/pixel-agents"/);
  assert.match(release, /source_sha=.*rev-parse HEAD/);
  assert.match(release, /target_sha=.*rev-parse HEAD/);
  assert.match(release, /canonical source SHA/);
  assert.match(release, /await backup\(db, target\)/);
  assert.match(release, /runtime\.enabled !== true \|\| runtime\.autonomousPolling !== true/);
  assert.match(release, /runtime\.implementationRoutes\[0\] !== 'gpt-5\.6-luna'/);
  assert.match(release, /runtime\.reviewRoutes\[0\] !== 'gpt-5\.6-sol'/);
  assert.match(release, /runtime\.automationProjectKeys/);
  assert.match(release, /api\/v4\/plans\/__release_probe__/);
  assert.doesNotMatch(release, /PIXEL_V4_ALLOW_DATA_RESET=true/);
});

test('OpenHands coding runtime is built and release-gated on Node 24', () => {
  assert.match(openHandsBuild, /OPENHANDS_BASE_IMAGE:-nikolaik\/python-nodejs:python3\.13-nodejs24-slim/);
  assert.match(openHandsBuild, /--build-arg BASE_IMAGE="\$BASE_IMAGE"/);
  assert.match(release, /process\.versions\.node\.split/);
  assert.match(release, /OpenHands coding runtime must use Node 24/);
});

test('OpenHands persists and prewarms exact Corepack pnpm versions without prompts', () => {
  assert.match(openHandsCompose, /COREPACK_HOME: \/openhands-state\/corepack/);
  assert.match(openHandsCompose, /COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'/);
  assert.match(openHandsTooling, /COREPACK_PNPM_VERSIONS=.*10\.32\.1 11\.17\.0 11\.20\.0/);
  assert.match(openHandsTooling, /corepack install -g "pnpm@\$version"/);
  assert.match(release, /test "\$COREPACK_HOME" = \/openhands-state\/corepack/);
  for (const version of ['10.32.1', '11.17.0', '11.20.0'])
    assert.match(release, new RegExp('pnpm/' + version.replace(/\./g, '\\.') + '"'));
  assert.match(release, /actual_version=.*pnpm --version/);
});

test('V4 release never rsyncs a build directory onto itself', () => {
  assert.match(release, /if \[\[ "\$repo_root" != "\$target_root" \]\]; then/);
  assert.match(release, /rsync -a --delete/);
});

test('V4 release proves the exact service sandbox can read, chown and write only approved paths', () => {
  assert.match(release, /systemd-run --wait --pipe --collect/);
  assert.match(release, /CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID/);
  assert.match(release, /probe-v4-service-sandbox\.sh/);
  assert.match(probe, /test -r "\$entry_file"/);
  assert.match(probe, /chown -R "\$owner_uid:\$owner_gid"/);
  assert.match(probe, /spawnSync\('\/usr\/bin\/id', \['-u'\], \{ encoding: 'utf8', uid, gid \}\)/);
  assert.match(release, /install -d -o root -g root -m 0711/);
  assert.match(release, /docker exec --user 10001:10001 hermes-openhands-v3/);
  assert.match(probe, /trap - EXIT/);
  assert.doesNotMatch(probe, /\ncleanup\ntrap - EXIT/);
  assert.match(release, /memoflow-platform-1003\/\.pixel-v4-release/);
  assert.match(release, /memoflow\/\.git\/pixel-v4-release/);
  assert.match(probe, /memo_git_probe/);
  assert.match(release, /digital-biome\/\.pixel-v4-release/);
  assert.match(release, /trap cleanup_probe EXIT/);
});

test('V4 release and sandbox probe scripts are valid Bash', () => {
  execFileSync('bash', ['-n', releasePath]);
  execFileSync('bash', ['-n', probePath]);
});
