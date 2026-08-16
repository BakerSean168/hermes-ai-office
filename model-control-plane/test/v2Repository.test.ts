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

  const events = repository.eventsAfter(0, 100);
  assert.ok(events.some((event) => event.type === 'employee.discovered'));
  assert.ok(events.some((event) => event.type === 'employment.started'));
  assert.ok(events.some((event) => event.type === 'appointment.started'));
  assert.equal(
    events.every((event) => typeof event.seq === 'number'),
    true,
  );
});
