import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildControlPlane } from '../src/app.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-app-'));
  const allowed = path.join(root, 'repositories');
  const repository = path.join(allowed, 'project');
  const managed = path.join(root, 'managed');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  git(repository, ['config', 'user.name', 'Pixel V4 Test']);
  git(repository, ['config', 'user.email', 'pixel-v4-test@local']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# App test\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'chore: initialize']);
  return { root, allowed, repository, managed, revision: git(repository, ['rev-parse', 'HEAD']) };
}

test('V4 app runtime fails closed when execution automation is disabled', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    env: { NODE_ENV: 'test', MODEL_CP_EXECUTION_RUNTIME_ENABLED: 'false' },
  });
  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().executionRuntime.enabled, false);
  const run = await runtime.app.inject({ method: 'POST', url: '/api/v4/plans/missing/run' });
  assert.equal(run.statusCode, 503);
  assert.equal(run.json().error, 'EXECUTION_RUNTIME_DISABLED');
  await runtime.app.close();
});

test('V4 app creates a durable first execution through the public plan runtime API', async () => {
  const value = fixture();
  let providerCalled = false;
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    fetchImpl: (async () => {
      providerCalled = true;
      throw new Error('provider should not launch in first plan cycle');
    }) as typeof fetch,
    env: {
      NODE_ENV: 'test',
      MODEL_CP_EXECUTION_RUNTIME_ENABLED: 'true',
      MODEL_CP_AUTOMATION_RUNTIME_ENABLED: 'false',
      MODEL_CP_OPENHANDS_URL: 'http://openhands.test',
      SESSION_API_KEY: 'test-session-key',
      LITELLM_V3_KEY: 'test-litellm-key',
      LITELLM_V3_BASE_URL: 'http://litellm.test/v1',
      MODEL_CP_V4_ALLOWED_REPOSITORY_ROOTS: value.allowed,
      MODEL_CP_V4_WORKSPACE_HOST_ROOT: value.managed,
      MODEL_CP_V4_WORKSPACE_EXECUTION_ROOT: '/workspace',
      MODEL_CP_V4_IMPLEMENTATION_ROUTES: 'gpt-5.6-luna,implementation-efficient',
      MODEL_CP_V4_REVIEW_ROUTES: 'codex-business-review=gpt-5.6-sol,gpt-5.6-sol,review-glm=glm-5.2',
      MODEL_CP_V4_AUTOMATION_PROJECTS: 'app-runtime-project',
      MODEL_CP_V4_WORKSPACE_UID: String(process.getuid?.() ?? 0),
      MODEL_CP_V4_WORKSPACE_GID: String(process.getgid?.() ?? 0),
    },
  });
  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.deepEqual(health.json().executionRuntime, {
    enabled: true,
    autonomousPolling: false,
    implementationRoutes: ['gpt-5.6-luna', 'implementation-efficient'],
    reviewRoutes: ['codex-business-review', 'gpt-5.6-sol', 'review-glm'],
    automationProjectKeys: ['app-runtime-project'],
    requireDelivery: true,
  });
  const created = await runtime.app.inject({
    method: 'POST',
    url: '/api/v4/plans',
    headers: { 'idempotency-key': 'app-runtime-plan' },
    payload: {
      projectKey: 'app-runtime-project',
      objective: 'exercise public V4 execution creation',
      repositoryPath: value.repository,
      baseRevision: value.revision,
      workItems: [
        {
          itemKey: 'first',
          title: 'First',
          objective: 'Implement first item',
          dependencies: [],
          acceptanceCriteria: ['commit the change', 'pass review'],
        },
      ],
    },
  });
  assert.equal(created.statusCode, 201);
  const planId = created.json().plan.planId as string;
  const delivery = {
    remote: 'origin',
    branch: 'pixel/app-runtime-plan',
    targetBranch: 'main',
    autoMerge: false,
    mergeMethod: 'merge',
    requiredChecks: [],
  };
  const attached = await runtime.app.inject({
    method: 'POST', url: '/api/v4/plans/' + planId + '/delivery', payload: delivery,
  });
  assert.equal(attached.statusCode, 201);
  assert.equal(attached.json().delivery.status, 'PENDING');
  const attachedAgain = await runtime.app.inject({
    method: 'POST', url: '/api/v4/plans/' + planId + '/delivery', payload: delivery,
  });
  assert.equal(attachedAgain.statusCode, 200);
  const child = await runtime.app.inject({
    method: 'POST',
    url: '/api/v4/plans/' + planId + '/children',
    payload: {
      childPlanId: 'app-runtime-child',
      objective: 'repair a delivery base drift',
      relation: 'FOLLOW_UP',
      repositoryPath: value.repository,
      delivery: {
        remote: 'origin', branch: 'pixel/app-runtime-child', targetBranch: 'main',
        autoMerge: false, mergeMethod: 'merge', requiredChecks: [],
      },
      workItems: [{
        itemKey: 'repair', title: 'Repair delivery base', objective: 'merge the target base safely',
        dependencies: [], acceptanceCriteria: ['preserve parent behavior'],
      }],
    },
  });
  assert.equal(child.statusCode, 201);
  assert.equal(child.json().plan.parentPlanId, planId);
  assert.equal(child.json().plan.status, 'READY');
  assert.equal(child.json().plan.delivery.status, 'PENDING');
  assert.equal(child.json().graph.items[0].itemKey, 'repair');
  const parentAfterChild = await runtime.app.inject({ method: 'GET', url: '/api/v4/plans/' + planId });
  assert.ok(parentAfterChild.json().plan.childPlanIds.includes('app-runtime-child'));

  const run = await runtime.app.inject({ method: 'POST', url: '/api/v4/plans/' + planId + '/run' });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().code, 'IMPLEMENTATION_QUEUED');
  assert.equal(providerCalled, false);
  const state = await runtime.app.inject({ method: 'GET', url: '/api/v4/plans/' + planId });
  assert.equal(state.statusCode, 200);
  const body = state.json();
  assert.equal(body.plan.status, 'RUNNING');
  assert.equal(body.delivery.status, 'PENDING');
  assert.equal(body.plan.delivery.status, 'PENDING');
  assert.equal(body.workItems[0].status, 'RUNNING');
  assert.equal(body.executions.length, 1);
  assert.equal(body.executions[0].identity.phase, 'IMPLEMENT');
  assert.equal(body.executions[0].identity.route, 'gpt-5.6-luna');
  assert.equal(body.executions[0].identity.sourceRevision, value.revision);
  assert.equal(body.executions[0].status, 'QUEUED');

  const plans = await runtime.app.inject({
    method: 'GET',
    url: '/api/v4/plans?status=RUNNING&limit=10',
  });
  assert.equal(plans.statusCode, 200);
  assert.equal(plans.json().count, 1);
  assert.equal(plans.json().items[0].plan.planId, planId);
  assert.equal(plans.json().items[0].workItems[0].itemKey, 'first');
  assert.equal(plans.json().items[0].executions.length, 1);

  const planSummaries = await runtime.app.inject({
    method: 'GET',
    url: '/api/v4/plans?view=summary',
  });
  assert.equal(planSummaries.statusCode, 200);
  assert.equal(planSummaries.json().items[0].executions.length, 1);
  assert.equal(planSummaries.json().items[0].sessions, undefined);
  assert.equal(planSummaries.json().items[0].reviews, undefined);
  assert.equal(planSummaries.json().items[0].supervisor, undefined);

  const executions = await runtime.app.inject({
    method: 'GET',
    url: '/api/v4/executions?planId=' + planId + '&status=QUEUED&limit=10',
  });
  assert.equal(executions.statusCode, 200);
  assert.equal(executions.json().count, 1);
  assert.equal(executions.json().items[0].identity.planId, planId);

  const invalidPlanStatus = await runtime.app.inject({
    method: 'GET',
    url: '/api/v4/plans?status=NOT_A_STATUS',
  });
  assert.equal(invalidPlanStatus.statusCode, 400);
  assert.equal(invalidPlanStatus.json().error, 'PLAN_STATUS_INVALID');

  const invalidExecutionStatus = await runtime.app.inject({
    method: 'GET',
    url: '/api/v4/executions?status=NOT_A_STATUS',
  });
  assert.equal(invalidExecutionStatus.statusCode, 400);
  assert.equal(invalidExecutionStatus.json().error, 'EXECUTION_STATUS_INVALID');

  const execution = await runtime.app.inject({
    method: 'GET',
    url: '/api/v4/executions/' + body.executions[0].identity.executionId,
  });
  assert.equal(execution.statusCode, 200);
  assert.equal(execution.json().session, undefined);

  const executionId = body.executions[0].identity.executionId as string;
  const workItemId = body.workItems[0].workItemId as string;
  runtime.repositories.executions.updateStatus(executionId, 'RUNNING');
  runtime.repositories.executions.recordResult(executionId, {
    status: 'FAILED',
    errorCode: 'WORKSPACE_DIRTY',
    retryable: false,
  });
  runtime.repositories.plans.updateWorkItemStatus(workItemId, 'FAILED');
  runtime.repositories.plans.updateStatus(planId, 'FAILED');

  const invalidReconcile = await runtime.app.inject({
    method: 'POST',
    url: '/api/v4/plans/' + planId + '/reconcile',
    payload: { mode: 'force' },
  });
  assert.equal(invalidReconcile.statusCode, 400);
  assert.equal(invalidReconcile.json().error, 'PLAN_RECONCILE_MODE_INVALID');

  const reconcile = await runtime.app.inject({
    method: 'POST',
    url: '/api/v4/plans/' + planId + '/reconcile',
    payload: { mode: 'auto' },
  });
  assert.equal(reconcile.statusCode, 202);
  assert.equal(reconcile.json().code, 'FINALIZATION_RECOVERY_QUEUED');
  assert.equal(reconcile.json().statusUrl, '/api/v4/plans/' + planId);
  assert.notEqual(reconcile.json().executionId, executionId);
  assert.equal(providerCalled, false);

  const recovered = await runtime.app.inject({ method: 'GET', url: '/api/v4/plans/' + planId });
  assert.equal(recovered.json().plan.status, 'RUNNING');
  assert.equal(recovered.json().workItems[0].status, 'RUNNING');
  assert.equal(recovered.json().executions.length, 2);
  assert.equal(recovered.json().executions[0].status, 'FAILED');
  assert.equal(recovered.json().executions[0].errorCode, 'WORKSPACE_DIRTY');
  assert.equal(recovered.json().executions[1].status, 'QUEUED');
  assert.equal(recovered.json().executions[1].identity.parentExecutionId, executionId);
  assert.equal(recovered.json().executions[1].identity.route, 'gpt-5.6-luna');
  await runtime.app.close();
});
