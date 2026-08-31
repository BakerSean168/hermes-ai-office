import assert from 'node:assert/strict';
import test from 'node:test';

import { V4Error } from '../src/v4/domain/errors.js';
import { openV4Database } from '../src/v4/persistence/database.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';
import { PlanKernel } from '../src/v4/kernel/planKernel.js';
import { buildBoundedProjection } from '../src/v4/supervisor/projection.js';
import { parseSupervisorDecision } from '../src/v4/supervisor/protocol.js';
import { SupervisorActionExecutor } from '../src/v4/supervisor/executor.js';

function seed() {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repos = createRepositories(db);
  const plan = repos.plans.createPlan({
    idempotencyKey: 'cursor-plan',
    projectKey: 'pixel',
    objective: 'cursor test',
    repositoryPath: '/repo',
    baseRevision: 'base',
  }).value!;
  const graph = repos.plans.createGraphVersion({ planId: plan.planId, reason: 'test' }).value!;
  const item = repos.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'item',
    title: 'Item',
    objective: 'Do item',
    dependencies: [],
    acceptanceCriteria: [],
  }).value!;
  repos.plans.updateStatus(plan.planId, 'READY');
  const supervisor = repos.supervisors.create({ planId: plan.planId }).value!;
  repos.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
  return { db, repos, plan, item, supervisor: repos.supervisors.getById(supervisor.supervisorId) };
}

test('invalid graph input fails before creating or superseding a graph version', () => {
  const { db, repos } = seed();
  const plan = repos.plans.createPlan({
    idempotencyKey: 'invalid-graph-plan',
    projectKey: 'pixel',
    objective: 'invalid graph',
    repositoryPath: '/repo',
    baseRevision: 'base',
  }).value!;
  const kernel = new PlanKernel(repos);
  assert.throws(() => kernel.ensureReadyGraph(plan.planId, [{
    itemKey: 'dependent',
    title: 'Dependent',
    objective: 'depends on missing',
    dependencies: ['missing'],
    acceptanceCriteria: [],
  }]), (error: unknown) => error instanceof V4Error && error.code === 'GRAPH_DEPENDENCY_NOT_FOUND');
  assert.equal(repos.plans.getActiveGraphVersion(plan.planId), undefined);
  db.close();
});

test('durable supervisor observation cursor suppresses a second decision for the same projection', () => {
  const { db, repos, plan, supervisor } = seed();
  const projection = buildBoundedProjection(db, supervisor.supervisorId);
  const make = (idempotencyKey: string) => parseSupervisorDecision(JSON.stringify({
    version: 1,
    planId: plan.planId,
    supervisorId: supervisor.supervisorId,
    observationCursor: projection.cursor,
    projectionDigest: projection.digest,
    idempotencyKey,
    preconditionSnapshot: {},
    action: { type: 'NO_ACTION', payload: { type: 'NO_ACTION', reason: 'wait' } },
  }));
  const executor = new SupervisorActionExecutor(repos.actions, repos.decisions, {}, repos.supervisors);
  assert.equal(executor.execute(make('cursor-action-1'), projection).status, 'SUCCEEDED');
  assert.equal(repos.supervisors.getById(supervisor.supervisorId).observationCursor, projection.cursor);
  const second = executor.execute(make('cursor-action-2'), projection);
  assert.equal(second.status, 'REJECTED');
  assert.equal(second.code, 'STALE_OBSERVATION_CURSOR');
  db.close();
});
