import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');

test('LiteLLM config keeps provider/model CRUD in the DB and exposes only stable V3 aliases', () => {
  const raw = fs.readFileSync(path.join(root, 'deploy/litellm/config.yaml'), 'utf8');
  const config = parse(raw) as any;
  const bootstrap = fs.readFileSync(
    path.join(root, 'deploy/litellm/bootstrap-dynamic-gateway.sh'),
    'utf8',
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.deepEqual(config.model_list, []);
  assert.deepEqual(config.router_settings.model_group_alias, {
    'planning-premium': 'gpt-5.6-sol',
    'review-premium': 'gpt-5.6-sol',
    'implementation-efficient': 'deepseek-v4-flash',
  });
  assert.equal(config.general_settings.store_model_in_db, true);
  assert.doesNotMatch(raw, /api_base:|api_key:|TEAMOROUTER|FORAPI|WORLDCLAW|OPENCODE_GO/);
  assert.doesNotMatch(raw, /model_name:\s*employment:/);
  assert.doesNotMatch(raw, /V2_REFERENCE_ROUTE|V2_REFERENCE_UPSTREAM_MODEL/);
  assert.doesNotMatch(bootstrap, /V2_REFERENCE_ROUTE|V2_REFERENCE_UPSTREAM_MODEL/);
  assert.equal(
    fs.existsSync(path.join(root, 'deploy/litellm/configure-reference-route.sh')),
    false,
  );
  assert.equal('bootstrap:v2-reference' in pkg.scripts, false);
  assert.equal('bootstrap:v2-reference:prod' in pkg.scripts, false);
  assert.equal(fs.existsSync(path.join(root, 'src/v2/bootstrapReference.ts')), false);
});

test('oracle2 systemd deployment is reproducible from the canonical checkout without committing host-specific admin URLs', () => {
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
  assert.doesNotMatch(unit, /\/srv\/hermes-personal\/workspace\/repos\/pixel-agents/);
  assert.match(dropin, /MODEL_CP_V3_LITELLM_URL=http:\/\/127\.0\.0\.1:4000/);
  assert.match(
    dropin,
    /EnvironmentFile=-\/srv\/hermes-personal\/secrets\/model-control-plane-v3\.env/,
  );
  assert.doesNotMatch(dropin, /\.ts\.net|MODEL_CP_V3_LITELLM_ADMIN_URL=/);
  assert.match(dropin, /MODEL_CP_V3_LITELLM_OBSERVABILITY=1/);
  assert.match(installer, /rm -f \"\$dropin_dir\/v3-shadow\.conf\"/);
  assert.match(installer, /systemctl restart hermes-model-control-plane\.service/);
  assert.match(installer, /chmod 0600 \"\$runtime_env\"/);
  assert.doesNotMatch(installer, /hermes gateway/);
});

test('OpenCode V3 logical models correlate LiteLLM spend by execution ID', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, 'deploy/openhands-v3/opencode-v3.json'), 'utf8'),
  ) as any;
  const models = config.provider['litellm-v3'].models;
  for (const model of ['implementation-efficient', 'planning-premium', 'review-premium']) {
    assert.equal(models[model].options.user, '{env:HERMES_V3_EXECUTION_ID}');
  }
});

test('Provider Hub migration preserves qualified fallback and economics order inside LiteLLM DB metadata', () => {
  const migration = fs.readFileSync(
    path.join(root, 'scripts/migrate-provider-hub-to-litellm.py'),
    'utf8',
  );

  assert.match(migration, /\("teamorouter-gpt-5-6", "gpt-5\.6-sol"\): 1/);
  assert.match(migration, /\("forapi-4sapi-org-gpt-5-6", "gpt-5\.6-sol"\): 2/);
  assert.match(migration, /\("teamorouter-gpt-5-6", "deepseek-v4-flash-free"\): 1/);
  assert.match(migration, /\("opencode-go", "deepseek-v4-flash"\): 2/);
  assert.match(migration, /"FREE": 20/);
  assert.match(migration, /"SPONSORED": 20/);
  assert.match(migration, /"SUBSCRIPTION": 30/);
  assert.match(migration, /"METERED": 40/);
  assert.match(migration, /migrated_from.*ai-office-provider-hub/);
});
