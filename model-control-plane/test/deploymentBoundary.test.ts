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
  assert.match(dropin, /MODEL_CP_V3_ENABLED_BACKENDS=opencode-acp,openhands-builtin/);
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
