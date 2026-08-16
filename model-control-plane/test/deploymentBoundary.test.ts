import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('LiteLLM deployment binds an existing Employment and never bootstraps HR identity', () => {
  const script = fs.readFileSync(
    path.join(root, 'deploy/litellm/configure-reference-route.sh'),
    'utf8',
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.match(script, /V2_REFERENCE_EMPLOYMENT_ID/);
  assert.match(script, /SELECT status,effective_to FROM v2_employments/);
  assert.doesNotMatch(script, /bootstrapReference/);
  assert.equal('bootstrap:v2-reference' in pkg.scripts, false);
  assert.equal('bootstrap:v2-reference:prod' in pkg.scripts, false);
  assert.equal(fs.existsSync(path.join(root, 'src/v2/bootstrapReference.ts')), false);
});
