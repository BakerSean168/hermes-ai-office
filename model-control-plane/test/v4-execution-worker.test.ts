import assert from 'node:assert/strict';
import test from 'node:test';

import { V4Error } from '../src/v4/domain/errors.js';
import type { Execution } from '../src/v4/domain/execution.js';
import { ExecutionWorker } from '../src/v4/orchestration/executionWorker.js';
import type {
  ExecutionProviderPort,
  ProviderLaunchInput,
  ProviderRecoveryInput,
  ProviderSessionSnapshot,
  ReviewProviderPort,
  WorkspaceCompletionSnapshot,
  WorkspaceDescriptor,
  WorkspaceProviderPort,
  WorkspaceProvisionInput,
} from '../src/v4/orchestration/contracts.js';
import { openV4Database } from '../src/v4/persistence/database.js';
import { createRepositories, type V4Repositories } from '../src/v4/persistence/repositories.js';

function now(offset = 0): string {
  return new Date(Date.now() + offset).toISOString();
}

function seed() {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    idempotencyKey: 'worker-plan',
    projectKey: 'pixel-worker-test',
    objective: 'exercise the execution worker',
    repositoryPath: '/repositories/project',
    baseRevision: 'base-sha',
  }).value!;
  const graph = repositories.plans.createGraphVersion({ planId: plan.planId, reason: 'worker graph' }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'worker-item',
    title: 'Worker item',
    objective: 'Implement and review the worker item',
    acceptanceCriteria: ['implementation committed', 'review passes'],
    dependencies: [],
  }).value!;
  repositories.plans.updateStatus(plan.planId, 'READY');
  repositories.plans.compareAndSetStatus(plan.planId, 'READY', 'RUNNING');
  repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
  return { db, repositories, plan: repositories.plans.getPlan(plan.planId), item: repositories.plans.getWorkItem(item.workItemId) };
}

function createExecution(repositories: V4Repositories, input: {
  executionId: string;
  planId: string;
  workItemId: string;
  phase?: 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'REVIEW';
  parentExecutionId?: string;
  sourceRevision?: string;
  route?: string;
  attempt?: number;
}): Execution {
  return repositories.executions.create({
    idempotencyKey: input.executionId,
    identity: {
      executionId: input.executionId,
      planId: input.planId,
      workItemId: input.workItemId,
      phase: input.phase ?? 'IMPLEMENT',
      parentExecutionId: input.parentExecutionId,
      attempt: input.attempt ?? 1,
      route: input.route ?? 'implementation',
      sourceRevision: input.sourceRevision ?? 'base-sha',
    },
    objective: 'complete ' + input.executionId,
  }).value!;
}

class FakeWorkspace implements WorkspaceProviderPort {
  readonly descriptors = new Map<string, WorkspaceDescriptor>();
  readonly completions = new Map<string, WorkspaceCompletionSnapshot>();
  provisionCalls = 0;

  async observeRepository(repositoryPath: string, revision: string) {
    return { repositoryPath, rootPath: repositoryPath, headRevision: revision, clean: true, commitExists: true, observedAt: now() };
  }

  async provision(input: WorkspaceProvisionInput): Promise<WorkspaceDescriptor> {
    this.provisionCalls += 1;
    const existing = this.descriptors.get(input.executionId);
    if (existing) return existing;
    const descriptor: WorkspaceDescriptor = {
      executionId: input.executionId,
      hostPath: '/managed/' + input.executionId + '/repo',
      executionPath: '/workspace/' + input.executionId + '/repo',
      evidenceHostPath: '/managed/' + input.executionId + '/completion-evidence.json',
      evidenceExecutionPath: '/workspace/' + input.executionId + '/completion-evidence.json',
      sourceRepositoryPath: input.repositoryPath,
      sourceRevision: input.sourceRevision,
      createdAt: now(),
    };
    this.descriptors.set(input.executionId, descriptor);
    return descriptor;
  }

  async verifyImplementation(workspace: WorkspaceDescriptor): Promise<WorkspaceCompletionSnapshot> {
    const completion = this.completions.get(workspace.executionId);
    if (!completion) throw new V4Error('WORKSPACE_EVIDENCE_INVALID');
    return completion;
  }

  async verifyReview(workspace: WorkspaceDescriptor, reviewedSha: string): Promise<WorkspaceCompletionSnapshot> {
    const completion = this.completions.get(workspace.executionId);
    if (!completion || completion.headRevision !== reviewedSha) throw new V4Error('WORKSPACE_REVIEW_SHA_MISMATCH');
    return completion;
  }

  async integrateAcceptedRevision(input: { repositoryPath: string; expectedRevision: string; acceptedRevision: string; candidateWorkspace: WorkspaceDescriptor }) {
    return { repositoryPath: input.repositoryPath, rootPath: input.repositoryPath, headRevision: input.acceptedRevision, clean: true, commitExists: true, observedAt: now() };
  }
}

class FakeProvider implements ExecutionProviderPort {
  readonly provider = 'fake-implementation';
  launchCalls = 0;
  recoverCalls = 0;
  inspectCalls = 0;
  launchSnapshot: ProviderSessionSnapshot = { provider: this.provider, providerSessionId: 'provider-session-1', status: 'RUNNING', observedAt: now(10) };
  recoveredSnapshot?: ProviderSessionSnapshot;
  inspectSnapshot: ProviderSessionSnapshot = { provider: this.provider, providerSessionId: 'provider-session-1', status: 'RUNNING', observedAt: now(20) };
  launchError?: Error;
  lastLaunch?: ProviderLaunchInput;

  async launch(input: ProviderLaunchInput): Promise<ProviderSessionSnapshot> {
    this.launchCalls += 1;
    this.lastLaunch = input;
    if (this.launchError) throw this.launchError;
    return { ...this.launchSnapshot, observedAt: now(10) };
  }

  async recover(_input: ProviderRecoveryInput): Promise<ProviderSessionSnapshot | undefined> {
    this.recoverCalls += 1;
    return this.recoveredSnapshot ? { ...this.recoveredSnapshot, observedAt: now(10) } : undefined;
  }

  async inspect(_providerSessionId: string): Promise<ProviderSessionSnapshot> {
    this.inspectCalls += 1;
    return { ...this.inspectSnapshot, observedAt: now(100 + this.inspectCalls) };
  }
}

class FakeReviewProvider extends FakeProvider implements ReviewProviderPort {
  readonly provider = 'fake-review';
  readonly independentReview = true as const;
}

function implementationCompletion(workspace: WorkspaceDescriptor, resultRevision = 'result-sha'): WorkspaceCompletionSnapshot {
  return {
    workspace,
    clean: true,
    headRevision: resultRevision,
    sourceRevision: workspace.sourceRevision,
    descendantOfSource: true,
    changedFiles: ['src/feature.ts'],
    diffStat: '1 file changed, 2 insertions(+)',
    evidence: {
      version: 1,
      executionId: workspace.executionId,
      phase: 'IMPLEMENT',
      sourceRevision: workspace.sourceRevision,
      resultRevision,
      summary: 'implementation complete',
      tests: [{ command: 'npm test', status: 'PASS', exitCode: 0 }],
    },
    observedAt: now(),
  };
}

function reviewCompletion(workspace: WorkspaceDescriptor, verdict: 'PASS' | 'FAIL' = 'PASS'): WorkspaceCompletionSnapshot {
  return {
    workspace,
    clean: true,
    headRevision: workspace.sourceRevision,
    sourceRevision: workspace.sourceRevision,
    descendantOfSource: true,
    changedFiles: [],
    diffStat: '',
    evidence: {
      version: 1,
      executionId: workspace.executionId,
      phase: 'REVIEW',
      reviewedSha: workspace.sourceRevision,
      verdict,
      findings: verdict === 'PASS' ? [] : ['blocking defect'],
      checks: [{ command: 'npm test', status: verdict === 'PASS' ? 'PASS' : 'FAIL', exitCode: verdict === 'PASS' ? 0 : 1 }],
      summary: verdict === 'PASS' ? 'approved' : 'rejected',
    },
    observedAt: now(),
  };
}

function succeedImplementationSession(repositories: V4Repositories, execution: Execution, workspace: WorkspaceDescriptor, resultRevision = 'result-sha'): void {
  repositories.sessions.create({ executionId: execution.identity.executionId, phase: 'IMPLEMENT', provider: 'fake-implementation', workspace, sourceRevision: execution.identity.sourceRevision! });
  repositories.sessions.attachProviderSession(execution.identity.executionId, 'implementation-session-' + execution.identity.executionId);
  repositories.sessions.updateProviderStatus(execution.identity.executionId, 'RUNNING', now(10));
  repositories.executions.updateStatus(execution.identity.executionId, 'RUNNING');
  repositories.sessions.complete(execution.identity.executionId, { status: 'SUCCEEDED', finalResponse: 'done', completedAt: now(20) });
  repositories.executions.recordResult(execution.identity.executionId, { status: 'SUCCEEDED', resultRevision, resultSummary: 'done' });
}

test('execution worker launches once, persists provider correlation, then completes after restart', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, { executionId: 'exec-implementation', planId: seeded.plan.planId, workItemId: seeded.item.workItemId });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  const worker = new ExecutionWorker(seeded.repositories, workspace, [{ route: 'implementation', provider }], { ownerId: 'worker-one' });

  const launched = await worker.runExecution(execution.identity.executionId);
  assert.equal(launched.status, 'RUNNING');
  assert.equal(provider.launchCalls, 1);
  assert.equal(provider.recoverCalls, 1);
  assert.equal(seeded.repositories.executions.get(execution.identity.executionId).status, 'RUNNING');
  assert.equal(seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId, 'provider-session-1');

  const descriptor = seeded.repositories.sessions.get(execution.identity.executionId).workspace;
  workspace.completions.set(execution.identity.executionId, implementationCompletion(descriptor));
  provider.inspectSnapshot = { provider: provider.provider, providerSessionId: 'provider-session-1', status: 'SUCCEEDED', finalResponse: 'done', observedAt: now(200) };
  const restarted = new ExecutionWorker(seeded.repositories, workspace, [{ route: 'implementation', provider }], { ownerId: 'worker-two' });
  const completed = await restarted.runExecution(execution.identity.executionId);
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(completed.resultRevision, 'result-sha');
  assert.equal(provider.launchCalls, 1);
  assert.equal(seeded.repositories.executions.get(execution.identity.executionId).resultRevision, 'result-sha');
  assert.equal(seeded.repositories.sessions.get(execution.identity.executionId).providerStatus, 'SUCCEEDED');
  assert.ok(seeded.repositories.evidence.listByExecution(execution.identity.executionId).some((item) => item.kind === 'DIFF'));
  seeded.db.close();
});

test('execution worker recovers a provider session after launch response loss without a duplicate launch', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, { executionId: 'exec-response-loss', planId: seeded.plan.planId, workItemId: seeded.item.workItemId });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchError = new Error('connection reset after create');
  provider.recoveredSnapshot = undefined;
  const originalRecover = provider.recover.bind(provider);
  provider.recover = async (input) => {
    const value = await originalRecover(input);
    if (provider.launchCalls > 0) return { provider: provider.provider, providerSessionId: 'recovered-session', status: 'RUNNING', observedAt: now(50) };
    return value;
  };
  const worker = new ExecutionWorker(seeded.repositories, workspace, [{ route: 'implementation', provider }], { ownerId: 'worker-recovery' });
  const result = await worker.runExecution(execution.identity.executionId);
  assert.equal(result.status, 'RUNNING');
  assert.equal(provider.launchCalls, 1);
  assert.equal(provider.recoverCalls, 2);
  assert.equal(seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId, 'recovered-session');
  seeded.db.close();
});

test('execution worker records retryable provider failure and preserves the same durable session', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, { executionId: 'exec-provider-failure', planId: seeded.plan.planId, workItemId: seeded.item.workItemId });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchSnapshot = { provider: provider.provider, providerSessionId: 'failed-session', status: 'FAILED', errorCode: 'ServiceUnavailable', retryable: true, observedAt: now(50) };
  const worker = new ExecutionWorker(seeded.repositories, workspace, [{ route: 'implementation', provider }], { ownerId: 'worker-failure' });
  const result = await worker.runExecution(execution.identity.executionId);
  assert.equal(result.status, 'FAILED');
  assert.equal(seeded.repositories.executions.get(execution.identity.executionId).status, 'FAILED');
  assert.equal(seeded.repositories.executions.get(execution.identity.executionId).retryable, true);
  assert.equal(seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId, 'failed-session');
  assert.equal(seeded.repositories.sessions.get(execution.identity.executionId).providerStatus, 'FAILED');
  seeded.db.close();
});

test('execution worker binds an independent reviewer and persists PASS or FAIL verdict at the exact revision', async () => {
  for (const verdict of ['PASS', 'FAIL'] as const) {
    const seeded = seed();
    const implementation = createExecution(seeded.repositories, { executionId: 'implementation-' + verdict, planId: seeded.plan.planId, workItemId: seeded.item.workItemId });
    const implementationWorkspace: WorkspaceDescriptor = {
      executionId: implementation.identity.executionId,
      hostPath: '/managed/' + implementation.identity.executionId + '/repo',
      executionPath: '/workspace/' + implementation.identity.executionId + '/repo',
      evidenceHostPath: '/managed/' + implementation.identity.executionId + '/completion-evidence.json',
      evidenceExecutionPath: '/workspace/' + implementation.identity.executionId + '/completion-evidence.json',
      sourceRepositoryPath: seeded.plan.repositoryPath,
      sourceRevision: 'base-sha',
      createdAt: now(),
    };
    succeedImplementationSession(seeded.repositories, implementation, implementationWorkspace);
    const review = seeded.repositories.reviews.create({
      idempotencyKey: 'review-' + verdict,
      planId: seeded.plan.planId,
      workItemId: seeded.item.workItemId,
      implementationExecutionId: implementation.identity.executionId,
      sourceRevision: 'result-sha',
    }).value!;
    const reviewer = createExecution(seeded.repositories, {
      executionId: 'reviewer-' + verdict,
      planId: seeded.plan.planId,
      workItemId: seeded.item.workItemId,
      phase: 'REVIEW',
      parentExecutionId: implementation.identity.executionId,
      sourceRevision: 'result-sha',
      route: 'review',
    });
    const workspace = new FakeWorkspace();
    const provider = new FakeReviewProvider();
    provider.launchSnapshot = { provider: provider.provider, providerSessionId: 'review-session-' + verdict, status: 'SUCCEEDED', finalResponse: verdict, observedAt: now(100) };
    const descriptor = await workspace.provision({ executionId: reviewer.identity.executionId, repositoryPath: seeded.plan.repositoryPath, sourceRevision: 'result-sha', phase: 'REVIEW', sourceWorkspace: implementationWorkspace });
    workspace.completions.set(reviewer.identity.executionId, reviewCompletion(descriptor, verdict));
    const worker = new ExecutionWorker(seeded.repositories, workspace, [{ route: 'review', provider }], { ownerId: 'review-worker-' + verdict });
    const result = await worker.runExecution(reviewer.identity.executionId);
    assert.equal(result.status, 'SUCCEEDED');
    const durableReview = seeded.repositories.reviews.getById(review.reviewId);
    assert.equal(durableReview.reviewerExecutionId, reviewer.identity.executionId);
    assert.equal(durableReview.verdict, verdict);
    assert.equal(durableReview.status, verdict === 'PASS' ? 'PASSED' : 'FAILED');
    assert.equal(seeded.repositories.executions.get(reviewer.identity.executionId).resultRevision, 'result-sha');
    seeded.db.close();
  }
});

test('execution worker refuses non-independent review routes and releases a held lease', async () => {
  const seeded = seed();
  const implementation = createExecution(seeded.repositories, { executionId: 'implementation-for-route', planId: seeded.plan.planId, workItemId: seeded.item.workItemId });
  const implementationWorkspace: WorkspaceDescriptor = {
    executionId: implementation.identity.executionId,
    hostPath: '/managed/implementation-for-route/repo',
    executionPath: '/workspace/implementation-for-route/repo',
    evidenceHostPath: '/managed/implementation-for-route/completion-evidence.json',
    evidenceExecutionPath: '/workspace/implementation-for-route/completion-evidence.json',
    sourceRepositoryPath: seeded.plan.repositoryPath,
    sourceRevision: 'base-sha',
    createdAt: now(),
  };
  succeedImplementationSession(seeded.repositories, implementation, implementationWorkspace);
  seeded.repositories.reviews.create({ idempotencyKey: 'route-review', planId: seeded.plan.planId, workItemId: seeded.item.workItemId, implementationExecutionId: implementation.identity.executionId, sourceRevision: 'result-sha' });
  const reviewer = createExecution(seeded.repositories, { executionId: 'reviewer-wrong-route', planId: seeded.plan.planId, workItemId: seeded.item.workItemId, phase: 'REVIEW', parentExecutionId: implementation.identity.executionId, sourceRevision: 'result-sha', route: 'wrong-review' });
  const worker = new ExecutionWorker(seeded.repositories, new FakeWorkspace(), [{ route: 'wrong-review', provider: new FakeProvider() }], { ownerId: 'wrong-route-worker' });
  const result = await worker.runExecution(reviewer.identity.executionId);
  assert.equal(result.code, 'INDEPENDENT_REVIEW_PROVIDER_REQUIRED');
  const lease = seeded.repositories.executions.claimLease(reviewer.identity.executionId, 'after-worker', 1_000);
  assert.ok(lease.value);
  seeded.repositories.executions.releaseLease(reviewer.identity.executionId, 'after-worker', lease.value.leaseToken);
  seeded.db.close();
});
