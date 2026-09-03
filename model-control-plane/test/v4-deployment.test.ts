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
const openHandsBuild = fs.readFileSync(
  path.join(root, 'scripts/build-openhands-v3-source.sh'),
  'utf8',
);
const openHandsCompose = fs.readFileSync(
  path.join(root, 'deploy/openhands-v3/docker-compose.yml'),
  'utf8',
);
const openHandsTooling = fs.readFileSync(
  path.join(root, 'scripts/install-openhands-v3-tooling.sh'),
  'utf8',
);
const gitWorkspace = fs.readFileSync(path.join(root, 'src/v4/adapters/gitWorkspace.ts'), 'utf8');
const headlessReview = fs.readFileSync(
  path.join(root, 'openhands_tools/headless_review_acp.mjs'),
  'utf8',
);

test('V4 service enables durable execution with narrowly scoped writable paths', () => {
  assert.match(service, /Description=Hermes Pixel Agent V4 Durable Coding Control Plane/);
  assert.match(
    service,
    /MODEL_CP_DB=\/srv\/hermes-personal\/data\/model-control-plane\/pixel-v4\.sqlite/,
  );
  assert.match(service, /MODEL_CP_EXECUTION_RUNTIME_ENABLED=true/);
  assert.match(service, /MODEL_CP_AUTOMATION_RUNTIME_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_AUTOMATION_PROJECTS=memoflow,digital-biome,bodysense/);
  assert.match(
    service,
    /MODEL_CP_V4_IMPLEMENTATION_ROUTES=gpt-5\.6-luna,implementation-efficient,implementation-glm=glm-5\.2/,
  );
  assert.match(
    service,
    /MODEL_CP_V4_REVIEW_ROUTES=codex-business-review=gpt-5\.6-sol,gpt-5\.6-sol,codex-auto-review,review-glm=glm-5\.2/,
  );
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ProtectHome=read-only/);
  for (const writable of [
    '/srv/hermes-personal/data/model-control-plane',
    '/opt/data/hermes-ai-office-v3/workspaces',
    '/home/dev/projects/memoflow-platform-1003',
    '/home/dev/projects/memoflow/.git',
    '/home/dev/projects/digital-biome',
    '/home/dev/projects/bodysense',
  ])
    assert.match(
      service,
      new RegExp('ReadWritePaths=' + writable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  assert.doesNotMatch(service, /ReadWritePaths=\/home\/dev\/projects\s*$/m);
  assert.match(
    service,
    /CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID/,
  );
  assert.match(
    service,
    /AmbientCapabilities=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID/,
  );
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
  assert.match(release, /runtime\.reviewRoutes\[0\] !== 'codex-business-review'/);
  assert.match(release, /runtime\.requireDelivery !== true/);
  assert.match(release, /runtime\.automationProjectKeys/);
  assert.match(release, /api\/v4\/plans\/__release_probe__/);
  assert.doesNotMatch(release, /PIXEL_V4_ALLOW_DATA_RESET=true/);
});

test('V4 Luna implementation uses managed Codex Responses and bridges durable implementation evidence', () => {
  assert.match(headlessReview, /wire_api = \"responses\"/);
  assert.match(headlessReview, /unified_exec = false/);
  assert.doesNotMatch(headlessReview, /managedCodexModelCatalog|model_catalog_json|use_responses_lite/);
  assert.match(headlessReview, /PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH/);
  assert.match(headlessReview, /PIXEL_V4_SOURCE_SHA/);
  assert.match(headlessReview, /writePixelV4ImplementationEvidence/);
  assert.match(headlessReview, /PIXEL_V4_IMPLEMENTATION_WORKSPACE_DIRTY/);
  assert.match(headlessReview, /PIXEL_V4_IMPLEMENTATION_TEST_EVIDENCE_MISSING/);
  assert.match(headlessReview, /PIXEL_V4_IMPLEMENTATION_SOURCE_SHA_INVALID/);
  assert.match(headlessReview, /merge-base.*is-ancestor/);
  assert.match(headlessReview, /outcome/);
  assert.doesNotMatch(headlessReview, /PIXEL_V4_IMPLEMENTATION_NO_COMMIT/);
  assert.match(headlessReview, /Pixel V4 controller finalization retry/);
  assert.match(headlessReview, /isPixelV4ImplementationFinalizationError/);
  assert.match(headlessReview, /outer headless adapter, not this Codex sandbox, persists/);
  assert.match(headlessReview, /HEADLESS_ROLE === 'worker'/);
});

test('V4 Business Codex review is provider-native and bridges durable review evidence', () => {
  assert.match(service, /MODEL_CP_V4_MAX_REVIEW_ATTEMPTS=4/);
  assert.match(headlessReview, /PIXEL_V4_REVIEW_EVIDENCE_PATH/);
  assert.match(headlessReview, /PIXEL_V4_EXECUTION_ID/);
  assert.match(headlessReview, /PIXEL_V4_REVIEWED_SHA/);
  assert.match(headlessReview, /writePixelV4ReviewEvidence/);
  assert.match(headlessReview, /required: \['verdict', 'summary', 'findings', 'checks'\]/);
  assert.match(headlessReview, /enum: \['PASS', 'FAIL', 'INVALID'\]/);
  assert.match(headlessReview, /outer headless adapter, not this Codex sandbox, persists/);
  assert.match(headlessReview, /HEADLESS_TRANSPORT === 'provider-native'/);
  assert.match(headlessReview, /HEADLESS_ROLE === 'review' \? 'openhands-review' : 'openhands'/);
  assert.match(
    headlessReview,
    /Verification may create ignored dependency or tool-cache artifacts/,
  );
  assert.match(headlessReview, /delete env\.CODEX_API_KEY/);
});

test('V4 model-native ACP tooling exposes DSH, ZCode and safe execution-scoped ZCode config', () => {
  const launcher = fs.readFileSync(
    path.join(root, 'openhands_tools/harness_agent_launcher.sh'),
    'utf8',
  );
  assert.match(launcher, /dsh-acp\|zcode-acp/);
  assert.match(launcher, /expected_workspace_repo="\/workspace\/executions\/\$execution_id\/repo"/);
  assert.match(launcher, /zcode_root="\$root\/zcode"/);
  assert.match(launcher, /zcode_key="\$\{AI_OFFICE_LITELLM_API_KEY:-\$\{ZCODE_API_KEY:-\}\}"/);
  assert.match(launcher, /zcode_base="\$\{AI_OFFICE_LITELLM_BASE_URL:-\$\{ZCODE_BASE_URL:-\}\}"/);
  assert.match(launcher, /zcode_model="\$\{AI_OFFICE_AGENT_MODEL:-\$\{ZCODE_MODEL:-\}\}"/);
  assert.match(launcher, /unset ZCODE_AUTH_TOKEN ZCODE_OAUTH_TOKEN ZCODE_ACCESS_TOKEN ZCODE_USER_TOKEN/);
  assert.match(launcher, /exec \/openhands-state\/tooling\/node_modules\/\.bin\/zcode-acp-server/);
  assert.match(launcher, /target\.chmod\(0o600\)/);
  assert.doesNotMatch(launcher, /\.config\/zcode|\.zcode/);
  execFileSync('bash', ['-n', path.join(root, 'openhands_tools/harness_agent_launcher.sh')]);
});

test('OpenHands coding runtime is built and release-gated on Node 24', () => {
  assert.match(
    openHandsBuild,
    /OPENHANDS_BASE_IMAGE:-nikolaik\/python-nodejs:python3\.13-nodejs24-slim/,
  );
  assert.match(openHandsBuild, /--build-arg BASE_IMAGE="\$BASE_IMAGE"/);
  assert.match(release, /process\.versions\.node\.split/);
  assert.match(release, /OpenHands coding runtime must use Node 24/);
});

test('V4 release reconciles OpenHands Agent runtimes from the shared Harness lock and verifies Business Codex auth', () => {
  assert.match(openHandsTooling, /HARNESS_RUNTIME_LOCK=.*agent-harness\/runtime\.lock\.json/);
  assert.match(openHandsTooling, /runtime_lock_version codex/);
  assert.match(openHandsTooling, /runtime_lock_version opencode/);
  assert.match(openHandsTooling, /runtime_lock_version claude/);
  assert.match(release, /install-openhands-v3-tooling\.sh/);
  assert.match(release, /CODEX_HOME=\/openhands-state\/codex-business/);
  assert.match(release, /codex login status/);
});

test('OpenHands persists and gates the exact BodySense Go toolchain', () => {
  assert.match(openHandsCompose, /PATH: \/openhands-state\/toolchains\/go-1\.26\.0\/bin:/);
  assert.match(openHandsCompose, /GOTOOLCHAIN: local/);
  assert.match(openHandsTooling, /OPENHANDS_GO_TOOLCHAIN_VERSION:-1\.26\.0/);
  assert.match(openHandsTooling, /golang:\$\{GO_TOOLCHAIN_VERSION\}-bookworm/);
  assert.match(openHandsTooling, /--volumes-from "\$CONTAINER"/);
  assert.match(openHandsTooling, /"\$GO_TOOLCHAIN_ROOT\/bin\/go" version/);
  assert.match(openHandsTooling, /test -x "\$GO_TOOLCHAIN_ROOT\/bin\/gofmt"/);
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
  assert.match(
    release,
    /CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID/,
  );
  assert.match(release, /probe-v4-service-sandbox\.sh/);
  assert.match(probe, /test -r "\$entry_file"/);
  assert.match(probe, /chown -R "\$owner_uid:\$owner_gid"/);
  assert.match(probe, /chmod 0711 "\$probe_dir"/);
  assert.match(probe, /spawnSync\('\/usr\/bin\/id', \['-u'\], \{ encoding: 'utf8', uid, gid \}\)/);
  assert.match(release, /install -d -o root -g root -m 0711/);
  assert.match(release, /docker exec --user 10001:10001 hermes-openhands-v3/);
  assert.match(probe, /trap - EXIT/);
  assert.match(probe, /Source-repository probes must never escape/);
  assert.match(release, /\$\{digital_probe\}\.repository-owner/);
  assert.doesNotMatch(probe, /\ncleanup\ntrap - EXIT/);
  assert.match(probe, /repository_probe=\"\$\{digital_probe\}\.repository-owner\"/);
  assert.match(probe, /repository-owner Git probe failed/);
  assert.match(probe, /GIT_OPTIONAL_LOCKS=0/);
  assert.match(gitWorkspace, /GIT_OPTIONAL_LOCKS: '0'/);
  assert.match(release, /memoflow-platform-1003\/\.pixel-v4-release/);
  assert.match(release, /memoflow\/\.git\/pixel-v4-release/);
  assert.match(probe, /memo_git_probe/);
  assert.match(release, /digital-biome\/\.pixel-v4-release/);
  assert.match(release, /bodysense\/\.pixel-v4-release/);
  assert.match(release, /bodysense\/\.git\/pixel-v4-release/);
  assert.match(probe, /body_probe/);
  assert.match(probe, /body_git_probe/);
  assert.match(release, /trap cleanup_probe EXIT/);
});

test('V4 release and sandbox probe scripts are valid Bash', () => {
  execFileSync('bash', ['-n', releasePath]);
  execFileSync('bash', ['-n', probePath]);
});
