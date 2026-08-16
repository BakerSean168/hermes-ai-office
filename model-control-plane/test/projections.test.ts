import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { HermesExecutionSyncService } from '../src/v2/execution.js';
import { FinanceRepository } from '../src/v2/finance.js';
import { runV2Migrations } from '../src/v2/migrations.js';
import { OrganizationRepository } from '../src/v2/organization.js';
import { OfficeProjectionService } from '../src/v2/projections.js';
import { V2Repository } from '../src/v2/repository.js';
import { StaffingRepository } from '../src/v2/staffing.js';

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const domain = new V2Repository(db);
  const organization = new OrganizationRepository(domain);
  const execution = new HermesExecutionSyncService(domain, organization);
  const staffing = new StaffingRepository(domain);
  const finance = new FinanceRepository(domain);
  const projections = new OfficeProjectionService({
    domain,
    organization,
    execution,
    staffing,
    finance,
  });
  return { db, domain, organization, execution, staffing, finance, projections };
}

test('OfficeProjection distinguishes active runtime from known employee staffing', async () => {
  const { domain, execution, projections } = make();
  await execution.sync({
    profiles: [
      {
        profileId: 'profile-a',
        availability: 'ONLINE',
        workload: 'EXECUTING',
        sessionId: 'session-a',
        controllerState: 'THINKING',
        controllerActive: true,
        lastSeenAt: 1000,
      },
    ],
    runs: [
      {
        id: 'interactive:profile-a:session-a',
        profileId: 'profile-a',
        title: 'Projection run',
        status: 'RUNNING',
        createdAt: 900,
        startedAt: 950,
      },
    ],
    nodes: [
      {
        id: 'node-a',
        profileId: 'profile-a',
        runId: 'interactive:profile-a:session-a',
        type: 'CODEX',
        role: 'EXECUTOR',
        model: 'unknown-model',
        state: 'CODING',
        sessionId: 'codex-a',
        startedAt: 970,
        updatedAt: 1000,
      },
    ],
    edges: [],
  });

  const office = projections.office();
  assert.equal((office.summary as Record<string, number>).employees, 0);
  assert.equal((office.summary as Record<string, number>).staffedPositions, 0);
  assert.equal((office.summary as Record<string, number>).runtimeActiveUnattributedPositions, 2);
  assert.equal((office.summary as Record<string, number>).activeRuntimeSessions, 2);
  assert.ok(
    (office.positions as Array<Record<string, unknown>>).every(
      (position) => position.status === 'RUNTIME_ACTIVE_UNATTRIBUTED',
    ),
  );
  assert.equal(domain.listEmployees().length, 0);
});

test('PositionDossier joins appointments, runtime, qualifications, evaluations and usage by stable position', async () => {
  const { domain, execution, staffing, finance, projections } = make();
  const seeded = domain.bootstrapReference({
    supplierSlug: 'supplier-a',
    supplierName: 'Supplier A',
    supplierModelKey: 'model-a',
    supplierModelName: 'Model A',
    agreementRef: 'agreement-a',
    agreementName: 'Agreement A',
    gatewaySlug: 'gateway-a',
    gatewayKind: 'OTHER',
    gatewayName: 'Gateway A',
    workScopeSlug: 'development',
    workScopeName: 'Development',
    externalProfileRef: 'development',
    positionSlug: 'coding-review',
    positionName: 'Coding Reviewer',
    positionKind: 'REVIEWER',
    runtimeKind: 'CODEX',
    protocol: 'openai-responses',
  });
  const capability = staffing.createCapabilityDefinition({
    slug: 'review',
    name: 'Review',
    valueType: 'NUMERIC',
  });
  staffing.addCapabilityClaim({
    subjectType: 'EMPLOYEE',
    subjectId: seeded.employeeId,
    capabilityId: String(capability.id),
    value: 95,
    source: 'MEASURED',
  });
  const requirements = staffing.createRequirementSet({
    name: 'Reviewer v1',
    requirements: [{ capability: 'review', operator: 'GTE', value: 80 }],
  });
  staffing.assignRequirementSet(seeded.positionId, String(requirements.id));
  staffing.assessQualification(seeded.employeeId, seeded.positionId);
  finance.recordEvaluation({
    subjectType: 'Position',
    subjectId: seeded.positionId,
    positionId: seeded.positionId,
    employeeId: seeded.employeeId,
    dimensions: { review_quality: 92 },
    source: 'TEST',
  });

  const dossier = projections.positionDossier(seeded.positionId);
  assert.ok(dossier);
  assert.equal((dossier!.position as Record<string, unknown>).id, seeded.positionId);
  assert.equal((dossier!.appointments as unknown[]).length, 1);
  assert.equal((dossier!.qualifications as unknown[]).length, 1);
  assert.equal((dossier!.evaluations as unknown[]).length, 1);
  assert.equal((dossier!.usageByEmployee as unknown[]).length, 0);
  assert.equal((dossier!.runtimeSessions as unknown[]).length, 0);
});

test('RunDossier preserves position/runtime graph even when no Employee attribution exists', async () => {
  const { execution, projections } = make();
  await execution.sync({
    profiles: [
      {
        profileId: 'profile-a',
        availability: 'ONLINE',
        workload: 'EXECUTING',
        lastSeenAt: 1000,
      },
    ],
    runs: [
      {
        id: 'run-a',
        profileId: 'profile-a',
        title: 'Run dossier',
        status: 'RUNNING',
        createdAt: 900,
      },
    ],
    nodes: [
      {
        id: 'node-parent',
        profileId: 'profile-a',
        runId: 'run-a',
        type: 'CODEX',
        role: 'EXECUTOR',
        state: 'CODING',
        startedAt: 910,
        updatedAt: 1000,
      },
      {
        id: 'node-child',
        profileId: 'profile-a',
        runId: 'run-a',
        parentId: 'node-parent',
        type: 'HERMES_SUBAGENT',
        role: 'REVIEWER',
        state: 'REVIEWING',
        startedAt: 920,
        updatedAt: 1000,
      },
    ],
    edges: [
      {
        id: 'edge-a',
        runId: 'run-a',
        fromNodeId: 'node-parent',
        toNodeId: 'node-child',
        relation: 'DELEGATED',
      },
    ],
  });
  const office = projections.office();
  const run = (office.activeRuns as Array<Record<string, unknown>>)[0]!;
  const dossier = projections.runDossier(String(run.id));
  assert.ok(dossier);
  assert.equal((dossier!.positions as unknown[]).length, 2);
  assert.equal((dossier!.runtimeSessions as unknown[]).length, 2);
  assert.equal((dossier!.runtimeEdges as unknown[]).length, 1);
  assert.equal((dossier!.staffing as unknown[]).length, 0);
});
