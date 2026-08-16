import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GatewayExecutionPort,
  GatewayHealth,
  GatewayRequestUsageEvidence,
  GatewayRouteRef,
  GatewayUsagePage,
  GatewayUsagePort,
} from '../src/gateway/ports.js';
import { GatewayRegistry } from '../src/gateway/registry.js';
import { DispatchService } from '../src/v2/dispatch.js';
import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';
import { UsageReconciliationService } from '../src/v2/usageReconciliation.js';

const reference = {
  supplierSlug: 'planner-pool',
  supplierName: 'Planner Pool',
  supplierModelKey: 'deepseek-v4-flash',
  supplierModelName: 'DeepSeek V4 Flash',
  agreementRef: 'planner-pool-primary',
  agreementName: 'Planner Pool Primary Supply',
  gatewaySlug: 'fixture-usage',
  gatewayKind: 'OTHER' as const,
  gatewayName: 'Fixture Usage Gateway',
  workScopeSlug: 'development',
  workScopeName: 'Development',
  positionSlug: 'coding-review',
  positionName: 'Coding Reviewer',
  positionKind: 'REVIEWER',
  runtimeKind: 'CODEX',
  protocol: 'openai-responses' as const,
};

class UsageGateway implements GatewayExecutionPort, GatewayUsagePort {
  readonly gatewayId = 'fixture-usage';
  page: GatewayUsagePage = { evidence: [] };

  async resolveRoute(employmentId: string) {
    return {
      route: {
        gatewayId: this.gatewayId,
        employmentId,
        externalRouteRef: `employment:${employmentId}`,
        protocol: 'openai-responses' as const,
      },
      routable: true,
      reasons: ['FIXTURE_AVAILABLE'],
      observedAt: Date.now(),
    };
  }

  async getRouteHealth(_route: GatewayRouteRef): Promise<GatewayHealth> {
    return 'healthy';
  }

  async pullUsage(): Promise<GatewayUsagePage> {
    return this.page;
  }
}

async function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const seeded = repository.bootstrapReference(reference);
  const gateway = new UsageGateway();
  const registry = new GatewayRegistry([gateway]);
  const run = repository.createRun({
    workScopeId: seeded.workScopeId,
    title: 'Usage reconciliation',
    externalRunRef: 'usage-reconciliation-run',
  });
  const duty = repository.openDuty({
    runId: String(run.id),
    positionId: seeded.positionId,
    activity: 'VERIFYING',
  });
  await new DispatchService(repository, registry).dispatchDuty(String(duty.id));
  const context = repository.invocationContext(String(duty.id));
  assert.ok(context);
  const invocation = repository.startInvocation({ context });
  const attempt = repository.startInvocationAttempt({
    invocationId: String(invocation.id),
    context,
  });
  repository.completeInvocationAttempt({
    attemptId: String(attempt.id),
    gatewayRequestId: 'gw-request-1',
    externalDeploymentRef: 'deployment-a',
    latencyMs: 10,
  });
  return {
    db,
    repository,
    gateway,
    service: new UsageReconciliationService(repository, registry),
    seeded,
    context,
    invocation,
    attempt,
  };
}

function requestEvidence(
  overrides: Partial<GatewayRequestUsageEvidence> = {},
): GatewayRequestUsageEvidence {
  return {
    kind: 'request',
    gatewayId: 'fixture-usage',
    gatewayRequestId: 'gw-request-1',
    externalRouteRef: 'employment:any',
    externalDeploymentRef: 'deployment-a',
    model: 'deepseek-v4-flash',
    provider: 'fixture',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    reasoningTokens: 5,
    actualCost: 0.25,
    currency: 'USD',
    startedAt: 100,
    completedAt: 200,
    status: 'succeeded',
    metadata: { source: 'fixture' },
    ...overrides,
  };
}

test('request-level gateway evidence fills a missing attributable UsageEntry once', async () => {
  const { gateway, service, repository, context } = await make();
  gateway.page = { evidence: [requestEvidence({ externalRouteRef: context.externalRouteRef })] };

  const first = await service.reconcile('fixture-usage');
  const second = await service.reconcile('fixture-usage');

  assert.equal(first.requestUsageCreated, 1);
  assert.equal(second.requestMatched, 1);
  const usage = repository.listUsage({ runId: context.runId });
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 100);
  assert.equal(usage[0].actualCost, 0.25);
  assert.equal(usage[0].source, 'gateway-reconciliation:fixture-usage');
  assert.equal(repository.listGatewayUsageEvidence({ kind: 'request' }).length, 1);
});

test('aggregate gateway evidence stays outside the attributable request ledger', async () => {
  const { gateway, service, repository } = await make();
  gateway.page = {
    evidence: [
      {
        kind: 'aggregate',
        gatewayId: 'fixture-usage',
        aggregateKey: '30d:fixture:deepseek-v4-flash',
        window: '30d',
        generatedAt: 123,
        externalRouteRef: 'fixture/aggregate',
        model: 'deepseek-v4-flash',
        provider: 'fixture',
        requests: 9,
        failedRequests: 1,
        inputTokens: 900,
        outputTokens: 180,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        reasoningTokens: 50,
        actualCost: 2.5,
        currency: 'USD',
        metadata: { aggregate: true },
      },
    ],
  };

  const first = await service.reconcile('fixture-usage');
  const second = await service.reconcile('fixture-usage');

  assert.equal(first.aggregateCount, 1);
  assert.equal(second.aggregateCount, 1);
  assert.equal(repository.listUsage().length, 0);
  const evidence = repository.listGatewayUsageEvidence({ kind: 'aggregate' });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].requests, 9);
  assert.equal(evidence[0].actualCost, 2.5);
});

test('mismatching request evidence is audited without mutating the canonical ledger', async () => {
  const { gateway, service, repository, context, attempt } = await make();
  repository.recordUsage({
    attemptId: String(attempt.id),
    context,
    source: 'gateway:fixture-usage',
    usage: {
      inputTokens: 90,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      actualCost: 0.2,
      currency: 'USD',
    },
  });
  gateway.page = { evidence: [requestEvidence({ externalRouteRef: context.externalRouteRef })] };

  const result = await service.reconcile('fixture-usage');

  assert.equal(result.requestMismatched, 1);
  assert.equal(result.issues.length, 1);
  assert.equal((result.issues[0] as { code: string }).code, 'USAGE_LEDGER_MISMATCH');
  const usage = repository.listUsage({ runId: context.runId });
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 90);
  assert.equal(usage[0].actualCost, 0.2);
});

test('unmatched request evidence remains evidence and never fabricates a business request', async () => {
  const { gateway, service, repository } = await make();
  gateway.page = { evidence: [requestEvidence({ gatewayRequestId: 'unknown-request' })] };

  const result = await service.reconcile('fixture-usage');

  assert.equal(result.requestUnmatched, 1);
  assert.equal(repository.listUsage().length, 0);
  assert.equal(repository.listGatewayUsageEvidence({ kind: 'request' }).length, 1);
});
