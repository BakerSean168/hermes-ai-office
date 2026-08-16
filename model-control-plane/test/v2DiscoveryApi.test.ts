import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import type {
  GatewayDiscoveryPort,
  GatewayExecutionPort,
  GatewayHealth,
  GatewayRouteRef,
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

class ApiDiscoveryGateway implements GatewayExecutionPort, GatewayDiscoveryPort {
  readonly gatewayId = 'cpa-compat';

  async resolveRoute() {
    return { route: null, routable: false, reasons: ['NOT_USED'], observedAt: Date.now() };
  }

  async getRouteHealth(_route: GatewayRouteRef): Promise<GatewayHealth> {
    return 'healthy';
  }

  async discover() {
    return {
      gatewayId: this.gatewayId,
      observedAt: 123,
      routes: [
        {
          externalRouteRef: 'cpa/opencode/model/deepseek-v4-flash',
          protocol: 'openai-responses' as const,
          health: 'healthy' as const,
          supplierHint: 'OpenCode',
          supplierModelHint: 'deepseek-v4-flash',
          agreementHint: 'opencode-go',
          capabilities: ['reasoning'],
          deployments: [],
          metadata: { channelName: 'opencode-go', enabled: true },
        },
      ],
    };
  }
}

test('gateway discovery API reconciles durable workforce identity and exposes safe Channel evidence', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([new ApiDiscoveryGateway()]),
  });
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/gateways/cpa-compat/discover',
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().createdEmployees, 1);
    assert.equal(response.json().createdEmployments, 1);

    const workforce = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/workforce',
    });
    assert.equal(workforce.json().summary.employees, 1);
    assert.equal(workforce.json().employees[0].displayName, 'Deepseek V4 Flash @ OpenCode');

    const channels = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/channels?gatewayId=cpa-compat',
    });
    assert.equal(channels.statusCode, 200);
    assert.equal(channels.json().items.length, 1);
    assert.equal(channels.json().items[0].health, 'HEALTHY');
    assert.equal(JSON.stringify(channels.json()).includes('Authorization'), false);

    const runs = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/discovery-runs',
    });
    assert.equal(runs.json().items[0].status, 'COMPLETED');
    assert.equal(runs.json().items[0].routeCount, 1);

    const repeat = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/gateways/cpa-compat/discover',
      payload: {},
    });
    assert.equal(repeat.json().createdEmployees, 0);
    assert.equal(repeat.json().createdEmployments, 0);
  } finally {
    await runtime.app.close();
  }
});

test('unknown gateway discovery returns a deterministic 404', async () => {
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
      url: '/api/v2/internal/gateways/missing/discover',
      payload: {},
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'GATEWAY_DISCOVERY_UNAVAILABLE');
  } finally {
    await runtime.app.close();
  }
});
