import assert from 'node:assert/strict';
import test from 'node:test';

import type { Execution } from '../src/v4/domain/execution.js';
import {
  PlanAutomationRuntime,
  StaticPlanAutomationPolicyResolver,
  type ExecutionRunnerPort,
} from '../src/v4/orchestration/planAutomationRuntime.js';
import type { ExecutionWorkerResult } from '../src/v4/orchestration/executionWorker.js';
import type {
  WorkspaceDescriptor,
  WorkspaceProviderPort,
  WorkspaceProvisionInput,
} from '../src/v4/orchestration/contracts.js';
import { openV4Database } from '../src/v4/persistence/database.js';
import { createRepositories, type V4Repositories } from '../src/v4/persistence/repositories.js';

function now(offset = 0): string {
  return new Date(Date.now() + offset).toISOString();
}

function seed(items: Array<{ itemKey: string; dependencies?: string[] }> = [{ itemKey: 'first' }]) {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    idempotencyKey: 'automation-plan',
    projectKey: 'automation-project',
    objective: 'complete the autonomous plan',
    repositoryPath: '/repositories/automation-project',
    baseRevision: 'base-sha',
  }).value!;
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'automation graph',
  }).value!;
  for (const item of items) {
    repositories.plans.appendGraphWorkItem({
      graphVersionId: graph.graphVersionId,
      itemKey: item.itemKey,
      title: item.itemKey,
      objective: 'complete ' + item.itemKey,
      acceptanceCriteria: ['tests pass', 'independent review passes'],
      dependencies: item.dependencies ?? [],
    });
  }
  repositories.plans.updateStatus(plan.planId, 'READY');
  return { db, repositories, plan: repositories.plans.getPlan(plan.planId), graph };
}

class AutomationWorkspace implements WorkspaceProviderPort {
  repositoryHead = 'base-sha';
  integrateCalls = 0;
  readonly workspaces = new Map<string, WorkspaceDescriptor>();

  async observeRepository(repositoryPath: string, revision: string) {
    return {
      repositoryPath,
      rootPath: repositoryPath,
      headRevision: this.repositoryHead,
      clean: true,
      commitExists: this.repositoryHead === revision,
      observedAt: now(),
    };
  }

  async provision(input: WorkspaceProvisionInput): Promise<WorkspaceDescriptor> {
    const existing = this.workspaces.get(input.executionId);
    if (existing) return existing;
    const workspace: WorkspaceDescriptor = {
      executionId: input.executionId,
      hostPath: '/managed/' + input.executionId + '/repo',
      executionPath: '/workspace/' + input.executionId + '/repo',
      evidenceHostPath: '/managed/' + input.executionId + '/completion-evidence.json',
      evidenceExecutionPath: '/workspace/' + input.executionId + '/completion-evidence.json',
      sourceRepositoryPath: input.repositoryPath,
      sourceRevision: input.sourceRevision,
      createdAt: now(),
    };
    this.workspaces.set(input.executionId, workspace);
    return workspace;
  }

  async verifyImplementation(): Promise<never> {
    throw new Error('not used');
  }
  async verifyReview(): Promise<never> {
    throw new Error('not used');
  }

  async integrateAcceptedRevision(input: {
    repositoryPath: string;
    expectedRevision: string;
    acceptedRevision: string;
    candidateWorkspace: WorkspaceDescriptor;
  }) {
    assert.equal(this.repositoryHead, input.expectedRevision);
    this.integrateCalls += 1;
    this.repositoryHead = input.acceptedRevision;
    return {
      repositoryPath: input.repositoryPath,
      rootPath: input.repositoryPath,
      headRevision: input.acceptedRevision,
      clean: true,
      commitExists: true,
      observedAt: now(),
    };
  }
}

class ScriptedRunner implements ExecutionRunnerPort {
  readonly runCounts = new Map<string, number>();
  readonly implementationRoutes: string[] = [];
  implementationFailures = 0;
  reviewVerdicts: Array<'PASS' | 'FAIL' | 'INVALID'> = ['PASS'];
  implementationRevision = 0;

  constructor(
    readonly repositories: V4Repositories,
    readonly workspace: AutomationWorkspace,
  ) {}

  async runExecution(executionId: string): Promise<ExecutionWorkerResult> {
    const execution = this.repositories.executions.get(executionId);
    this.runCounts.set(executionId, (this.runCounts.get(executionId) ?? 0) + 1);
    if (execution.status !== 'QUEUED' && execution.status !== 'RUNNING')
      return { executionId, status: 'SKIPPED', code: 'terminal' };
    const plan = this.repositories.plans.getPlan(execution.identity.planId);
    const descriptor = await this.workspace.provision({
      executionId,
      repositoryPath: plan.repositoryPath,
      sourceRevision: execution.identity.sourceRevision!,
      phase: execution.identity.phase,
      ...(execution.identity.parentExecutionId
        ? {
            sourceWorkspace: this.repositories.sessions.get(execution.identity.parentExecutionId)
              .workspace,
          }
        : {}),
    });
    const provider =
      execution.identity.phase === 'REVIEW' ? 'scripted-review' : 'scripted-implementation';
    this.repositories.sessions.create({
      executionId,
      phase: execution.identity.phase,
      provider,
      workspace: descriptor,
      sourceRevision: execution.identity.sourceRevision!,
    });
    this.repositories.sessions.attachProviderSession(executionId, provider + '-' + executionId);
    if (execution.status === 'QUEUED')
      this.repositories.executions.updateStatus(executionId, 'RUNNING');
    this.repositories.sessions.updateProviderStatus(executionId, 'RUNNING', now(10));

    if (execution.identity.phase !== 'REVIEW') {
      this.implementationRoutes.push(execution.identity.route);
      if (this.implementationFailures > 0) {
        this.implementationFailures -= 1;
        this.repositories.sessions.complete(executionId, {
          status: 'FAILED',
          errorCode: 'PROVIDER_UNAVAILABLE',
          completedAt: now(20),
        });
        this.repositories.executions.recordResult(executionId, {
          status: 'FAILED',
          errorCode: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        });
        return { executionId, status: 'FAILED', code: 'PROVIDER_UNAVAILABLE' };
      }
      this.implementationRevision += 1;
      const revision = 'result-sha-' + this.implementationRevision;
      this.repositories.sessions.complete(executionId, {
        status: 'SUCCEEDED',
        finalResponse: 'implemented',
        completedAt: now(20),
      });
      this.repositories.executions.recordResult(executionId, {
        status: 'SUCCEEDED',
        resultRevision: revision,
        resultSummary: 'implemented',
      });
      return { executionId, status: 'SUCCEEDED', code: 'implemented', resultRevision: revision };
    }

    const parent = this.repositories.executions.get(execution.identity.parentExecutionId!);
    const review = this.repositories.reviews.findByImplementationExecution(
      parent.identity.executionId,
    )!;
    this.repositories.reviews.attachReviewerExecution(review.reviewId, executionId);
    const verdict = this.reviewVerdicts.shift() ?? 'PASS';
    this.repositories.sessions.complete(executionId, {
      status: 'SUCCEEDED',
      finalResponse: verdict,
      completedAt: now(20),
    });
    this.repositories.executions.recordResult(executionId, {
      status: 'SUCCEEDED',
      resultRevision: execution.identity.sourceRevision!,
      resultSummary: verdict,
    });
    this.repositories.reviews.updateStatus(review.reviewId, 'RUNNING');
    this.repositories.reviews.recordVerdict(
      review.reviewId,
      verdict,
      verdict === 'PASS' ? [] : ['repair the boundary'],
    );
    return {
      executionId,
      status: 'SUCCEEDED',
      code: 'reviewed',
      resultRevision: execution.identity.sourceRevision,
    };
  }
}

function runtime(
  repositories: V4Repositories,
  runner: ExecutionRunnerPort,
  workspace: WorkspaceProviderPort,
) {
  return new PlanAutomationRuntime(
    repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      implementationRoutes: ['gpt-5.6-luna', 'implementation-efficient', 'glm-5.2'],
      reviewRoutes: ['gpt-5.6-sol', 'review-premium'],
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxRepairCycles: 3,
    }),
  );
}

async function drive(runtime: PlanAutomationRuntime, planId: string, limit = 20) {
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await runtime.runPlan(planId);
    results.push(result);
    if (result.status === 'SUCCEEDED' || result.status === 'FAILED') return results;
  }
  throw new Error('plan did not reach a terminal state');
}

test('plan automation creates one stable first execution and completes only after exact independent review', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace);

  const first = await automation.runPlan(seeded.plan.planId);
  assert.equal(first.code, 'IMPLEMENTATION_QUEUED');
  const repeated = automation.createInitialExecution(
    seeded.repositories.plans.getPlan(seeded.plan.planId),
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]!,
  );
  assert.equal(repeated.identity.executionId, first.executionId);
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 1);

  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.code, 'PLAN_SUCCEEDED');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'SUCCEEDED');
  assert.equal(
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]?.exactAcceptedRevision,
    'result-sha-1',
  );
  assert.equal(workspace.repositoryHead, 'result-sha-1');
  assert.equal(workspace.integrateCalls, 1);
  const executions = seeded.repositories.executions.listByPlan(seeded.plan.planId);
  assert.deepEqual(
    executions.map((execution) => execution.identity.phase),
    ['IMPLEMENT', 'REVIEW'],
  );
  assert.equal(seeded.repositories.reviews.listByPlan(seeded.plan.planId)[0]?.status, 'PASSED');
  seeded.db.close();
});

test('plan automation switches from unavailable Luna to the next implementation route without duplicate work', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.implementationFailures = 1;
  const automation = runtime(seeded.repositories, runner, workspace);
  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.status, 'SUCCEEDED');
  assert.deepEqual(runner.implementationRoutes.slice(0, 2), [
    'gpt-5.6-luna',
    'implementation-efficient',
  ]);
  const implementations = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(implementations.length, 2);
  assert.equal(
    implementations[1]?.identity.parentExecutionId,
    implementations[0]?.identity.executionId,
  );
  assert.equal(implementations[0]?.status, 'FAILED');
  assert.equal(implementations[1]?.status, 'SUCCEEDED');
  seeded.db.close();
});

test('plan automation turns review FAIL into a repair execution and independently re-reviews the repaired SHA', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.reviewVerdicts = ['FAIL', 'PASS'];
  const automation = runtime(seeded.repositories, runner, workspace);
  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.status, 'SUCCEEDED');
  const executions = seeded.repositories.executions.listByPlan(seeded.plan.planId);
  const implementation = executions.find((execution) => execution.identity.phase === 'IMPLEMENT')!;
  const repair = executions.find((execution) => execution.identity.phase === 'IMPLEMENT_FIX')!;
  assert.equal(repair.identity.parentExecutionId, implementation.identity.executionId);
  assert.equal(repair.identity.sourceRevision, implementation.resultRevision);
  assert.equal(repair.resultRevision, 'result-sha-2');
  const reviews = seeded.repositories.reviews.listByPlan(seeded.plan.planId);
  assert.deepEqual(
    reviews.map((review) => review.verdict),
    ['FAIL', 'PASS'],
  );
  assert.deepEqual(
    reviews.map((review) => review.sourceRevision),
    ['result-sha-1', 'result-sha-2'],
  );
  assert.equal(
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]?.exactAcceptedRevision,
    'result-sha-2',
  );
  seeded.db.close();
});

test('plan automation retries an INVALID review without creating a product repair execution', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.reviewVerdicts = ['INVALID', 'PASS'];
  const automation = runtime(seeded.repositories, runner, workspace);
  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.status, 'SUCCEEDED');
  assert.ok(results.some((result) => result.code === 'REVIEW_INVALID_RETRY_QUEUED'));
  const executions = seeded.repositories.executions.listByPlan(seeded.plan.planId);
  assert.equal(
    executions.filter((execution) => execution.identity.phase === 'IMPLEMENT_FIX').length,
    0,
  );
  assert.deepEqual(
    seeded.repositories.reviews.listByPlan(seeded.plan.planId).map((review) => review.verdict),
    ['INVALID', 'PASS'],
  );
  seeded.db.close();
});

test('plan automation advances dependency-ready work sequentially on the accepted plan revision', async () => {
  const seeded = seed([{ itemKey: 'first' }, { itemKey: 'second', dependencies: ['first'] }]);
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace);
  const results = await drive(automation, seeded.plan.planId, 30);
  assert.equal(results.at(-1)?.status, 'SUCCEEDED');
  const items = seeded.repositories.plans.listWorkItems(seeded.plan.planId);
  assert.deepEqual(
    items.map((item) => item.status),
    ['SUCCEEDED', 'SUCCEEDED'],
  );
  assert.deepEqual(
    items.map((item) => item.exactAcceptedRevision),
    ['result-sha-1', 'result-sha-2'],
  );
  const implementations = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(implementations[1]?.identity.sourceRevision, 'result-sha-1');
  assert.equal(workspace.integrateCalls, 2);
  seeded.db.close();
});

test('plan automation replays a completed Git fast-forward after a crash without integrating twice', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace);
  await automation.runPlan(seeded.plan.planId);
  await automation.runPlan(seeded.plan.planId);
  const reviewResult = await automation.runPlan(seeded.plan.planId);
  assert.equal(reviewResult.code, 'PLAN_SUCCEEDED');
  assert.equal(workspace.integrateCalls, 1);

  // Reconstruct the pre-DB-write crash state in a second plan: Git already points to the accepted SHA.
  const replay = seed();
  const replayWorkspace = new AutomationWorkspace();
  const replayRunner = new ScriptedRunner(replay.repositories, replayWorkspace);
  const replayAutomation = runtime(replay.repositories, replayRunner, replayWorkspace);
  await replayAutomation.runPlan(replay.plan.planId);
  await replayAutomation.runPlan(replay.plan.planId);
  const candidate = replay.repositories.executions
    .listByPlan(replay.plan.planId)
    .find((execution) => execution.identity.phase === 'IMPLEMENT')!;
  replayWorkspace.repositoryHead = candidate.resultRevision!;
  const replayResult = await replayAutomation.runPlan(replay.plan.planId);
  assert.equal(replayResult.status, 'SUCCEEDED');
  assert.equal(replayWorkspace.integrateCalls, 0);
  assert.equal(
    replay.repositories.plans.getPlan(replay.plan.planId).currentRevision,
    candidate.resultRevision,
  );
  replay.db.close();
  seeded.db.close();
});

test('plan automation surfaces an active worker failure instead of reporting false activity', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const failingRunner: ExecutionRunnerPort = {
    runExecution: async (executionId) => ({
      executionId,
      status: 'FAILED',
      code: 'WORKSPACE_GIT_COMMAND_FAILED',
    }),
  };
  const automation = runtime(seeded.repositories, failingRunner, workspace);
  const queued = await automation.runPlan(seeded.plan.planId);
  assert.equal(queued.code, 'IMPLEMENTATION_QUEUED');
  const failed = await automation.runPlan(seeded.plan.planId);
  assert.equal(failed.status, 'WAITING');
  assert.equal(failed.code, 'WORKSPACE_GIT_COMMAND_FAILED');
  assert.equal(seeded.repositories.executions.get(failed.executionId!).status, 'QUEUED');
  seeded.db.close();
});

test('plan reconcile recovers a historical non-retryable finalization failure without rewriting the failed execution', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const passiveRunner: ExecutionRunnerPort = {
    runExecution: async (executionId) => ({ executionId, status: 'RUNNING', code: 'RUNNING' }),
  };
  const automation = runtime(seeded.repositories, passiveRunner, workspace);
  const queued = await automation.runPlan(seeded.plan.planId);
  const failedExecutionId = queued.executionId!;
  const failedExecution = seeded.repositories.executions.get(failedExecutionId);
  const item = seeded.repositories.plans.getWorkItem(queued.workItemId!);
  seeded.repositories.executions.updateStatus(failedExecutionId, 'RUNNING');
  seeded.repositories.executions.recordResult(failedExecutionId, {
    status: 'FAILED',
    errorCode: 'WORKSPACE_DIRTY',
    retryable: false,
  });
  seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');

  const reconciled = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(reconciled.status, 'RUNNING');
  assert.equal(reconciled.code, 'FINALIZATION_RECOVERY_QUEUED');
  assert.notEqual(reconciled.executionId, failedExecutionId);
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  assert.equal(seeded.repositories.plans.getWorkItem(item.workItemId).status, 'RUNNING');

  const historical = seeded.repositories.executions.get(failedExecutionId);
  assert.equal(historical.status, 'FAILED');
  assert.equal(historical.errorCode, 'WORKSPACE_DIRTY');
  assert.equal(historical.retryable, false);
  const recovery = seeded.repositories.executions.get(reconciled.executionId!);
  assert.equal(recovery.status, 'QUEUED');
  assert.equal(recovery.identity.phase, 'IMPLEMENT');
  assert.equal(recovery.identity.parentExecutionId, failedExecutionId);
  assert.equal(recovery.identity.sourceRevision, failedExecution.identity.sourceRevision);
  assert.equal(recovery.identity.route, failedExecution.identity.route);
  assert.equal(recovery.identity.attempt, failedExecution.identity.attempt + 1);

  const repeated = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(repeated.executionId, recovery.identity.executionId);
  assert.equal(
    seeded.repositories.executions
      .listByWorkItem(item.workItemId)
      .filter((execution) => execution.identity.phase === 'IMPLEMENT').length,
    2,
  );
  seeded.db.close();
});

test('plan reconcile recovers after a crash that durably queued the retry before reviving plan state', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const passiveRunner: ExecutionRunnerPort = {
    runExecution: async (executionId) => ({ executionId, status: 'RUNNING', code: 'RUNNING' }),
  };
  const automation = runtime(seeded.repositories, passiveRunner, workspace);
  const queued = await automation.runPlan(seeded.plan.planId);
  const failedExecution = seeded.repositories.executions.get(queued.executionId!);
  const item = seeded.repositories.plans.getWorkItem(queued.workItemId!);
  seeded.repositories.executions.updateStatus(failedExecution.identity.executionId, 'RUNNING');
  seeded.repositories.executions.recordResult(failedExecution.identity.executionId, {
    status: 'FAILED',
    errorCode: 'WORKSPACE_DIRTY',
    retryable: false,
  });
  seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');

  const crashRecovery = seeded.repositories.executions.create({
    idempotencyKey: 'simulated-crash-recovery',
    identity: {
      ...failedExecution.identity,
      executionId: 'execution-simulated-crash-recovery',
      parentExecutionId: failedExecution.identity.executionId,
      attempt: failedExecution.identity.attempt + 1,
    },
    objective: failedExecution.objective,
  }).value!;
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'FAILED');
  assert.equal(seeded.repositories.plans.getWorkItem(item.workItemId).status, 'FAILED');

  const reconciled = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(reconciled.code, 'RECOVERY_EXECUTION_ACTIVE');
  assert.equal(reconciled.executionId, crashRecovery.identity.executionId);
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  assert.equal(seeded.repositories.plans.getWorkItem(item.workItemId).status, 'RUNNING');
  assert.equal(seeded.repositories.executions.listByWorkItem(item.workItemId).length, 2);
  seeded.db.close();
});

test('plan reconcile refuses unrelated non-retryable failures and preserves the failed plan', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const passiveRunner: ExecutionRunnerPort = {
    runExecution: async (executionId) => ({ executionId, status: 'RUNNING', code: 'RUNNING' }),
  };
  const automation = runtime(seeded.repositories, passiveRunner, workspace);
  const queued = await automation.runPlan(seeded.plan.planId);
  const executionId = queued.executionId!;
  const item = seeded.repositories.plans.getWorkItem(queued.workItemId!);
  seeded.repositories.executions.updateStatus(executionId, 'RUNNING');
  seeded.repositories.executions.recordResult(executionId, {
    status: 'FAILED',
    errorCode: 'WORKSPACE_RESULT_NOT_DESCENDANT',
    retryable: false,
  });
  seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');

  const result = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'IMPLEMENTATION_NOT_RETRYABLE');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'FAILED');
  assert.equal(seeded.repositories.plans.getWorkItem(item.workItemId).status, 'FAILED');
  assert.equal(seeded.repositories.executions.listByWorkItem(item.workItemId).length, 1);
  seeded.db.close();
});

test('plan automation project allowlist prevents stale plans from becoming writers', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  let calls = 0;
  const runner: ExecutionRunnerPort = {
    runExecution: async (executionId) => {
      calls += 1;
      return { executionId, status: 'RUNNING', code: 'RUNNING' };
    },
  };
  const resolver = new StaticPlanAutomationPolicyResolver(
    {
      implementationRoutes: ['gpt-5.6-luna'],
      reviewRoutes: ['gpt-5.6-sol'],
    },
    {},
    ['memoflow', 'digital-biome'],
  );
  const automation = new PlanAutomationRuntime(seeded.repositories, runner, workspace, resolver);
  const result = await automation.runPlan(seeded.plan.planId);
  assert.equal(result.status, 'WAITING');
  assert.equal(result.code, 'PLAN_POLICY_UNAVAILABLE');
  assert.equal(calls, 0);
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 0);
  seeded.db.close();
});
