import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');

test('LiteLLM deployment contains only V3 logical capability routes, never historical Employment routes', () => {
  const config = fs.readFileSync(path.join(root, 'deploy/litellm/config.yaml'), 'utf8');
  const bootstrap = fs.readFileSync(
    path.join(root, 'deploy/litellm/bootstrap-dynamic-gateway.sh'),
    'utf8',
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.match(config, /model_name:\s*planning-premium/);
  assert.match(config, /model_name:\s*implementation-efficient/);
  assert.match(config, /model_name:\s*review-premium/);
  assert.doesNotMatch(config, /model_name:\s*employment:/);
  assert.doesNotMatch(config, /V2_REFERENCE_ROUTE|V2_REFERENCE_UPSTREAM_MODEL/);
  assert.doesNotMatch(bootstrap, /V2_REFERENCE_ROUTE|V2_REFERENCE_UPSTREAM_MODEL/);
  assert.equal(
    fs.existsSync(path.join(root, 'deploy/litellm/configure-reference-route.sh')),
    false,
  );
  assert.equal('bootstrap:v2-reference' in pkg.scripts, false);
  assert.equal('bootstrap:v2-reference:prod' in pkg.scripts, false);
  assert.equal(fs.existsSync(path.join(root, 'src/v2/bootstrapReference.ts')), false);
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

test('premium logical classes use deterministic ordered provider fallback while implementation stays single-route', () => {
  const raw = fs.readFileSync(path.join(root, 'deploy/litellm/config.yaml'), 'utf8');
  const config = parse(raw) as any;
  const routes = config.model_list as any[];
  const byName = (name: string) => routes.filter((route) => route.model_name === name);

  for (const logical of ['planning-premium', 'review-premium']) {
    const deployments = byName(logical);
    assert.equal(deployments.length, 2);
    assert.deepEqual(
      deployments.map((route) => ({
        order: route.litellm_params.order,
        base: route.litellm_params.api_base,
        source: route.model_info.metadata.source,
        role: route.model_info.metadata.route_role,
      })),
      [
        {
          order: 1,
          base: 'https://api.teamorouter.com/v1',
          source: 'teamorouter',
          role: 'primary',
        },
        { order: 2, base: 'https://4sapi.org/v1', source: 'forapi-4sapi-org', role: 'fallback' },
      ],
    );
    assert.equal(deployments[0].litellm_params.model, 'openai/gpt-5.6-sol');
    assert.equal(deployments[1].litellm_params.model, 'openai/gpt-5.6-sol');
    assert.equal(
      deployments[1].litellm_params.api_key,
      'os.environ/FORAPI_4SAPI_ORG_GPT_5_6_API_KEY',
    );
  }

  const implementation = byName('implementation-efficient');
  assert.equal(implementation.length, 1);
  assert.equal(implementation[0].litellm_params.order, 1);
  assert.equal(config.router_settings.max_fallbacks, 2);
  assert.equal(config.router_settings.enable_weighted_failover, undefined);
});
