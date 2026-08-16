import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import { GatewayRegistry } from '../src/gateway/registry.js';

const cpa: LegacyCpaPort = {
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
const usage: LegacyUsagePort = {
  async snapshot() {
    return { stats: { groups: [] }, costs: { models: [] } };
  },
};

const snapshot = {
  sourceRevision: 'api-rev-1',
  profiles: [
    {
      profileId: 'memo',
      displayName: 'Memo',
      availability: 'ONLINE',
      workload: 'EXECUTING',
      sessionId: 'memo-session',
      controllerState: 'THINKING',
      controllerActive: true,
      controllerModel: 'deepseek-v4-flash',
      lastSeenAt: 1000,
    },
  ],
  runs: [
    {
      id: 'interactive:memo:memo-session',
      profileId: 'memo',
      title: 'Memo live run',
      status: 'RUNNING',
      createdAt: 900,
      startedAt: 950,
    },
  ],
  nodes: [
    {
      id: 'memo-opencode-1',
      profileId: 'memo',
      runId: 'interactive:memo:memo-session',
      type: 'OPENCODE',
      role: 'EXECUTOR',
      runtime: 'opencode',
      model: 'mystery-model-that-must-not-become-an-employee',
      taskTitle: 'Implement memo flow',
      state: 'CODING',
      sessionId: 'opencode-session-1',
      startedAt: 970,
      updatedAt: 1010,
    },
  ],
  edges: [],
};

test('Hermes sync HTTP contract is repeatable and keeps runtime model hints outside workforce identity', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry(),
  });
  try {
    const before = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/workforce',
    });
    assert.equal(before.json().summary.employees, 0);

    const first = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/hermes/sync',
      payload: snapshot,
    });
    const second = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/hermes/sync',
      payload: snapshot,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.json().runtimeSessionsCreated, 2);
    assert.equal(second.json().runtimeSessionsCreated, 0);

    const workforce = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/workforce',
    });
    assert.equal(workforce.json().summary.employees, 0);

    const sessions = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/runtime-sessions?activeOnly=true',
    });
    assert.equal(sessions.statusCode, 200);
    assert.equal(sessions.json().items.length, 2);
    assert.ok(
      sessions
        .json()
        .items.some(
          (item: { runtimeKind: string; modelHint: string }) =>
            item.runtimeKind === 'OPENCODE' &&
            item.modelHint === 'mystery-model-that-must-not-become-an-employee',
        ),
    );

    const topology = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/organization',
    });
    assert.ok(
      topology.json().positions.some((item: { slug: string }) => item.slug === 'profile-lead'),
    );
    assert.ok(
      topology
        .json()
        .positions.some(
          (item: { externalPositionRef: string }) => item.externalPositionRef === 'memo-opencode-1',
        ),
    );

    const syncRuns = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/execution-sync-runs',
    });
    assert.equal(syncRuns.json().items.length, 2);
    assert.ok(
      syncRuns.json().items.every((item: { status: string }) => item.status === 'COMPLETED'),
    );
  } finally {
    await runtime.app.close();
  }
});

test('Hermes sync rejects non-normalized payloads deterministically', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry(),
  });
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/hermes/sync',
      payload: { profiles: [] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'HERMES_ORG_SNAPSHOT_REQUIRED');
  } finally {
    await runtime.app.close();
  }
});
