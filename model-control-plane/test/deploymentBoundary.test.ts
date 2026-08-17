import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('LiteLLM deployment starts without a historical static Employment route', () => {
  const config = fs.readFileSync(path.join(root, 'deploy/litellm/config.yaml'), 'utf8');
  const bootstrap = fs.readFileSync(
    path.join(root, 'deploy/litellm/bootstrap-dynamic-gateway.sh'),
    'utf8',
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.match(config, /model_list:\s*\[\]/);
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
