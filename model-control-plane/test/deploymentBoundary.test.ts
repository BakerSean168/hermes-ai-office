import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');

test('LiteLLM is the only provider/model authority and exposes stable logical aliases', () => {
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
