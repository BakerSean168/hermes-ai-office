import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';
import { RuntimeAccessRepository } from '../src/v2/runtimeAccess.js';
import { SupplyRepository } from '../src/v2/supply.js';

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const supply = new SupplyRepository(repository);
  const seeded = repository.bootstrapReference({
    supplierSlug: 'opencode',
    supplierName: 'OpenCode',
    supplierModelKey: 'deepseek-v4-flash',
    supplierModelName: 'DeepSeek V4 Flash',
    agreementRef: 'opencode-go-primary',
    agreementName: 'OpenCode Go / Primary subscription',
    gatewaySlug: 'litellm-reference',
    gatewayKind: 'LITELLM',
    gatewayName: 'LiteLLM Reference Gateway',
    workScopeSlug: 'development',
    workScopeName: 'Development',
    positionSlug: 'coding-review',
    positionName: 'Coding Reviewer',
    positionKind: 'REVIEWER',
    runtimeKind: 'CODEX',
    protocol: 'openai-responses',
  });
  return { repository, supply, seeded };
}

test('Supply projection exposes HR supplier hierarchy without assigning unmapped gateway evidence', () => {
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
    protocolOptions: ['openai-responses'],
  });
  supply.assignOfferingToEmployment(seeded.employmentId, String(offering.id));
  const runtimeAccess = new RuntimeAccessRepository(repository);
  runtimeAccess.upsert({
    employmentId: seeded.employmentId,
    runtimeKind: 'CODEX',
    adapterKind: 'NATIVE_CONFIG',
    providerRef: 'hao-opencode-test',
    modelRef: 'deepseek-v4-flash',
    profileRef: 'hao-reviewer',
    baseUrl: 'https://example.test/v1',
    credentialRef: 'TEST_PROVIDER_API_KEY',
    protocol: 'openai-responses',
  });
  supply.upsertCapacityPool({
    supplyAgreementId: seeded.agreementId,
    name: 'monthly-requests',
    dimension: 'REQUESTS',
    limit: 1_000,
    remaining: 600,
    unit: 'requests',
    source: 'TEST',
  });

  repository.upsertChannelObservation({
    gatewayId: seeded.gatewayId,
    supplyAgreementId: seeded.agreementId,
    externalRouteRef: 'opencode-go/deepseek-v4-flash',
    name: 'OpenCode Go',
    protocol: 'openai-responses',
    health: 'HEALTHY',
    observedAt: Date.now(),
  });
  repository.upsertChannelObservation({
    gatewayId: seeded.gatewayId,
    externalRouteRef: 'technical/unmapped/model-x',
    name: 'Technical route only',
    protocol: 'openai-responses',
    health: 'UNKNOWN',
    observedAt: Date.now(),
  });

  const projection = supply.projection();
  assert.deepEqual(projection.summary, {
    suppliers: 1,
    activeSuppliers: 1,
    workforceSources: 1,
    internalSources: 0,
    supplierModels: 1,
    employees: 1,
    internalEmployees: 0,
    plans: 1,
    agreements: 1,
    activeAgreements: 1,
    currentEmployments: 1,
    capacityPools: 1,
    activeBindings: 1,
    runtimeAccessProfiles: 1,
    nativeRuntimeAccessProfiles: 1,
    gatewayRuntimeAccessProfiles: 0,
    gateways: 1,
    unmappedChannels: 1,
  });

  const supplier = (projection.suppliers as Array<Record<string, unknown>>)[0]!;
  assert.equal(supplier.name, 'OpenCode');
  assert.equal((supplier.plans as unknown[]).length, 1);
  assert.equal(
    (supplier.employees as Array<Record<string, unknown>>)[0]?.displayName,
    'DeepSeek V4 Flash @ OpenCode',
  );
  const agreement = (supplier.agreements as Array<Record<string, unknown>>)[0]!;
  assert.equal(agreement.planName, 'OpenCode Go');
  assert.equal((agreement.employments as unknown[]).length, 1);
  const employment = (agreement.employments as Array<Record<string, unknown>>)[0]!;
  const access = (employment.runtimeAccess as Array<Record<string, unknown>>)[0]!;
  assert.equal(access.adapterKind, 'NATIVE_CONFIG');
  assert.equal(access.runtimeKind, 'CODEX');
  assert.equal(access.profileRef, 'hao-reviewer');
  assert.equal((agreement.capacityPools as unknown[]).length, 1);
  assert.equal((agreement.channels as Array<Record<string, unknown>>)[0]?.name, 'OpenCode Go');
  const channelInfrastructure = projection.channelInfrastructure as {
    gateways: Array<{ name: string; groups: Array<Record<string, unknown>> }>;
    count: number;
  };
  assert.equal(channelInfrastructure.count, 2);
  assert.equal(channelInfrastructure.gateways.length, 1);
  assert.equal(channelInfrastructure.gateways[0]?.groups.length, 2);
  assert.equal(
    channelInfrastructure.gateways[0]?.groups.find((group) => group.channelName === 'OpenCode Go')
      ?.classification,
    'MAPPED',
  );
  assert.equal(
    channelInfrastructure.gateways[0]?.groups.find(
      (group) => group.channelName === 'Technical route only',
    )?.classification,
    'UNMAPPED',
  );
  assert.equal((projection.unmappedInfrastructure as Record<string, unknown>).count, 1);
  const groups = (projection.unmappedInfrastructure as { groups: Array<Record<string, unknown>> })
    .groups;
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.channelName, 'Technical route only');
  assert.deepEqual(groups[0]?.modelHints, []);
});
