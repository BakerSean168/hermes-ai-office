import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');

test('LiteLLM remains the managed model authority and exposes stable logical aliases', () => {
  const raw = fs.readFileSync(path.join(root, 'deploy/litellm/config.yaml'), 'utf8');
  const config = parse(raw) as any;
  assert.deepEqual(config.model_list, []);
  assert.deepEqual(config.router_settings.model_group_alias, {
    'planning-premium': 'gpt-5.6-sol',
    'review-premium': 'gpt-5.6-sol',
    'implementation-efficient': 'deepseek-v4-flash',
  });
  assert.equal(config.general_settings.store_model_in_db, true);
  assert.doesNotMatch(raw, /api_key:|TEAMOROUTER|FORAPI|WORLDCLAW|OPENCODE_GO/);
});

test('control-plane deployment contains no V2, CPA, or Provider Hub runtime configuration', () => {
  const unit = fs.readFileSync(
    path.join(root, 'deploy/hermes-model-control-plane.service'),
    'utf8',
  );
  const dropin = fs.readFileSync(
    path.join(root, 'deploy/hermes-model-control-plane.service.d/v3-production.conf'),
    'utf8',
  );
  const installer = fs.readFileSync(path.join(root, 'deploy/install-oracle2-systemd.sh'), 'utf8');

  assert.match(unit, /WorkingDirectory=\/home\/ubuntu\/projects\/pixel-agents/);
  assert.doesNotMatch(unit, /MODEL_CP_V2|CPA_|GATEWAYCTL|provider-hub/i);
  assert.doesNotMatch(unit, /\/opt\/cpa/);
  assert.match(dropin, /MODEL_CP_V3_LITELLM_URL=http:\/\/127\.0\.0\.1:4000/);
  assert.match(
    dropin,
    /MODEL_CP_V3_ENABLED_BACKENDS=opencode-acp,dsh-acp,codex-acp,codex-business-planner-headless,codex-business-worker-headless,codex-business-review-headless,codex-review-headless,claude-code-review-headless,openhands-builtin/,
  );
  assert.match(
    dropin,
    /MODEL_CP_V3_LITELLM_ADMIN_ENV_FILE=\/srv\/hermes-personal\/secrets\/litellm\.env/,
  );
  assert.match(installer, /systemctl restart hermes-model-control-plane\.service/);
  assert.doesNotMatch(installer, /hermes gateway/);
  assert.equal(fs.existsSync(path.join(root, 'src/v2')), false);
  assert.equal(fs.existsSync(path.join(root, 'scripts/migrate-provider-hub-to-litellm.py')), false);
});

test('linked workspace staging stays outside systemd PrivateTmp', () => {
  const workspace = fs.readFileSync(path.join(root, 'src/v3/workspace.ts'), 'utf8');
  const gcpUnit = fs.readFileSync(
    path.join(root, 'deploy/gcp/hermes-model-control-plane.service'),
    'utf8',
  );
  const genericUnit = fs.readFileSync(
    path.join(root, 'deploy/hermes-model-control-plane.service'),
    'utf8',
  );
  const productionDropin = fs.readFileSync(
    path.join(root, 'deploy/hermes-model-control-plane.service.d/v3-production.conf'),
    'utf8',
  );

  assert.match(gcpUnit, /PrivateTmp=true/);
  assert.match(gcpUnit, /^ReadWritePaths=\/srv\/hermes-personal\/data\/model-control-plane$/m);
  assert.doesNotMatch(gcpUnit, /ReadWritePaths=.*hermes-ai-office-v3\/workspaces/);
  assert.doesNotMatch(genericUnit, /ReadWritePaths=.*hermes-ai-office-v3\/workspaces/);
  assert.doesNotMatch(productionDropin, /^ReadWritePaths=.*hermes-ai-office-v3\/workspaces/m);
  assert.match(
    workspace,
    /path\.join\(path\.dirname\(this\.#hostRoot\), '\.model-control-plane-staging'\)/,
  );
  assert.doesNotMatch(workspace, /path\.join\(os\.tmpdir\(\), 'hermes-ai-office-v3-'\)/);
  assert.match(workspace, /hardlinkFilesystemCompatible = stagingDevice === sourceDevice/);
  assert.match(workspace, /'\/usr\/bin\/flock'/);
  assert.match(workspace, /'\.model-control-plane-locks'/);
  assert.match(workspace, /V3_WORKSPACE_STAGING_ROOT_NOT_ALLOWED/);
  assert.match(workspace, /fs\.chmodSync\(stagingRoot, 0o711\)/);
  assert.match(
    workspace,
    /const cloneParent = cloneWithServiceIdentity \? stagingRoot : path\.join\(stagingRoot, 'source'\)/,
  );
  assert.doesNotMatch(workspace, /fs\.chownSync\(stagingRoot, sourceOwner\.uid/);
});

test('OpenHands outer container permits Codex bubblewrap without granting Linux capabilities', () => {
  const raw = fs.readFileSync(path.join(root, 'deploy/openhands-v3/docker-compose.yml'), 'utf8');
  const compose = parse(raw) as any;
  const service = compose.services['agent-server'];
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.ok(service.security_opt.includes('seccomp:unconfined'));
  assert.ok(service.security_opt.includes('apparmor:hermes-openhands-codex'));
  assert.notEqual(service.privileged, true);
  const profile = fs.readFileSync(
    path.join(root, 'deploy/openhands-v3/hermes-openhands-codex.apparmor'),
    'utf8',
  );
  assert.match(profile, /profile hermes-openhands-codex/);
  assert.match(profile, /\buserns,/);
  assert.doesNotMatch(profile, /capability sys_admin/);
  const installer = fs.readFileSync(
    path.join(root, 'deploy/gcp/install-gcp-execution-plane.sh'),
    'utf8',
  );
  assert.match(installer, /apparmor_parser -r/);
});

test('OpenHands coding workers launch through Agent Harness capability materialization', () => {
  const policyRaw = fs.readFileSync(path.join(root, 'config/development-policy.yaml'), 'utf8');
  const policy = parse(policyRaw) as any;
  const composeRaw = fs.readFileSync(
    path.join(root, 'deploy/openhands-v3/docker-compose.yml'),
    'utf8',
  );
  const compose = parse(composeRaw) as any;
  const tooling = fs.readFileSync(
    path.join(root, 'scripts/install-openhands-v3-tooling.sh'),
    'utf8',
  );
  const launcher = fs.readFileSync(
    path.join(root, 'openhands_tools/harness_agent_launcher.sh'),
    'utf8',
  );
  const gatewayUnit = fs.readFileSync(
    path.join(root, 'deploy/gcp/hermes-agent-harness-mcp.service'),
    'utf8',
  );

  assert.deepEqual(policy.backends['opencode-acp'].command, [
    '/opt/hermes-ai-office-tools/harness_agent_launcher.sh',
    'opencode',
    'acp',
  ]);
  assert.deepEqual(policy.backends['codex-acp'].command, [
    '/opt/hermes-ai-office-tools/harness_agent_launcher.sh',
    'codex-acp',
  ]);
  assert.deepEqual(policy.backends['claude-code-acp'].command, [
    '/opt/hermes-ai-office-tools/harness_agent_launcher.sh',
    'claude-acp',
  ]);
  assert.deepEqual(policy.backends['dsh-acp'].command, [
    '/opt/hermes-ai-office-tools/harness_agent_launcher.sh',
    'dsh-acp',
  ]);
  assert.ok(
    compose.services['agent-server'].volumes.includes(
      '/home/dev/projects/agent-harness:/opt/agent-harness:ro',
    ),
  );
  assert.match(launcher, /prepare \"\$PWD\" --profile openhands --host \"\$host\" --execution/);
  assert.match(launcher, /prepare_root opencode/);
  assert.match(launcher, /prepare_root codex/);
  assert.match(launcher, /prepare_root claude/);
  assert.match(launcher, /prepare_root dsh/);
  assert.match(launcher, /if \[\[ ! -d "\$DSH_HOME\/profiles\/acp" \]\]/);
  assert.match(
    launcher,
    /plugin --profile acp add \/openhands-state\/tooling\/node_modules\/dsh-acp-server/,
  );
  assert.match(launcher, /unset OPENCODE_CONFIG/);
  assert.match(launcher, /AGENT_HARNESS_STATE/);
  assert.match(launcher, /HERMES_V3_EXECUTION_ID/);
  assert.match(launcher, /HERMES_V3_WORKSPACE_REF/);
  assert.match(launcher, /workspace_repo="\$\{HERMES_V3_WORKSPACE_REF:-\}"/);
  assert.match(launcher, /execution_root="\/workspace\/executions\/\$execution_id"/);
  assert.match(launcher, /cd -- "\$workspace_repo"/);
  assert.doesNotMatch(launcher, /case "\$PWD" in/);
  assert.match(tooling, /@colbymchenry\/codegraph@\$CODEGRAPH_VERSION/);
  assert.match(tooling, /mcp-remote@\$MCP_REMOTE_VERSION/);
  assert.match(tooling, /nx-mcp@\$NX_MCP_VERSION/);
  assert.match(tooling, /patch_dsh_no_default_max_tokens\.mjs/);
  assert.match(tooling, /verify_dsh_no_default_max_tokens\.mjs/);
  const dshPatch = fs.readFileSync(
    path.join(root, 'deploy/openhands-v3/dsh-acp-v3.patch.yml'),
    'utf8',
  );
  assert.doesNotMatch(dshPatch, /^\s*maxTokens:/m);
  const dshVendorPatch = fs.readFileSync(
    path.join(root, 'openhands_tools/patch_dsh_no_default_max_tokens.mjs'),
    'utf8',
  );
  assert.match(dshVendorPatch, /expectedVersion = '0\.1\.1-rc\.2'/);
  assert.match(dshVendorPatch, /implicit maxTokens disabled/);
  assert.match(dshVendorPatch, /defaultMaxTokens/);
  const dshVerifier = fs.readFileSync(
    path.join(root, 'openhands_tools/verify_dsh_no_default_max_tokens.mjs'),
    'utf8',
  );
  assert.match(dshVerifier, /implicitBody/);
  assert.match(dshVerifier, /hasOwnProperty\.call\(implicitBody, 'max_tokens'\)/);
  assert.match(dshVerifier, /explicitBody\.max_tokens !== 12345/);
  assert.match(gatewayUnit, /--transport streaming/);
  assert.match(gatewayUnit, /--host 127\.0\.0\.1 --port 18330/);
  assert.match(gatewayUnit, /--allow-unauthenticated/);
});

test('OpenCode logical models correlate LiteLLM spend by execution ID', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, 'deploy/openhands-v3/opencode-v3.json'), 'utf8'),
  ) as any;
  const models = config.provider['litellm-v3'].models;
  for (const model of ['implementation-efficient', 'planning-premium', 'review-premium']) {
    assert.equal(models[model].options.user, '{env:HERMES_V3_EXECUTION_ID}');
  }
});

test('headless reviewers stream frozen evidence over stdin instead of process arguments', () => {
  const adapter = fs.readFileSync(
    path.join(root, 'openhands_tools/headless_review_acp.mjs'),
    'utf8',
  );

  assert.match(adapter, /lastMessage,\s*'-',\s*\],\s*input: reviewPrompt/);
  assert.match(adapter, /command: CLAUDE_BIN,\s*args: \[\s*'-p',\s*'--mcp-config'/);
  assert.equal(adapter.match(/input: reviewPrompt/g)?.length, 2);
  assert.match(adapter, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.match(adapter, /child\.stdin\.end\(spec\.input\)/);
  assert.doesNotMatch(adapter, /lastMessage,\s*reviewPrompt/);
  assert.doesNotMatch(adapter, /'-p',\s*reviewPrompt/);
  assert.match(adapter, /prepareHarness\(session, 'codex'\)/);
  assert.match(adapter, /prepareHarness\(session, 'claude'\)/);
  assert.match(adapter, /--profile',\s*HARNESS_PROFILE/);
  assert.match(adapter, /--execution/);
  assert.match(adapter, /sandbox_mode = \"workspace-write\"/);
  assert.match(adapter, /'--sandbox',\s*'workspace-write'/);
  assert.match(adapter, /rev-parse', '--absolute-git-dir'/);
  assert.match(adapter, /HEADLESS_WORKER_WRITABLE_ROOT_NOT_ALLOWED/);
  assert.match(adapter, /\.\.\.codexWritableArgs\(session, harness\)/);
  assert.match(adapter, /harness\.env\.HOME/);
  assert.match(adapter, /harness\.env\.AGENT_HARNESS_STATE/);
  assert.match(adapter, /harness\.env\.AGENT_HARNESS_SHARE/);
  assert.equal(adapter.match(/sandbox_workspace_write\.network_access=true/g)?.length, 3);
  assert.match(adapter, /refs\/ai-office\/review-base..HEAD/);
  assert.match(adapter, /reviewer completed without independent repository command activity/);
  assert.match(adapter, /item\?\.type === 'command_execution'/);
  assert.doesNotMatch(adapter, /sandbox_mode = \"read-only\"/);
});

test('provider-native Business Codex review is explicit, persistent, and excluded from untrusted external change', () => {
  const policyRaw = fs.readFileSync(path.join(root, 'config/development-policy.yaml'), 'utf8');
  const policy = parse(policyRaw) as any;
  const adapter = fs.readFileSync(
    path.join(root, 'openhands_tools/headless_review_acp.mjs'),
    'utf8',
  );
  const planner = policy.backends['codex-business-planner-headless'];
  const backend = policy.backends['codex-business-review-headless'];
  const worker = policy.backends['codex-business-worker-headless'];

  assert.equal(planner.kind, 'acp');
  assert.equal(planner.default_model, 'gpt-5.6-sol');
  assert.equal(planner.supports.provider_native, true);
  assert.equal(planner.supports.write, false);
  assert.equal(planner.supports.untrusted_external, false);
  assert.equal(planner.static_env.AI_OFFICE_HEADLESS_ROLE, 'planner');
  assert.equal(planner.static_env.AI_OFFICE_HEADLESS_MODEL, 'gpt-5.6-sol');
  assert.equal(planner.static_env.AI_OFFICE_HEADLESS_REASONING_EFFORT, 'medium');
  assert.equal(policy.phases.ORCHESTRATE.backend_candidates[0], 'openhands-builtin');
  assert.ok(
    policy.phases.ORCHESTRATE.backend_candidates.includes('codex-business-planner-headless'),
  );
  assert.ok(
    policy.phases.INVESTIGATE_PLAN.backend_candidates.includes('codex-business-planner-headless'),
  );

  assert.equal(worker.kind, 'acp');
  assert.equal(worker.default_model, 'gpt-5.6-luna');
  assert.equal(worker.supports.provider_native, true);
  assert.equal(worker.supports.write, true);
  assert.equal(worker.supports.untrusted_external, false);
  assert.equal(worker.static_env.AI_OFFICE_HEADLESS_ROLE, 'worker');
  assert.equal(policy.phases.IMPLEMENT.backend_candidates[0], 'dsh-acp');
  assert.equal(policy.phases.IMPLEMENT_FIX.backend_candidates[0], 'dsh-acp');
  assert.equal(
    policy.phases.IMPLEMENT.backend_candidates.includes('codex-business-worker-headless'),
    false,
  );
  assert.equal(worker.static_env.AI_OFFICE_HEADLESS_MODEL, 'gpt-5.6-luna');
  assert.equal(worker.static_env.AI_OFFICE_HEADLESS_REASONING_EFFORT, 'xhigh');

  assert.equal(backend.kind, 'acp');
  assert.equal(backend.default_model, 'gpt-5.6-sol');
  assert.equal(backend.supports.provider_native, true);
  assert.equal(backend.supports.litellm_managed, false);
  assert.equal(backend.supports.untrusted_external, false);
  assert.equal(backend.static_env.AI_OFFICE_CODEX_AUTH_HOME, '/openhands-state/codex-business');
  assert.equal(backend.static_env.AI_OFFICE_HEADLESS_REASONING_EFFORT, 'medium');
  assert.equal(policy.phases.VERIFY_REVIEW.backend_candidates[0], 'codex-business-review-headless');
  assert.equal(policy.phases.BATCH_VERIFY.backend_candidates[0], 'codex-business-review-headless');
  assert.match(adapter, /HEADLESS_TRANSPORT === 'provider-native'/);
  assert.match(adapter, /AI_OFFICE_HEADLESS_REASONING_EFFORT/);
  assert.match(adapter, /HEADLESS_ROLE === 'planner'/);
  assert.match(adapter, /PLAN_TRANSPORT_ERROR/);
  assert.match(
    adapter,
    /model_reasoning_effort=\$\{JSON\.stringify\(HEADLESS_REASONING_EFFORT\)\}/,
  );
  assert.match(adapter, /HEADLESS_REVIEW_CODEX_AUTH_MISSING/);
  assert.match(adapter, /delete env\.CODEX_API_KEY/);
  assert.doesNotMatch(adapter, /--ignore-user-config/);
  assert.match(adapter, /safeSymlink\(authFile, path.join\(codexHome, 'auth.json'\)\)/);
  assert.match(adapter, /path.join\(codexHome, 'skills', '\.system'\)/);
});

test('provider-native Antigravity remains opt-in and executes behind the mount sandbox boundary', () => {
  const policyRaw = fs.readFileSync(path.join(root, 'config/development-policy.yaml'), 'utf8');
  const policy = parse(policyRaw) as any;
  const unit = fs.readFileSync(
    path.join(root, 'deploy/gcp/hermes-model-control-plane.service'),
    'utf8',
  );
  const wrapper = fs.readFileSync(path.join(root, 'scripts/run-antigravity-sandbox.sh'), 'utf8');
  const adapter = fs.readFileSync(path.join(root, 'src/v3/adapters/antigravity.ts'), 'utf8');
  const repairPublisher = fs.readFileSync(
    path.join(root, 'src/v3/githubPrRepairPublisher.ts'),
    'utf8',
  );
  const app = fs.readFileSync(path.join(root, 'src/app.ts'), 'utf8');

  assert.equal(policy.backends['antigravity-review'].kind, 'external_adapter');
  assert.equal(policy.backends['antigravity-review'].supports.provider_native, true);
  assert.equal(policy.backends['antigravity-worker'].supports.provider_native, true);
  assert.equal(policy.backends['antigravity-worker'].supports.write, true);
  assert.equal(policy.backends['antigravity-review'].supports.untrusted_external, false);
  assert.equal(policy.backends['antigravity-worker'].supports.untrusted_external, false);
  assert.doesNotMatch(policy.phases.VERIFY_REVIEW.backend_candidates.join(','), /antigravity/);
  assert.doesNotMatch(policy.phases.IMPLEMENT_FIX.backend_candidates.join(','), /antigravity/);
  assert.doesNotMatch(unit, /antigravity-review|antigravity-worker/);
  assert.ok(app.includes("configuredBackends.has('antigravity-review')"));
  assert.ok(app.includes('if (!antigravityEnabled) return openHandsHost'));
  assert.ok(wrapper.includes('mount -t tmpfs -o mode=0755 tmpfs /home'));
  assert.ok(wrapper.includes('mount -t tmpfs -o mode=0755 tmpfs "$workspace_root"'));
  assert.ok(
    wrapper.includes('mount --bind "$stash/workspace" "$workspace_root/$workspace_relative"'),
  );
  assert.match(wrapper, /^#!\/bin\/bash\n/);
  assert.doesNotMatch(wrapper, /^#!\/usr\/bin\/env bash/m);
  assert.match(adapter, /'--pid'/);
  assert.match(adapter, /'--fork'/);
  assert.match(adapter, /'--kill-child=SIGKILL'/);
  assert.match(adapter, /'--mount-proc'/);
  assert.match(adapter, /PATH: '\/usr\/local\/bin:\/usr\/bin:\/bin'/);
  assert.ok(wrapper.includes('cd "$workspace_root/$workspace_relative"'));
  assert.match(wrapper, /--workspace-gid/);
  assert.match(wrapper, /mount -t tmpfs -o .*size=64m.*tmpfs "\$stash\/auth"/);
  assert.match(wrapper, /auth_files=\(/);
  assert.match(wrapper, /antigravity-oauth-token/);
  assert.match(wrapper, /cp -p -- "\$src" "\$stash\/auth\/\$rel"/);
  assert.doesNotMatch(wrapper, /mount --bind "\$auth"/);
  assert.match(wrapper, /umask 0002/);
  assert.match(app, /MODEL_CP_V3_ANTIGRAVITY_WORKSPACE_GID/);
  assert.match(wrapper, /--clear-groups/);
  assert.match(wrapper, /--bounding-set=-all/);
  assert.match(wrapper, /--inh-caps=-all/);
  assert.match(wrapper, /--ambient-caps=-all/);
  assert.match(wrapper, /--no-new-privs/);
  assert.doesNotMatch(adapter, /execFileSync/);
  assert.doesNotMatch(adapter, /groupCanWriteAndTraverse/);
  assert.match(adapter, /await execFileAsync\('\/usr\/bin\/chgrp'/);
  assert.match(adapter, /await execFileAsync\('\/usr\/bin\/chmod'/);
  assert.match(repairPublisher, /fs\.chownSync\(tempRoot, owner\.uid, owner\.gid\)/);
  assert.match(repairPublisher, /fs\.chmodSync\(tempRoot, 0o700\)/);
});

test('GitHub webhook ingress installs dependency-free ESM artifacts outside protected home', () => {
  const unit = fs.readFileSync(
    path.join(root, 'deploy/gcp/hermes-github-webhook-ingress.service'),
    'utf8',
  );
  const installer = fs.readFileSync(
    path.join(root, 'deploy/gcp/install-github-webhook-ingress.sh'),
    'utf8',
  );
  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/hermes-github-webhook-ingress\/githubWebhookIngressMain\.js/,
  );
  assert.match(unit, /ProtectHome=true/);
  assert.match(installer, /\{"type":"module","private":true\}/);
  assert.match(installer, /\/usr\/local\/lib\/hermes-github-webhook-ingress/);
});
