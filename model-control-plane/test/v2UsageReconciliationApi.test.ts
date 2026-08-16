import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import type {
  GatewayExecutionPort,
  GatewayHealth,
  GatewayRouteRef,
  GatewayUsagePort,
} from '../src/gateway/ports.js';
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

class AggregateGateway implements GatewayExecutionPort, GatewayUsagePort {
  readonly gatewayId = 'usage-api-fixture';

  async resolveRoute(employmentId: string) {
    return {
      route: {
        gatewayId: this.gatewayId,
        employmentId,
        externalRouteRef: `employment:${employmentId}`,
        protocol: 'openai-responses' as const,
      },
      routable: true,
      reasons: ['FIXTURE'],
      observedAt: Date.now(),
    };
  }

  async getRouteHealth(_route: GatewayRouteRef): Promise<GatewayHealth> {
    return 'healthy';
  }

  async pullUsage() {
    return {
      evidence: [
        {
          kind: 'aggregate' as const,
          gatewayId: this.gatewayId,
          aggregateKey: '30d:fixture:model',
          window: '30d',
          generatedAt: 123,
          externalRouteRef: 'fixture/aggregate',
          model: 'model',
          provider: 'fixture',
          requests: 4,
          failedRequests: 0,
          inputTokens: 40,
          outputTokens: 8,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          actualCost: 0.04,
          currency: 'USD',
        },
      ],
    };
  }
}

test('usage reconciliation API exposes aggregate evidence without adding employee usage', async () => {
  const gateway = new AggregateGateway();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([gateway]),
  });
  try {
    runtime.v2.bootstrapReference({
      supplierSlug: 'fixture-supplier',
      supplierName: 'Fixture Supplier',
      supplierModelKey: 'fixture-model',
      supplierModelName: 'Fixture Model',
      agreementRef: 'fixture-agreement',
      agreementName: 'Fixture Agreement',
      gatewaySlug: gateway.gatewayId,
      gatewayKind: 'OTHER',
      gatewayName: 'Usage API Fixture',
      workScopeSlug: 'development',
      workScopeName: 'Development',
      positionSlug: 'coding-review',
      positionName: 'Coding Reviewer',
      positionKind: 'REVIEWER',
      runtimeKind: 'CODEX',
      protocol: 'openai-responses',
    });

    const reconciled = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/gateways/usage-api-fixture/reconcile-usage',
      payload: {},
    });
    assert.equal(reconciled.statusCode, 200);
    assert.equal(reconciled.json().aggregateCount, 1);
    assert.equal(reconciled.json().requestUsageCreated, 0);

    const evidence = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/usage-evidence?gatewayId=usage-api-fixture&kind=aggregate',
    });
    assert.equal(evidence.statusCode, 200);
    assert.equal(evidence.json().items.length, 1);
    assert.equal(evidence.json().items[0].requests, 4);

    const runs = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/usage-reconciliation-runs?gatewayId=usage-api-fixture',
    });
    assert.equal(runs.statusCode, 200);
    assert.equal(runs.json().items.length, 1);
    assert.equal(runs.json().items[0].status, 'COMPLETED');

    const attributable = await runtime.app.inject({ method: 'GET', url: '/api/v2/usage' });
    assert.equal(attributable.json().items.length, 0);
  } finally {
    await runtime.app.close();
  }
});

test('usage reconciliation API reports adapters without usage support as not found', async () => {
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
      url: '/api/v2/internal/gateways/missing/reconcile-usage',
      payload: {},
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'GATEWAY_USAGE_UNAVAILABLE');
  } finally {
    await runtime.app.close();
  }
});
