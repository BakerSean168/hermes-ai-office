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
    fetchImpl: (async () => { providerCalled = true; throw new Error('provider should not launch in first plan cycle'); }) as typeof fetch,
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
      MODEL_CP_V4_REVIEW_ROUTES: 'gpt-5.6-sol',
      MODEL_CP_V4_WORKSPACE_UID: String(process.getuid?.() ?? 0),
      MODEL_CP_V4_WORKSPACE_GID: String(process.getgid?.() ?? 0),
    },
  });
  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.deepEqual(health.json().executionRuntime, {
    enabled: true,
    autonomousPolling: false,
    implementationRoutes: ['gpt-5.6-luna', 'implementation-efficient'],
    reviewRoutes: ['gpt-5.6-sol'],
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
      workItems: [{
        itemKey: 'first',
        title: 'First',
        objective: 'Implement first item',
        dependencies: [],
        acceptanceCriteria: ['commit the change', 'pass review'],
      }],
    },
  });
  assert.equal(created.statusCode, 201);
  const planId = created.json().plan.planId as string;
  const run = await runtime.app.inject({ method: 'POST', url: '/api/v4/plans/' + planId + '/run' });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().code, 'IMPLEMENTATION_QUEUED');
  assert.equal(providerCalled, false);
  const state = await runtime.app.inject({ method: 'GET', url: '/api/v4/plans/' + planId });
  assert.equal(state.statusCode, 200);
  const body = state.json();
  assert.equal(body.plan.status, 'RUNNING');
  assert.equal(body.workItems[0].status, 'RUNNING');
  assert.equal(body.executions.length, 1);
  assert.equal(body.executions[0].identity.phase, 'IMPLEMENT');
  assert.equal(body.executions[0].identity.route, 'gpt-5.6-luna');
  assert.equal(body.executions[0].identity.sourceRevision, value.revision);
  assert.equal(body.executions[0].status, 'QUEUED');
  const execution = await runtime.app.inject({ method: 'GET', url: '/api/v4/executions/' + body.executions[0].identity.executionId });
  assert.equal(execution.statusCode, 200);
  assert.equal(execution.json().session, undefined);
  await runtime.app.close();
});
