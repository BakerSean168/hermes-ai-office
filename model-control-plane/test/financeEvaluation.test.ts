import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayExecutionPort, GatewayHealth, GatewayRouteRef } from '../src/gateway/ports.js';
import { GatewayRegistry } from '../src/gateway/registry.js';
import { openDb } from '../src/db.mjs';
import { DispatchService } from '../src/v2/dispatch.js';
import { FinanceRepository } from '../src/v2/finance.js';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository, type InvocationContext } from '../src/v2/repository.js';
import { SupplyRepository } from '../src/v2/supply.js';

const reference = {
  supplierSlug: 'planner-pool',
  supplierName: 'Planner Pool',
  supplierModelKey: 'deepseek-v4-flash',
  supplierModelName: 'DeepSeek V4 Flash',
  agreementRef: 'planner-pool-primary',
  agreementName: 'Planner Pool Primary Supply',
  gatewaySlug: 'fixture-finance',
  gatewayKind: 'OTHER' as const,
  gatewayName: 'Fixture Finance Gateway',
  workScopeSlug: 'development',
  workScopeName: 'Development',
  positionSlug: 'coding-review',
  positionName: 'Coding Reviewer',
  positionKind: 'REVIEWER',
  runtimeKind: 'CODEX',
  protocol: 'openai-responses' as const,
};

class FixtureGateway implements GatewayExecutionPort {
  readonly gatewayId = 'fixture-finance';

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
}

async function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const supply = new SupplyRepository(repository);
  const finance = new FinanceRepository(repository);
  const seeded = repository.bootstrapReference(reference);
  const run = repository.createRun({ workScopeId: seeded.workScopeId, title: 'Finance fixture' });
  const duty = repository.openDuty({ runId: String(run.id), positionId: seeded.positionId });
  await new DispatchService(
    repository,
    new GatewayRegistry([new FixtureGateway()]),
    supply,
  ).dispatchDuty(String(duty.id));
  const context = repository.invocationContext(String(duty.id));
  assert.ok(context);
  return { db, repository, supply, finance, seeded, run, duty, context };
}

function recordUsage(
  repository: V2Repository,
  context: InvocationContext,
  sequence: number,
  inputTokens: number,
  outputTokens: number,
) {
  const invocation = repository.startInvocation({ context });
  const attempt = repository.startInvocationAttempt({
    invocationId: String(invocation.id),
    context,
  });
  repository.completeInvocationAttempt({
    attemptId: String(attempt.id),
    gatewayRequestId: `finance-request-${sequence}`,
    externalDeploymentRef: 'fixture-deployment',
    latencyMs: 10,
  });
  const usage = repository.recordUsage({
    attemptId: String(attempt.id),
    context,
    source: 'fixture-finance',
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      actualCost: 0,
      currency: 'USD',
    },
  });
  repository.completeInvocation({ invocationId: String(invocation.id), status: 'SUCCEEDED' });
  return usage;
}

test('reference pricing is versioned and never rewrites closed UsageEntry facts', async () => {
  const { db, repository, finance, seeded, context } = await make();
  recordUsage(repository, context, 1, 10, 2);
  recordUsage(repository, context, 2, 20, 4);

  const first = finance.createReferencePrice({
    supplierModelId: seeded.supplierModelId,
    name: 'Reference A',
    inputPerMillion: 1_000_000,
    outputPerMillion: 2_000_000,
    source: 'TEST_REFERENCE',
    effectiveFrom: 0,
  });
  const firstResult = finance.applyReferencePrice(String(first.id));
  assert.equal(firstResult.marketValue, 42);
  assert.equal(repository.employeeDossier(seeded.employeeId)?.career.usage.marketValue, 42);

  const rawBefore = db
    .prepare('SELECT market_value,allocated_cost FROM v2_usage_entries ORDER BY id')
    .all();
  assert.deepEqual(
    rawBefore.map((item) => [item.market_value, item.allocated_cost]),
    [
      [0, 0],
      [0, 0],
    ],
  );

  const second = finance.createReferencePrice({
    supplierModelId: seeded.supplierModelId,
    name: 'Reference B',
    inputPerMillion: 2_000_000,
    outputPerMillion: 4_000_000,
    source: 'TEST_REFERENCE',
    effectiveFrom: 0,
  });
  const secondResult = finance.applyReferencePrice(String(second.id));
  assert.equal(secondResult.marketValue, 84);
  assert.equal(repository.employeeDossier(seeded.employeeId)?.career.usage.marketValue, 84);

  assert.equal(
    Number(db.prepare('SELECT COUNT(*) count FROM v2_usage_market_valuations').get()?.count ?? 0),
    4,
  );
  assert.equal(
    Number(
      db
        .prepare(
          'SELECT COUNT(*) count FROM v2_usage_market_valuations WHERE superseded_at IS NULL',
        )
        .get()?.count ?? 0,
    ),
    2,
  );
  const rawAfter = db.prepare('SELECT market_value FROM v2_usage_entries').all();
  assert.ok(rawAfter.every((item) => Number(item.market_value) === 0));
});

test('subscription allocation is append-only and a replacement run does not double-count', async () => {
  const { db, repository, supply, finance, seeded, context } = await make();
  recordUsage(repository, context, 1, 10, 2);
  recordUsage(repository, context, 2, 20, 4);
  supply.updateAgreementCommercialTerms(seeded.agreementId, {
    fixedCost: 12,
    currency: 'USD',
    billingPeriod: 'month',
  });

  const periodStart = 0;
  const periodEnd = Date.now() + 60_000;
  const first = finance.allocateAgreementCost({
    supplyAgreementId: seeded.agreementId,
    periodStart,
    periodEnd,
    basis: 'TOKENS',
  });
  assert.equal(Number(first.allocated_total), 12);
  assert.equal(repository.employeeDossier(seeded.employeeId)?.career.usage.allocatedCost, 12);

  const second = finance.allocateAgreementCost({
    supplyAgreementId: seeded.agreementId,
    periodStart,
    periodEnd,
    basis: 'TOKENS',
    fixedCost: 18,
  });
  assert.equal(Number(second.allocated_total), 18);
  assert.equal(repository.employeeDossier(seeded.employeeId)?.career.usage.allocatedCost, 18);
  assert.equal(
    Number(db.prepare('SELECT COUNT(*) count FROM v2_cost_allocation_entries').get()?.count ?? 0),
    4,
  );
  assert.equal(
    Number(
      db
        .prepare('SELECT COUNT(*) count FROM v2_cost_allocation_runs WHERE superseded_at IS NULL')
        .get()?.count ?? 0,
    ),
    1,
  );
  assert.ok(
    db
      .prepare('SELECT allocated_cost FROM v2_usage_entries')
      .all()
      .every((item) => Number(item.allocated_cost) === 0),
  );
});

test('evaluation evidence is role-aware through Position and aggregates numeric dimensions', async () => {
  const { finance, seeded } = await make();
  finance.recordEvaluation({
    subjectType: 'DutySession',
    subjectId: 'duty-a',
    employeeId: seeded.employeeId,
    positionId: seeded.positionId,
    dimensions: { correctness: 80, review_quality: 90, accepted: true },
    source: 'TEST_EVALUATOR',
  });
  finance.recordEvaluation({
    subjectType: 'DutySession',
    subjectId: 'duty-b',
    employeeId: seeded.employeeId,
    positionId: seeded.positionId,
    dimensions: { correctness: 100, review_quality: 70 },
    source: 'TEST_EVALUATOR',
  });

  const performance = finance.performanceByPosition(seeded.employeeId);
  assert.equal(performance.length, 1);
  assert.equal(performance[0]?.positionId, seeded.positionId);
  assert.deepEqual(performance[0]?.dimensions, {
    correctness: { count: 2, average: 90 },
    review_quality: { count: 2, average: 80 },
  });
  assert.equal(finance.listEvaluations({ employeeId: seeded.employeeId }).length, 2);
});
