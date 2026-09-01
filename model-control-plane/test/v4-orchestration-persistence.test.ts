import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { V4Error } from '../src/v4/domain/errors.js';
import type { WorkspaceDescriptor } from '../src/v4/orchestration/contracts.js';
import { openV4Database, SCHEMA_VERSION, SCHEMA_V4_SQL } from '../src/v4/persistence/database.js';
import { JulesAdapter } from '../src/v4/adapters/jules.js';
import { MaintenanceCandidateRegistry } from '../src/v4/adapters/maintenance.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';

function tempDatabase(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'control-plane.sqlite');
}

function seed(db: DatabaseSync, key = 'orchestration-seed') {
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    idempotencyKey: key,
    projectKey: 'pixel-v4',
    objective: 'exercise durable execution orchestration',
    repositoryPath: '/srv/repos/example',
    baseRevision: 'base-sha',
  }).value!;
  const graph = repositories.plans.createGraphVersion({ planId: plan.planId, reason: 'initial graph' }).value!;
  const workItem = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'implementation',
    title: 'Implement the vertical slice',
    objective: 'Implement, test, review, and accept the exact revision',
    acceptanceCriteria: ['tests pass', 'review passes'],
    dependencies: [],
  }).value!;
  repositories.plans.updateStatus(plan.planId, 'READY');
  const supervisor = repositories.supervisors.create({ planId: plan.planId }).value!;
  repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
  return {
    repositories,
    plan: repositories.plans.getPlan(plan.planId),
    graph,
    workItem,
    supervisor: repositories.supervisors.getById(supervisor.supervisorId),
  };
}

function downgradeFixtureToV1(file: string): void {
  const raw = new DatabaseSync(file);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE execution_evidence;
    DROP TABLE execution_sessions;
    DROP TABLE v4_jules_sessions;
    CREATE TABLE improvement_candidates_v1 (
      candidate_id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES maintenance_programs(program_id),
      fingerprint TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      evidence TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_id TEXT,
      pull_request_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO improvement_candidates_v1(candidate_id,program_id,fingerprint,title,evidence,status,plan_id,pull_request_id,created_at,updated_at)
      SELECT candidate_id,program_id,fingerprint,title,evidence,status,plan_id,pull_request_id,created_at,updated_at FROM improvement_candidates;
    DROP TABLE improvement_candidates;
    ALTER TABLE improvement_candidates_v1 RENAME TO improvement_candidates;
    UPDATE schema_meta SET schema_version=1 WHERE schema_id='pixel-v4';
    PRAGMA foreign_keys = ON;
  `);
  raw.close();
}

function schemaDescriptor(db: DatabaseSync): Record<string, unknown> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as Array<{ name: string }>).map((row) => row.name);
  const descriptor: Record<string, unknown> = {};
  for (const table of tables) {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const columns = (db.prepare('PRAGMA table_info(' + quoted + ')').all() as unknown as Array<Record<string, unknown>>)
      .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const foreignKeys = (db.prepare('PRAGMA foreign_key_list(' + quoted + ')').all() as unknown as Array<Record<string, unknown>>)
      .map(({ table: target, from, to, on_update, on_delete, match }) => ({ target, from, to, on_update, on_delete, match }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const indexes = (db.prepare('PRAGMA index_list(' + quoted + ')').all() as unknown as Array<{ name: string; unique: number; origin: string; partial: number }>)
      .map((index) => ({
        unique: index.unique,
        origin: index.origin,
        partial: index.partial,
        columns: (db.prepare('PRAGMA index_info("' + index.name.replaceAll('"', '""') + '")').all() as unknown as Array<{ seqno: number; name: string }>).sort((a, b) => a.seqno - b.seqno).map((column) => column.name),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    descriptor[table] = { columns, foreignKeys, indexes };
  }
  return descriptor;
}

test('runtime schema and checked-in schema-v4.sql remain semantically synchronized', () => {
  const runtime = new DatabaseSync(':memory:');
  runtime.exec(SCHEMA_V4_SQL);
  const fileSchema = new DatabaseSync(':memory:');
  const sqlFile = fs.readFileSync(new URL('../src/v4/persistence/schema-v4.sql', import.meta.url), 'utf8');
  fileSchema.exec(sqlFile);
  assert.deepEqual(schemaDescriptor(fileSchema), schemaDescriptor(runtime));
  assert.equal(fileSchema.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()?.schema_version, SCHEMA_VERSION);
  assert.equal(runtime.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()?.schema_version, SCHEMA_VERSION);
  runtime.close();
  fileSchema.close();
});

test('adapters require the centralized current V4 schema and never create private tables', () => {
  const raw = new DatabaseSync(':memory:');
  assert.throws(
    () => new JulesAdapter(undefined, raw),
    (error: unknown) => error instanceof V4Error && error.code === 'V4_SCHEMA_VERSION_INVALID',
  );
  assert.throws(
    () => new MaintenanceCandidateRegistry(raw),
    (error: unknown) => error instanceof V4Error && error.code === 'V4_SCHEMA_VERSION_INVALID',
  );
  assert.equal(raw.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get()?.count, 0);
  raw.close();
});

test('schema v1 migrates in place to v2 and preserves durable production state across restart', () => {
  const file = tempDatabase('pixel-v4-migrate-');
  let db = openV4Database(file, { environment: 'production', env: { NODE_ENV: 'production' } });
  const seeded = seed(db, 'migration-plan');
  seeded.repositories.supervisors.attachConversation(seeded.supervisor.supervisorId, 'conversation-before-migration');
  const before = {
    plan: seeded.repositories.plans.getPlan(seeded.plan.planId),
    graph: seeded.repositories.plans.getActiveGraphVersion(seeded.plan.planId),
    workItem: seeded.repositories.plans.getWorkItem(seeded.workItem.workItemId),
    supervisor: seeded.repositories.supervisors.getById(seeded.supervisor.supervisorId),
    events: seeded.repositories.events.listAfterCursor(0, 1000).events,
  };
  db.close();

  downgradeFixtureToV1(file);
  db = openV4Database(file, { environment: 'production', env: { NODE_ENV: 'production' } });
  const migrated = createRepositories(db);
  assert.equal(db.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()?.schema_version, SCHEMA_VERSION);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_sessions'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_evidence'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='v4_jules_sessions'").get());
  assert.ok((db.prepare('PRAGMA table_info(improvement_candidates)').all() as unknown as Array<{ name: string }>).some((column) => column.name === 'risk'));
  assert.deepEqual(migrated.plans.getPlan(before.plan.planId), before.plan);
  assert.deepEqual(migrated.plans.getActiveGraphVersion(before.plan.planId), before.graph);
  assert.deepEqual(migrated.plans.getWorkItem(before.workItem.workItemId), before.workItem);
  assert.deepEqual(migrated.supervisors.getById(before.supervisor.supervisorId), before.supervisor);
  assert.deepEqual(migrated.events.listAfterCursor(0, 1000).events, before.events);
  db.close();

  db = openV4Database(file, { environment: 'production', env: { NODE_ENV: 'production' } });
  const restarted = createRepositories(db);
  assert.equal(db.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()?.schema_version, SCHEMA_VERSION);
  assert.deepEqual(restarted.plans.getPlan(before.plan.planId), before.plan);
  assert.equal(restarted.events.listAfterCursor(0, 1000).events.length, before.events.length);
  db.close();
});

test('unknown newer and incomplete V4 schemas fail closed without resetting durable rows', () => {
  const newerFile = tempDatabase('pixel-v4-newer-schema-');
  let db = openV4Database(newerFile, { environment: 'production', env: { NODE_ENV: 'production' } });
  seed(db, 'newer-schema-plan');
  db.close();
  let raw = new DatabaseSync(newerFile);
  raw.prepare("UPDATE schema_meta SET schema_version=99 WHERE schema_id='pixel-v4'").run();
  raw.close();
  assert.throws(
    () => openV4Database(newerFile, { environment: 'production', env: { NODE_ENV: 'production' } }),
    (error: unknown) => error instanceof V4Error && error.code === 'V4_SCHEMA_VERSION_INVALID',
  );
  raw = new DatabaseSync(newerFile, { readOnly: true });
  assert.equal(raw.prepare('SELECT count(*) AS count FROM plans').get()?.count, 1);
  raw.close();

  const incompleteFile = tempDatabase('pixel-v4-incomplete-schema-');
  db = openV4Database(incompleteFile, { environment: 'production', env: { NODE_ENV: 'production' } });
  seed(db, 'incomplete-schema-plan');
  db.close();
  raw = new DatabaseSync(incompleteFile);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE execution_evidence;
    DROP TABLE execution_sessions;
    DROP TABLE reviews;
    UPDATE schema_meta SET schema_version=1 WHERE schema_id='pixel-v4';
    PRAGMA foreign_keys = ON;
  `);
  raw.close();
  assert.throws(
    () => openV4Database(incompleteFile, { environment: 'production', env: { NODE_ENV: 'production' } }),
    (error: unknown) => error instanceof V4Error && error.code === 'V4_SCHEMA_INCOMPLETE',
  );
  raw = new DatabaseSync(incompleteFile, { readOnly: true });
  assert.equal(raw.prepare('SELECT count(*) AS count FROM plans').get()?.count, 1);
  raw.close();

  const missingColumnFile = tempDatabase('pixel-v4-missing-column-');
  db = openV4Database(missingColumnFile, { environment: 'production', env: { NODE_ENV: 'production' } });
  seed(db, 'missing-column-plan');
  db.close();
  raw = new DatabaseSync(missingColumnFile);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE execution_evidence;
    DROP TABLE execution_sessions;
    ALTER TABLE plans DROP COLUMN objective;
    UPDATE schema_meta SET schema_version=1 WHERE schema_id='pixel-v4';
    PRAGMA foreign_keys = ON;
  `);
  raw.close();
  assert.throws(
    () => openV4Database(missingColumnFile, { environment: 'production', env: { NODE_ENV: 'production' } }),
    (error: unknown) => error instanceof V4Error && error.code === 'V4_SCHEMA_INCOMPLETE',
  );
  raw = new DatabaseSync(missingColumnFile, { readOnly: true });
  assert.equal(raw.prepare('SELECT count(*) AS count FROM plans').get()?.count, 1);
  raw.close();

  const malformedFile = tempDatabase('pixel-v4-malformed-schema-');
  db = openV4Database(malformedFile, { environment: 'test', env: { NODE_ENV: 'test' } });
  seed(db, 'malformed-schema-plan');
  db.close();
  raw = new DatabaseSync(malformedFile);
  raw.prepare("DELETE FROM schema_meta WHERE schema_id='pixel-v4'").run();
  raw.close();
  assert.throws(
    () => openV4Database(malformedFile, { environment: 'test', allowDataReset: true, env: { NODE_ENV: 'test', PIXEL_V4_ALLOW_DATA_RESET: 'true' } }),
    (error: unknown) => error instanceof V4Error && error.code === 'V4_SCHEMA_META_MISSING',
  );
  raw = new DatabaseSync(malformedFile, { readOnly: true });
  assert.equal(raw.prepare('SELECT count(*) AS count FROM plans').get()?.count, 1);
  raw.close();
});

test('execution sessions and evidence are durable, idempotent, correlated, and immutable', () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const seeded = seed(db, 'session-plan');
  seeded.repositories.plans.compareAndSetStatus(seeded.plan.planId, 'READY', 'RUNNING');
  seeded.repositories.plans.updateWorkItemStatus(seeded.workItem.workItemId, 'RUNNING');
  const execution = seeded.repositories.executions.create({
    idempotencyKey: 'implementation-execution',
    identity: {
      executionId: 'execution-implementation',
      planId: seeded.plan.planId,
      workItemId: seeded.workItem.workItemId,
      attempt: 1,
      route: 'openhands-luna',
      sourceRevision: 'base-sha',
    },
    objective: seeded.workItem.objective,
  }).value!;
  const workspace: WorkspaceDescriptor = {
    executionId: execution.identity.executionId,
    hostPath: '/host/v4/executions/execution-implementation/repo',
    executionPath: '/workspace/v4/executions/execution-implementation/repo',
    evidenceHostPath: '/host/v4/executions/execution-implementation/evidence.json',
    evidenceExecutionPath: '/workspace/v4/executions/execution-implementation/evidence.json',
    sourceRepositoryPath: '/srv/repos/example',
    sourceRevision: 'base-sha',
    createdAt: '2026-08-31T00:00:00.000Z',
  };

  assert.throws(
    () => seeded.repositories.sessions.create({ executionId: execution.identity.executionId, phase: 'IMPLEMENT', provider: 'openhands', workspace: { ...workspace, sourceRevision: 'other-sha' }, sourceRevision: 'base-sha' }),
    (error: unknown) => error instanceof V4Error && error.code === 'SESSION_WORKSPACE_REVISION_MISMATCH',
  );
  assert.throws(
    () => seeded.repositories.sessions.create({ executionId: execution.identity.executionId, phase: 'IMPLEMENT', provider: 'openhands', workspace: { ...workspace, createdAt: 'not-a-time' }, sourceRevision: 'base-sha' }),
    (error: unknown) => error instanceof V4Error && error.code === 'SESSION_WORKSPACE_TIME_INVALID',
  );
  assert.throws(
    () => seeded.repositories.sessions.create({ executionId: execution.identity.executionId, phase: 'IMPLEMENT', provider: 'openhands', workspace: { ...workspace, sourceRepositoryPath: '/srv/repos/other' }, sourceRevision: 'base-sha' }),
    (error: unknown) => error instanceof V4Error && error.code === 'SESSION_REPOSITORY_MISMATCH',
  );
  const created = seeded.repositories.sessions.create({
    executionId: execution.identity.executionId,
    phase: 'IMPLEMENT',
    provider: 'openhands',
    workspace,
    sourceRevision: 'base-sha',
  });
  assert.equal(created.status, 'created');
  assert.equal(created.value?.workspace.createdAt, workspace.createdAt);
  assert.equal(seeded.repositories.sessions.create({ executionId: execution.identity.executionId, phase: 'IMPLEMENT', provider: 'openhands', workspace, sourceRevision: 'base-sha' }).status, 'existing');
  assert.throws(
    () => seeded.repositories.sessions.create({ executionId: execution.identity.executionId, phase: 'IMPLEMENT', provider: 'openhands', workspace: { ...workspace, hostPath: '/other' }, sourceRevision: 'base-sha' }),
    (error: unknown) => error instanceof V4Error && error.code === 'EXECUTION_SESSION_IMMUTABLE',
  );

  assert.equal(seeded.repositories.sessions.attachProviderSession(execution.identity.executionId, 'openhands-session-1').status, 'updated');
  assert.equal(seeded.repositories.sessions.attachProviderSession(execution.identity.executionId, 'openhands-session-1').status, 'existing');
  assert.throws(
    () => seeded.repositories.sessions.attachProviderSession(execution.identity.executionId, 'openhands-session-2'),
    (error: unknown) => error instanceof V4Error && error.code === 'PROVIDER_SESSION_IMMUTABLE',
  );
  assert.equal(seeded.repositories.sessions.replaceProviderSession(execution.identity.executionId, 'openhands-session-1', 'openhands-session-2', 'remote session disappeared').status, 'updated');
  assert.equal(seeded.repositories.sessions.get(execution.identity.executionId).providerStatus, 'CREATED');
  assert.equal(seeded.repositories.sessions.replaceProviderSession(execution.identity.executionId, 'openhands-session-1', 'openhands-session-2', 'retry after persisted result').status, 'existing');
  assert.throws(
    () => seeded.repositories.sessions.updateProviderStatus(execution.identity.executionId, 'RUNNING', 'not-a-time'),
    (error: unknown) => error instanceof V4Error && error.code === 'PROVIDER_OBSERVATION_TIME_INVALID',
  );
  assert.equal(seeded.repositories.sessions.updateProviderStatus(execution.identity.executionId, 'RUNNING', '2099-08-31T00:00:01.000Z').status, 'updated');
  assert.equal(seeded.repositories.sessions.heartbeat(execution.identity.executionId, 'RUNNING', '2099-08-31T00:00:02.000Z').value?.lastHeartbeatAt, '2099-08-31T00:00:02.000Z');
  assert.equal(seeded.repositories.sessions.heartbeat(execution.identity.executionId, 'RUNNING', '2099-08-31T00:00:01.500Z').reason, 'STALE_PROVIDER_HEARTBEAT');

  const evidence = seeded.repositories.evidence.append({
    executionId: execution.identity.executionId,
    kind: 'TEST',
    name: 'unit-tests',
    sourceRevision: 'result-sha',
    payload: { command: 'npm test', status: 'PASS', exitCode: 0 },
  });
  assert.equal(evidence.status, 'created');
  assert.equal(seeded.repositories.evidence.append({ executionId: execution.identity.executionId, kind: 'TEST', name: 'unit-tests', sourceRevision: 'result-sha', payload: { exitCode: 0, status: 'PASS', command: 'npm test' } }).status, 'existing');
  assert.throws(
    () => seeded.repositories.evidence.append({ executionId: execution.identity.executionId, kind: 'TEST', name: 'unit-tests', sourceRevision: 'result-sha', payload: { command: 'npm test', status: 'FAIL', exitCode: 1 } }),
    (error: unknown) => error instanceof V4Error && error.code === 'DURABLE_EVIDENCE_IMMUTABLE',
  );

  assert.equal(seeded.repositories.sessions.complete(execution.identity.executionId, { status: 'SUCCEEDED', finalResponse: 'too early', completedAt: '2099-08-31T00:00:01.500Z' }).reason, 'STALE_PROVIDER_COMPLETION');
  assert.equal(seeded.repositories.sessions.complete(execution.identity.executionId, { status: 'SUCCEEDED', finalResponse: 'implementation complete', completedAt: '2099-08-31T00:00:03.000Z' }).status, 'updated');
  assert.equal(seeded.repositories.sessions.complete(execution.identity.executionId, { status: 'SUCCEEDED', finalResponse: 'implementation complete', completedAt: '2099-08-31T00:00:04.000Z' }).status, 'existing');
  assert.equal(seeded.repositories.sessions.heartbeat(execution.identity.executionId, 'SUCCEEDED', '2099-08-31T00:00:05.000Z').value?.completedAt, '2099-08-31T00:00:03.000Z');
  assert.throws(
    () => seeded.repositories.sessions.replaceProviderSession(execution.identity.executionId, 'openhands-session-2', 'openhands-session-3', 'too late'),
    (error: unknown) => error instanceof V4Error && error.code === 'EXECUTION_SESSION_TERMINAL',
  );
  assert.throws(
    () => seeded.repositories.sessions.complete(execution.identity.executionId, { status: 'FAILED', errorCode: 'LATE_FAILURE' }),
    (error: unknown) => error instanceof V4Error && error.code === 'EXECUTION_SESSION_RESULT_IMMUTABLE',
  );
  assert.equal(seeded.repositories.sessions.listByPlan(seeded.plan.planId).length, 1);
  assert.equal(seeded.repositories.evidence.listByExecution(execution.identity.executionId).length, 1);
  db.prepare('UPDATE execution_sessions SET provider=? WHERE execution_id=?').run('', execution.identity.executionId);
  assert.throws(
    () => seeded.repositories.sessions.get(execution.identity.executionId),
    (error: unknown) => error instanceof V4Error && error.code === 'CORRUPTED_EXECUTION_SESSION_IDENTITY',
  );
  db.prepare('UPDATE execution_sessions SET provider=?,workspace_host_path=? WHERE execution_id=?').run('openhands', '', execution.identity.executionId);
  assert.throws(
    () => seeded.repositories.sessions.get(execution.identity.executionId),
    (error: unknown) => error instanceof V4Error && error.code === 'CORRUPTED_EXECUTION_SESSION_WORKSPACE',
  );
  db.close();
});

test('execution leases allow takeover only after expiry', () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const seeded = seed(db, 'execution-lease-plan');
  const execution = seeded.repositories.executions.create({
    idempotencyKey: 'leased-execution',
    identity: { executionId: 'leased-execution', planId: seeded.plan.planId, workItemId: seeded.workItem.workItemId, attempt: 1, route: 'openhands', sourceRevision: 'base-sha' },
    objective: 'lease me',
  }).value!;
  assert.equal(seeded.repositories.executions.create({ idempotencyKey: 'leased-execution', identity: execution.identity, objective: 'lease me' }).status, 'existing');
  assert.throws(
    () => seeded.repositories.executions.create({ idempotencyKey: 'leased-execution', identity: { ...execution.identity, route: 'different-route' }, objective: 'lease me' }),
    (error: unknown) => error instanceof V4Error && error.code === 'DUPLICATE_KEY',
  );
  assert.throws(
    () => seeded.repositories.executions.create({ idempotencyKey: 'different-key', identity: execution.identity, objective: 'lease me' }),
    (error: unknown) => error instanceof V4Error && error.code === 'DUPLICATE_KEY',
  );
  const first = seeded.repositories.executions.claimLease(execution.identity.executionId, 'worker-a', 10, 1000);
  assert.equal(first.status, 'created');
  assert.equal(seeded.repositories.executions.claimLease(execution.identity.executionId, 'worker-b', 10, 1001).status, 'rejected');
  assert.equal(seeded.repositories.executions.claimLease(execution.identity.executionId, 'worker-b', 10, 1011).status, 'updated');
  db.close();
});

test('plan revision reconciliation and exact work-item acceptance are CAS guarded and audited', () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const seeded = seed(db, 'revision-plan');
  const reconciled = seeded.repositories.plans.reconcileCurrentRevision(seeded.plan.planId, 'base-sha', 'observed-sha', 'verified repository head');
  assert.equal(reconciled.status, 'updated');
  assert.equal(reconciled.value?.currentRevision, 'observed-sha');
  assert.equal(seeded.repositories.plans.reconcileCurrentRevision(seeded.plan.planId, 'base-sha', 'observed-sha', 'retry after response loss').status, 'existing');
  assert.equal(seeded.repositories.plans.reconcileCurrentRevision(seeded.plan.planId, 'base-sha', 'stale-sha', 'stale observer').status, 'rejected');
  assert.equal(seeded.repositories.plans.listPlans({ status: 'READY' }).some((plan) => plan.planId === seeded.plan.planId), true);

  seeded.repositories.plans.compareAndSetStatus(seeded.plan.planId, 'READY', 'RUNNING');
  seeded.repositories.plans.updateWorkItemStatus(seeded.workItem.workItemId, 'RUNNING');
  const advanced = seeded.repositories.plans.advanceAcceptedRevision(seeded.plan.planId, 'observed-sha', 'accepted-sha', 'review passed');
  assert.equal(advanced.status, 'updated');
  assert.equal(advanced.value?.currentRevision, 'accepted-sha');
  assert.equal(seeded.repositories.plans.advanceAcceptedRevision(seeded.plan.planId, 'observed-sha', 'accepted-sha', 'retry after response loss').status, 'existing');
  const accepted = seeded.repositories.plans.acceptWorkItemRevision(seeded.workItem.workItemId, 'accepted-sha');
  assert.equal(accepted.value?.status, 'SUCCEEDED');
  assert.equal(accepted.value?.exactAcceptedRevision, 'accepted-sha');
  assert.equal(seeded.repositories.plans.acceptWorkItemRevision(seeded.workItem.workItemId, 'accepted-sha').status, 'existing');
  assert.throws(
    () => seeded.repositories.plans.acceptWorkItemRevision(seeded.workItem.workItemId, 'different-sha'),
    (error: unknown) => error instanceof V4Error && error.code === 'WORK_ITEM_ACCEPTED_REVISION_IMMUTABLE',
  );
  const planEvents = seeded.repositories.events.listByAggregate(seeded.plan.planId).map((event) => event.type);
  assert.ok(planEvents.includes('PLAN_REVISION_RECONCILED'));
  assert.ok(planEvents.includes('PLAN_ACCEPTED_REVISION_ADVANCED'));
  const workEvents = seeded.repositories.events.listByAggregate(seeded.workItem.workItemId).map((event) => event.type);
  assert.ok(workEvents.includes('WORK_ITEM_REVISION_ACCEPTED'));
  db.close();
});

test('review binding requires a distinct reviewer execution for the same plan and work item', () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const seeded = seed(db, 'review-binding-plan');
  seeded.repositories.plans.compareAndSetStatus(seeded.plan.planId, 'READY', 'RUNNING');
  seeded.repositories.plans.updateWorkItemStatus(seeded.workItem.workItemId, 'RUNNING');
  const implementation = seeded.repositories.executions.create({
    idempotencyKey: 'implementation-for-review',
    identity: { executionId: 'implementation-for-review', planId: seeded.plan.planId, workItemId: seeded.workItem.workItemId, attempt: 1, route: 'luna', sourceRevision: 'base-sha' },
    objective: 'implement',
  }).value!;
  const workspaceFor = (executionId: string, sourceRevision: string, suffix: string): WorkspaceDescriptor => ({
    executionId,
    hostPath: '/host/review/' + suffix,
    executionPath: '/workspace/review/' + suffix,
    evidenceHostPath: '/host/review/' + suffix + '/evidence.json',
    evidenceExecutionPath: '/workspace/review/' + suffix + '/evidence.json',
    sourceRepositoryPath: '/srv/repos/example',
    sourceRevision,
    createdAt: '2026-08-31T00:00:00.000Z',
  });
  seeded.repositories.sessions.create({
    executionId: implementation.identity.executionId,
    phase: 'IMPLEMENT',
    provider: 'openhands',
    workspace: workspaceFor(implementation.identity.executionId, 'base-sha', 'implementation'),
    sourceRevision: 'base-sha',
  });
  seeded.repositories.sessions.attachProviderSession(implementation.identity.executionId, 'implementation-provider-session');
  seeded.repositories.sessions.updateProviderStatus(implementation.identity.executionId, 'RUNNING');
  seeded.repositories.executions.updateStatus(implementation.identity.executionId, 'RUNNING');
  seeded.repositories.sessions.complete(implementation.identity.executionId, { status: 'SUCCEEDED', finalResponse: 'implementation complete' });
  seeded.repositories.executions.recordResult(implementation.identity.executionId, { status: 'SUCCEEDED', resultRevision: 'result-sha' });
  const review = seeded.repositories.reviews.create({
    idempotencyKey: 'review-result-sha',
    planId: seeded.plan.planId,
    workItemId: seeded.workItem.workItemId,
    implementationExecutionId: implementation.identity.executionId,
    sourceRevision: 'result-sha',
  }).value!;
  const reviewer = seeded.repositories.executions.create({
    idempotencyKey: 'reviewer-execution',
    identity: { executionId: 'reviewer-execution', planId: seeded.plan.planId, workItemId: seeded.workItem.workItemId, attempt: 1, route: 'sol-review', sourceRevision: 'result-sha' },
    objective: 'independently review result-sha',
  }).value!;
  assert.throws(
    () => seeded.repositories.reviews.attachReviewerExecution(review.reviewId, implementation.identity.executionId),
    (error: unknown) => error instanceof V4Error && error.code === 'REVIEWER_NOT_INDEPENDENT',
  );
  const wrongSourceReviewer = seeded.repositories.executions.create({
    idempotencyKey: 'wrong-source-reviewer',
    identity: { executionId: 'wrong-source-reviewer', planId: seeded.plan.planId, workItemId: seeded.workItem.workItemId, attempt: 1, route: 'sol-review', sourceRevision: 'other-sha' },
    objective: 'review the wrong source',
  }).value!;
  assert.throws(
    () => seeded.repositories.reviews.attachReviewerExecution(review.reviewId, wrongSourceReviewer.identity.executionId),
    (error: unknown) => error instanceof V4Error && error.code === 'REVIEWER_EXECUTION_INVALID',
  );
  assert.throws(
    () => seeded.repositories.reviews.attachReviewerExecution(review.reviewId, reviewer.identity.executionId),
    (error: unknown) => error instanceof V4Error && error.code === 'REVIEWER_SESSION_INVALID',
  );
  seeded.repositories.sessions.create({
    executionId: reviewer.identity.executionId,
    phase: 'REVIEW',
    provider: 'openhands',
    workspace: workspaceFor(reviewer.identity.executionId, 'result-sha', 'reviewer'),
    sourceRevision: 'result-sha',
  });
  seeded.repositories.sessions.attachProviderSession(reviewer.identity.executionId, 'review-provider-session');
  assert.equal(seeded.repositories.reviews.attachReviewerExecution(review.reviewId, reviewer.identity.executionId).status, 'updated');
  assert.equal(seeded.repositories.reviews.attachReviewerExecution(review.reviewId, reviewer.identity.executionId).status, 'existing');
  assert.throws(
    () => seeded.repositories.reviews.recordVerdict(review.reviewId, 'PASS'),
    (error: unknown) => error instanceof V4Error && error.code === 'REVIEWER_EXECUTION_NOT_SUCCEEDED',
  );
  seeded.repositories.sessions.updateProviderStatus(reviewer.identity.executionId, 'RUNNING');
  seeded.repositories.executions.updateStatus(reviewer.identity.executionId, 'RUNNING');
  seeded.repositories.sessions.complete(reviewer.identity.executionId, { status: 'SUCCEEDED', finalResponse: 'review complete' });
  seeded.repositories.executions.recordResult(reviewer.identity.executionId, { status: 'SUCCEEDED', resultRevision: 'result-sha' });
  seeded.repositories.reviews.updateStatus(review.reviewId, 'RUNNING');
  assert.equal(seeded.repositories.reviews.recordVerdict(review.reviewId, 'PASS').value?.status, 'PASSED');
  assert.equal(seeded.repositories.reviews.create({ idempotencyKey: 'review-result-sha', planId: seeded.plan.planId, workItemId: seeded.workItem.workItemId, implementationExecutionId: implementation.identity.executionId, sourceRevision: 'result-sha' }).status, 'existing');
  const secondReviewer = seeded.repositories.executions.create({
    idempotencyKey: 'second-reviewer-execution',
    identity: { executionId: 'second-reviewer-execution', planId: seeded.plan.planId, workItemId: seeded.workItem.workItemId, attempt: 2, route: 'opus-review', sourceRevision: 'result-sha' },
    objective: 'second independent review',
  }).value!;
  assert.throws(
    () => seeded.repositories.reviews.attachReviewerExecution(review.reviewId, secondReviewer.identity.executionId),
    (error: unknown) => error instanceof V4Error && error.code === 'REVIEWER_EXECUTION_IMMUTABLE',
  );
  assert.equal(seeded.repositories.reviews.findByImplementationExecution(implementation.identity.executionId)?.reviewerExecutionId, reviewer.identity.executionId);
  db.close();
});



test('Jules correlation preserves immutable session lineage and validates remote refresh provenance', () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const request = { idempotencyKey: 'jules-digital-biome-1', repository: 'owner/digital-biome', baseRevision: 'base-sha', objective: 'Refactor the rendering boundary' };
  let remote: import('../src/v4/adapters/jules.js').JulesTaskResult = {
    sessionId: 'jules-session-1', repository: request.repository, baseRevision: request.baseRevision, status: 'RUNNING',
  };
  let getCalls = 0;
  const adapter = new JulesAdapter({
    submit: () => remote,
    getResult: () => { getCalls += 1; return remote; },
  }, db);
  assert.equal(adapter.submit(request).sessionId, 'jules-session-1');
  assert.equal(adapter.submit(request).sessionId, 'jules-session-1');
  assert.throws(
    () => adapter.correlate(request, { ...remote, sessionId: 'jules-session-2' }),
    (error: unknown) => error instanceof V4Error && error.code === 'JULES_SESSION_IMMUTABLE',
  );
  assert.throws(
    () => adapter.getResult('unknown-session'),
    (error: unknown) => error instanceof V4Error && error.code === 'JULES_SESSION_NOT_FOUND',
  );
  assert.equal(getCalls, 0);
  remote = { ...remote, status: 'SUCCEEDED', headRevision: 'result-sha', pullRequestId: '42' };
  const completed = adapter.getResult('jules-session-1');
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(completed.headRevision, 'result-sha');
  assert.equal(getCalls, 1);
  assert.throws(
    () => adapter.correlate(request, { ...remote, status: 'RUNNING' }),
    (error: unknown) => error instanceof V4Error && error.code === 'JULES_RESULT_IMMUTABLE',
  );
  remote = { sessionId: 'jules-session-1', repository: 'attacker/repo', baseRevision: request.baseRevision, status: 'RUNNING' };
  assert.equal(adapter.getResult('jules-session-1').status, 'SUCCEEDED');
  assert.equal(getCalls, 1, 'terminal durable results must not be refreshed or replaced');

  const secondRequest = { ...request, idempotencyKey: 'jules-digital-biome-2' };
  let mismatched = { sessionId: 'jules-session-3', repository: 'attacker/repo', baseRevision: request.baseRevision, status: 'RUNNING' as const };
  const mismatchedAdapter = new JulesAdapter({ submit: () => ({ ...mismatched, repository: secondRequest.repository }), getResult: () => mismatched }, db);
  mismatchedAdapter.submit(secondRequest);
  assert.throws(
    () => mismatchedAdapter.getResult('jules-session-3'),
    (error: unknown) => error instanceof V4Error && error.code === 'JULES_PROVENANCE_MISMATCH',
  );
  db.close();
});

test('maintenance candidate decoding fails closed on corrupted durable evidence', () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    idempotencyKey: 'candidate-corruption-plan', projectKey: 'digital-biome', objective: 'repair a candidate', repositoryPath: '/srv/repos/digital-biome', baseRevision: 'base-sha',
  }).value!;
  const program = {
    programId: 'digital-biome-program', projectKey: 'digital-biome', implementationRoutes: ['jules'], reviewRoutes: ['sol-review'],
    autonomousScope: 'CONSERVATIVE' as const, autoMerge: false, enabled: true,
  };
  const registry = new MaintenanceCandidateRegistry(db);
  const created = registry.create(program, { title: 'Improve rendering', evidence: ['metric:slow'], risk: 'LOW' });
  registry.attachPlan(created.candidate.candidateId, plan.planId);
  db.prepare('UPDATE improvement_candidates SET evidence=? WHERE candidate_id=?').run('{}', created.candidate.candidateId);
  assert.throws(
    () => registry.create(program, { title: 'Improve rendering', evidence: ['metric:slow'], risk: 'LOW' }),
    (error: unknown) => error instanceof V4Error && error.code === 'CORRUPTED_CANDIDATE_EVIDENCE',
  );
  db.close();
});

test('supervisor conversation replacement uses expected-old CAS and emits durable audit evidence', () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const seeded = seed(db, 'supervisor-correlation-plan');
  assert.equal(seeded.repositories.supervisors.attachConversation(seeded.supervisor.supervisorId, 'conversation-1').status, 'updated');
  assert.equal(seeded.repositories.supervisors.replaceConversation(seeded.supervisor.supervisorId, 'stale-conversation', 'conversation-2', 'remote session missing').status, 'rejected');
  assert.equal(seeded.repositories.supervisors.replaceConversation(seeded.supervisor.supervisorId, 'conversation-1', 'conversation-2', 'remote session missing').status, 'updated');
  assert.equal(seeded.repositories.supervisors.replaceConversation(seeded.supervisor.supervisorId, 'conversation-1', 'conversation-2', 'retry after response loss').status, 'existing');
  assert.equal(seeded.repositories.supervisors.getById(seeded.supervisor.supervisorId).conversationId, 'conversation-2');
  assert.throws(
    () => seeded.repositories.supervisors.attachConversation(seeded.supervisor.supervisorId, 'conversation-3'),
    (error: unknown) => error instanceof V4Error && error.code === 'SUPERVISOR_CONVERSATION_IMMUTABLE',
  );
  const events = seeded.repositories.events.listByAggregate(seeded.supervisor.supervisorId).map((event) => event.type);
  assert.ok(events.includes('SUPERVISOR_CONVERSATION_ATTACHED'));
  assert.ok(events.includes('SUPERVISOR_CONVERSATION_REPLACED'));
  db.close();
});
