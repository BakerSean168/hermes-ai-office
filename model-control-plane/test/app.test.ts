import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type CpaProbePort, type CpaUsagePort } from '../src/app.js';

const emptyCpa: CpaProbePort = {
  async status() {
    return [];
  },
  async test() {},
};

const emptyUsage: CpaUsagePort = {
  async snapshot() {
    return { range: '30d', stats: { groups: [] }, costs: { models: [] } };
  },
};

test('typed app factory exposes V2 only and retires public V1 routes', async () => {
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
      apiVersion: 2,
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
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      actualCost: 0,
      marketValue: 0,
    });

    const supply = await runtime.app.inject({ method: 'GET', url: '/api/v2/projections/supply' });
    assert.equal(supply.statusCode, 200);
    assert.equal(supply.json().summary.suppliers, 0);
    assert.deepEqual(supply.json().suppliers, []);

    for (const url of [
      '/api/v1/snapshot',
      '/api/v1/dashboard/workforce',
      '/api/v1/events',
      '/api/v2/compatibility/status',
    ]) {
      const retired = await runtime.app.inject({ method: 'GET', url });
      assert.equal(retired.statusCode, 404, `${url} must remain retired`);
    }
  } finally {
    await runtime.app.close();
  }
});

test('V2 gateway discovery replaces legacy CPA synchronization', async () => {
  const cpa: CpaProbePort = {
    async status() {
      return [
        {
          name: 'route-a',
          protocol: 'openai-compatible',
          enabled: true,
          models: ['model-a'],
          health: 'healthy',
          lastTest: 'pass',
        },
      ];
    },
    async test() {},
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    assert.equal(runtime.v2.listGateways().length, 0);
    await runtime.reconcileGateways();
    const gateways = runtime.v2.listGateways();
    assert.equal(gateways.length, 1);
    assert.equal(gateways[0]?.slug, 'cpa-compat');
    assert.equal(gateways[0]?.kind, 'CPA');
    assert.equal(runtime.v2.listEmployees().length, 0);
  } finally {
    await runtime.app.close();
  }
});
