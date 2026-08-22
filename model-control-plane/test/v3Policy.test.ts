import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DevelopmentPolicy } from '../src/v3/policy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyFile = path.resolve(here, '../config/development-policy.yaml');

test('V3 development policy falls back from unavailable ACP backends to OpenHands', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const planning = policy.select(
    'INVESTIGATE_PLAN',
    {},
    {
      'codex-acp': false,
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  );
  assert.equal(planning.backend, 'openhands-builtin');
  assert.equal(planning.modelClass, 'planning-premium');
  assert.equal(planning.transportMode, 'LITELLM_MANAGED');
  assert.equal(planning.workspaceMode, 'read_oriented');

  const implementation = policy.select(
    'IMPLEMENT',
    {},
    {
      'opencode-acp': false,
      'openhands-builtin': true,
      'codex-acp': false,
    },
  );
  assert.equal(implementation.backend, 'openhands-builtin');
  assert.equal(implementation.modelClass, 'implementation-efficient');
  assert.equal(implementation.transportMode, 'LITELLM_MANAGED');
  assert.equal(implementation.workspaceMode, 'isolated_write');
});

test('V3 policy preserves native subscription as a first-class transport lane', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const selected = policy.select('VERIFY_REVIEW', { backend: 'codex-acp' }, { 'codex-acp': true });
  assert.equal(selected.backend, 'codex-acp');
  assert.equal(selected.transportMode, 'NATIVE_SUBSCRIPTION');
  assert.equal(selected.sessionPolicy, 'fresh_required');
});

test('V3 policy rejects an unavailable explicit backend instead of silently changing an override', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  assert.throws(
    () => policy.select('INVESTIGATE_PLAN', { backend: 'codex-acp' }, { 'codex-acp': false }),
    /POLICY_NO_ELIGIBLE_BACKEND/,
  );
});

test('V3 FINALIZE uses the deterministic internal finalizer without a model transport', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const selected = policy.select('FINALIZE', {}, {});
  assert.equal(selected.backend, 'control-plane-finalizer');
  assert.equal(selected.transportMode, 'INTERNAL');
  assert.equal(selected.modelClass, 'deterministic-finalize-v1');
  assert.equal(selected.workspaceMode, 'none');
});

test('V3 policy exposes bounded writer concurrency caps', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  assert.equal(policy.config.concurrency.max_active_writers, 4);
  assert.equal(policy.config.concurrency.max_active_writers_per_project, 2);
});
