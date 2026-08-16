import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { IncidentProjectionService } from '../src/v2/incidents.js';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const incidents = new IncidentProjectionService(repository);
  const seeded = repository.bootstrapReference({
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
    positionSlug: 'coding-review',
    positionName: 'Coding Reviewer',
    positionKind: 'REVIEWER',
    runtimeKind: 'CODEX',
    protocol: 'openai-responses',
  });
  const run = repository.createRun({ workScopeId: seeded.workScopeId, title: 'Incident test' });
  const duty = repository.openDuty({ runId: String(run.id), positionId: seeded.positionId });
  return { db, repository, incidents, seeded, run, duty };
}

test('dispatch failure projects to an Incident and staffing recovery resolves it', () => {
  const { repository, incidents, duty, run, seeded } = make();
  repository.transaction(() =>
    repository.emit({
      type: 'dispatch.failed',
      entityType: 'DutySession',
      entityId: String(duty.id),
      runId: String(run.id),
      dutySessionId: String(duty.id),
      payload: { reasons: ['NO_HEALTHY_GATEWAY_ROUTE'] },
    }),
  );
  const projected = incidents.projectIncremental();
  assert.ok(Number(projected.processed) > 0);
  const open = incidents.listIncidents();
  assert.equal(open.length, 1);
  assert.equal(open[0]?.kind, 'DISPATCH_FAILURE');
  assert.equal(open[0]?.lifecycle, 'OPEN');
  assert.equal(open[0]?.positionId, seeded.positionId);
  assert.equal(open[0]?.dutySessionId, duty.id);

  repository.transaction(() =>
    repository.emit({
      type: 'staffing_segment.started',
      entityType: 'StaffingSegment',
      entityId: 'segment-recovery',
      runId: String(run.id),
      dutySessionId: String(duty.id),
      payload: { employeeId: seeded.employeeId },
    }),
  );
  incidents.projectIncremental();
  const resolved = incidents.listIncidents()[0]!;
  assert.equal(resolved.lifecycle, 'RESOLVED');
  assert.equal(resolved.resolutionNote, 'AUTO_RECOVERED');
  assert.equal(resolved.linkedEventCount, 2);

  const beforeId = resolved.id;
  const rebuilt = incidents.rebuild();
  assert.equal(rebuilt.rebuilt, true);
  const after = incidents.listIncidents()[0]!;
  assert.equal(after.id, beforeId);
  assert.equal(after.lifecycle, 'RESOLVED');
  assert.equal(after.linkedEventCount, 2);
  assert.equal(incidents.checkpoint()?.lastEventSeq, repository.eventsAfter(0, 1000).at(-1)?.seq);
});

test('operator acknowledge and resolve survive a full projection rebuild', () => {
  const { repository, incidents, duty, run } = make();
  repository.transaction(() =>
    repository.emit({
      type: 'invocation.failed',
      entityType: 'DutySession',
      entityId: String(duty.id),
      runId: String(run.id),
      dutySessionId: String(duty.id),
      payload: { code: 'GATEWAY_UNAVAILABLE' },
    }),
  );
  incidents.projectIncremental();
  const incident = incidents.listIncidents()[0]!;

  const acknowledged = incidents.acknowledge(String(incident.id), 'Investigating provider health');
  assert.equal(acknowledged.lifecycle, 'ACKNOWLEDGED');
  incidents.rebuild();
  const afterAckRebuild = incidents.getIncident(String(incident.id));
  assert.equal(afterAckRebuild?.lifecycle, 'ACKNOWLEDGED');
  assert.ok(afterAckRebuild?.acknowledgedAt);

  const resolved = incidents.resolve(String(incident.id), 'Provider recovered');
  assert.equal(resolved.lifecycle, 'RESOLVED');
  assert.equal(resolved.resolutionNote, 'Provider recovered');
  incidents.rebuild();
  const afterResolveRebuild = incidents.getIncident(String(incident.id));
  assert.equal(afterResolveRebuild?.lifecycle, 'RESOLVED');
  assert.equal(afterResolveRebuild?.resolutionNote, 'Provider recovered');
});

test('a new failure reopens a previously resolved fingerprint and increments occurrence count', () => {
  const { repository, incidents, duty, run } = make();
  const emitFailure = () =>
    repository.transaction(() =>
      repository.emit({
        type: 'dispatch.failed',
        entityType: 'DutySession',
        entityId: String(duty.id),
        runId: String(run.id),
        dutySessionId: String(duty.id),
        payload: { reason: 'NO_ROUTE' },
      }),
    );
  emitFailure();
  incidents.projectIncremental();
  const first = incidents.listIncidents()[0]!;
  incidents.resolve(String(first.id), 'Manual recovery');
  assert.equal(incidents.getIncident(String(first.id))?.lifecycle, 'RESOLVED');

  emitFailure();
  incidents.projectIncremental();
  const reopened = incidents.getIncident(String(first.id))!;
  assert.equal(reopened.lifecycle, 'OPEN');
  assert.equal(reopened.occurrenceCount, 2);
  assert.equal(reopened.resolvedAt, null);
  assert.equal(reopened.resolutionNote, null);
});

test('runtime snapshot disappearance is grouped by run and position and recovers on runtime open', () => {
  const { repository, incidents, duty, run, seeded } = make();
  repository.transaction(() =>
    repository.emit({
      type: 'duty.cancelled',
      entityType: 'DutySession',
      entityId: String(duty.id),
      runId: String(run.id),
      dutySessionId: String(duty.id),
      payload: { reason: 'SNAPSHOT_MISSING' },
    }),
  );
  incidents.projectIncremental();
  const incident = incidents.listIncidents()[0]!;
  assert.equal(incident.kind, 'RUNTIME_DISAPPEARED');
  assert.equal(incident.positionId, seeded.positionId);

  repository.transaction(() =>
    repository.emit({
      type: 'runtime_session.opened',
      entityType: 'RuntimeSession',
      entityId: 'runtime-recovered',
      runId: String(run.id),
      dutySessionId: String(duty.id),
      payload: { positionId: seeded.positionId },
    }),
  );
  incidents.projectIncremental();
  assert.equal(incidents.getIncident(String(incident.id))?.lifecycle, 'RESOLVED');
});
