import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayExecutionPort, GatewayHealth, GatewayRouteRef } from '../src/gateway/ports.js';
import { GatewayRegistry } from '../src/gateway/registry.js';
import { openDb } from '../src/db.mjs';
import { DispatchService } from '../src/v2/dispatch.js';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';
import { SupplyRepository } from '../src/v2/supply.js';

const reference = {
  supplierSlug: 'opencode',
  supplierName: 'OpenCode',
  supplierModelKey: 'deepseek-v4-flash',
  supplierModelName: 'DeepSeek V4 Flash',
  agreementRef: 'primary-subscription',
  agreementName: 'Primary Subscription',
  gatewaySlug: 'fixture',
  gatewayKind: 'OTHER' as const,
  gatewayName: 'Fixture Gateway',
  workScopeSlug: 'development',
  workScopeName: 'Development',
  positionSlug: 'coding-review',
  positionName: 'Coding Reviewer',
  positionKind: 'REVIEWER',
  runtimeKind: 'CODEX',
  protocol: 'openai-responses' as const,
};

class FixtureGateway implements GatewayExecutionPort {
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
      reasons: ['FIXTURE_AVAILABLE'],
      observedAt: Date.now(),
    };
  }
  async getRouteHealth(_route: GatewayRouteRef): Promise<GatewayHealth> {
    return 'healthy';
  }
}

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const supply = new SupplyRepository(repository);
  const seeded = repository.bootstrapReference(reference);
  return { db, repository, supply, seeded };
}

async function openDuty(
  repository: V2Repository,
  seeded: ReturnType<V2Repository['bootstrapReference']>,
) {
  const run = repository.createRun({
    workScopeId: seeded.workScopeId,
    title: 'Capacity test',
  });
  return repository.openDuty({ runId: String(run.id), positionId: seeded.positionId });
}

test('Plan and ModelOffering enrich Employment without changing Employee identity', () => {
  const { repository, supply, seeded } = make();
  const plan = supply.getOrCreatePlan({
    supplierId: seeded.supplierId,
    slug: 'go',
    name: 'OpenCode Go',
    commercialType: 'SUBSCRIPTION',
  });
  supply.assignPlanToAgreement(seeded.agreementId, String(plan.id));
  const offering = supply.getOrCreateModelOffering({
    supplierId: seeded.supplierId,
    supplierModelId: seeded.supplierModelId,
    planId: String(plan.id),
    supplyAgreementId: seeded.agreementId,
    advertisedCapabilities: ['coding', 'review'],
    protocolOptions: ['openai-responses'],
  });
  supply.assignOfferingToEmployment(seeded.employmentId, String(offering.id));

  assert.equal(supply.listPlans(seeded.supplierId).length, 1);
  assert.equal(supply.listModelOfferings({ agreementId: seeded.agreementId }).length, 1);
  assert.equal(supply.listSupplyAgreements(seeded.supplierId)[0]?.planId, plan.id);
  const employment = repository.getEmployment(seeded.employmentId);
  assert.equal(employment?.model_offering_id, offering.id);
  assert.equal(repository.listEmployees().length, 1);
  assert.equal(repository.listEmployees()[0]?.id, seeded.employeeId);
});

test('exhausted shared CapacityPool blocks an Employment route without disqualifying Employee', async () => {
  const { repository, supply, seeded } = make();
  supply.upsertCapacityPool({
    supplyAgreementId: seeded.agreementId,
    name: 'monthly-requests',
    dimension: 'REQUESTS',
    limit: 100,
    remaining: 0,
    unit: 'requests',
    source: 'TEST_AUTHORITATIVE',
  });
  const duty = await openDuty(repository, seeded);
  const dispatch = await new DispatchService(
    repository,
    new GatewayRegistry([new FixtureGateway()]),
    supply,
  ).dispatchDuty(String(duty.id));

  assert.equal(dispatch.selected, null);
  const candidate = (dispatch.candidateResults as Array<Record<string, unknown>>)[0]!;
  assert.equal(candidate.qualified, true);
  assert.equal(candidate.eligible, true);
  assert.equal(candidate.routable, false);
  const route = (candidate.routes as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(route.reasons, ['CAPACITY_REQUESTS_EXHAUSTED']);
  assert.equal((route.capacity as { available: boolean }).available, false);
});

test('capacity recovery restores routability without recreating Employee or Appointment', async () => {
  const { repository, supply, seeded } = make();
  supply.upsertCapacityPool({
    supplyAgreementId: seeded.agreementId,
    name: 'monthly-requests',
    dimension: 'REQUESTS',
    limit: 100,
    remaining: 0,
    unit: 'requests',
    source: 'TEST_AUTHORITATIVE',
  });
  const firstDuty = await openDuty(repository, seeded);
  const service = new DispatchService(
    repository,
    new GatewayRegistry([new FixtureGateway()]),
    supply,
  );
  const blocked = await service.dispatchDuty(String(firstDuty.id));
  assert.equal(blocked.selected, null);
  repository.completeDuty({ dutySessionId: String(firstDuty.id), outcome: 'CANCELLED' });

  supply.upsertCapacityPool({
    supplyAgreementId: seeded.agreementId,
    name: 'monthly-requests',
    dimension: 'REQUESTS',
    limit: 100,
    remaining: 42,
    unit: 'requests',
    source: 'TEST_AUTHORITATIVE',
  });
  const secondDuty = await openDuty(repository, seeded);
  const selected = await service.dispatchDuty(String(secondDuty.id));

  assert.equal((selected.selected as { employeeId: string }).employeeId, seeded.employeeId);
  assert.equal(repository.listEmployees().length, 1);
  assert.equal(repository.listAppointments({ employeeId: seeded.employeeId }).length, 1);
});

test('unknown remaining capacity is visible but does not fabricate exhaustion', () => {
  const { supply, seeded } = make();
  supply.upsertCapacityPool({
    supplyAgreementId: seeded.agreementId,
    name: 'unknown-token-pool',
    dimension: 'TOKENS',
    limit: 1_000_000,
    source: 'PARTIAL_EVIDENCE',
  });
  const state = supply.capacityForAgreement(seeded.agreementId);
  assert.equal(state.available, true);
  assert.equal(state.pools[0]?.remaining, null);
  assert.deepEqual(state.reasons, []);
});
