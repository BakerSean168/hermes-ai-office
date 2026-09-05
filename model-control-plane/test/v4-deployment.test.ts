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
const pinReleasePath = path.join(root, 'scripts/pin-v4-release-ref.sh');
const probePath = path.join(root, 'scripts/probe-v4-service-sandbox.sh');
const release = fs.readFileSync(releasePath, 'utf8');
const pinRelease = fs.readFileSync(pinReleasePath, 'utf8');
const probe = fs.readFileSync(probePath, 'utf8');
const literalWorktreeSmoke = fs.readFileSync(
  path.join(root, 'scripts/smoke-v4-literal-worktree.mjs'),
  'utf8',
);
const routingProfileSmoke = fs.readFileSync(
  path.join(root, 'scripts/smoke-v4-routing-profile.mts'),
  'utf8',
);
const atomicExchangePath = path.join(root, 'scripts/atomic-exchange-directories.py');
const hostCacheScriptPath = path.join(root, 'scripts/prune-v4-host-cache.sh');
const hostCacheScript = fs.readFileSync(hostCacheScriptPath, 'utf8');
const hostCacheService = fs.readFileSync(
  path.join(root, 'deploy/gcp/hermes-pixel-v4-host-cache.service'),
  'utf8',
);
const hostCacheTimer = fs.readFileSync(
  path.join(root, 'deploy/gcp/hermes-pixel-v4-host-cache.timer'),
  'utf8',
);
const atomicExchange = fs.readFileSync(atomicExchangePath, 'utf8');
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
const antigravityUnit = fs.readFileSync(
  path.join(root, 'deploy/gcp/hermes-antigravity-v4@.service'),
  'utf8',
);
const antigravityRunner = fs.readFileSync(
  path.join(root, 'scripts/run-antigravity-v4-unit.mjs'),
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
  assert.match(
    service,
    /MODEL_CP_V4_AUTOMATION_PROJECTS=memoflow,digital-biome,bodysense,forgeflow/,
  );
  assert.match(service, /MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_LITERAL_WORKTREES_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_LITERAL_WORKTREE_PROJECTS=bodysense,forgeflow/);
  assert.match(
    service,
    /MODEL_CP_V4_HOST_CACHE_STATE_FILE=\/srv\/hermes-personal\/data\/model-control-plane\/host-cache-maintenance\.json/,
  );
  assert.match(service, /MODEL_CP_V4_MAX_PARALLEL_WORK_ITEMS=2/);
  assert.match(
    service,
    /MODEL_CP_AGENT_HARNESS_CTL=\/home\/dev\/projects\/agent-harness\/bin\/harnessctl\.py/,
  );
  assert.match(service, /MODEL_CP_V4_RESOURCE_SELECTOR_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_LITERAL_WORKTREES_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_BUSINESS_RESOURCE_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_ANTIGRAVITY_RESOURCE_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_ANTIGRAVITY_PROJECTS=digital-biome/);
  assert.match(service, /MODEL_CP_V4_ANTIGRAVITY_SYSTEMD_UNIT=hermes-antigravity-v4@%i\.service/);
  assert.doesNotMatch(service, /MODEL_CP_V4_IMPLEMENTATION_ROUTES=/);
  assert.doesNotMatch(service, /MODEL_CP_V4_REVIEW_ROUTES=/);
  assert.doesNotMatch(service, /codex-auto-review/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ProtectHome=read-only/);
  for (const writable of [
    '/srv/hermes-personal/data/model-control-plane',
    '/opt/data/hermes-ai-office-v3/workspaces',
    '/home/dev/projects/memoflow-platform-1003',
    '/home/dev/projects/memoflow/.git',
    '/home/dev/projects/digital-biome',
    '/home/dev/projects/bodysense',
    '/home/dev/projects/forgeflow',
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
  assert.doesNotMatch(service, /CAP_SYS_ADMIN/);
  assert.match(antigravityUnit, /CapabilityBoundingSet=.*CAP_SYS_ADMIN/);
  // The root-only mount wrapper needs CAP_SETPCAP solely to drop the final
  // capability bounding set before execing Antigravity as the unprivileged user.
  assert.match(antigravityUnit, /CapabilityBoundingSet=.*CAP_SETPCAP/);
  assert.match(antigravityUnit, /AmbientCapabilities=.*CAP_SETPCAP/);
  assert.match(
    antigravityUnit,
    /ExecStart=\/usr\/bin\/node \/usr\/local\/libexec\/hermes-antigravity-v4-unit\.mjs %i/,
  );
  assert.match(antigravityUnit, /KillMode=control-group/);
  assert.match(antigravityRunner, /ANTIGRAVITY_UNIT_REQUEST_POLICY_INVALID/);
  assert.match(antigravityRunner, /--kill-child=SIGKILL/);
  assert.match(antigravityRunner, /allowedModels/);
  assert.doesNotMatch(service, /(?:SESSION_API_KEY|LITELLM_V3_KEY|OH_SECRET_KEY)=\S+/);
});

test('OpenHands literal-worktree mounts expose only managed workspaces and allowlisted Git common dirs', () => {
  assert.match(openHandsCompose, /\/opt\/data\/hermes-ai-office-v3\/workspaces:\/workspace/);
  assert.match(
    openHandsCompose,
    /\/opt\/data\/hermes-ai-office-v3\/workspaces:\/opt\/data\/hermes-ai-office-v3\/workspaces/,
  );
  for (const project of ['bodysense', 'digital-biome', 'memoflow', 'forgeflow', 'ai-office-smoke'])
    assert.ok(
      openHandsCompose.includes(
        `/home/dev/projects/${project}/.git:/home/dev/projects/${project}/.git`,
      ),
    );
  assert.doesNotMatch(openHandsCompose, /\/home\/dev\/projects:\/home\/dev\/projects(?:\s|$)/);
  assert.doesNotMatch(
    openHandsCompose,
    /\/home\/dev\/projects\/ai-office-smoke:\/home\/dev\/projects\/ai-office-smoke(?:\s|$)/,
  );
  assert.match(
    openHandsCompose,
    /HERMES_OPENHANDS_TOOLS_DIR:-\.\.\/\.\.\/openhands_tools.*:\/opt\/hermes-ai-office-tools:ro/,
  );
  assert.match(release, /release-artifacts\/openhands-tools/);
  assert.match(release, /HERMES_OPENHANDS_TOOLS_DIR=.*openhands_tools_release/);
  assert.match(release, /actual_tools_mount=.*docker inspect hermes-openhands-v3/);
  assert.match(release, /persisted OpenHands tools differ from approved SHA/);
  assert.match(release, /harness_agent_launcher\.sh/);
  assert.match(release, /\/opt\/agent-harness\/bin\/harnessctl\.py/);
  assert.match(installer, /apt-get install -y -qq acl/);
  assert.match(installer, /command -v setfacl/);
  assert.match(release, /setfacl is required for literal V4 worktree ACLs/);
  assert.match(release, /Agent Harness resolver is missing/);
  assert.match(release, /python3 .*harnessctl.*--help/);
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

test('V4 release uses an approved exact-SHA transient worktree and fails closed on partial health', () => {
  assert.match(service, /WorkingDirectory=\/home\/dev\/projects\/pixel-agents/);
  assert.match(service, /ExecStart=\/usr\/bin\/node model-control-plane\/dist\/main\.js/);
  assert.match(release, /canonical_root=.*\/home\/dev\/projects\/pixel-agents/);
  assert.match(release, /release_ref=.*refs\/pixel-v4\/release-approved/);
  assert.match(release, /rev-parse .*release_ref.*\^\{commit\}/);
  assert.match(release, /worktree add --detach/);
  assert.match(release, /PIXEL_V4_RELEASE_INNER=1/);
  assert.match(release, /inherited release lock is missing/);
  assert.match(release, /flock -n 9/);
  assert.match(release, /release worktree HEAD mismatch/);
  assert.match(release, /release worktree is not clean/);
  assert.match(release, /--path-format=absolute --git-common-dir/);
  assert.match(release, /release worktree does not share canonical Git common dir/);
  assert.match(release, /approved ref moved during release/);
  assert.match(release, /launcher differs from approved release SHA/);
  assert.doesNotMatch(release, /refusing release from dirty worktree/);
  assert.doesNotMatch(release, /canonical source SHA .* does not match release SHA/);
  assert.match(release, /await backup\(db, target\)/);
  assert.match(release, /runtime\.enabled !== true \|\| runtime\.autonomousPolling !== true/);
  assert.match(release, /runtime\.resourceSelectorEnabled !== true/);
  assert.match(release, /runtime\.routingAuthority !== 'RESOURCE_SELECTOR'/);
  assert.match(release, /runtime\.compatibilityImplementationRoutes\.length !== 0/);
  assert.match(release, /runtime\.compatibilityReviewRoutes\.length !== 0/);
  assert.match(release, /storage\.lowCapacity !== false/);
  assert.match(release, /hostCacheMaintenance\?\.status === 'INVALID'/);
  assert.match(release, /storage\.freeBytes/);
  assert.match(release, /storage\.minimumFreeBytes/);
  assert.match(release, /runtime\.reviewRoutes\.includes\('codex-auto-review'\)/);
  assert.match(release, /runtime\.requireDelivery !== true/);
  assert.match(release, /runtime\.automationProjectKeys/);
  assert.match(release, /\['memoflow', 'digital-biome', 'bodysense', 'forgeflow'\]/);
  assert.match(
    release,
    /expectedLiteralProjects = expectedLiteral \? \['bodysense', 'forgeflow'\] : \[\]/,
  );
  assert.match(release, /api\/v4\/plans\/__release_probe__/);
  assert.match(release, /api\/v4\/resources/);
  assert.match(release, /hermes-antigravity-v4-unit\.mjs/);
  assert.match(release, /hermes-antigravity-v4@\.service/);
  assert.match(release, /gemini-3\.8-flash-high/);
  assert.match(release, /gemini-3\.1-pro-high/);
  assert.match(release, /MODEL_CP_V4_LITERAL_WORKTREES_ENABLED=true/);
  assert.match(release, /smoke-v4-literal-worktree\.mjs/);
  assert.doesNotMatch(release, /PIXEL_V4_ALLOW_DATA_RESET=true/);
});

test('V4 release approval ref is explicit, durable, and fast-forward only', () => {
  const temp = fs.mkdtempSync('/tmp/pixel-v4-release-ref-');
  try {
    execFileSync('git', ['init', '-q', temp]);
    execFileSync('git', ['-C', temp, 'config', 'user.name', 'Pixel Test']);
    execFileSync('git', ['-C', temp, 'config', 'user.email', 'pixel-test@localhost']);
    fs.writeFileSync(path.join(temp, 'value.txt'), 'one\n');
    execFileSync('git', ['-C', temp, 'add', 'value.txt']);
    execFileSync('git', ['-C', temp, 'commit', '-qm', 'one']);
    const first = execFileSync('git', ['-C', temp, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    fs.writeFileSync(path.join(temp, 'value.txt'), 'two\n');
    execFileSync('git', ['-C', temp, 'commit', '-qam', 'two']);
    const second = execFileSync('git', ['-C', temp, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    execFileSync('bash', [pinReleasePath, first], {
      env: {
        ...process.env,
        PIXEL_V4_CANONICAL_ROOT: temp,
        PIXEL_V4_RELEASE_LOCK: path.join(temp, 'release.lock'),
      },
      stdio: 'pipe',
    });
    execFileSync('bash', [pinReleasePath, second], {
      env: {
        ...process.env,
        PIXEL_V4_CANONICAL_ROOT: temp,
        PIXEL_V4_RELEASE_LOCK: path.join(temp, 'release.lock'),
      },
      stdio: 'pipe',
    });
    const approved = execFileSync(
      'git',
      ['-C', temp, 'rev-parse', 'refs/pixel-v4/release-approved^{commit}'],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(approved, second);
    assert.throws(() =>
      execFileSync('bash', [pinReleasePath, first], {
        env: {
          ...process.env,
          PIXEL_V4_CANONICAL_ROOT: temp,
          PIXEL_V4_RELEASE_LOCK: path.join(temp, 'release.lock'),
        },
        stdio: 'pipe',
      }),
    );
    const reflog = execFileSync(
      'git',
      ['-C', temp, 'reflog', 'show', 'refs/pixel-v4/release-approved'],
      { encoding: 'utf8' },
    );
    assert.match(reflog, /pixel-v4 release approval/);
    assert.match(pinRelease, /not invent or claim review evidence itself/);
    assert.match(pinRelease, /merge-base --is-ancestor/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('V4 Luna implementation uses managed Codex Responses and bridges durable implementation evidence', () => {
  assert.match(headlessReview, /wire_api = \"responses\"/);
  assert.match(headlessReview, /unified_exec = false/);
  assert.doesNotMatch(
    headlessReview,
    /managedCodexModelCatalog|model_catalog_json|use_responses_lite/,
  );
  assert.match(headlessReview, /PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH/);
  assert.match(headlessReview, /assertPixelV4EvidenceTarget/);
  assert.match(headlessReview, /\.executions.*PIXEL_V4_EXECUTION_ID.*completion-evidence\.json/s);
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
  assert.match(headlessReview, /AI_OFFICE_EXPECTED_GIT_COMMON_DIR/);
  assert.match(headlessReview, /AI_OFFICE_EXPECTED_WORKTREE_GIT_FILE/);
  assert.match(headlessReview, /HEADLESS_WORKER_GIT_COMMON_DIR_MISMATCH/);
  assert.match(headlessReview, /HEADLESS_WORKER_GIT_COMMON_POINTER_INVALID/);
  assert.match(headlessReview, /HEADLESS_WORKER_GIT_WORKTREE_POINTER_INVALID/);
  assert.match(headlessReview, /HEADLESS_WORKER_GIT_WORKTREE_IDENTITY_INVALID/);
  assert.match(
    headlessReview,
    /path\.dirname\(adminDir\) !== path\.join\(commonDir, 'worktrees'\)/,
  );
  assert.match(headlessReview, /AI_OFFICE_HEADLESS_IDLE_EXIT_SECONDS/);
  assert.match(headlessReview, /scheduleProcessExit\(1_000\)/);
  assert.doesNotMatch(headlessReview, /EXIT_GRACE_MS = 5_000/);
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
  assert.match(launcher, /ai_office_dsh_patch=\/etc\/hermes-ai-office-v3\/dsh-acp-v3\.patch\.yml/);
  assert.match(
    launcher,
    /--patch \"\$ai_office_dsh_patch\"[\s\S]*--patch \"\$root\/dsh\/capabilities\.patch\.yml\"/,
  );
  assert.match(
    launcher,
    /expected_v3_workspace_repo="\/workspace\/executions\/\$execution_id\/repo"/,
  );
  assert.match(
    launcher,
    /expected_v4_workspace_repo="\/workspace\/v4\/executions\/\$execution_id\/repo"/,
  );
  assert.match(launcher, /execution_root="\$\{workspace_repo%\/repo\}"/);
  assert.match(launcher, /zcode-acp\)\n    root="\$\(prepare_root zcode\)"/);
  assert.match(launcher, /zcode_root="\$root\/zcode"/);
  assert.match(launcher, /zcode_key="\$\{AI_OFFICE_LITELLM_API_KEY:-\$\{ZCODE_API_KEY:-\}\}"/);
  assert.match(launcher, /zcode_base="\$\{AI_OFFICE_LITELLM_BASE_URL:-\$\{ZCODE_BASE_URL:-\}\}"/);
  assert.match(launcher, /zcode_model="\$\{AI_OFFICE_AGENT_MODEL:-\$\{ZCODE_MODEL:-\}\}"/);
  assert.match(launcher, /zcode_model_family="\$\{ZCODE_MODEL_FAMILY:-\}"/);
  assert.match(launcher, /zcode_reasoning_effort="\$\{ZCODE_REASONING_EFFORT:-high\}"/);
  assert.match(launcher, /model_family == "glm-current"/);
  assert.match(launcher, /model_config\["limit"\] = \{"context": 1_000_000\}/);
  assert.match(launcher, /"variants": \["max", "high", "nothink"\]/);
  assert.match(launcher, /"defaultVariant": thought/);
  assert.match(
    launcher,
    /unset ZCODE_AUTH_TOKEN ZCODE_OAUTH_TOKEN ZCODE_ACCESS_TOKEN ZCODE_USER_TOKEN/,
  );
  assert.match(launcher, /exec \/openhands-state\/tooling\/node_modules\/\.bin\/zcode-acp-server/);
  assert.match(launcher, /target\.chmod\(0o600\)/);
  assert.match(launcher, /zcode_provider_config="\$zcode_provider_dir\/config\.json"/);
  assert.match(launcher, /zcode_home="\$zcode_root\/home"/);
  assert.match(launcher, /"kind": "openai-compatible"/);
  assert.match(launcher, /"provider":/);
  assert.doesNotMatch(launcher, /\.config\/zcode/);
  execFileSync('bash', ['-n', path.join(root, 'openhands_tools/harness_agent_launcher.sh')]);
});

test('routing profile acceptance uses production admission and always disposes isolated runtime state', () => {
  assert.match(routingProfileSmoke, /\/api\/v4\/runtime-admission/);
  assert.match(routingProfileSmoke, /production target is not READY/);
  assert.match(routingProfileSmoke, /dbFile: ':memory:'/);
  assert.match(routingProfileSmoke, /canonical smoke repository HEAD changed/);
  assert.match(routingProfileSmoke, /canonical smoke repository became dirty/);
  assert.match(routingProfileSmoke, /\/interrupt/);
  assert.match(routingProfileSmoke, /method: 'DELETE'/);
  assert.match(routingProfileSmoke, /cleanupRoots/);
  assert.match(routingProfileSmoke, /REVISION/);
  assert.match(routingProfileSmoke, /TEST/);
  assert.match(routingProfileSmoke, /REVIEW/);
  assert.doesNotMatch(routingProfileSmoke, /SESSION_API_KEY\s*=\s*['"][^'"]+['"]/);
  assert.doesNotMatch(routingProfileSmoke, /LITELLM_V3_KEY\s*=\s*['"][^'"]+['"]/);
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
  assert.match(openHandsTooling, /runtime_lock_version zcode/);
  assert.match(release, /deploy\/openhands-v3\/docker-compose\.yml/);
  assert.match(release, /docker compose.*up -d --remove-orphans --wait --wait-timeout 120/);
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
  assert.match(release, /command -v go/);
  assert.match(release, /OpenHands Agent PATH must resolve persisted Go 1\.26\.0 first/);
  assert.match(release, /go version/);
  assert.match(release, /OpenHands Agent PATH must expose Go 1\.26\.0/);
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

test('V4 release publishes only a complete fsynced dist with an atomic directory exchange', () => {
  assert.match(release, /core\.fsync committed/);
  assert.match(release, /\.release-candidates/);
  assert.match(release, /npm exec -- tsc -p tsconfig\.json --outDir "\$candidate_dist"/);
  assert.match(release, /PIXEL_V4_DIST_ROOT="\$candidate_dist"/);
  assert.match(literalWorktreeSmoke, /PIXEL_V4_DIST_ROOT/);
  assert.match(release, /sync -f "\$candidate_dist"/);
  assert.match(release, /atomic-exchange-directories\.py/);
  assert.match(release, /dist_manifest_sha\(\)/);
  assert.match(release, /cd \"\$root\"/);
  assert.match(release, /find \. -type f -print0/);
  assert.match(release, /deployed_artifact_sha/);
  assert.doesNotMatch(release, /npm run build/);
  assert.doesNotMatch(release, /rsync -a --delete/);
  assert.match(atomicExchange, /RENAME_EXCHANGE = 2/);
  assert.match(atomicExchange, /renameat2/);
});

test('V4 host cache maintenance is high-watermark, execution-aware, and volume-safe', () => {
  assert.match(hostCacheScript, /TRIGGER_FREE_BYTES:-17179869184/);
  assert.match(hostCacheScript, /TARGET_FREE_BYTES:-25769803776/);
  assert.match(hostCacheScript, /status=RUNNING&limit=1/);
  assert.match(hostCacheScript, /SKIPPED_ACTIVE_EXECUTION/);
  assert.match(hostCacheScript, /SKIPPED_RELEASE_ACTIVE/);
  assert.match(hostCacheScript, /builder prune -af --filter/);
  assert.match(hostCacheScript, /builder prune -af/);
  assert.match(hostCacheScript, /image prune -f/);
  assert.match(hostCacheScript, /image prune -af --filter/);
  assert.doesNotMatch(hostCacheScript, /volume prune|--volumes|system prune/);
  assert.match(hostCacheScript, /host-cache-maintenance\.json/);
  assert.doesNotMatch(hostCacheScript, /install -d -m 0755.*state_file/);
  assert.match(hostCacheService, /Type=oneshot/);
  assert.match(hostCacheService, /User=root/);
  assert.match(hostCacheService, /NoNewPrivileges=true/);
  assert.match(hostCacheService, /CapabilityBoundingSet=\s*$/m);
  assert.match(hostCacheService, /AmbientCapabilities=\s*$/m);
  assert.match(hostCacheService, /ProtectSystem=strict/);
  assert.match(
    hostCacheService,
    /ReadWritePaths=\/srv\/hermes-personal\/data\/model-control-plane/,
  );
  assert.match(hostCacheTimer, /OnUnitActiveSec=15min/);
  assert.match(hostCacheTimer, /Persistent=true/);
  assert.match(release, /prune-v4-host-cache\.sh/);
  assert.match(release, /hermes-pixel-v4-host-cache\.service/);
  assert.match(release, /hermes-pixel-v4-host-cache\.timer/);
  assert.match(release, /systemctl enable --now hermes-pixel-v4-host-cache\.timer/);
  assert.match(installer, /HOST_CACHE_SCRIPT_SOURCE/);
  assert.match(installer, /systemctl enable --now hermes-pixel-v4-host-cache\.timer/);
  execFileSync('bash', ['-n', hostCacheScriptPath]);
});

test('atomic dist exchange helper swaps two complete directories in one operation', () => {
  const temp = fs.mkdtempSync('/tmp/pixel-v4-atomic-exchange-');
  const candidate = path.join(temp, 'candidate');
  const current = path.join(temp, 'current');
  try {
    fs.mkdirSync(candidate);
    fs.mkdirSync(current);
    fs.writeFileSync(path.join(candidate, 'main.js'), 'candidate\n');
    fs.writeFileSync(path.join(current, 'main.js'), 'current\n');
    execFileSync('/usr/bin/python3', [atomicExchangePath, candidate, current], {
      stdio: 'pipe',
    });
    assert.equal(fs.readFileSync(path.join(current, 'main.js'), 'utf8'), 'candidate\n');
    assert.equal(fs.readFileSync(path.join(candidate, 'main.js'), 'utf8'), 'current\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
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
