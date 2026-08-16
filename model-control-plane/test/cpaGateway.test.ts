import assert from 'node:assert/strict';
import test from 'node:test';

import { CpaGateway, cpaRouteRef, parseCpaRouteRef } from '../src/gateway/cpaGateway.js';
import { StaticGatewayBindingSource } from '../src/gateway/staticBindings.js';

const statusSource = {
  async status() {
    return [
      {
        name: 'opencode-go',
        protocol: 'openai-compatible',
        enabled: true,
        models: ['deepseek-v4-flash', 'position:coding-review'],
        logicalAliases: ['position:coding-review'],
        lastTest: 'pass',
        health: 'healthy',
      },
      {
        name: 'disabled-route',
        protocol: 'openai-compatible',
        enabled: false,
        models: ['deepseek-v4-flash'],
        lastTest: 'fail',
        health: 'degraded',
      },
    ];
  },
};

const usageSource = {
  async snapshot() {
    return {
      range: '30d',
      stats: {
        generated_at: '2026-08-16T00:00:00Z',
        groups: [
          {
            provider: 'openai-compatible-opencode-go',
            model: 'deepseek-v4-flash',
            requests: 3,
            failed_requests: 1,
            input_tokens: 100,
            output_tokens: 20,
            cached_tokens: 50,
            reasoning_tokens: 5,
          },
        ],
      },
      costs: {
        models: [
          {
            provider: 'openai-compatible-opencode-go',
            model: 'deepseek-v4-flash',
            total_usd: 0.25,
          },
        ],
      },
    };
  },
};

function makeGateway() {
  const bindings = new StaticGatewayBindingSource([
    {
      gatewayId: 'cpa-compat',
      employmentId: 'empl_open_code',
      externalRouteRef: cpaRouteRef('opencode-go', 'deepseek-v4-flash'),
      protocol: 'openai-chat-completions',
    },
    {
      gatewayId: 'cpa-compat',
      employmentId: 'empl_disabled',
      externalRouteRef: cpaRouteRef('disabled-route', 'deepseek-v4-flash'),
      protocol: 'openai-chat-completions',
    },
  ]);
  return new CpaGateway({ statusSource, usageSource, bindings });
}

test('CPA route references round-trip without becoming business identity', () => {
  const ref = cpaRouteRef('OpenCode Go / A', 'deepseek/v4');
  assert.deepEqual(parseCpaRouteRef(ref), {
    channelName: 'OpenCode Go / A',
    modelId: 'deepseek/v4',
  });
});

test('CPA gateway adapter resolves only the selected employment binding', async () => {
  const gateway = makeGateway();
  const selected = await gateway.resolveRoute('empl_open_code');
  assert.equal(selected.routable, true);
  assert.equal(selected.route?.employmentId, 'empl_open_code');
  assert.equal(selected.route?.gatewayId, 'cpa-compat');

  const missing = await gateway.resolveRoute('empl_other');
  assert.equal(missing.routable, false);
  assert.deepEqual(missing.reasons, ['NO_GATEWAY_BINDING']);

  const disabled = await gateway.resolveRoute('empl_disabled');
  assert.equal(disabled.routable, false);
  assert.deepEqual(disabled.reasons, ['CPA_ROUTE_UNAVAILABLE']);
});

test('CPA discovery exposes safe normalized route evidence', async () => {
  const snapshot = await makeGateway().discover();
  assert.equal(snapshot.gatewayId, 'cpa-compat');
  assert.equal(snapshot.routes.length, 2);
  assert.equal(snapshot.routes[0]?.supplierModelHint, 'deepseek-v4-flash');
  assert.equal(snapshot.routes[0]?.health, 'healthy');
  assert.equal(JSON.stringify(snapshot).includes('apiKey'), false);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal(
    snapshot.routes.some((route) => route.externalRouteRef.includes('position%3A')),
    false,
  );
});

test('CPA aggregate usage remains aggregate evidence and is not fabricated as requests', async () => {
  const page = await makeGateway().pullUsage();
  assert.equal(page.evidence.length, 1);
  const evidence = page.evidence[0];
  assert.equal(evidence?.kind, 'aggregate');
  if (evidence?.kind !== 'aggregate') throw new Error('expected aggregate evidence');
  assert.equal(evidence.requests, 3);
  assert.equal(evidence.failedRequests, 1);
  assert.equal(evidence.inputTokens, 100);
  assert.equal(evidence.actualCost, 0.25);
  assert.equal('gatewayRequestId' in evidence, false);
});
