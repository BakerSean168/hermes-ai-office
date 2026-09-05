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

test('V4 health exposes only validated host cache maintenance state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-host-cache-state-'));
  const stateFile = path.join(root, 'host-cache-maintenance.json');
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        checkedAt: '2026-09-05T08:00:00Z',
        action: 'PRUNED_TARGET_REACHED',
        reason: 'SAFE_RECLAIM_COMPLETED',
        freeBytesBefore: 12 * 1024 ** 3,
        freeBytesAfter: 26 * 1024 ** 3,
        activeExecutions: 0,
        triggerFreeBytes: 16 * 1024 ** 3,
        targetFreeBytes: 24 * 1024 ** 3,
        steps: ['BUILDER_CACHE_OLDER_THAN_POLICY'],
        ignoredUntrustedField: 'must-not-project',
      }),
    );
    const runtime = await buildControlPlane({
      dbFile: ':memory:',
      environment: 'test',
      logger: false,
      env: {
        NODE_ENV: 'test',
        MODEL_CP_EXECUTION_RUNTIME_ENABLED: 'false',
        MODEL_CP_V4_HOST_CACHE_STATE_FILE: stateFile,
      },
    });
    try {
      const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
      assert.deepEqual(health.json().hostCacheMaintenance, {
        status: 'AVAILABLE',
        version: 1,
        checkedAt: '2026-09-05T08:00:00Z',
        action: 'PRUNED_TARGET_REACHED',
        reason: 'SAFE_RECLAIM_COMPLETED',
        freeBytesBefore: 12 * 1024 ** 3,
        freeBytesAfter: 26 * 1024 ** 3,
        activeExecutions: 0,
        triggerFreeBytes: 16 * 1024 ** 3,
        targetFreeBytes: 24 * 1024 ** 3,
        steps: ['BUILDER_CACHE_OLDER_THAN_POLICY'],
      });
      const storage = await runtime.app.inject({ method: 'GET', url: '/api/v4/storage' });
      assert.equal(storage.json().hostCacheMaintenance.status, 'AVAILABLE');
      fs.writeFileSync(stateFile, '{"version":1,"action":"UNTRUSTED"}\n');
      const invalid = await runtime.app.inject({ method: 'GET', url: '/api/health' });
      assert.deepEqual(invalid.json().hostCacheMaintenance, { status: 'INVALID' });
    } finally {
      await runtime.app.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
      MODEL_CP_V4_AUTOMATION_PROJECTS: 'app-runtime-project',
      MODEL_CP_V4_WORKSPACE_UID: String(process.getuid?.() ?? 0),
      MODEL_CP_V4_WORKSPACE_GID: String(process.getgid?.() ?? 0),
    },
  });
  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.deepEqual(health.json().executionRuntime, {
    enabled: true,
    autonomousPolling: false,
    resourceSelectorEnabled: false,
    resourceCount: 2,
    runtimeAdmission: {
      enabled: false,
      checked: 0,
      ready: 0,
      unready: 0,
      implementationReady: 0,
      reviewReady: 0,
    },
    routingAuthority: 'LEGACY_ROUTE_LIST',
    compatibilityImplementationRoutes: ['gpt-5.6-luna'],
    compatibilityReviewRoutes: ['codex-business-review', 'gpt-5.6-sol'],
    implementationRoutes: ['gpt-5.6-luna'],
    reviewRoutes: ['codex-business-review', 'gpt-5.6-sol'],
    automationProjectKeys: ['app-runtime-project'],
    literalWorktreeProjectKeys: [],
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
    method: 'POST',
    url: '/api/v4/plans/' + planId + '/delivery',
    payload: delivery,
  });
  assert.equal(attached.statusCode, 201);
  assert.equal(attached.json().delivery.status, 'PENDING');
  const attachedAgain = await runtime.app.inject({
    method: 'POST',
    url: '/api/v4/plans/' + planId + '/delivery',
    payload: delivery,
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
        remote: 'origin',
        branch: 'pixel/app-runtime-child',
        targetBranch: 'main',
        autoMerge: false,
        mergeMethod: 'merge',
        requiredChecks: [],
      },
      workItems: [
        {
          itemKey: 'repair',
          title: 'Repair delivery base',
          objective: 'merge the target base safely',
          dependencies: [],
          acceptanceCriteria: ['preserve parent behavior'],
        },
      ],
    },
  });
  assert.equal(child.statusCode, 201);
  assert.equal(child.json().plan.parentPlanId, planId);
  assert.equal(child.json().plan.status, 'READY');
  assert.equal(child.json().plan.delivery.status, 'PENDING');
  assert.equal(child.json().graph.items[0].itemKey, 'repair');
  const parentAfterChild = await runtime.app.inject({
    method: 'GET',
    url: '/api/v4/plans/' + planId,
  });
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

test('V4 resource selector creates immutable execution provenance and resource controls gate later plans', async () => {
  const value = fixture();
  const adminEnv = path.join(value.root, 'litellm.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  let providerCalled = false;
  let statePatchCalls = 0;
  let deploymentBlocked = false;
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/model/info')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: 'route-free-deepseek-v4-flash',
              litellm_params: { litellm_credential_name: 'free-provider' },
              model_info: {
                id: 'deployment-free-deepseek',
                blocked: deploymentBlocked,
                metadata: {
                  automatic_core: true,
                  resource_id: 'free-provider',
                  resource_sequence: 101,
                  model_family: 'deepseek-v4-flash',
                  route_model: 'route-free-deepseek-v4-flash',
                  protocol: 'openai-chat-completions',
                  commercial_type: 'FREE',
                  supply_origin: 'COMMUNITY_RELAY',
                  resource_lifecycle: 'RECURRING',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/model/deployment-free-deepseek/update') && init.method === 'PATCH') {
      statePatchCalls += 1;
      const body = JSON.parse(String(init.body));
      assert.equal(typeof body.blocked, 'boolean');
      deploymentBlocked = body.blocked;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    providerCalled = true;
    throw new Error('provider should not launch while only creating an execution');
  }) as typeof fetch;
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env: {
      NODE_ENV: 'test',
      MODEL_CP_EXECUTION_RUNTIME_ENABLED: 'true',
      MODEL_CP_AUTOMATION_RUNTIME_ENABLED: 'false',
      MODEL_CP_V4_RESOURCE_SELECTOR_ENABLED: 'true',
      // Deliberately conflicting legacy route lists prove selector mode never
      // reads or validates the rollback-only route authority.
      MODEL_CP_V4_IMPLEMENTATION_ROUTES: 'must-not-be-read',
      MODEL_CP_V4_REVIEW_ROUTES: 'must-not-be-read',
      MODEL_CP_V4_BUSINESS_RESOURCE_ENABLED: 'false',
      MODEL_CP_OPENHANDS_URL: 'http://openhands.test',
      SESSION_API_KEY: 'test-session-key',
      LITELLM_V3_KEY: 'test-litellm-key',
      LITELLM_V3_BASE_URL: 'http://litellm.test/v1',
      MODEL_CP_V4_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
      MODEL_CP_LITELLM_ADMIN_ENV_FILE: adminEnv,
      MODEL_CP_V4_ALLOWED_REPOSITORY_ROOTS: value.allowed,
      MODEL_CP_V4_WORKSPACE_HOST_ROOT: value.managed,
      MODEL_CP_V4_WORKSPACE_EXECUTION_ROOT: '/workspace',
      MODEL_CP_V4_AUTOMATION_PROJECTS: 'app-runtime-project',
      MODEL_CP_V4_WORKSPACE_UID: String(process.getuid?.() ?? 0),
      MODEL_CP_V4_WORKSPACE_GID: String(process.getgid?.() ?? 0),
    },
  });

  assert.equal(runtime.automation?.worker.requireResourceSelection, true);
  assert.equal(runtime.automation?.worker.routes.size, 0);
  assert.deepEqual(runtime.automation?.compatibilityImplementationRoutes, []);
  assert.deepEqual(runtime.automation?.compatibilityReviewRoutes, []);
  assert.deepEqual(runtime.automation?.implementationRoutes, [
    'deepseek-v4-flash',
    'glm-current',
    'gpt-5.6-luna',
  ]);
  assert.deepEqual(runtime.automation?.reviewRoutes, [
    'gpt-5.6-sol',
    'claude-opus-5',
    'claude-opus-4-8',
  ]);
  const selectorHealth = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(selectorHealth.json().executionRuntime.routingAuthority, 'RESOURCE_SELECTOR');
  assert.deepEqual(selectorHealth.json().executionRuntime.compatibilityImplementationRoutes, []);
  assert.deepEqual(selectorHealth.json().executionRuntime.compatibilityReviewRoutes, []);

  const resources = await runtime.app.inject({ method: 'GET', url: '/api/v4/resources' });
  assert.equal(resources.statusCode, 200);
  assert.equal(resources.json().count, 3);
  const free = resources.json().items.find((item: any) => item.resourceId === 'free-provider');
  assert.equal(free.resourceTier, 'FREE');
  assert.equal(free.resourceSequence, 101);
  assert.equal(free.modelBindings[0].agentBackend, 'dsh-acp');

  const createPlan = async (key: string) => {
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v4/plans',
      headers: { 'idempotency-key': key },
      payload: {
        projectKey: 'app-runtime-project',
        objective: 'exercise resource routing',
        repositoryPath: value.repository,
        baseRevision: value.revision,
        workItems: [
          {
            itemKey: 'first',
            title: 'First',
            objective: 'Implement first item',
            dependencies: [],
            acceptanceCriteria: ['commit the change'],
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    return created.json().plan.planId as string;
  };

  const planId = await createPlan('selector-plan');
  const run = await runtime.app.inject({ method: 'POST', url: `/api/v4/plans/${planId}/run` });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().code, 'IMPLEMENTATION_QUEUED');
  assert.equal(providerCalled, false);
  const state = await runtime.app.inject({ method: 'GET', url: `/api/v4/plans/${planId}` });
  const execution = state.json().executions[0];
  assert.match(execution.identity.route, /^resource:free-provider:/);
  assert.equal(execution.resourceSelection.resourceId, 'free-provider');
  assert.equal(execution.resourceSelection.modelFamily, 'deepseek-v4-flash');
  assert.equal(execution.resourceSelection.agentBackend, 'dsh-acp');
  assert.equal(execution.resourceSelection.routeModel, 'route-free-deepseek-v4-flash');

  const bindingDisabled = await runtime.app.inject({
    method: 'POST',
    url: '/api/v4/resources/free-provider/bindings/deployment-free-deepseek/state',
    payload: { state: 'DISABLED' },
  });
  assert.equal(bindingDisabled.statusCode, 200);
  assert.equal(bindingDisabled.json().resource.modelBindings[0].enabled, false);
  const bindingEnabled = await runtime.app.inject({
    method: 'POST',
    url: '/api/v4/resources/free-provider/bindings/deployment-free-deepseek/state',
    payload: { state: 'ACTIVE' },
  });
  assert.equal(bindingEnabled.statusCode, 200);
  assert.equal(bindingEnabled.json().resource.modelBindings[0].enabled, true);

  const disabled = await runtime.app.inject({
    method: 'POST',
    url: '/api/v4/resources/free-provider/state',
    payload: { state: 'DISABLED', reason: 'operator test', expectedVersion: 0 },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().resource.state, 'DISABLED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statePatchCalls, 3);
  assert.equal(deploymentBlocked, true);

  const waitingPlanId = await createPlan('selector-waiting-plan');
  const waiting = await runtime.app.inject({
    method: 'POST',
    url: `/api/v4/plans/${waitingPlanId}/run`,
  });
  assert.equal(waiting.statusCode, 200);
  assert.equal(waiting.json().code, 'WAITING_FOR_RESOURCE');
  const waitingState = await runtime.app.inject({
    method: 'GET',
    url: `/api/v4/plans/${waitingPlanId}`,
  });
  assert.equal(waitingState.json().plan.status, 'WAITING_FOR_RESOURCE');
  await runtime.app.close();
});

test('selector-off rollback preserves durable selector provenance in the same V4 database', async () => {
  const value = fixture();
  const dbFile = path.join(value.root, 'rollback.sqlite');
  const adminEnv = path.join(value.root, 'litellm.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  const commonEnv = {
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
    MODEL_CP_V4_AUTOMATION_PROJECTS: 'rollback-project',
    MODEL_CP_V4_WORKSPACE_UID: String(process.getuid?.() ?? 0),
    MODEL_CP_V4_WORKSPACE_GID: String(process.getgid?.() ?? 0),
  };
  const selectorFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/model/info')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: 'route-rollback-deepseek-v4-flash',
              litellm_params: { litellm_credential_name: 'rollback-free' },
              model_info: {
                id: 'deployment-rollback-deepseek',
                blocked: false,
                metadata: {
                  automatic_core: true,
                  resource_id: 'rollback-free',
                  resource_sequence: 77,
                  model_family: 'deepseek-v4-flash',
                  route_model: 'route-rollback-deepseek-v4-flash',
                  protocol: 'openai-chat-completions',
                  commercial_type: 'FREE',
                  supply_origin: 'COMMUNITY_RELAY',
                  resource_lifecycle: 'RECURRING',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected selector rollback fetch: ${url}`);
  }) as typeof fetch;

  try {
    const selectorRuntime = await buildControlPlane({
      dbFile,
      environment: 'test',
      logger: false,
      fetchImpl: selectorFetch,
      env: {
        ...commonEnv,
        MODEL_CP_V4_RESOURCE_SELECTOR_ENABLED: 'true',
        MODEL_CP_V4_BUSINESS_RESOURCE_ENABLED: 'false',
        MODEL_CP_V4_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
        MODEL_CP_LITELLM_ADMIN_ENV_FILE: adminEnv,
      },
    });
    let planId = '';
    let executionId = '';
    try {
      const created = await selectorRuntime.app.inject({
        method: 'POST',
        url: '/api/v4/plans',
        headers: { 'idempotency-key': 'selector-rollback-plan' },
        payload: {
          projectKey: 'rollback-project',
          objective: 'prove selector rollback durability',
          repositoryPath: value.repository,
          baseRevision: value.revision,
          workItems: [
            {
              itemKey: 'first',
              title: 'First',
              objective: 'Create one immutable selector decision',
              dependencies: [],
              acceptanceCriteria: ['persist resource provenance'],
            },
          ],
        },
      });
      assert.equal(created.statusCode, 201);
      planId = created.json().plan.planId as string;
      const run = await selectorRuntime.app.inject({
        method: 'POST',
        url: `/api/v4/plans/${planId}/run`,
      });
      assert.equal(run.statusCode, 200);
      assert.equal(run.json().code, 'IMPLEMENTATION_QUEUED');
      const selected = await selectorRuntime.app.inject({
        method: 'GET',
        url: `/api/v4/plans/${planId}`,
      });
      executionId = selected.json().executions[0].identity.executionId as string;
      assert.equal(selected.json().executions[0].resourceSelection.resourceId, 'rollback-free');
      assert.equal(
        selected.json().executions[0].resourceSelection.routeModel,
        'route-rollback-deepseek-v4-flash',
      );
    } finally {
      await selectorRuntime.app.close();
    }

    const rollbackRuntime = await buildControlPlane({
      dbFile,
      environment: 'test',
      logger: false,
      fetchImpl: (async (input: string | URL | Request) => {
        throw new Error(`rollback startup must not require selector discovery: ${String(input)}`);
      }) as typeof fetch,
      env: {
        ...commonEnv,
        MODEL_CP_V4_RESOURCE_SELECTOR_ENABLED: 'false',
        MODEL_CP_V4_IMPLEMENTATION_ROUTES: 'gpt-5.6-luna',
        MODEL_CP_V4_REVIEW_ROUTES: 'gpt-5.6-sol',
      },
    });
    try {
      const health = await rollbackRuntime.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(health.json().executionRuntime.routingAuthority, 'LEGACY_ROUTE_LIST');
      assert.deepEqual(health.json().executionRuntime.compatibilityImplementationRoutes, [
        'gpt-5.6-luna',
      ]);
      assert.deepEqual(health.json().executionRuntime.compatibilityReviewRoutes, ['gpt-5.6-sol']);

      const restored = await rollbackRuntime.app.inject({
        method: 'GET',
        url: `/api/v4/plans/${planId}`,
      });
      assert.equal(restored.statusCode, 200);
      assert.equal(restored.json().plan.planId, planId);
      const execution = restored
        .json()
        .executions.find((item: any) => item.identity.executionId === executionId);
      assert.ok(execution);
      assert.equal(execution.resourceSelection.resourceId, 'rollback-free');
      assert.equal(execution.resourceSelection.modelFamily, 'deepseek-v4-flash');
      assert.equal(execution.resourceSelection.agentBackend, 'dsh-acp');
      assert.equal(execution.resourceSelection.routeModel, 'route-rollback-deepseek-v4-flash');
      assert.equal(
        rollbackRuntime.repositories.resourceSelections.require(executionId).resourceId,
        'rollback-free',
      );
    } finally {
      await rollbackRuntime.app.close();
    }
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('runtime admission warms in background, single-flights probes, and uses execution-shaped Harness workspaces', async () => {
  const value = fixture();
  const adminEnv = path.join(value.root, 'litellm.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  let releaseProbe!: () => void;
  const probeBlocked = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let providerRequests = 0;
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/model/info')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: 'route-free-deepseek-v4-flash',
              litellm_params: { litellm_credential_name: 'free-provider' },
              model_info: {
                id: 'deployment-free-deepseek',
                blocked: false,
                metadata: {
                  automatic_core: true,
                  resource_id: 'free-provider',
                  resource_sequence: 101,
                  model_family: 'deepseek-v4-flash',
                  route_model: 'route-free-deepseek-v4-flash',
                  protocol: 'openai-chat-completions',
                  commercial_type: 'FREE',
                  supply_origin: 'COMMUNITY_RELAY',
                  resource_lifecycle: 'RECURRING',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    providerRequests += 1;
    if (url.endsWith('/api/conversations') && init.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      const workingDir = String(payload.workspace?.working_dir ?? '');
      assert.match(
        workingDir,
        /^\/workspace\/v4\/executions\/runtime-admission-[a-f0-9]{20}\/repo$/,
      );
      const probeId = workingDir.split('/').at(-2)!;
      const manifestPath = path.join(
        value.managed,
        'v4',
        'executions',
        probeId,
        'repo',
        '.agent-harness.json',
      );
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.id, 'pixel-runtime-admission');
      await probeBlocked;
      throw new Error('intentional blocked runtime probe');
    }
    throw new Error('unexpected provider request: ' + url);
  }) as typeof fetch;

  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env: {
      NODE_ENV: 'test',
      MODEL_CP_EXECUTION_RUNTIME_ENABLED: 'true',
      MODEL_CP_AUTOMATION_RUNTIME_ENABLED: 'false',
      MODEL_CP_V4_RESOURCE_SELECTOR_ENABLED: 'true',
      MODEL_CP_V4_RUNTIME_ADMISSION_ENABLED: 'true',
      MODEL_CP_V4_BUSINESS_RESOURCE_ENABLED: 'false',
      MODEL_CP_OPENHANDS_URL: 'http://openhands.test',
      SESSION_API_KEY: 'test-session-key',
      LITELLM_V3_KEY: 'test-litellm-key',
      LITELLM_V3_BASE_URL: 'http://litellm.test/v1',
      MODEL_CP_V4_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
      MODEL_CP_LITELLM_ADMIN_ENV_FILE: adminEnv,
      MODEL_CP_V4_ALLOWED_REPOSITORY_ROOTS: value.allowed,
      MODEL_CP_V4_WORKSPACE_HOST_ROOT: value.managed,
      MODEL_CP_V4_WORKSPACE_EXECUTION_ROOT: '/workspace',
      MODEL_CP_V4_AUTOMATION_PROJECTS: 'app-runtime-project',
      MODEL_CP_V4_WORKSPACE_UID: String(process.getuid?.() ?? 0),
      MODEL_CP_V4_WORKSPACE_GID: String(process.getgid?.() ?? 0),
      MODEL_CP_V4_RESOURCE_REFRESH_MS: '3600000',
    },
  });

  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().executionRuntime.runtimeAdmission.enabled, true);
  assert.equal(health.json().executionRuntime.runtimeAdmission.checked, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerRequests, 1);

  const first = runtime.automation!.reconcileRuntimeAdmission();
  const second = runtime.automation!.reconcileRuntimeAdmission();
  releaseProbe();
  await Promise.all([first, second]);
  assert.equal(providerRequests, 1);
  assert.equal(runtime.automation!.runtimeAdmission.summary().checked, 1);
  assert.equal(runtime.automation!.runtimeAdmission.summary().unready, 1);
  await runtime.app.close();
});

test('single-active-plan API queues later root tasks without supervisor or execution activity and hands off atomically', async () => {
  const value = fixture();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    env: {
      NODE_ENV: 'test',
      MODEL_CP_EXECUTION_RUNTIME_ENABLED: 'false',
      MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED: 'true',
      MODEL_CP_V4_LITERAL_WORKTREES_ENABLED: 'false',
    },
  });

  const createRoot = async (key: string, objective: string) => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v4/plans',
      headers: { 'idempotency-key': key },
      payload: {
        projectKey: 'bodysense',
        objective,
        repositoryPath: value.repository,
        baseRevision: value.revision,
        workItems: [
          {
            itemKey: 'objective',
            title: objective,
            objective,
            dependencies: [],
            acceptanceCriteria: ['complete safely'],
          },
        ],
      },
    });
    assert.equal(response.statusCode, 201);
    return response.json();
  };

  const first = await createRoot('single-active-a', 'active root task');
  const second = await createRoot('single-active-b', 'queued root task');
  const firstPlanId = first.plan.planId as string;
  const secondPlanId = second.plan.planId as string;

  assert.equal(first.plan.status, 'READY');
  assert.equal(first.scheduling.status, 'ACTIVE');
  assert.equal(first.supervisor.status, 'ACTIVE');
  assert.equal(second.plan.status, 'QUEUED');
  assert.equal(second.scheduling.status, 'QUEUED');
  assert.equal(second.supervisor, null);
  assert.equal(runtime.repositories.executions.listByPlan(secondPlanId).length, 0);
  assert.equal(runtime.repositories.supervisors.getByPlanId(secondPlanId), undefined);

  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().planScheduling.singleActivePlanEnabled, true);
  assert.equal(health.json().planScheduling.literalWorktreesEnabled, false);
  assert.equal(health.json().planScheduling.leases[0].activeRootPlanId, firstPlanId);
  assert.equal(health.json().planScheduling.leases[0].queuedPlans, 1);

  const queue = await runtime.app.inject({
    method: 'GET',
    url: '/api/v4/projects/bodysense/plan-queue',
  });
  assert.equal(queue.statusCode, 200);
  assert.equal(queue.json().lease.activeRootPlanId, firstPlanId);
  assert.deepEqual(
    queue.json().items.map((item: { planId: string }) => item.planId),
    [secondPlanId],
  );

  runtime.repositories.plans.updateStatus(firstPlanId, 'RUNNING');
  runtime.repositories.plans.updateStatus(firstPlanId, 'SUCCEEDED');
  const handoff = await runtime.projectPlanQueue!.reconcile();
  assert.equal(handoff[0]?.releasedPlanId, firstPlanId);
  assert.equal(handoff[0]?.activatedPlanId, secondPlanId);
  assert.equal(runtime.repositories.plans.getPlan(secondPlanId).status, 'READY');
  assert.equal(runtime.repositories.supervisors.getByPlanId(firstPlanId)?.status, 'CANCELLED');
  assert.equal(runtime.repositories.supervisors.getByPlanId(secondPlanId)?.status, 'ACTIVE');
  assert.equal(runtime.repositories.executions.listByPlan(secondPlanId).length, 0);

  const after = await runtime.app.inject({
    method: 'GET',
    url: '/api/v4/projects/bodysense/plan-queue',
  });
  assert.equal(after.json().lease.activeRootPlanId, secondPlanId);
  assert.equal(after.json().items.length, 0);
  await runtime.app.close();
});

test('literal worktree canary is project-scoped and keeps legacy projects on isolated clones', async () => {
  const value = fixture();
  const harnessctl = path.join(value.root, 'fake-harnessctl.py');
  fs.writeFileSync(
    harnessctl,
    [
      'import pathlib, sys',
      'project = pathlib.Path(sys.argv[2])',
      "manifest = project / '.agent-harness.json'",
      'sys.exit(0 if manifest.is_file() else 3)',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(value.repository, '.agent-harness.json'),
    JSON.stringify({
      version: 1,
      id: 'literal-project',
      sharedMcpProfile: 'common',
      packs: [],
      capabilities: [],
    }) + '\n',
  );
  git(value.repository, ['add', '.agent-harness.json']);
  git(value.repository, ['commit', '-m', 'chore: register literal harness']);
  const literalRevision = git(value.repository, ['rev-parse', 'HEAD']);
  const legacyRepository = path.join(value.allowed, 'legacy-project');
  fs.mkdirSync(legacyRepository, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', legacyRepository]);
  git(legacyRepository, ['config', 'user.name', 'Pixel V4 Test']);
  git(legacyRepository, ['config', 'user.email', 'pixel-v4-test@local']);
  fs.writeFileSync(path.join(legacyRepository, 'README.md'), '# Legacy\n');
  git(legacyRepository, ['add', 'README.md']);
  git(legacyRepository, ['commit', '-m', 'chore: initialize legacy']);
  const legacyRevision = git(legacyRepository, ['rev-parse', 'HEAD']);

  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    fetchImpl: (async () => {
      throw new Error('provider should not be called');
    }) as typeof fetch,
    env: {
      NODE_ENV: 'test',
      MODEL_CP_EXECUTION_RUNTIME_ENABLED: 'true',
      MODEL_CP_AUTOMATION_RUNTIME_ENABLED: 'false',
      MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED: 'true',
      MODEL_CP_V4_LITERAL_WORKTREES_ENABLED: 'true',
      MODEL_CP_V4_LITERAL_WORKTREE_PROJECTS: 'literal-project',
      MODEL_CP_AGENT_HARNESS_CTL: harnessctl,
      MODEL_CP_V4_MAX_PARALLEL_WORK_ITEMS: '2',
      MODEL_CP_OPENHANDS_URL: 'http://openhands.test',
      SESSION_API_KEY: 'test-session-key',
      LITELLM_V3_KEY: 'test-litellm-key',
      LITELLM_V3_BASE_URL: 'http://litellm.test/v1',
      MODEL_CP_V4_ALLOWED_REPOSITORY_ROOTS: value.allowed,
      MODEL_CP_V4_WORKSPACE_HOST_ROOT: value.managed,
      MODEL_CP_V4_WORKSPACE_EXECUTION_ROOT: '/workspace',
      MODEL_CP_V4_AUTOMATION_PROJECTS: 'literal-project,legacy-project',
      MODEL_CP_V4_WORKSPACE_UID: String(process.getuid?.() ?? 1000),
      MODEL_CP_V4_WORKSPACE_GID: String(process.getgid?.() ?? 1000),
    },
  });

  const create = async (
    key: string,
    projectKey: string,
    repositoryPath: string,
    baseRevision: string,
  ) => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v4/plans',
      headers: { 'idempotency-key': key },
      payload: {
        projectKey,
        objective: 'canary ' + projectKey,
        repositoryPath,
        baseRevision,
        workItems: [
          {
            itemKey: 'first',
            title: 'First',
            objective: 'implement',
            dependencies: [],
            acceptanceCriteria: ['pass'],
            parallelSafe: true,
            writeScopes: ['src/' + projectKey],
          },
        ],
      },
    });
    assert.equal(response.statusCode, 201);
    return response.json();
  };

  const literal = await create(
    'literal-plan',
    'literal-project',
    value.repository,
    literalRevision,
  );
  const legacy = await create('legacy-plan', 'legacy-project', legacyRepository, legacyRevision);
  assert.deepEqual(runtime.automation?.literalWorktreeProjectKeys, ['literal-project']);
  assert.equal(runtime.automation?.policy.resolve('literal-project')?.maxParallelWorkItems, 2);
  assert.equal(runtime.automation?.policy.resolve('legacy-project')?.maxParallelWorkItems, 1);

  const provision = async (body: any, executionId: string, sourceRevision: string) => {
    const planId = body.plan.planId as string;
    const workItemId = body.graph.items[0].workItemId as string;
    runtime.repositories.executions.create({
      executionId,
      idempotencyKey: executionId,
      identity: {
        executionId,
        planId,
        workItemId,
        phase: 'IMPLEMENT',
        attempt: 1,
        route: 'gpt-5.6-luna',
        sourceRevision,
      },
      objective: 'implement',
    });
    return await runtime.automation!.workspace.provision({
      executionId,
      planId,
      projectKey: body.plan.projectKey,
      workItemId,
      repositoryPath: body.plan.repositoryPath,
      sourceRevision,
      phase: 'IMPLEMENT',
    });
  };
  const literalWorkspace = await provision(literal, 'exec-literal-canary', literalRevision);
  const legacyWorkspace = await provision(legacy, 'exec-legacy-canary', legacyRevision);
  assert.match(literalWorkspace.executionPath, /^\/workspace\/v4\/plans\/literal-project\//);
  assert.equal(legacyWorkspace.executionPath, '/workspace/v4/executions/exec-legacy-canary/repo');
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), literalRevision);
  assert.equal(git(legacyRepository, ['rev-parse', 'HEAD']), legacyRevision);

  await runtime.app.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});
