import assert from 'node:assert/strict';
import test from 'node:test';

import { RepositoryGatewayBindingSource, V2Repository } from '../src/v2/repository.js';
import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';

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

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  return { db, repository: new V2Repository(db) };
}

test('reference bootstrap is idempotent across repeated runs', () => {
  const { db, repository } = make();
  const first = repository.bootstrapReference(reference);
  const second = repository.bootstrapReference(reference);

  assert.deepEqual(second, first);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM v2_employees').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM v2_employments').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM v2_appointments').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM v2_gateway_bindings').get().count, 1);
  assert.ok(first.externalRouteRef.startsWith('employment:empl_'));
});

test('a later Agreement creates another Employment but preserves Employee career identity', () => {
  const { repository } = make();
  const first = repository.bootstrapReference(reference);
  const second = repository.bootstrapReference({
    ...reference,
    agreementRef: 'planner-pool-secondary',
    agreementName: 'Planner Pool Secondary Supply',
  });

  assert.equal(second.employeeId, first.employeeId);
  assert.notEqual(second.agreementId, first.agreementId);
  assert.notEqual(second.employmentId, first.employmentId);
  assert.notEqual(second.externalRouteRef, first.externalRouteRef);
  assert.equal(second.appointmentId, first.appointmentId);

  const employees = repository.listEmployees();
  assert.equal(employees.length, 1);
  assert.equal(employees[0]?.currentEmploymentCount, 2);
  assert.equal(employees[0]?.currentAppointmentCount, 1);
  assert.equal(employees[0]?.currentDutyCount, 0);

  const dossier = repository.employeeDossier(first.employeeId);
  assert.equal(dossier?.cooperation.state, 'EMPLOYED');
  assert.equal(dossier?.cooperation.currentEmployments.length, 2);
  assert.equal(dossier?.organization.currentAppointments.length, 1);
  assert.equal(dossier?.currentWork.length, 0);
});

test('workforce projection separates gateway-observed aggregates from verified employee usage', () => {
  const { repository } = make();
  const seeded = repository.bootstrapReference(reference);
  repository.upsertGatewayUsageEvidence(seeded.gatewayId, {
    kind: 'aggregate',
    gatewayId: reference.gatewaySlug,
    aggregateKey: '30d:openai-compatible-planner-pool:deepseek-v4-flash',
    window: '30d',
    generatedAt: 1_000,
    externalRouteRef: 'cpa/channel/planner-pool/model/deepseek-v4-flash',
    model: 'deepseek-v4-flash',
    provider: 'openai-compatible-planner-pool',
    requests: 4,
    failedRequests: 1,
    inputTokens: 120,
    outputTokens: 24,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    reasoningTokens: 8,
    actualCost: 0.12,
    currency: 'USD',
  });

  const projection = repository.workforceProjection();
  const employee = projection.employees[0];
  assert.equal(employee?.career.usage.requests, 0);
  assert.equal(employee?.career.observedUsage.requests, 4);
  assert.equal(employee?.career.observedUsage.failedRequests, 1);
  assert.equal(employee?.career.observedUsage.successfulRequests, 3);
  assert.equal(employee?.career.observedUsage.inputTokens, 120);
  assert.equal(employee?.career.observedUsage.attributionBases[0], 'SUPPLIER_HINT');
  assert.equal(employee?.career.observedUsage.authoritative, false);
  assert.equal(projection.summary.observedUsage.attributedRequests, 4);
  assert.equal(projection.summary.observedUsage.unattributedRequests, 0);
});

test('gateway aggregate usage stays unattributed when a model maps to multiple employees', () => {
  const { repository } = make();
  const first = repository.bootstrapReference(reference);
  repository.bootstrapReference({
    ...reference,
    supplierSlug: 'secondary-pool',
    supplierName: 'Secondary Pool',
    agreementRef: 'secondary-pool-primary',
    agreementName: 'Secondary Pool Primary Supply',
  });
  repository.upsertGatewayUsageEvidence(first.gatewayId, {
    kind: 'aggregate',
    gatewayId: reference.gatewaySlug,
    aggregateKey: '30d:generic:deepseek-v4-flash',
    window: '30d',
    generatedAt: 2_000,
    externalRouteRef: 'cpa/channel/generic/model/deepseek-v4-flash',
    model: 'deepseek-v4-flash',
    provider: 'generic',
    requests: 7,
    failedRequests: 2,
    inputTokens: 77,
    outputTokens: 11,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    actualCost: 0,
    currency: 'USD',
  });

  const projection = repository.workforceProjection();
  assert.equal(
    projection.employees.every(
      (employee: Record<string, any>) => employee.career.observedUsage === null,
    ),
    true,
  );
  assert.equal(projection.summary.observedUsage.attributedRequests, 0);
  assert.equal(projection.summary.observedUsage.unattributedRequests, 7);
  assert.equal(projection.summary.observedUsage.unattributedEvidenceCount, 1);
});

test('an explicitly classified route disambiguates aggregate usage for duplicate model identities', () => {
  const { repository } = make();
  const first = repository.bootstrapReference(reference);
  repository.bootstrapReference({
    ...reference,
    supplierSlug: 'secondary-pool',
    supplierName: 'Secondary Pool',
    agreementRef: 'secondary-pool-primary',
    agreementName: 'Secondary Pool Primary Supply',
  });
  const route = 'cpa/channel/planner-pool/model/deepseek-v4-flash';
  repository.upsertChannelObservation({
    gatewayId: first.gatewayId,
    supplyAgreementId: first.agreementId,
    externalRouteRef: route,
    name: 'planner-pool',
    protocol: 'openai-responses',
    health: 'HEALTHY',
    supplierHint: 'planner-pool',
    supplierModelHint: 'deepseek-v4-flash',
    observedAt: 3_000,
  });
  repository.upsertGatewayUsageEvidence(first.gatewayId, {
    kind: 'aggregate',
    gatewayId: reference.gatewaySlug,
    aggregateKey: '30d:generic:deepseek-v4-flash',
    window: '30d',
    generatedAt: 3_000,
    externalRouteRef: route,
    model: 'deepseek-v4-flash',
    provider: 'generic',
    requests: 9,
    failedRequests: 0,
    inputTokens: 90,
    outputTokens: 18,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    actualCost: 0.09,
    currency: 'USD',
  });

  const projection = repository.workforceProjection();
  const selected = projection.employees.find(
    (employee: Record<string, any>) => employee.id === first.employeeId,
  );
  const other = projection.employees.find(
    (employee: Record<string, any>) => employee.id !== first.employeeId,
  );
  assert.equal(selected?.career.observedUsage.requests, 9);
  assert.equal(selected?.career.observedUsage.attributionBases[0], 'CLASSIFIED_ROUTE');
  assert.equal(other?.career.observedUsage, null);
});

test('repository gateway binding source returns gateway-neutral Employment route', async () => {
  const { repository } = make();
  const seeded = repository.bootstrapReference(reference);
  const source = new RepositoryGatewayBindingSource(repository, 'litellm-reference');

  assert.deepEqual(await source.findByEmploymentId(seeded.employmentId), {
    gatewayId: 'litellm-reference',
    employmentId: seeded.employmentId,
    externalRouteRef: seeded.externalRouteRef,
    protocol: 'openai-responses',
  });
  assert.equal(await source.findByEmploymentId('empl_missing'), null);
});

test('workforce projection and event history are derived from canonical facts', () => {
  const { repository } = make();
  const seeded = repository.bootstrapReference(reference);
  const projection = repository.workforceProjection();

  assert.equal(projection.summary.employees, 1);
  assert.equal(projection.summary.employed, 1);
  assert.equal(projection.summary.dormant, 0);
  assert.equal(projection.employees[0]?.id, seeded.employeeId);
  assert.equal(projection.gateways[0]?.slug, 'litellm-reference');
  assert.equal(projection.gateways[0]?.activeBindings, 1);
  assert.equal(projection.employees[0]?.currentAppointments.length, 1);
  assert.equal(projection.employees[0]?.currentAppointments[0].positionSlug, 'coding-review');
  assert.deepEqual(projection.employees[0]?.currentWork, []);
  assert.equal(projection.employees[0]?.career.usage.requests, 0);
  assert.equal(projection.summary.requests, 0);

  const events = repository.eventsAfter(0, 100);
  assert.ok(events.some((event) => event.type === 'employee.discovered'));
  assert.ok(events.some((event) => event.type === 'employment.started'));
  assert.ok(events.some((event) => event.type === 'appointment.started'));
  assert.equal(
    events.every((event) => typeof event.seq === 'number'),
    true,
  );
});
