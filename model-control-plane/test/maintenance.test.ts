import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { MaintenanceService } from '../src/v2/maintenance.js';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const maintenance = new MaintenanceService(repository);
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
  return { db, repository, maintenance, seeded };
}

test('maintenance dry-run reports ephemeral cleanup without mutating any record', () => {
  const { db, maintenance } = make();
  db.prepare(
    `INSERT INTO v2_idempotency_keys(
      idempotency_key,command_type,request_hash,response_json,created_at,expires_at)
     VALUES('expired','test','hash','{}',100,200)`,
  ).run();
  db.prepare(
    `INSERT INTO v2_execution_sync_runs(
      id,source,started_at,status,profiles_seen,runs_seen,nodes_seen,runtime_sessions_seen,edges_seen,issues_json,metadata_json)
     VALUES('stale-sync','HERMES_ORG',100,'RUNNING',0,0,0,0,0,'[]','{}')`,
  ).run();

  const result = maintenance.run({ dryRun: true, at: 2_000_000, staleSyncAfterMs: 60_000 });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.dryRun, true);
  assert.equal(result.expiredIdempotencyKeys, 1);
  assert.equal(result.staleExecutionSyncRuns, 1);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) count FROM v2_idempotency_keys WHERE idempotency_key='expired'")
        .get() as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      db.prepare("SELECT status FROM v2_execution_sync_runs WHERE id='stale-sync'").get() as {
        status: string;
      }
    ).status,
    'RUNNING',
  );
});

test('maintenance deletes only expired idempotency cache and marks stale sync runs failed', () => {
  const { db, repository, maintenance, seeded } = make();
  db.prepare(
    `INSERT INTO v2_idempotency_keys(
      idempotency_key,command_type,request_hash,response_json,created_at,expires_at)
     VALUES('expired','test','hash','{}',100,200),
           ('fresh','test','hash2','{}',100,999999999)`,
  ).run();
  db.prepare(
    `INSERT INTO v2_execution_sync_runs(
      id,source,started_at,status,profiles_seen,runs_seen,nodes_seen,runtime_sessions_seen,edges_seen,issues_json,metadata_json)
     VALUES('stale-sync','HERMES_ORG',100,'RUNNING',0,0,0,0,0,'[]','{}'),
           ('fresh-sync','HERMES_ORG',1999000,'RUNNING',0,0,0,0,0,'[]','{}')`,
  ).run();
  const employeeCountBefore = repository.listEmployees().length;
  const eventCountBefore = repository.eventsAfter(0, 10_000).length;

  const result = maintenance.run({ at: 2_000_000, staleSyncAfterMs: 60_000 });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.dryRun, false);
  assert.equal(result.expiredIdempotencyKeys, 1);
  assert.equal(result.staleExecutionSyncRuns, 1);

  const keys = db
    .prepare('SELECT idempotency_key FROM v2_idempotency_keys ORDER BY idempotency_key')
    .all() as Array<{ idempotency_key: string }>;
  assert.deepEqual(
    keys.map((item) => item.idempotency_key),
    ['fresh'],
  );
  const syncs = db
    .prepare('SELECT id,status,error_code FROM v2_execution_sync_runs ORDER BY id')
    .all() as Array<{ id: string; status: string; error_code: string | null }>;
  assert.deepEqual(
    syncs.map((item) => ({ ...item })),
    [
      { id: 'fresh-sync', status: 'RUNNING', error_code: null },
      { id: 'stale-sync', status: 'FAILED', error_code: 'STALE_SYNC_RUN' },
    ],
  );

  assert.equal(repository.listEmployees().length, employeeCountBefore);
  assert.equal(repository.listEmployees()[0]?.id, seeded.employeeId);
  assert.equal(repository.eventsAfter(0, 10_000).length, eventCountBefore + 1);
  assert.equal(repository.eventsAfter(0, 10_000).at(-1)?.type, 'maintenance.completed');
});

test('retention policy explicitly keeps business evidence and labels only replay cache ephemeral', () => {
  const { maintenance } = make();
  const policy = maintenance.retentionPolicy();
  assert.ok((policy.keepForever as string[]).includes('UsageEntry'));
  assert.ok((policy.keepForever as string[]).includes('V2Event'));
  assert.ok((policy.keepForever as string[]).includes('Evaluation'));
  assert.deepEqual(
    (policy.ephemeral as Array<{ artifact: string }>).map((item) => item.artifact),
    ['IdempotencyKey'],
  );
});
