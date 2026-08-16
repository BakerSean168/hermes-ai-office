import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GatewayExecutionPort,
  GatewayHealth,
  GatewayInvocationPort,
  GatewayInvocationRequest,
  GatewayInvocationResult,
  GatewayRouteRef,
} from '../src/gateway/ports.js';
import { GatewayRegistry } from '../src/gateway/registry.js';
import { DispatchService } from '../src/v2/dispatch.js';
import { InvocationService } from '../src/v2/invocation.js';
import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';

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

class InvocationGateway implements GatewayExecutionPort, GatewayInvocationPort {
  readonly gatewayId = 'litellm-reference';
  readonly #failure: string | null;

  constructor(failure: string | null = null) {
    this.#failure = failure;
  }

  async resolveRoute(employmentId: string) {
    return {
      route: {
        gatewayId: this.gatewayId,
        employmentId,
        externalRouteRef: `employment:${employmentId}`,
        protocol: 'openai-responses' as const,
      },
      routable: true,
      reasons: ['TEST_ROUTE'],
      observedAt: Date.now(),
    };
  }

  async getRouteHealth(_route: GatewayRouteRef): Promise<GatewayHealth> {
    return 'healthy';
  }

  async invoke(request: GatewayInvocationRequest): Promise<GatewayInvocationResult> {
    if (this.#failure) throw new Error(this.#failure);
    assert.equal(request.route.externalRouteRef, `employment:${request.route.employmentId}`);
    return {
      gatewayRequestId: 'call_test',
      externalDeploymentRef: 'deployment_test',
      outputText: 'REVIEW_OK',
      responseModel: request.route.externalRouteRef,
      status: 'succeeded',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      actualCost: 0.125,
      currency: 'USD',
      latencyMs: 42,
      metadata: { attemptedRetries: 0, attemptedFallbacks: 0 },
    };
  }
}

async function make(gateway: InvocationGateway) {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const seeded = repository.bootstrapReference(reference);
  const run = repository.createRun({
    workScopeId: seeded.workScopeId,
    title: 'Invocation test run',
    externalRunRef: `invocation-test-${Math.random()}`,
  });
  const duty = repository.openDuty({
    runId: String(run.id),
    positionId: seeded.positionId,
    activity: 'REVIEWING',
  });
  const registry = new GatewayRegistry([gateway]);
  await new DispatchService(repository, registry).dispatchDuty(String(duty.id));
  return {
    db,
    repository,
    seeded,
    run,
    duty,
    service: new InvocationService(repository, registry),
  };
}

test('successful invocation records attempt, usage and closes the duty atomically', async () => {
  const { repository, seeded, run, duty, service } = await make(new InvocationGateway());
  const result = await service.invokeDuty(String(duty.id), 'Review this change.', {
    correlationId: 'corr_success',
  });

  assert.equal(result.outputText, 'REVIEW_OK');
  assert.equal(result.employeeId, seeded.employeeId);
  assert.equal(result.employmentId, seeded.employmentId);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.actualCost, 0.125);

  const invocations = repository.listInvocations({ runId: String(run.id) });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.status, 'SUCCEEDED');
  assert.equal(invocations[0]?.attemptCount, 1);
  const usage = repository.listUsage({ employeeId: seeded.employeeId });
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.inputTokens, 100);
  assert.equal(usage[0]?.actualCost, 0.125);
  assert.equal(repository.getDuty(String(duty.id))?.lifecycle, 'COMPLETED');
  assert.equal(repository.getRun(String(run.id))?.status, 'COMPLETED');

  const dossier = repository.employeeDossier(seeded.employeeId);
  assert.equal(dossier?.currentWork.length, 0);
  assert.equal(dossier?.career.staffingSegments, 1);
  assert.equal(dossier?.career.usage.requests, 1);
  assert.equal(dossier?.career.usage.inputTokens, 100);
  assert.equal(dossier?.career.usage.actualCost, 0.125);
});

test('failed invocation records failure, blocks duty and never fabricates usage', async () => {
  const { db, repository, run, duty, service } = await make(
    new InvocationGateway('UPSTREAM_TIMEOUT'),
  );

  await assert.rejects(
    () => service.invokeDuty(String(duty.id), 'Review this change.'),
    /UPSTREAM_TIMEOUT/,
  );
  const invocations = repository.listInvocations({ runId: String(run.id) });
  assert.equal(invocations[0]?.status, 'FAILED');
  assert.equal(repository.listUsage({ runId: String(run.id) }).length, 0);
  assert.equal(repository.getDuty(String(duty.id))?.current_activity, 'BLOCKED');
  assert.equal(repository.getDuty(String(duty.id))?.lifecycle, 'ACTIVE');
  assert.equal(
    db.prepare('SELECT outcome,error_class FROM v2_invocation_attempts').get().outcome,
    'FAILED',
  );
  assert.equal(
    db.prepare('SELECT outcome,error_class FROM v2_invocation_attempts').get().error_class,
    'UPSTREAM_TIMEOUT',
  );
});
