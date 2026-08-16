import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayExecutionPort, GatewayHealth, GatewayRouteRef } from '../src/gateway/ports.js';
import { GatewayRegistry } from '../src/gateway/registry.js';
import { openDb } from '../src/db.mjs';
import { DispatchService } from '../src/v2/dispatch.js';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';
import { StaffingRepository } from '../src/v2/staffing.js';
import { SupplyRepository } from '../src/v2/supply.js';

const reference = {
  supplierSlug: 'planner-pool',
  supplierName: 'Planner Pool',
  supplierModelKey: 'deepseek-v4-flash',
  supplierModelName: 'DeepSeek V4 Flash',
  agreementRef: 'planner-pool-primary',
  agreementName: 'Planner Pool Primary Supply',
  gatewaySlug: 'fixture-staffing',
  gatewayKind: 'OTHER' as const,
  gatewayName: 'Fixture Staffing Gateway',
  workScopeSlug: 'development',
  workScopeName: 'Development',
  positionSlug: 'coding-review',
  positionName: 'Coding Reviewer',
  positionKind: 'REVIEWER',
  runtimeKind: 'CODEX',
  protocol: 'openai-responses' as const,
};

class FixtureGateway implements GatewayExecutionPort {
  readonly gatewayId = 'fixture-staffing';
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
  const staffing = new StaffingRepository(repository);
  const seeded = repository.bootstrapReference(reference);
  const gateway = new FixtureGateway();
  const dispatch = new DispatchService(
    repository,
    new GatewayRegistry([gateway]),
    supply,
    staffing,
  );
  return { db, repository, supply, staffing, seeded, gateway, dispatch };
}

async function openDuty(
  repository: V2Repository,
  workScopeId: string,
  positionId: string,
  title: string,
) {
  const run = repository.createRun({ workScopeId, title });
  const duty = repository.openDuty({ runId: String(run.id), positionId });
  return { run, duty };
}

test('qualification composes Supplier, SupplierModel and Employee claims conservatively', async () => {
  const { repository, staffing, seeded, dispatch } = make();
  const coding = staffing.createCapabilityDefinition({
    slug: 'coding',
    name: 'Coding',
    valueType: 'NUMERIC',
    unit: 'score',
  });
  staffing.addCapabilityClaim({
    subjectType: 'SUPPLIER',
    subjectId: seeded.supplierId,
    capabilityId: String(coding.id),
    value: 80,
    source: 'MANUAL',
    observedAt: 100,
  });
  staffing.addCapabilityClaim({
    subjectType: 'SUPPLIER_MODEL',
    subjectId: seeded.supplierModelId,
    capabilityId: String(coding.id),
    value: 90,
    source: 'MEASURED',
    observedAt: 200,
  });
  staffing.addCapabilityClaim({
    subjectType: 'EMPLOYEE',
    subjectId: seeded.employeeId,
    capabilityId: String(coding.id),
    value: 95,
    source: 'MEASURED',
    observedAt: 300,
  });
  const requirements = staffing.createRequirementSet({
    name: 'Senior reviewer v1',
    requirements: [{ capability: 'coding', operator: 'GTE', value: 85, hard: true }],
  });
  staffing.assignRequirementSet(seeded.positionId, String(requirements.id));

  const first = staffing.assessQualification(seeded.employeeId, seeded.positionId);
  assert.equal(first.effectiveCapabilities.coding?.value, 80);
  assert.equal(first.qualified, false);
  assert.ok(first.reasons.includes('REQUIREMENT_coding_FAILED'));

  const { duty } = await openDuty(
    repository,
    seeded.workScopeId,
    seeded.positionId,
    'Blocked by supplier qualification',
  );
  const blocked = await dispatch.dispatchDuty(String(duty.id));
  assert.equal(blocked.selected, null);
  const blockedCandidate = (blocked.candidateResults as Array<Record<string, unknown>>)[0]!;
  assert.equal(blockedCandidate.qualified, false);
  assert.equal(blockedCandidate.eligible, false);

  staffing.addCapabilityClaim({
    subjectType: 'SUPPLIER',
    subjectId: seeded.supplierId,
    capabilityId: String(coding.id),
    value: 100,
    source: 'MANUAL',
    observedAt: 400,
  });
  const second = staffing.assessQualification(seeded.employeeId, seeded.positionId);
  assert.equal(second.effectiveCapabilities.coding?.value, 90);
  assert.equal(second.qualified, true);

  const selected = await dispatch.dispatchDuty(String(duty.id), {
    trigger: 'QUALIFICATION_CHANGED',
  });
  assert.equal((selected.selected as { employeeId: string }).employeeId, seeded.employeeId);
  assert.ok(staffing.listQualificationAssessments({ employeeId: seeded.employeeId }).length >= 4);
});

test('StaffingRule can appoint one Employee to every Profile Lead position across WorkScopes', () => {
  const { db, repository, staffing, seeded } = make();
  const scopeA = repository.getOrCreateWorkScope({ slug: 'profile-a', name: 'Profile A' });
  const scopeB = repository.getOrCreateWorkScope({ slug: 'profile-b', name: 'Profile B' });
  const positionA = repository.getOrCreatePosition({
    workScopeId: String(scopeA.id),
    slug: 'lead',
    name: 'Profile A Lead',
    kind: 'PROFILE_LEAD',
    runtimeKind: 'HERMES_PROFILE',
  });
  const positionB = repository.getOrCreatePosition({
    workScopeId: String(scopeB.id),
    slug: 'lead',
    name: 'Profile B Lead',
    kind: 'PROFILE_LEAD',
    runtimeKind: 'HERMES_PROFILE',
  });
  const rule = staffing.createStaffingRule({
    name: 'DeepSeek leads all profiles',
    employeeSelector: { employeeIds: [seeded.employeeId] },
    positionSelector: { kinds: ['PROFILE_LEAD'] },
    appointmentClass: 'PRIMARY',
    priority: 90,
    provenance: { policy: 'all-profiles' },
  });

  const result = staffing.materializeStaffingRule(String(rule.id));
  assert.equal(result.matchedEmployees, 1);
  assert.equal(result.matchedPositions, 2);
  assert.equal(result.created, 2);
  assert.equal(result.existing, 0);

  const appointed = repository
    .listAppointments({ employeeId: seeded.employeeId })
    .filter((item) => [positionA.id, positionB.id].includes(item.positionId));
  assert.equal(appointed.length, 2);
  const sourceRows = db
    .prepare(
      `SELECT source,source_rule_id FROM v2_appointments
       WHERE employee_id=? AND position_id IN (?,?) ORDER BY position_id`,
    )
    .all(seeded.employeeId, positionA.id, positionB.id);
  assert.ok(sourceRows.every((item) => item.source === 'RULE' && item.source_rule_id === rule.id));

  const replay = staffing.materializeStaffingRule(String(rule.id));
  assert.equal(replay.created, 0);
  assert.equal(replay.existing, 2);
});

test('hard separation-of-duties constraint forces Reviewer away from the active Developer employee', async () => {
  const { repository, staffing, seeded: employeeA, dispatch } = make();
  const employeeB = repository.bootstrapReference({
    ...reference,
    supplierModelKey: 'claude-sonnet',
    supplierModelName: 'Claude Sonnet',
    agreementRef: 'planner-pool-secondary',
    agreementName: 'Planner Pool Secondary Supply',
  });
  const developerPosition = repository.getOrCreatePosition({
    workScopeId: employeeA.workScopeId,
    slug: 'coding-developer',
    name: 'Coding Developer',
    kind: 'DEVELOPER',
    runtimeKind: 'CODEX',
  });
  repository.getOrCreateCurrentAppointment({
    employeeId: employeeA.employeeId,
    positionId: String(developerPosition.id),
    appointmentClass: 'PRIMARY',
    priority: 100,
  });

  const run = repository.createRun({
    workScopeId: employeeA.workScopeId,
    title: 'Separation of duties run',
  });
  const developerDuty = repository.openDuty({
    runId: String(run.id),
    positionId: String(developerPosition.id),
    activity: 'CODING',
  });
  const developerDispatch = await dispatch.dispatchDuty(String(developerDuty.id));
  assert.equal(
    (developerDispatch.selected as { employeeId: string }).employeeId,
    employeeA.employeeId,
  );

  staffing.createStaffingConstraint({
    name: 'Reviewer must differ from developer',
    scopeType: 'POSITION',
    scopeId: employeeA.positionId,
    constraintType: 'SEPARATION_OF_DUTIES',
    strength: 'HARD',
    expression: { positionIds: [String(developerPosition.id)] },
  });
  const reviewerDuty = repository.openDuty({
    runId: String(run.id),
    positionId: employeeA.positionId,
    activity: 'REVIEWING',
  });
  const reviewDispatch = await dispatch.dispatchDuty(String(reviewerDuty.id));

  assert.equal(
    (reviewDispatch.selected as { employeeId: string }).employeeId,
    employeeB.employeeId,
  );
  const results = reviewDispatch.candidateResults as Array<Record<string, unknown>>;
  const first = results.find((item) => item.employeeId === employeeA.employeeId)!;
  const second = results.find((item) => item.employeeId === employeeB.employeeId)!;
  assert.equal(first.eligible, false);
  assert.ok((first.reasons as string[]).includes('SEPARATION_OF_DUTIES_VIOLATION'));
  assert.equal(second.eligible, true);
});
