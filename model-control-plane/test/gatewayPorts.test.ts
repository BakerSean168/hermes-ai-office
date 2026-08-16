import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GatewayDiscoveryPort,
  GatewayExecutionPort,
  GatewayRouteRef,
  GatewayUsagePort,
} from '../src/gateway/ports.js';

class FixtureGateway implements GatewayExecutionPort, GatewayDiscoveryPort, GatewayUsagePort {
  readonly gatewayId = 'fixture';

  async resolveRoute(employmentId: string) {
    return {
      route: {
        gatewayId: this.gatewayId,
        employmentId,
        externalRouteRef: `employment:${employmentId}`,
        protocol: 'openai-responses' as const,
      },
      routable: true,
      reasons: ['FIXTURE_ROUTE'],
      observedAt: 1,
    };
  }

  async getRouteHealth(_route: GatewayRouteRef) {
    return 'healthy' as const;
  }

  async discover() {
    return {
      gatewayId: this.gatewayId,
      observedAt: 1,
      routes: [],
    };
  }

  async pullUsage() {
    return { evidence: [] };
  }
}

test('gateway contracts keep employment identity above physical routing', async () => {
  const gateway = new FixtureGateway();
  const result = await gateway.resolveRoute('empl_001');

  assert.equal(result.routable, true);
  assert.equal(result.route?.employmentId, 'empl_001');
  assert.equal(result.route?.externalRouteRef, 'employment:empl_001');
  assert.equal(await gateway.getRouteHealth(result.route!), 'healthy');
});
