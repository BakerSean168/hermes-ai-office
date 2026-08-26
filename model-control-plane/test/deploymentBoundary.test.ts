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
    /MODEL_CP_V3_ENABLED_BACKENDS=opencode-acp,dsh-acp,codex-review-headless,claude-code-review-headless,openhands-builtin/,
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
  assert.match(adapter, /command: CLAUDE_BIN,\s*args: \[\s*'-p',\s*'--bare'/);
  assert.equal(adapter.match(/input: reviewPrompt/g)?.length, 2);
  assert.match(adapter, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.match(adapter, /child\.stdin\.end\(spec\.input\)/);
  assert.doesNotMatch(adapter, /lastMessage,\s*reviewPrompt/);
  assert.doesNotMatch(adapter, /'-p',\s*reviewPrompt/);
  assert.match(adapter, /sandbox_mode = \"workspace-write\"/);
  assert.match(adapter, /'--sandbox',\s*'workspace-write'/);
  assert.match(adapter, /refs\/ai-office\/review-base..HEAD/);
  assert.match(adapter, /reviewer completed without independent repository command activity/);
  assert.match(adapter, /item\?\.type === 'command_execution'/);
  assert.doesNotMatch(adapter, /sandbox_mode = \"read-only\"/);
});


test('provider-native Antigravity remains opt-in and executes behind the mount sandbox boundary', () => {
  const policyRaw = fs.readFileSync(path.join(root, 'config/development-policy.yaml'), 'utf8');
  const policy = parse(policyRaw) as any;
  const unit = fs.readFileSync(path.join(root, 'deploy/gcp/hermes-model-control-plane.service'), 'utf8');
  const wrapper = fs.readFileSync(path.join(root, 'scripts/run-antigravity-sandbox.sh'), 'utf8');
  const adapter = fs.readFileSync(path.join(root, 'src/v3/adapters/antigravity.ts'), 'utf8');
  const repairPublisher = fs.readFileSync(path.join(root, 'src/v3/githubPrRepairPublisher.ts'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/app.ts'), 'utf8');

  assert.equal(policy.backends['antigravity-review'].kind, 'external_adapter');
  assert.equal(policy.backends['antigravity-review'].supports.provider_native, true);
  assert.equal(policy.backends['antigravity-worker'].supports.provider_native, true);
  assert.equal(policy.backends['antigravity-worker'].supports.write, true);
  assert.equal(policy.backends['antigravity-review'].supports.untrusted_external, false);
  assert.equal(policy.backends['antigravity-worker'].supports.untrusted_external, false);
  assert.doesNotMatch(
    policy.phases.VERIFY_REVIEW.backend_candidates.join(','),
    /antigravity/,
  );
  assert.doesNotMatch(
    policy.phases.IMPLEMENT_FIX.backend_candidates.join(','),
    /antigravity/,
  );
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
