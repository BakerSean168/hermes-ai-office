import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';

const emptyCpa: LegacyCpaPort = {
  async status() {
    return [];
  },
  async bindAlias() {},
  async unbindAlias() {},
  async addChannel() {},
  async test() {},
  async enable() {},
  async disable() {},
  async quarantine() {},
};

const emptyUsage: LegacyUsagePort = {
  async snapshot() {
    return { range: '30d', stats: { groups: [] }, costs: { models: [] } };
  },
};

test('typed app factory preserves V1 health and workforce routes', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa: emptyCpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), {
      status: 'ok',
      service: 'hermes-model-control-plane',
      db: ':memory:',
    });

    const v2Health = await runtime.app.inject({ method: 'GET', url: '/api/v2/health' });
    assert.equal(v2Health.statusCode, 200);
    assert.equal(v2Health.json().apiVersion, 2);

    const v2Workforce = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/workforce',
    });
    assert.equal(v2Workforce.statusCode, 200);
    assert.deepEqual(v2Workforce.json().summary, {
      employees: 0,
      employed: 0,
      dormant: 0,
      currentDuties: 0,
    });

    const workforce = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/workforce',
    });
    assert.equal(workforce.statusCode, 200);
    const snapshot = workforce.json();
    assert.deepEqual(snapshot.positions.map((position: { id: string }) => position.id).sort(), [
      'codex-general',
      'coding-review',
      'hermes-brain',
    ]);
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
  } finally {
    await runtime.app.close();
  }
});

test('typed app factory preserves validation status codes', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa: emptyCpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/usage',
      payload: { workerId: 'missing' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'unknown worker');
  } finally {
    await runtime.app.close();
  }
});
