import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import type { GatewayExecutionPort, GatewayHealth, GatewayRouteRef } from '../src/gateway/ports.js';
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

class FixtureGateway implements GatewayExecutionPort {
  readonly gatewayId = 'finance-api';
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
}

async function setup() {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([new FixtureGateway()]),
  });
  const seeded = runtime.v2.bootstrapReference({
    supplierSlug: 'fixture-supplier',
    supplierName: 'Fixture Supplier',
    supplierModelKey: 'fixture-model',
    supplierModelName: 'Fixture Model',
    agreementRef: 'fixture-agreement',
    agreementName: 'Fixture Agreement',
    gatewaySlug: 'finance-api',
    gatewayKind: 'OTHER',
    gatewayName: 'Finance API Gateway',
    workScopeSlug: 'development',
    workScopeName: 'Development',
    positionSlug: 'coding-review',
    positionName: 'Coding Reviewer',
    positionKind: 'REVIEWER',
    runtimeKind: 'CODEX',
    protocol: 'openai-responses',
  });
  const run = runtime.v2.createRun({ workScopeId: seeded.workScopeId, title: 'Finance API run' });
  const duty = runtime.v2.openDuty({ runId: String(run.id), positionId: seeded.positionId });
  await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/duties/${duty.id}/dispatch`,
    payload: {},
  });
  const context = runtime.v2.invocationContext(String(duty.id));
  assert.ok(context);
  const invocation = runtime.v2.startInvocation({ context });
  const attempt = runtime.v2.startInvocationAttempt({
    invocationId: String(invocation.id),
    context,
  });
  runtime.v2.completeInvocationAttempt({
    attemptId: String(attempt.id),
    gatewayRequestId: 'finance-api-request',
    latencyMs: 1,
  });
  runtime.v2.recordUsage({
    attemptId: String(attempt.id),
    context,
    source: 'fixture',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      actualCost: 0,
      currency: 'USD',
    },
  });
  return { runtime, seeded, run, duty };
}

test('finance and evaluation commands are idempotent HTTP contracts and project derived values', async () => {
  const { runtime, seeded, duty } = await setup();
  try {
    const terms = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/supply-agreements/${seeded.agreementId}/commercial-terms`,
      headers: { 'Idempotency-Key': 'finance-terms-1' },
      payload: { fixedCost: 15, currency: 'USD', billingPeriod: 'month' },
    });
    assert.equal(terms.statusCode, 200);

    const price = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/reference-prices/create',
      headers: { 'Idempotency-Key': 'finance-price-1' },
      payload: {
        supplierModelId: seeded.supplierModelId,
        name: 'Fixture Reference',
        inputPerMillion: 1_000_000,
        outputPerMillion: 2_000_000,
        source: 'TEST_REFERENCE',
        effectiveFrom: 0,
      },
    });
    assert.equal(price.statusCode, 200);
    const priceId = price.json().id as string;

    const applied1 = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/reference-prices/${priceId}/apply`,
      headers: { 'Idempotency-Key': 'finance-price-apply-1' },
      payload: {},
    });
    const applied2 = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/reference-prices/${priceId}/apply`,
      headers: { 'Idempotency-Key': 'finance-price-apply-1' },
      payload: {},
    });
    assert.equal(applied1.statusCode, 200);
    assert.equal(applied1.json().marketValue, 20);
    assert.equal(applied2.headers['idempotency-replayed'], 'true');

    const allocation1 = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/supply-agreements/${seeded.agreementId}/allocate-cost`,
      headers: { 'Idempotency-Key': 'finance-allocation-1' },
      payload: { periodStart: 0, periodEnd: Date.now() + 60_000, basis: 'TOKENS' },
    });
    assert.equal(allocation1.statusCode, 200);
    assert.equal(allocation1.json().allocated_total, 15);

    const evaluationPayload = {
      subjectType: 'DutySession',
      subjectId: String(duty.id),
      employeeId: seeded.employeeId,
      positionId: seeded.positionId,
      dimensions: { correctness: 91, review_quality: 87 },
      source: 'TEST_EVALUATOR',
    };
    const evaluation1 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/evaluations/record',
      headers: { 'Idempotency-Key': 'finance-evaluation-1' },
      payload: evaluationPayload,
    });
    const evaluation2 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/evaluations/record',
      headers: { 'Idempotency-Key': 'finance-evaluation-1' },
      payload: evaluationPayload,
    });
    assert.equal(evaluation1.statusCode, 200);
    assert.equal(evaluation2.headers['idempotency-replayed'], 'true');

    const dossier = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/employees/${seeded.employeeId}`,
    });
    assert.equal(dossier.json().career.usage.marketValue, 20);
    assert.equal(dossier.json().career.usage.allocatedCost, 15);

    const performance = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/employees/${seeded.employeeId}/performance`,
    });
    assert.equal(performance.statusCode, 200);
    assert.equal(performance.json().items[0].dimensions.correctness.average, 91);

    const prices = await runtime.app.inject({ method: 'GET', url: '/api/v2/reference-prices' });
    const allocations = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/cost-allocation-runs?agreementId=${seeded.agreementId}`,
    });
    const evaluations = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/evaluations?employeeId=${seeded.employeeId}`,
    });
    assert.equal(prices.json().items.length, 1);
    assert.equal(allocations.json().items.length, 1);
    assert.equal(evaluations.json().items.length, 1);
  } finally {
    await runtime.app.close();
  }
});
