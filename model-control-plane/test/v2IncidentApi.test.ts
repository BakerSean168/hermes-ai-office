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

test('incident HTTP commands are idempotent and projection rebuild preserves operator state', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry(),
  });
  try {
    const seeded = runtime.v2.bootstrapReference({
      supplierSlug: 'supplier-a',
      supplierName: 'Supplier A',
      supplierModelKey: 'model-a',
      supplierModelName: 'Model A',
      agreementRef: 'agreement-a',
      agreementName: 'Agreement A',
      gatewaySlug: 'gateway-a',
      gatewayKind: 'OTHER',
      gatewayName: 'Gateway A',
      workScopeSlug: 'development',
      workScopeName: 'Development',
      positionSlug: 'coding-review',
      positionName: 'Coding Reviewer',
      positionKind: 'REVIEWER',
      runtimeKind: 'CODEX',
      protocol: 'openai-responses',
    });
    const run = runtime.v2.createRun({
      workScopeId: seeded.workScopeId,
      title: 'Incident API run',
    });
    const duty = runtime.v2.openDuty({ runId: String(run.id), positionId: seeded.positionId });
    runtime.v2.transaction(() =>
      runtime.v2.emit({
        type: 'dispatch.failed',
        entityType: 'DutySession',
        entityId: String(duty.id),
        runId: String(run.id),
        dutySessionId: String(duty.id),
        payload: { reason: 'NO_ROUTE' },
      }),
    );

    const list = await runtime.app.inject({ method: 'GET', url: '/api/v2/incidents' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 1);
    const incidentId = list.json().items[0].id as string;

    const ack1 = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/incidents/${incidentId}/acknowledge`,
      headers: { 'Idempotency-Key': 'incident-ack-1' },
      payload: { note: 'Looking into it' },
    });
    const ack2 = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/incidents/${incidentId}/acknowledge`,
      headers: { 'Idempotency-Key': 'incident-ack-1' },
      payload: { note: 'Looking into it' },
    });
    assert.equal(ack1.statusCode, 200);
    assert.equal(ack1.json().lifecycle, 'ACKNOWLEDGED');
    assert.equal(ack2.headers['idempotency-replayed'], 'true');

    const rebuild = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/projections/incidents/rebuild',
      payload: {},
    });
    assert.equal(rebuild.statusCode, 200);
    const afterRebuild = await runtime.app.inject({ method: 'GET', url: '/api/v2/incidents' });
    assert.equal(afterRebuild.json().items[0].id, incidentId);
    assert.equal(afterRebuild.json().items[0].lifecycle, 'ACKNOWLEDGED');

    const resolved = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/incidents/${incidentId}/resolve`,
      headers: { 'Idempotency-Key': 'incident-resolve-1' },
      payload: { note: 'Recovered' },
    });
    assert.equal(resolved.statusCode, 200);
    assert.equal(resolved.json().lifecycle, 'RESOLVED');
    assert.equal(resolved.json().resolutionNote, 'Recovered');

    const checkpoint = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projection-checkpoints/incidents',
    });
    assert.equal(checkpoint.statusCode, 200);
    assert.equal(checkpoint.json().checkpoint.projectionName, 'incidents');
    assert.ok(checkpoint.json().checkpoint.lastEventSeq > 0);
  } finally {
    await runtime.app.close();
  }
});
