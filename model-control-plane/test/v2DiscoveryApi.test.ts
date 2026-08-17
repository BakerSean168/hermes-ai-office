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

test('technical CPA channel names remain evidence and do not fabricate business identity', async () => {
  class AmbiguousGateway implements GatewayExecutionPort, GatewayDiscoveryPort {
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
        observedAt: 456,
        routes: [
          {
            externalRouteRef: 'cpa/channel/planner-pool/model/planner-cheap',
            protocol: 'openai-chat-completions' as const,
            health: 'healthy' as const,
            supplierModelHint: 'planner-cheap',
            capabilities: [],
            deployments: [],
            metadata: { channelName: 'planner-pool', source: 'cpa-compat' },
          },
        ],
      };
    }
  }

  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([new AmbiguousGateway()]),
  });
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/gateways/cpa-compat/discover',
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().createdEmployees, 0);
    assert.ok(
      response
        .json()
        .issues.some((issue: { code: string }) => issue.code === 'SUPPLIER_IDENTITY_MISSING'),
    );

    const workforce = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/workforce',
    });
    assert.equal(workforce.json().summary.employees, 0);

    const channels = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/channels?gatewayId=cpa-compat',
    });
    assert.equal(channels.json().items.length, 1);
    assert.equal(channels.json().items[0].supplierModelHint, 'planner-cheap');
  } finally {
    await runtime.app.close();
  }
});
test('gateway discovery archives routes that disappear from the authoritative snapshot', async () => {
  class MutableGateway implements GatewayExecutionPort, GatewayDiscoveryPort {
    readonly gatewayId = 'cpa-compat';
    routes = [
      {
        externalRouteRef: 'cpa/channel/deepseek-api/model/deepseek-v4-flash',
        protocol: 'openai-chat-completions' as const,
        health: 'healthy' as const,
        supplierModelHint: 'deepseek-v4-flash',
        capabilities: [],
        deployments: [],
        metadata: { channelName: 'deepseek-api' },
      },
      {
        externalRouteRef: 'cpa/channel/deepseek-api/model/employment%3Aretired',
        protocol: 'openai-chat-completions' as const,
        health: 'healthy' as const,
        supplierModelHint: 'employment:retired',
        capabilities: [],
        deployments: [],
        metadata: { channelName: 'deepseek-api' },
      },
    ];

    async resolveRoute() {
      return { route: null, routable: false, reasons: ['NOT_USED'], observedAt: Date.now() };
    }

    async getRouteHealth(_route: GatewayRouteRef): Promise<GatewayHealth> {
      return 'healthy';
    }

    async discover() {
      return { gatewayId: this.gatewayId, observedAt: Date.now(), routes: this.routes };
    }
  }

  const gateway = new MutableGateway();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([gateway]),
  });
  try {
    await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/gateways/cpa-compat/discover',
      payload: {},
    });
    assert.equal(
      runtime.v2.listChannels('cpa-compat').filter((row) => row.lifecycle !== 'ARCHIVED').length,
      2,
    );

    gateway.routes = gateway.routes.slice(0, 1);
    await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/internal/gateways/cpa-compat/discover',
      payload: {},
    });

    const channels = runtime.v2.listChannels('cpa-compat');
    assert.equal(channels.length, 2);
    assert.equal(
      channels.find((row) => String(row.externalRouteRef).includes('employment%3Aretired'))
        ?.lifecycle,
      'ARCHIVED',
    );
    assert.equal(
      channels.find((row) => String(row.externalRouteRef).endsWith('deepseek-v4-flash'))?.lifecycle,
      'ENABLED',
    );
  } finally {
    await runtime.app.close();
  }
});
