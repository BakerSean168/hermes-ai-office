import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GatewayExecutionPort,
  GatewayHealth,
  GatewayRouteRef,
  GatewayRouteResolution,
} from '../src/gateway/ports.js';
import { GatewayRegistry } from '../src/gateway/registry.js';
import { DispatchService } from '../src/v2/dispatch.js';
import { WorkforceLifecycleService } from '../src/v2/lifecycle.js';
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

class MutableGateway implements GatewayExecutionPort {
  readonly gatewayId = 'litellm-reference';
  readonly routable = new Set<string>();

  async resolveRoute(employmentId: string): Promise<GatewayRouteResolution> {
    const routable = this.routable.has(employmentId);
    return {
      route: routable
        ? {
            gatewayId: this.gatewayId,
            employmentId,
            externalRouteRef: `employment:${employmentId}`,
            protocol: 'openai-responses',
          }
        : null,
      routable,
      reasons: routable ? ['AVAILABLE'] : ['UNAVAILABLE'],
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
  const seeded = repository.bootstrapReference(reference);
  const run = repository.createRun({
    workScopeId: seeded.workScopeId,
    title: 'Lifecycle test run',
    externalRunRef: `lifecycle-${Math.random()}`,
  });
  const duty = repository.openDuty({
    runId: String(run.id),
    positionId: seeded.positionId,
    activity: 'REVIEWING',
  });
  const gateway = new MutableGateway();
  const registry = new GatewayRegistry([gateway]);
  const dispatch = new DispatchService(repository, registry);
  const lifecycle = new WorkforceLifecycleService(repository, dispatch);
  return { db, repository, seeded, run, duty, gateway, dispatch, lifecycle };
}

function createBackupEmployee(repository: V2Repository, positionId: string) {
  const supplier = repository.getOrCreateSupplier('backup-supplier', 'Backup Supplier');
  const supplierModel = repository.getOrCreateSupplierModel({
    supplierId: String(supplier.id),
    supplierModelKey: 'backup-reviewer',
    displayName: 'Backup Reviewer Model',
  });
  const employee = repository.getOrCreateEmployee({
    supplierId: String(supplier.id),
    supplierModelId: String(supplierModel.id),
    displayName: 'Backup Reviewer @ Backup Supplier',
  });
  const agreement = repository.getOrCreateAgreement({
    supplierId: String(supplier.id),
    externalAccountRef: 'backup-primary',
    name: 'Backup Primary Supply',
  });
  const employment = repository.getOrCreateCurrentEmployment({
    employeeId: String(employee.id),
    supplyAgreementId: String(agreement.id),
  });
  const gateway = repository.getOrCreateGateway({
    slug: 'litellm-reference',
    kind: 'LITELLM',
    displayName: 'LiteLLM Reference Gateway',
  });
  repository.getOrCreateGatewayBinding({
    employmentId: String(employment.id),
    gatewayId: String(gateway.id),
    externalRouteRef: `employment:${String(employment.id)}`,
    protocol: 'openai-responses',
  });
  const appointment = repository.getOrCreateCurrentAppointment({
    employeeId: String(employee.id),
    positionId,
    appointmentClass: 'BACKUP',
    priority: 50,
  });
  return {
    employeeId: String(employee.id),
    employmentId: String(employment.id),
    appointmentId: String(appointment.id),
  };
}

test('B2 Employment failover keeps Employee and StaffingSegment stable', async () => {
  const { repository, seeded, duty, gateway, dispatch, lifecycle } = await make();
  const second = repository.bootstrapReference({
    ...reference,
    agreementRef: 'planner-pool-secondary',
    agreementName: 'Planner Pool Secondary Supply',
  });
  gateway.routable.add(seeded.employmentId);
  await dispatch.dispatchDuty(String(duty.id));
  const before = repository.listDuties({ activeOnly: true })[0]!.currentStaffing.segmentId;

  gateway.routable.delete(seeded.employmentId);
  gateway.routable.add(second.employmentId);
  const result = await lifecycle.endEmployment(seeded.employmentId, {
    reason: 'QUOTA_EXHAUSTED',
    correlationId: 'corr_b2',
  });

  assert.equal(result.redispatches.length, 1);
  const redispatch = result.redispatches[0]!.result;
  assert.equal(redispatch.selected.employeeId, seeded.employeeId);
  assert.equal(redispatch.selected.employmentId, second.employmentId);
  assert.equal(redispatch.staffingSegmentId, before);
  assert.equal(redispatch.replacedStaffingSegmentId, null);
  const after = repository.listDuties({ activeOnly: true })[0]!.currentStaffing.segmentId;
  assert.equal(after, before);
  assert.equal(repository.invocationContext(String(duty.id))?.employmentId, second.employmentId);
  assert.equal(repository.employeeDossier(seeded.employeeId)?.currentWork.length, 1);
});

test('B3 Employee failover creates sequential StaffingSegments on the same Duty', async () => {
  const { db, repository, seeded, duty, gateway, dispatch, lifecycle } = await make();
  const backup = createBackupEmployee(repository, seeded.positionId);
  gateway.routable.add(seeded.employmentId);
  gateway.routable.add(backup.employmentId);
  await dispatch.dispatchDuty(String(duty.id));
  const firstSegment = String(
    repository.listDuties({ activeOnly: true })[0]!.currentStaffing.segmentId,
  );

  gateway.routable.delete(seeded.employmentId);
  const result = await lifecycle.endEmployment(seeded.employmentId, {
    reason: 'SUPPLY_ENDED',
    correlationId: 'corr_b3',
  });
  const redispatch = result.redispatches[0]!.result;
  assert.equal(redispatch.selected.employeeId, backup.employeeId);
  assert.notEqual(redispatch.staffingSegmentId, firstSegment);
  assert.equal(redispatch.replacedStaffingSegmentId, firstSegment);

  const segments = db
    .prepare(
      'SELECT id,employee_id,ended_at,ended_reason FROM v2_staffing_segments WHERE duty_session_id=? ORDER BY started_at,id',
    )
    .all(String(duty.id));
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.employee_id, seeded.employeeId);
  assert.ok(segments[0]?.ended_at);
  assert.equal(segments[0]?.ended_reason, 'REPLACED');
  assert.equal(segments[1]?.employee_id, backup.employeeId);
  assert.equal(segments[1]?.ended_at, null);
  assert.equal(repository.invocationContext(String(duty.id))?.employeeId, backup.employeeId);
});

test('ending the active Appointment redispatches to Backup Employee', async () => {
  const { repository, seeded, duty, gateway, dispatch, lifecycle } = await make();
  const backup = createBackupEmployee(repository, seeded.positionId);
  gateway.routable.add(seeded.employmentId);
  gateway.routable.add(backup.employmentId);
  await dispatch.dispatchDuty(String(duty.id));

  const result = await lifecycle.endAppointment(seeded.appointmentId, {
    reason: 'ROLE_REASSIGNED',
    correlationId: 'corr_appointment',
  });
  assert.equal(result.entity.status, 'ENDED');
  assert.equal(result.redispatches[0]!.result.selected.employeeId, backup.employeeId);
  assert.equal(
    repository.employeeDossier(seeded.employeeId)?.organization.currentAppointments.length,
    0,
  );
  assert.equal(repository.employeeDossier(backup.employeeId)?.currentWork.length, 1);
});

test('ending an Employment is idempotent and emits one lifecycle event', async () => {
  const { repository, seeded, lifecycle } = await make();
  const first = await lifecycle.endEmployment(seeded.employmentId, { reason: 'END_TEST' });
  const second = await lifecycle.endEmployment(seeded.employmentId, { reason: 'END_TEST' });
  assert.equal(first.entity.status, 'ENDED');
  assert.equal(second.entity.status, 'ENDED');
  assert.equal(
    repository.eventsAfter().filter((event) => event.type === 'employment.ended').length,
    1,
  );
});
