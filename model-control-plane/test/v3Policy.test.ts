import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DevelopmentPolicy } from '../src/v3/policy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyFile = path.resolve(here, '../config/development-policy.yaml');

test('development policy uses LiteLLM-managed execution for all model-backed phases', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  for (const phase of [
    'INVESTIGATE_PLAN',
    'IMPLEMENT',
    'IMPLEMENT_FIX',
    'VERIFY_REVIEW',
  ] as const) {
    const selected = policy.select(phase, {}, { 'openhands-builtin': true, 'opencode-acp': true });
    assert.equal(selected.transportMode, 'LITELLM_MANAGED');
    assert.ok(['openhands-builtin', 'opencode-acp'].includes(selected.backend));
  }
  assert.equal(policy.config.version, 2);
  assert.deepEqual(Object.keys(policy.config.backends).sort(), [
    'control-plane-finalizer',
    'opencode-acp',
    'openhands-builtin',
  ]);
});

test('development policy falls back from OpenCode ACP to OpenHands', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const implementation = policy.select(
    'IMPLEMENT',
    {},
    { 'opencode-acp': false, 'openhands-builtin': true },
  );
  assert.equal(implementation.backend, 'openhands-builtin');
  assert.equal(implementation.modelClass, 'implementation-efficient');
  assert.equal(implementation.transportMode, 'LITELLM_MANAGED');
  assert.equal(implementation.workspaceMode, 'isolated_write');
});

test('development policy rejects an unavailable explicit backend', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  assert.throws(
    () => policy.select('IMPLEMENT', { backend: 'opencode-acp' }, { 'opencode-acp': false }),
    /POLICY_NO_ELIGIBLE_BACKEND/,
  );
});

test('FINALIZE uses the deterministic internal finalizer', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const selected = policy.select('FINALIZE', {}, {});
  assert.equal(selected.backend, 'control-plane-finalizer');
  assert.equal(selected.transportMode, 'INTERNAL');
  assert.equal(selected.modelClass, 'deterministic-finalize-v1');
  assert.equal(selected.workspaceMode, 'none');
});

test('development policy exposes bounded writer concurrency caps', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  assert.equal(policy.config.concurrency.max_active_writers, 4);
  assert.equal(policy.config.concurrency.max_active_writers_per_project, 2);
});
