import assert from 'node:assert/strict';
import test from 'node:test';

import { openV4Database } from '../src/v4/persistence/database.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';
import { buildBoundedProjection } from '../src/v4/supervisor/projection.js';
import { parseSupervisorDecision } from '../src/v4/supervisor/protocol.js';
import { SupervisorActionExecutor } from '../src/v4/supervisor/executor.js';

function seed() {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({ idempotencyKey: 'effects-plan', projectKey: 'effects', objective: 'effects', repositoryPath: '/repo', baseRevision: 'base' }).value!;
  const graph = repositories.plans.createGraphVersion({ planId: plan.planId, reason: 'effects' }).value!;
  const item = repositories.plans.appendGraphWorkItem({ graphVersionId: graph.graphVersionId, itemKey: 'first', title: 'First', objective: 'first', dependencies: [], acceptanceCriteria: [] }).value!;
  repositories.plans.updateStatus(plan.planId, 'READY');
  const supervisor = repositories.supervisors.create({ planId: plan.planId }).value!;
  repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
  return { db, repositories, plan: repositories.plans.getPlan(plan.planId), item, supervisor: repositories.supervisors.getById(supervisor.supervisorId) };
}

test('typed CREATE_EXECUTION awaits the kernel effect before recording action success', async () => {
  const seeded = seed();
  const projection = buildBoundedProjection(seeded.db, seeded.supervisor.supervisorId);
  let completed = false;
  const executor = new SupervisorActionExecutor(seeded.repositories.actions, seeded.repositories.decisions, {
    createExecution: async () => {
      await Promise.resolve();
      completed = true;
      return { code: 'EXECUTION_QUEUED', linkedExecutionId: 'execution-created' };
    },
  }, seeded.repositories.supervisors);
  const decision = parseSupervisorDecision(JSON.stringify({
    version: 1,
    planId: seeded.plan.planId,
    supervisorId: seeded.supervisor.supervisorId,
    observationCursor: projection.cursor,
    projectionDigest: projection.digest,
    idempotencyKey: 'create-execution-effect',
    preconditionSnapshot: {},
    action: { type: 'CREATE_EXECUTION', payload: { type: 'CREATE_EXECUTION', workItemId: seeded.item.workItemId, route: 'gpt-5.6-luna' } },
  }));
  const result = await executor.execute(decision, projection);
  assert.equal(completed, true);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.code, 'EXECUTION_QUEUED');
  assert.equal(seeded.repositories.actions.getById(result.actionId).result?.linkedExecutionId, 'execution-created');
  seeded.db.close();
});

test('an async typed effect failure is durably recorded as action failure', async () => {
  const seeded = seed();
  const projection = buildBoundedProjection(seeded.db, seeded.supervisor.supervisorId);
  const executor = new SupervisorActionExecutor(seeded.repositories.actions, seeded.repositories.decisions, {
    createExecution: async () => { throw new Error('provider unavailable'); },
  }, seeded.repositories.supervisors);
  const decision = parseSupervisorDecision(JSON.stringify({
    version: 1,
    planId: seeded.plan.planId,
    supervisorId: seeded.supervisor.supervisorId,
    observationCursor: projection.cursor,
    projectionDigest: projection.digest,
    idempotencyKey: 'create-execution-failure',
    preconditionSnapshot: {},
    action: { type: 'CREATE_EXECUTION', payload: { type: 'CREATE_EXECUTION', workItemId: seeded.item.workItemId, route: 'gpt-5.6-luna' } },
  }));
  const result = await executor.execute(decision, projection);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'ACTION_EXECUTION_FAILED');
  const action = seeded.repositories.actions.getById(result.actionId);
  assert.equal(action.status, 'FAILED');
  assert.match(action.result?.message ?? '', /provider unavailable/);
  seeded.db.close();
});
