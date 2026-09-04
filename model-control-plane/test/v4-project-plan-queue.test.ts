import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { V4Error } from '../src/v4/domain/errors.js';
import { ProjectPlanQueueRuntime } from '../src/v4/orchestration/projectPlanQueueRuntime.js';
import { openV4Database, SCHEMA_VERSION } from '../src/v4/persistence/database.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';

function createRoot(
  repositories: ReturnType<typeof createRepositories>,
  planId: string,
  projectKey = 'bodysense',
  repositoryPath = '/home/dev/projects/bodysense',
) {
  return repositories.plans.createPlan({
    planId,
    idempotencyKey: 'queue:' + planId,
    projectKey,
    objective: 'Execute ' + planId,
    repositoryPath,
    baseRevision: 'base-sha',
  }).value!;
}

function finish(repositories: ReturnType<typeof createRepositories>, planId: string): void {
  const plan = repositories.plans.getPlan(planId);
  if (plan.status === 'READY') repositories.plans.updateStatus(planId, 'RUNNING');
  repositories.plans.updateStatus(planId, 'SUCCEEDED');
}

test('single-active-plan scheduler keeps later root plans queued and hands off FIFO across restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-plan-queue-'));
  const dbFile = path.join(root, 'pixel.sqlite');
  let db = openV4Database(dbFile, { environment: 'test' });
  let repositories = createRepositories(db);
  let runtime = new ProjectPlanQueueRuntime(repositories);

  createRoot(repositories, 'plan-a');
  createRoot(repositories, 'plan-b');
  createRoot(repositories, 'plan-c');

  const active = runtime.scheduleRootPlan('plan-a');
  const queuedB = runtime.scheduleRootPlan('plan-b');
  const queuedC = runtime.scheduleRootPlan('plan-c');
  assert.equal(active.status, 'ACTIVE');
  assert.equal(queuedB.status, 'QUEUED');
  assert.equal(queuedC.status, 'QUEUED');
  assert.equal(repositories.plans.getPlan('plan-a').status, 'READY');
  assert.equal(repositories.plans.getPlan('plan-b').status, 'QUEUED');
  assert.equal(repositories.plans.getPlan('plan-c').status, 'QUEUED');
  assert.equal(repositories.supervisors.getByPlanId('plan-a')?.status, 'ACTIVE');
  assert.equal(repositories.supervisors.getByPlanId('plan-b'), undefined);
  assert.equal(repositories.supervisors.getByPlanId('plan-c'), undefined);
  assert.deepEqual(
    repositories.projectPlans.listQueue('bodysense').map((entry) => entry.planId),
    ['plan-b', 'plan-c'],
  );

  const leaseBeforeRestart = repositories.projectPlans.getLease('bodysense')!;
  assert.equal(leaseBeforeRestart.activeRootPlanId, 'plan-a');
  db.close();

  db = openV4Database(dbFile, { environment: 'test' });
  repositories = createRepositories(db);
  runtime = new ProjectPlanQueueRuntime(repositories);
  assert.equal(repositories.projectPlans.getLease('bodysense')?.activeRootPlanId, 'plan-a');

  finish(repositories, 'plan-a');
  const firstHandoff = runtime.reconcile();
  assert.equal(firstHandoff[0]?.activatedPlanId, 'plan-b');
  assert.equal(repositories.projectPlans.getLease('bodysense')?.activeRootPlanId, 'plan-b');
  assert.equal(repositories.plans.getPlan('plan-b').status, 'READY');
  assert.equal(repositories.supervisors.getByPlanId('plan-a')?.status, 'CANCELLED');
  assert.equal(repositories.supervisors.getByPlanId('plan-b')?.status, 'ACTIVE');
  assert.equal(repositories.supervisors.getByPlanId('plan-c'), undefined);

  finish(repositories, 'plan-b');
  runtime.reconcile();
  assert.equal(repositories.projectPlans.getLease('bodysense')?.activeRootPlanId, 'plan-c');
  assert.equal(repositories.plans.getPlan('plan-c').status, 'READY');
  assert.equal(repositories.supervisors.getByPlanId('plan-c')?.status, 'ACTIVE');

  finish(repositories, 'plan-c');
  runtime.reconcile();
  const emptyLease = repositories.projectPlans.getLease('bodysense')!;
  assert.equal(emptyLease.activeRootPlanId, undefined);
  assert.equal(repositories.projectPlans.listQueue('bodysense').length, 0);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('project lease is version fenced, repository bound and cannot be double acquired', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-plan-fence-'));
  const dbFile = path.join(root, 'pixel.sqlite');
  const db1 = openV4Database(dbFile, { environment: 'test' });
  const r1 = createRepositories(db1);
  createRoot(r1, 'plan-a');
  createRoot(r1, 'plan-b');

  const db2 = openV4Database(dbFile, { environment: 'test' });
  const r2 = createRepositories(db2);
  const first = r1.projectPlans.tryAcquire('bodysense', 'plan-a', 0);
  assert.equal(first.status, 'created');
  const stale = r2.projectPlans.tryAcquire('bodysense', 'plan-b', 0);
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.reason, 'STALE_VERSION');

  const lease = r1.projectPlans.getLease('bodysense')!;
  const renewed = r1.projectPlans.renew('bodysense', 'plan-a', lease.version);
  assert.equal(renewed.value?.version, lease.version + 1);
  const staleRenew = r2.projectPlans.renew('bodysense', 'plan-a', lease.version);
  assert.equal(staleRenew.status, 'rejected');
  assert.equal(staleRenew.reason, 'STALE_VERSION');

  createRoot(r1, 'wrong-repo', 'bodysense', '/home/dev/projects/other-bodysense');
  assert.throws(
    () => r1.projectPlans.scheduleRootPlan('wrong-repo'),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'PROJECT_PLAN_REPOSITORY_MISMATCH',
  );

  db2.close();
  db1.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('queued plan reprioritization is deterministic and cancellation provisions no supervisor', () => {
  const db = openV4Database(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const runtime = new ProjectPlanQueueRuntime(repositories);
  createRoot(repositories, 'plan-a');
  createRoot(repositories, 'plan-b');
  createRoot(repositories, 'plan-c');
  runtime.scheduleRootPlan('plan-a');
  runtime.scheduleRootPlan('plan-b');
  runtime.scheduleRootPlan('plan-c');

  repositories.projectPlans.reprioritize('plan-c', 10);
  assert.deepEqual(
    repositories.projectPlans.listQueue('bodysense').map((entry) => entry.planId),
    ['plan-c', 'plan-b'],
  );
  runtime.cancelQueued('plan-c');
  assert.equal(repositories.plans.getPlan('plan-c').status, 'CANCELLED');
  assert.equal(repositories.supervisors.getByPlanId('plan-c'), undefined);
  assert.deepEqual(
    repositories.projectPlans.listQueue('bodysense').map((entry) => entry.planId),
    ['plan-b'],
  );
  db.close();
});

test('schema v6 migrates additively to the single-active-plan scheduling schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-plan-schema-'));
  const dbFile = path.join(root, 'pixel.sqlite');
  const current = openV4Database(dbFile, { environment: 'test' });
  current.exec('DROP TABLE project_plan_queue; DROP TABLE project_plan_leases;');
  current.prepare("UPDATE schema_meta SET schema_version=6 WHERE schema_id='pixel-v4'").run();
  current.close();

  const migrated = openV4Database(dbFile, { environment: 'test' });
  assert.equal(
    migrated.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()
      ?.schema_version,
    SCHEMA_VERSION,
  );
  const tables = new Set(
    (
      migrated.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  assert.equal(tables.has('project_plan_leases'), true);
  assert.equal(tables.has('project_plan_queue'), true);
  migrated.close();
  fs.rmSync(root, { recursive: true, force: true });
});
