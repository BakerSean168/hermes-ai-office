import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DevelopmentPolicy } from '../src/v3/policy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyFile = path.resolve(here, '../config/development-policy.yaml');

const allAvailable = {
  'antigravity-review': true,
  'antigravity-worker': true,
  'openhands-builtin': true,
  'opencode-acp': true,
  'codex-business-planner-headless': true,
  'codex-business-worker-headless': true,
  'codex-business-review-headless': true,
  'codex-review-headless': true,
  'claude-code-review-headless': true,
  'codex-acp': true,
  'claude-code-acp': true,
  'dsh-acp': true,
  'zcode-acp': true,
};

test('development policy keeps managed implementation routes and provider-native Business review', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  for (const phase of ['ORCHESTRATE', 'INVESTIGATE_PLAN'] as const) {
    assert.equal(policy.select(phase, {}, allAvailable).transportMode, 'LITELLM_MANAGED');
  }
  for (const phase of ['IMPLEMENT', 'IMPLEMENT_FIX'] as const) {
    const selected = policy.select(phase, {}, allAvailable);
    assert.equal(selected.backend, 'dsh-acp');
    assert.equal(selected.transportMode, 'LITELLM_MANAGED');
    assert.equal(selected.modelClass, 'implementation-efficient');
  }
  for (const phase of ['VERIFY_REVIEW', 'BATCH_VERIFY'] as const) {
    const selected = policy.select(phase, {}, allAvailable);
    assert.equal(selected.backend, 'codex-business-review-headless');
    assert.equal(selected.transportMode, 'PROVIDER_NATIVE');
    assert.equal(selected.modelClass, 'gpt-5.6-sol');
  }
  assert.equal(policy.config.version, 2);
  assert.deepEqual(Object.keys(policy.config.backends).sort(), [
    'antigravity-review',
    'antigravity-worker',
    'claude-code-acp',
    'claude-code-review-headless',
    'codex-acp',
    'codex-business-planner-headless',
    'codex-business-review-headless',
    'codex-business-worker-headless',
    'codex-review-headless',
    'control-plane-change-adopter',
    'control-plane-finalizer',
    'dsh-acp',
    'opencode-acp',
    'openhands-builtin',
    'zcode-acp',
  ]);
});

test('ORCHESTRATE is owned by the OpenHands supervisor', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const selected = policy.select('ORCHESTRATE', {}, allAvailable);
  assert.equal(selected.backend, 'openhands-builtin');
  assert.equal(selected.modelClass, 'planning-premium');
  assert.equal(selected.workspaceMode, 'read_oriented');
});

test('implementation defaults to managed workers while Business Codex remains an explicit Luna xhigh route', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const implement = policy.select('IMPLEMENT', {}, allAvailable);
  assert.equal(implement.backend, 'dsh-acp');
  assert.equal(implement.transportMode, 'LITELLM_MANAGED');
  assert.equal(implement.modelClass, 'implementation-efficient');
  assert.equal(policy.select('IMPLEMENT_FIX', {}, allAvailable).backend, 'dsh-acp');
  const managedCodex = policy.select('IMPLEMENT', { backend: 'codex-acp' }, allAvailable);
  assert.equal(managedCodex.backend, 'codex-acp');
  assert.equal(managedCodex.modelClass, 'implementation-efficient');
  assert.equal(managedCodex.transportMode, 'LITELLM_MANAGED');
  assert.deepEqual(policy.backend('codex-acp')?.managed_model_overrides, {
    'implementation-efficient': 'gpt-5.6-luna',
  });
  assert.deepEqual(policy.backend('codex-acp')?.managed_reasoning_effort_overrides, {
    'implementation-efficient': 'xhigh',
  });
  const businessPlanner = policy.select(
    'INVESTIGATE_PLAN',
    { backend: 'codex-business-planner-headless' },
    allAvailable,
  );
  assert.equal(businessPlanner.backend, 'codex-business-planner-headless');
  assert.equal(businessPlanner.transportMode, 'PROVIDER_NATIVE');
  assert.equal(businessPlanner.modelClass, 'gpt-5.6-sol');
  assert.equal(businessPlanner.workspaceMode, 'read_oriented');
  const business = policy.select(
    'IMPLEMENT',
    { backend: 'codex-business-worker-headless' },
    allAvailable,
  );
  assert.equal(business.backend, 'codex-business-worker-headless');
  assert.equal(business.transportMode, 'PROVIDER_NATIVE');
  assert.equal(business.modelClass, 'gpt-5.6-luna');
  const review = policy.select('VERIFY_REVIEW', {}, allAvailable);
  assert.equal(review.backend, 'codex-business-review-headless');
  assert.equal(review.modelClass, 'gpt-5.6-sol');
  assert.equal(review.transportMode, 'PROVIDER_NATIVE');
  const batchReview = policy.select('BATCH_VERIFY', {}, allAvailable);
  assert.equal(batchReview.backend, 'codex-business-review-headless');
  assert.equal(batchReview.modelClass, 'gpt-5.6-sol');
  assert.equal(batchReview.transportMode, 'PROVIDER_NATIVE');
  assert.equal(batchReview.workspaceMode, 'read_oriented');
});

test('implementation retry candidates rotate managed agents on the implementation-efficient model class', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const retry = policy.retryCandidates('IMPLEMENT', {
    ...allAvailable,
    'zcode-acp': false,
    'claude-code-acp': false,
    'codex-acp': false,
  });
  assert.deepEqual(retry.backendCandidates, ['dsh-acp', 'opencode-acp', 'openhands-builtin']);
  assert.deepEqual(retry.modelClasses, ['implementation-efficient']);
  assert.equal(retry.backendCandidates.includes('codex-business-worker-headless'), false);
});

test('review retry candidates preserve backend order and expose bounded model fallbacks', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const retry = policy.retryCandidates('VERIFY_REVIEW', {
    ...allAvailable,
    'claude-code-review-headless': false,
  });
  assert.deepEqual(retry.backendCandidates, [
    'codex-business-review-headless',
    'codex-review-headless',
    'openhands-builtin',
  ]);
  assert.deepEqual(retry.modelClasses, ['review-premium', 'codex-auto-review', 'gpt-5.4']);
});

test('review falls back from Business Codex to managed Codex, Claude Code, and OpenHands', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const managedCodex = policy.select(
    'VERIFY_REVIEW',
    {},
    { ...allAvailable, 'codex-business-review-headless': false },
  );
  assert.equal(managedCodex.backend, 'codex-review-headless');
  assert.equal(managedCodex.modelClass, 'review-premium');
  assert.equal(managedCodex.transportMode, 'LITELLM_MANAGED');

  const claude = policy.select(
    'VERIFY_REVIEW',
    {},
    {
      ...allAvailable,
      'codex-business-review-headless': false,
      'codex-review-headless': false,
    },
  );
  assert.equal(claude.backend, 'claude-code-review-headless');
  assert.equal(claude.modelClass, 'review-premium');

  const openhands = policy.select(
    'VERIFY_REVIEW',
    {},
    {
      ...allAvailable,
      'codex-business-review-headless': false,
      'codex-review-headless': false,
      'claude-code-review-headless': false,
    },
  );
  assert.equal(openhands.backend, 'openhands-builtin');
  assert.equal(openhands.modelClass, 'review-premium');
});

test('development policy falls back through enabled implementation workers to OpenHands', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  const implementation = policy.select(
    'IMPLEMENT',
    {},
    {
      'codex-business-worker-headless': false,
      'opencode-acp': false,
      'dsh-acp': false,
      'zcode-acp': false,
      'claude-code-acp': false,
      'codex-acp': false,
      'openhands-builtin': true,
    },
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

test('writer phases reject read-only backends even when explicitly overridden', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  for (const phase of ['IMPLEMENT', 'IMPLEMENT_FIX'] as const) {
    assert.throws(
      () => policy.select(phase, { backend: 'antigravity-review' }, allAvailable),
      /POLICY_NO_ELIGIBLE_BACKEND/,
    );
  }
  assert.equal(
    policy.select('IMPLEMENT_FIX', { backend: 'antigravity-worker' }, allAvailable).backend,
    'antigravity-worker',
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

test('Antigravity is provider-native and opt-in without changing default phase routing', () => {
  const policy = DevelopmentPolicy.fromFile(policyFile);
  assert.equal(policy.backend('antigravity-review')?.supports?.untrusted_external, false);
  assert.equal(policy.backend('antigravity-worker')?.supports?.untrusted_external, false);
  const defaultReview = policy.select('VERIFY_REVIEW', {}, allAvailable);
  assert.equal(defaultReview.backend, 'codex-business-review-headless');
  assert.equal(defaultReview.transportMode, 'PROVIDER_NATIVE');

  const review = policy.select('VERIFY_REVIEW', { backend: 'antigravity-review' }, allAvailable);
  assert.equal(review.backend, 'antigravity-review');
  assert.equal(review.transportMode, 'PROVIDER_NATIVE');
  assert.equal(review.modelClass, 'gemini-3.1-pro-high');

  const repair = policy.select('IMPLEMENT_FIX', { backend: 'antigravity-worker' }, allAvailable);
  assert.equal(repair.backend, 'antigravity-worker');
  assert.equal(repair.transportMode, 'PROVIDER_NATIVE');
  assert.equal(repair.modelClass, 'gemini-3.7-flash-high');
});
