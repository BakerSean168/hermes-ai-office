import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';
import { OrganizationRepository } from '../src/v2/organization.js';
import { V2Repository } from '../src/v2/repository.js';

const reference = {
  supplierSlug: 'planner-pool',
  supplierName: 'Planner Pool',
  supplierModelKey: 'deepseek-v4-flash',
  supplierModelName: 'DeepSeek V4 Flash',
  agreementRef: 'planner-pool-primary',
  agreementName: 'Planner Pool Primary Supply',
  gatewaySlug: 'fixture-org',
  gatewayKind: 'OTHER' as const,
  gatewayName: 'Fixture Org Gateway',
  workScopeSlug: 'development',
  workScopeName: 'Development',
  positionSlug: 'coding-review',
  positionName: 'Coding Reviewer',
  positionKind: 'REVIEWER',
  runtimeKind: 'CODEX',
  protocol: 'openai-responses' as const,
};

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const organization = new OrganizationRepository(repository);
  const seeded = repository.bootstrapReference(reference);
  return { db, repository, organization, seeded };
}

test('RUN_SCOPED positions are retired with their Run while standing positions and history remain', () => {
  const { db, repository, organization, seeded } = make();
  const role = organization.createRole({
    slug: 'researcher',
    name: 'Researcher',
    purpose: 'Explore delegated questions.',
  });
  const template = organization.createPositionTemplate({
    slug: 'hermes-research-subagent',
    name: 'Hermes Research Subagent',
    roleId: String(role.id),
    runtimePolicy: { kind: 'HERMES_SUBAGENT', requiredTools: ['web'] },
    lifecyclePolicy: 'RUN_SCOPED',
  });
  const run = repository.createRun({
    workScopeId: seeded.workScopeId,
    title: 'Run scoped organization test',
    externalRunRef: 'run-scoped-org-1',
  });
  const first = organization.instantiatePosition({
    templateId: String(template.id),
    workScopeId: seeded.workScopeId,
    originRunId: String(run.id),
    name: 'Researcher 01',
  });
  const second = organization.instantiatePosition({
    templateId: String(template.id),
    workScopeId: seeded.workScopeId,
    originRunId: String(run.id),
    name: 'Researcher 02',
  });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.slug, second.slug);

  const appointment = repository.getOrCreateCurrentAppointment({
    employeeId: seeded.employeeId,
    positionId: String(first.id),
    appointmentClass: 'PRIMARY',
    priority: 100,
  });
  const duty = repository.openDuty({
    runId: String(run.id),
    positionId: String(first.id),
    activity: 'RESEARCHING',
  });
  repository.completeDuty({ dutySessionId: String(duty.id), outcome: 'COMPLETED' });

  const runRow = db.prepare('SELECT * FROM v2_runs WHERE id=?').get(run.id) as Record<
    string,
    unknown
  >;
  assert.equal(runRow.status, 'COMPLETED');
  const retired = db
    .prepare(
      'SELECT id,lifecycle,origin_run_id,retired_at FROM v2_positions WHERE origin_run_id=? ORDER BY id',
    )
    .all(run.id) as Array<Record<string, unknown>>;
  assert.equal(retired.length, 2);
  assert.ok(retired.every((item) => item.lifecycle === 'RETIRED'));
  assert.ok(retired.every((item) => item.retired_at != null));
  assert.ok(retired.every((item) => item.origin_run_id === run.id));

  const endedAppointment = db
    .prepare('SELECT * FROM v2_appointments WHERE id=?')
    .get(appointment.id) as Record<string, unknown>;
  assert.equal(endedAppointment.status, 'ENDED');
  assert.ok(endedAppointment.effective_to != null);
  assert.equal(endedAppointment.ended_reason, 'RUN_COMPLETED');

  const standing = db
    .prepare('SELECT * FROM v2_positions WHERE id=?')
    .get(seeded.positionId) as Record<string, unknown>;
  assert.equal(standing.lifecycle, 'ACTIVE');
  assert.equal(standing.lifecycle_policy, 'STANDING');

  const projected = repository.listPositions().filter((item) => item.originRunId === run.id);
  assert.equal(projected.length, 2);
  assert.ok(projected.every((item) => item.lifecycle === 'RETIRED'));
  assert.ok(projected.every((item) => item.role?.id === role.id));
  assert.ok(projected.every((item) => item.template?.id === template.id));
  assert.ok(projected.every((item) => item.runtimePolicy.kind === 'HERMES_SUBAGENT'));
});

test('Position relations survive Employee replacement because topology belongs to positions', () => {
  const { repository, organization, seeded: employeeA } = make();
  const employeeB = repository.bootstrapReference({
    ...reference,
    supplierModelKey: 'claude-sonnet',
    supplierModelName: 'Claude Sonnet',
    agreementRef: 'planner-pool-secondary',
    agreementName: 'Planner Pool Secondary',
  });
  const leadRole = organization.createRole({ slug: 'profile-lead', name: 'Profile Lead' });
  const subagentRole = organization.createRole({ slug: 'researcher', name: 'Researcher' });
  const leadTemplate = organization.createPositionTemplate({
    slug: 'profile-lead',
    name: 'Profile Lead',
    roleId: String(leadRole.id),
    runtimePolicy: { kind: 'HERMES_PROFILE' },
    lifecyclePolicy: 'STANDING',
  });
  const childTemplate = organization.createPositionTemplate({
    slug: 'research-subagent',
    name: 'Research Subagent',
    roleId: String(subagentRole.id),
    runtimePolicy: { kind: 'HERMES_SUBAGENT' },
    lifecyclePolicy: 'STANDING',
  });
  const lead = organization.instantiatePosition({
    templateId: String(leadTemplate.id),
    workScopeId: employeeA.workScopeId,
    slug: 'profile-lead-seat',
    name: 'Development Lead',
  });
  const child = organization.instantiatePosition({
    templateId: String(childTemplate.id),
    workScopeId: employeeA.workScopeId,
    slug: 'research-seat',
    name: 'Development Researcher',
  });
  const relation = organization.createPositionRelation({
    fromPositionId: String(lead.id),
    toPositionId: String(child.id),
    relationType: 'SUPERVISES',
    source: 'MANUAL',
  });
  const firstAppointment = repository.getOrCreateCurrentAppointment({
    employeeId: employeeA.employeeId,
    positionId: String(lead.id),
  });
  repository.endAppointment(String(firstAppointment.id), 'EMPLOYEE_REPLACED');
  repository.getOrCreateCurrentAppointment({
    employeeId: employeeB.employeeId,
    positionId: String(lead.id),
  });

  const relations = organization.listPositionRelations();
  assert.equal(relations.length, 1);
  assert.equal(relations[0]?.id, relation.id);
  assert.equal(relations[0]?.fromPositionId, lead.id);
  assert.equal(relations[0]?.toPositionId, child.id);
  assert.equal(relations[0]?.relationType, 'SUPERVISES');

  const current = repository
    .listAppointments({ positionId: String(lead.id) })
    .filter((item) => item.status === 'CURRENT');
  assert.equal(current.length, 1);
  assert.equal(current[0]?.employeeId, employeeB.employeeId);
  assert.equal(organization.topology().relations.length, 1);
});
