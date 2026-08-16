import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import type {
  GatewayExecutionPort,
  GatewayInvocationPort,
  GatewayInvocationRequest,
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

const reference = {
  supplierSlug: 'planner-pool',
  supplierName: 'Planner Pool',
  supplierModelKey: 'deepseek-v4-flash',
  supplierModelName: 'DeepSeek V4 Flash',
  agreementRef: 'planner-pool-primary',
  agreementName: 'Planner Pool Primary Supply',
  gatewaySlug: 'litellm-reference',
  gatewayKind: 'LITELLM' as const,
  gatewayName: 'LiteLLM Reference Gateway',
  gatewayBaseUrlHint: 'http://127.0.0.1:4000',
  workScopeSlug: 'development',
  workScopeName: 'Development',
  externalProfileRef: 'development',
  positionSlug: 'coding-review',
  positionName: 'Coding Reviewer',
  positionKind: 'REVIEWER',
  runtimeKind: 'CODEX',
  protocol: 'openai-responses' as const,
};

class CountingGateway implements GatewayExecutionPort, GatewayInvocationPort {
  readonly gatewayId = 'litellm-reference';
  calls = 0;
  startedResolve!: () => void;
  releaseResolve!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });
  readonly release = new Promise<void>((resolve) => {
    this.releaseResolve = resolve;
  });

  async resolveRoute(employmentId: string) {
    return {
      route: {
        gatewayId: this.gatewayId,
        employmentId,
        externalRouteRef: 'employment:' + employmentId,
        protocol: 'openai-responses' as const,
      },
      routable: true,
      reasons: ['TEST_ROUTE'],
      observedAt: Date.now(),
    };
  }

  async getRouteHealth(_route: GatewayRouteRef) {
    return 'healthy' as const;
  }

  async invoke(request: GatewayInvocationRequest) {
    this.calls += 1;
    this.startedResolve();
    await this.release;
    return {
      gatewayRequestId: 'gateway_request_1',
      externalDeploymentRef: 'deployment_1',
      outputText: 'IDEMPOTENCY_OK',
      responseModel: request.route.externalRouteRef,
      status: 'succeeded' as const,
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      actualCost: 0.02,
      currency: 'USD',
      latencyMs: 12,
      metadata: {},
    };
  }
}

async function setup() {
  const gateway = new CountingGateway();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([gateway]),
  });
  const seeded = runtime.v2.bootstrapReference(reference);
  return { runtime, gateway, seeded };
}

test('Run, Duty, Dispatch and Redispatch replay persisted command results without duplicate facts', async () => {
  const { runtime, seeded } = await setup();
  try {
    const runPayload = {
      workScopeId: seeded.workScopeId,
      title: 'Idempotent API run',
      externalRunRef: 'idempotent-api-run',
    };
    const run1 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/runs/create',
      headers: { 'Idempotency-Key': 'run-create-1' },
      payload: runPayload,
    });
    const run2 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/runs/create',
      headers: { 'Idempotency-Key': 'run-create-1' },
      payload: runPayload,
    });
    assert.equal(run1.statusCode, 200);
    assert.equal(run2.statusCode, 200);
    assert.equal(run2.headers['idempotency-replayed'], 'true');
    assert.equal(run2.json().id, run1.json().id);

    const dutyPayload = {
      runId: run1.json().id,
      positionId: seeded.positionId,
      activity: 'REVIEWING',
    };
    const duty1 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/duties/open',
      headers: { 'Idempotency-Key': 'duty-open-1' },
      payload: dutyPayload,
    });
    const duty2 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/duties/open',
      headers: { 'Idempotency-Key': 'duty-open-1' },
      payload: dutyPayload,
    });
    assert.equal(duty2.headers['idempotency-replayed'], 'true');
    assert.equal(duty2.json().id, duty1.json().id);

    const dispatchUrl = '/api/v2/commands/duties/' + duty1.json().id + '/dispatch';
    const dispatchPayload = { correlationId: 'corr-idempotent-dispatch' };
    const dispatch1 = await runtime.app.inject({
      method: 'POST',
      url: dispatchUrl,
      headers: { 'Idempotency-Key': 'dispatch-1' },
      payload: dispatchPayload,
    });
    const dispatch2 = await runtime.app.inject({
      method: 'POST',
      url: dispatchUrl,
      headers: { 'Idempotency-Key': 'dispatch-1' },
      payload: dispatchPayload,
    });
    assert.equal(dispatch2.headers['idempotency-replayed'], 'true');
    assert.equal(dispatch2.json().decisionId, dispatch1.json().decisionId);
    assert.equal(runtime.v2.listDispatchDecisions(duty1.json().id).length, 1);

    const redispatchUrl = '/api/v2/commands/duties/' + duty1.json().id + '/redispatch';
    const redispatchPayload = { correlationId: 'corr-idempotent-redispatch' };
    const redispatch1 = await runtime.app.inject({
      method: 'POST',
      url: redispatchUrl,
      headers: { 'Idempotency-Key': 'redispatch-1' },
      payload: redispatchPayload,
    });
    const redispatch2 = await runtime.app.inject({
      method: 'POST',
      url: redispatchUrl,
      headers: { 'Idempotency-Key': 'redispatch-1' },
      payload: redispatchPayload,
    });
    assert.equal(redispatch2.headers['idempotency-replayed'], 'true');
    assert.equal(redispatch2.json().decisionId, redispatch1.json().decisionId);
    assert.equal(runtime.v2.listDispatchDecisions(duty1.json().id).length, 2);

    const runs = await runtime.app.inject({ method: 'GET', url: '/api/v2/runs?limit=100' });
    assert.equal(
      runs
        .json()
        .items.filter(
          (item: { externalRunRef?: string }) => item.externalRunRef === 'idempotent-api-run',
        ).length,
      1,
    );
    const duties = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/duties?runId=' + run1.json().id,
    });
    assert.equal(duties.json().items.length, 1);
  } finally {
    await runtime.app.close();
  }
});

test('concurrent duplicate Invoke requests share one gateway call and one UsageEntry', async () => {
  const { runtime, gateway, seeded } = await setup();
  try {
    const run = runtime.v2.createRun({
      workScopeId: seeded.workScopeId,
      title: 'Concurrent invocation replay',
      externalRunRef: 'concurrent-invoke-run',
    });
    const duty = runtime.v2.openDuty({
      runId: String(run.id),
      positionId: seeded.positionId,
      activity: 'REVIEWING',
    });
    await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/duties/' + duty.id + '/dispatch',
      payload: { correlationId: 'corr-concurrent-invoke' },
    });

    const url = '/api/v2/internal/duties/' + duty.id + '/invoke';
    const request = {
      method: 'POST' as const,
      url,
      headers: { 'Idempotency-Key': 'invoke-concurrent-1' },
      payload: { input: 'Return IDEMPOTENCY_OK.', correlationId: 'corr-concurrent-invoke' },
    };
    const first = runtime.app.inject(request);
    await gateway.started;
    const second = runtime.app.inject(request);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gateway.calls, 1);
    gateway.releaseResolve();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 200);
    assert.equal(gateway.calls, 1);
    assert.equal(secondResponse.headers['idempotency-replayed'], 'true');
    assert.equal(secondResponse.json().invocationId, firstResponse.json().invocationId);
    assert.equal(secondResponse.json().usageEntryId, firstResponse.json().usageEntryId);

    const invocations = runtime.v2.listInvocations({ dutySessionId: String(duty.id) });
    const usageRows = runtime.v2.listUsage({ dutySessionId: String(duty.id) });
    assert.equal(invocations.length, 1);
    assert.equal(usageRows.length, 1);
    assert.equal(usageRows[0].inputTokens, 20);
    assert.equal(usageRows[0].actualCost, 0.02);
  } finally {
    gateway.releaseResolve();
    await runtime.app.close();
  }
});
