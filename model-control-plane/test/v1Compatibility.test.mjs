import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { ControlPlaneStore } from '../src/store.mjs';

test('V1 workforce projection keeps its public top-level contract', () => {
  const store = new ControlPlaneStore(openDb(':memory:'));
  store.syncCpa([
    {
      name: 'primary',
      protocol: 'openai-compatible',
      enabled: true,
      models: ['deepseek-v4-flash'],
      lastTest: 'pass',
      health: 'healthy',
    },
  ]);
  store.upsertProfile({ id: 'development', name: 'Development' });
  store.upsertPosition({
    id: 'coding-review',
    profileId: 'development',
    name: 'Coding Reviewer',
    requiredCapabilities: ['review', 'reasoning'],
  });
  store.autoAssignDefaults();

  const snapshot = store.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'activeRuns',
    'assignments',
    'channels',
    'contracts',
    'models',
    'positions',
    'prices',
    'profiles',
    'providers',
    'quotas',
    'stats',
    'workers',
  ]);
  assert.equal(snapshot.providers[0].id, 'cpa');
  assert.equal(snapshot.channels[0].id, 'cpa:primary');
  assert.equal(snapshot.workers.length, 1);
  assert.equal(snapshot.positions[0].id, 'coding-review');
  assert.equal(snapshot.assignments.filter((item) => item.status === 'active').length, 1);
});
