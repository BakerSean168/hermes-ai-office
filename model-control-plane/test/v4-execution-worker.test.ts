import assert from 'node:assert/strict';
import test from 'node:test';

import { V4Error } from '../src/v4/domain/errors.js';
import type { Execution } from '../src/v4/domain/execution.js';
import { createExecutionResourceSelection } from '../src/v4/domain/resourceRouting.js';
import { ExecutionWorker } from '../src/v4/orchestration/executionWorker.js';
import type {
  ExecutionProviderPort,
  ProviderLaunchInput,
  ProviderRecoveryInput,
  ProviderSessionReplacementInput,
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
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'worker graph',
  }).value!;
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
  return {
    db,
    repositories,
    plan: repositories.plans.getPlan(plan.planId),
    item: repositories.plans.getWorkItem(item.workItemId),
  };
}

function createExecution(
  repositories: V4Repositories,
  input: {
    executionId: string;
    planId: string;
    workItemId: string;
    phase?: 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'REVIEW';
    parentExecutionId?: string;
    sourceRevision?: string;
    route?: string;
    attempt?: number;
  },
): Execution {
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
  readonly implementationFailures = new Map<string, V4Error[]>();
  readonly completionEvidence = new Set<string>();
  readonly progressFingerprints = new Map<string, string>();
  readonly progressFailures = new Map<string, V4Error[]>();
  provisionError?: V4Error;
  provisionCalls = 0;

  hasCompletionEvidence(workspace: WorkspaceDescriptor): boolean {
    return this.completionEvidence.has(workspace.executionId);
  }

  async progressFingerprint(workspace: WorkspaceDescriptor): Promise<string> {
    const failure = this.progressFailures.get(workspace.executionId)?.shift();
    if (failure) throw failure;
    return (
      this.progressFingerprints.get(workspace.executionId) ?? 'workspace:' + workspace.executionId
    );
  }

  async observeRepository(repositoryPath: string, revision: string) {
    return {
      repositoryPath,
      rootPath: repositoryPath,
      headRevision: revision,
      clean: true,
      commitExists: true,
      observedAt: now(),
    };
  }

  async provision(input: WorkspaceProvisionInput): Promise<WorkspaceDescriptor> {
    this.provisionCalls += 1;
    if (this.provisionError) throw this.provisionError;
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
    const failures = this.implementationFailures.get(workspace.executionId);
    const failure = failures?.shift();
    if (failure) throw failure;
    const completion = this.completions.get(workspace.executionId);
    if (!completion) throw new V4Error('WORKSPACE_EVIDENCE_INVALID');
    return completion;
  }

  async verifyReview(
    workspace: WorkspaceDescriptor,
    reviewedSha: string,
  ): Promise<WorkspaceCompletionSnapshot> {
    const completion = this.completions.get(workspace.executionId);
    if (!completion || completion.headRevision !== reviewedSha)
      throw new V4Error('WORKSPACE_REVIEW_SHA_MISMATCH');
    return completion;
  }

  async integrateAcceptedRevision(input: {
    repositoryPath: string;
    expectedRevision: string;
    acceptedRevision: string;
    candidateWorkspace: WorkspaceDescriptor;
  }) {
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

class FakeProvider implements ExecutionProviderPort {
  readonly provider = 'fake-implementation';
  launchCalls = 0;
  recoverCalls = 0;
  inspectCalls = 0;
  continueCalls = 0;
  interruptCalls = 0;
  continueObservedOffset = 50;
  replaceCalls = 0;
  launchSnapshot: ProviderSessionSnapshot = {
    provider: this.provider,
    providerSessionId: 'provider-session-1',
    status: 'RUNNING',
    observedAt: now(10),
  };
  recoveredSnapshot?: ProviderSessionSnapshot;
  inspectSnapshot: ProviderSessionSnapshot = {
    provider: this.provider,
    providerSessionId: 'provider-session-1',
    status: 'RUNNING',
    observedAt: now(20),
  };
  continueSnapshot: ProviderSessionSnapshot = {
    provider: this.provider,
    providerSessionId: 'provider-session-1',
    status: 'RUNNING',
    observedAt: now(30),
  };
  interruptSnapshot: ProviderSessionSnapshot = {
    provider: this.provider,
    providerSessionId: 'provider-session-1',
    status: 'PAUSED',
    observedAt: now(25),
  };
  replaceSnapshot: ProviderSessionSnapshot = {
    provider: this.provider,
    providerSessionId: 'provider-session-2',
    status: 'RUNNING',
    observedAt: now(35),
  };
  launchError?: Error;
  lastLaunch?: ProviderLaunchInput;
  lastContinueInstruction?: string;
  lastReplacement?: ProviderSessionReplacementInput;

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

  async inspect(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    this.inspectCalls += 1;
    return { ...this.inspectSnapshot, providerSessionId, observedAt: now(100 + this.inspectCalls) };
  }

  async continue(
    _providerSessionId: string,
    instruction: string,
  ): Promise<ProviderSessionSnapshot> {
    this.continueCalls += 1;
    this.lastContinueInstruction = instruction;
    return {
      ...this.continueSnapshot,
      observedAt: now(this.continueObservedOffset + this.continueCalls),
    };
  }

  async interrupt(_providerSessionId: string): Promise<ProviderSessionSnapshot> {
    this.interruptCalls += 1;
    return { ...this.interruptSnapshot, observedAt: now(500 + this.interruptCalls) };
  }

  async replace(input: ProviderSessionReplacementInput): Promise<ProviderSessionSnapshot> {
    this.replaceCalls += 1;
    this.lastReplacement = input;
    return { ...this.replaceSnapshot, observedAt: now(-1_000) };
  }
}

class BlockingLaunchProvider extends FakeProvider {
  readonly launchEntered: Promise<void>;
  private readonly launchGate: Promise<void>;
  private markLaunchEntered!: () => void;
  private releaseLaunchGate!: () => void;

  constructor() {
    super();
    this.launchEntered = new Promise<void>((resolve) => {
      this.markLaunchEntered = resolve;
    });
    this.launchGate = new Promise<void>((resolve) => {
      this.releaseLaunchGate = resolve;
    });
  }

  releaseLaunch(): void {
    this.releaseLaunchGate();
  }

  override async launch(input: ProviderLaunchInput): Promise<ProviderSessionSnapshot> {
    this.launchCalls += 1;
    this.lastLaunch = input;
    this.markLaunchEntered();
    await this.launchGate;
    if (this.launchError) throw this.launchError;
    return { ...this.launchSnapshot, observedAt: now(10) };
  }
}

class FakeResourceFeedback {
  readonly failures: Array<{ resourceId: string; error: unknown }> = [];
  readonly successes: string[] = [];

  failure(
    selection: import('../src/v4/domain/resourceRouting.js').ExecutionResourceSelection,
    error: unknown,
  ): void {
    this.failures.push({ resourceId: selection.resourceId, error });
  }

  success(
    selection: import('../src/v4/domain/resourceRouting.js').ExecutionResourceSelection,
  ): void {
    this.successes.push(selection.resourceId);
  }
}

class FakeReviewProvider extends FakeProvider implements ReviewProviderPort {
  readonly provider = 'fake-review';
  readonly independentReview = true as const;
}

function implementationCompletion(
  workspace: WorkspaceDescriptor,
  resultRevision = 'result-sha',
): WorkspaceCompletionSnapshot {
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

function reviewCompletion(
  workspace: WorkspaceDescriptor,
  verdict: 'PASS' | 'FAIL' = 'PASS',
): WorkspaceCompletionSnapshot {
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
      checks: [
        {
          command: 'npm test',
          status: verdict === 'PASS' ? 'PASS' : 'FAIL',
          exitCode: verdict === 'PASS' ? 0 : 1,
        },
      ],
      summary: verdict === 'PASS' ? 'approved' : 'rejected',
    },
    observedAt: now(),
  };
}

function succeedImplementationSession(
  repositories: V4Repositories,
  execution: Execution,
  workspace: WorkspaceDescriptor,
  resultRevision = 'result-sha',
): void {
  repositories.sessions.create({
    executionId: execution.identity.executionId,
    phase: 'IMPLEMENT',
    provider: 'fake-implementation',
    workspace,
    sourceRevision: execution.identity.sourceRevision!,
  });
  repositories.sessions.attachProviderSession(
    execution.identity.executionId,
    'implementation-session-' + execution.identity.executionId,
  );
  repositories.sessions.updateProviderStatus(execution.identity.executionId, 'RUNNING', now(10));
  repositories.executions.updateStatus(execution.identity.executionId, 'RUNNING');
  repositories.sessions.complete(execution.identity.executionId, {
    status: 'SUCCEEDED',
    finalResponse: 'done',
    completedAt: now(20),
  });
  repositories.executions.recordResult(execution.identity.executionId, {
    status: 'SUCCEEDED',
    resultRevision,
    resultSummary: 'done',
  });
}

test('execution worker launches once, persists provider correlation, then completes after restart', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-implementation',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-one' },
  );

  const launched = await worker.runExecution(execution.identity.executionId);
  assert.equal(launched.status, 'RUNNING');
  assert.equal(provider.launchCalls, 1);
  assert.equal(provider.recoverCalls, 1);
  assert.equal(
    seeded.repositories.executions.get(execution.identity.executionId).status,
    'RUNNING',
  );
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId,
    'provider-session-1',
  );

  const descriptor = seeded.repositories.sessions.get(execution.identity.executionId).workspace;
  workspace.completions.set(execution.identity.executionId, implementationCompletion(descriptor));
  provider.inspectSnapshot = {
    provider: provider.provider,
    providerSessionId: 'provider-session-1',
    status: 'SUCCEEDED',
    finalResponse: 'done',
    observedAt: now(200),
  };
  const restarted = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-two' },
  );
  const completed = await restarted.runExecution(execution.identity.executionId);
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(completed.resultRevision, 'result-sha');
  assert.equal(provider.launchCalls, 1);
  assert.equal(
    seeded.repositories.executions.get(execution.identity.executionId).resultRevision,
    'result-sha',
  );
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'SUCCEEDED',
  );
  assert.ok(
    seeded.repositories.evidence
      .listByExecution(execution.identity.executionId)
      .some((item) => item.kind === 'DIFF'),
  );
  seeded.db.close();
});

test('execution worker lease rejects same-owner reentry before a provider session can launch twice', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-overlapping-launch',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new BlockingLaunchProvider();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'shared-worker-owner' },
  );

  const first = worker.runExecution(execution.identity.executionId);
  await provider.launchEntered;
  const overlapping = await worker.runExecution(execution.identity.executionId);

  assert.equal(overlapping.status, 'SKIPPED');
  assert.equal(overlapping.code, 'LEASE_HELD');
  assert.equal(provider.launchCalls, 1);
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId,
    undefined,
  );

  provider.releaseLaunch();
  const launched = await first;
  assert.equal(launched.status, 'RUNNING');
  assert.equal(provider.launchCalls, 1);
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId,
    'provider-session-1',
  );
  seeded.db.close();
});

test('execution worker durably fails a queued execution when workspace capacity blocks provisioning', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-capacity-preflight-failure',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  workspace.provisionError = new V4Error('WORKSPACE_CAPACITY_LOW');
  const provider = new FakeProvider();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-capacity-preflight-failure' },
  );

  const result = await worker.runExecution(execution.identity.executionId);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'WORKSPACE_CAPACITY_LOW');
  const durable = seeded.repositories.executions.get(execution.identity.executionId);
  assert.equal(durable.status, 'FAILED');
  assert.equal(durable.retryable, true);
  assert.equal(provider.launchCalls, 0);
  seeded.db.close();
});

test('execution worker persists unrecovered provider launch failures instead of leaving RUNNING work orphaned', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-provider-launch-failure',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchError = new V4Error('OPENHANDS_LAUNCH_HTTP_503');
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-provider-launch-failure' },
  );

  const result = await worker.runExecution(execution.identity.executionId);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'OPENHANDS_LAUNCH_HTTP_503');
  const durable = seeded.repositories.executions.get(execution.identity.executionId);
  assert.equal(durable.status, 'FAILED');
  assert.equal(durable.retryable, true);
  assert.equal(provider.launchCalls, 1);
  seeded.db.close();
});

test('execution worker automatically finalizes exact implementation evidence while provider turn is still running', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-evidence-finalize-implementation',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-evidence-finalize-implementation' },
  );
  const launched = await worker.runExecution(execution.identity.executionId);
  assert.equal(launched.status, 'RUNNING');
  const descriptor = seeded.repositories.sessions.get(execution.identity.executionId).workspace;
  workspace.completions.set(execution.identity.executionId, implementationCompletion(descriptor));
  workspace.completionEvidence.add(execution.identity.executionId);
  provider.inspectSnapshot = {
    provider: provider.provider,
    providerSessionId: 'provider-session-1',
    status: 'RUNNING',
    observedAt: now(200),
  };
  provider.interruptSnapshot = {
    provider: provider.provider,
    providerSessionId: 'provider-session-1',
    status: 'PAUSED',
    observedAt: now(210),
  };

  const completed = await worker.runExecution(execution.identity.executionId);
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(completed.code, 'IMPLEMENTATION_EVIDENCE_FINALIZED');
  assert.equal(completed.resultRevision, 'result-sha');
  assert.equal(provider.interruptCalls, 1);
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'PAUSED',
  );
  const evidence = seeded.repositories.evidence.listByExecution(execution.identity.executionId);
  assert.ok(
    evidence.some(
      (item) =>
        item.kind === 'RECOVERY' &&
        item.name === 'evidence-verified-provider-finalization' &&
        item.payload.providerStatus === 'PAUSED',
    ),
  );
  seeded.db.close();
});

test('execution worker automatically finalizes exact independent review evidence without provider success fiction', async () => {
  const seeded = seed();
  const implementation = createExecution(seeded.repositories, {
    executionId: 'implementation-evidence-finalize-review',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const implementationWorkspace: WorkspaceDescriptor = {
    executionId: implementation.identity.executionId,
    hostPath: '/managed/implementation-evidence-finalize-review/repo',
    executionPath: '/workspace/implementation-evidence-finalize-review/repo',
    evidenceHostPath: '/managed/implementation-evidence-finalize-review/completion-evidence.json',
    evidenceExecutionPath:
      '/workspace/implementation-evidence-finalize-review/completion-evidence.json',
    sourceRepositoryPath: seeded.plan.repositoryPath,
    sourceRevision: 'base-sha',
    createdAt: now(),
  };
  succeedImplementationSession(seeded.repositories, implementation, implementationWorkspace);
  const review = seeded.repositories.reviews.create({
    idempotencyKey: 'review-evidence-finalize',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
    implementationExecutionId: implementation.identity.executionId,
    sourceRevision: 'result-sha',
  }).value!;
  const reviewer = createExecution(seeded.repositories, {
    executionId: 'reviewer-evidence-finalize',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
    phase: 'REVIEW',
    parentExecutionId: implementation.identity.executionId,
    sourceRevision: 'result-sha',
    route: 'review',
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeReviewProvider();
  provider.launchSnapshot = {
    provider: provider.provider,
    providerSessionId: 'review-evidence-session',
    status: 'RUNNING',
    observedAt: now(10),
  };
  provider.inspectSnapshot = {
    provider: provider.provider,
    providerSessionId: 'review-evidence-session',
    status: 'RUNNING',
    observedAt: now(200),
  };
  provider.interruptSnapshot = {
    provider: provider.provider,
    providerSessionId: 'review-evidence-session',
    status: 'PAUSED',
    observedAt: now(210),
  };
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'review', provider }],
    { ownerId: 'worker-evidence-finalize-review' },
  );
  const launched = await worker.runExecution(reviewer.identity.executionId);
  assert.equal(launched.status, 'RUNNING');
  seeded.repositories.reviews.attachReviewerExecution(
    review.reviewId,
    reviewer.identity.executionId,
  );
  const descriptor = seeded.repositories.sessions.get(reviewer.identity.executionId).workspace;
  workspace.completions.set(reviewer.identity.executionId, reviewCompletion(descriptor));
  workspace.completionEvidence.add(reviewer.identity.executionId);
  const completed = await worker.runExecution(reviewer.identity.executionId);
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(completed.code, 'REVIEW_EVIDENCE_FINALIZED');
  assert.equal(
    seeded.repositories.sessions.get(reviewer.identity.executionId).providerStatus,
    'PAUSED',
  );
  assert.equal(seeded.repositories.reviews.getById(review.reviewId).status, 'PASSED');
  seeded.db.close();
});

test('execution worker adopts a paused operator-assisted implementation only after deterministic workspace verification', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-operator-adoption',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-operator-adoption' },
  );

  const launched = await worker.runExecution(execution.identity.executionId);
  assert.equal(launched.status, 'RUNNING');
  const descriptor = seeded.repositories.sessions.get(execution.identity.executionId).workspace;
  workspace.completions.set(
    execution.identity.executionId,
    implementationCompletion(descriptor, 'operator-result-sha'),
  );
  provider.inspectSnapshot = {
    provider: provider.provider,
    providerSessionId: 'provider-session-1',
    status: 'PAUSED',
    observedAt: now(200),
  };

  const adopted = await worker.adoptPausedImplementation(
    execution.identity.executionId,
    'operator-handoff-1',
    'provider stalled after implementation; operator verified and committed the same workspace',
  );
  assert.equal(adopted.status, 'SUCCEEDED');
  assert.equal(adopted.code, 'OPERATOR_WORKSPACE_ADOPTED');
  assert.equal(adopted.resultRevision, 'operator-result-sha');
  assert.equal(
    seeded.repositories.executions.get(execution.identity.executionId).resultRevision,
    'operator-result-sha',
  );
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'PAUSED',
  );
  const evidence = seeded.repositories.evidence.listByExecution(execution.identity.executionId);
  assert.ok(evidence.some((item) => item.kind === 'DIFF' && item.name === 'implementation-diff'));
  assert.ok(
    evidence.some(
      (item) =>
        item.kind === 'RECOVERY' &&
        item.payload.mode === 'operator-assisted-workspace-adoption' &&
        item.payload.providerStatus === 'PAUSED',
    ),
  );
  assert.equal(
    evidence.some(
      (item) => item.kind === 'PROVIDER_OUTPUT' && item.name === 'terminal-provider-snapshot',
    ),
    false,
  );
  seeded.db.close();
});

test('execution worker refuses operator workspace adoption while the provider is still running', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-operator-adoption-running',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-operator-adoption-running' },
  );
  await worker.runExecution(execution.identity.executionId);
  const descriptor = seeded.repositories.sessions.get(execution.identity.executionId).workspace;
  workspace.completions.set(execution.identity.executionId, implementationCompletion(descriptor));
  provider.inspectSnapshot = {
    provider: provider.provider,
    providerSessionId: 'provider-session-1',
    status: 'RUNNING',
    observedAt: now(200),
  };

  const refused = await worker.adoptPausedImplementation(
    execution.identity.executionId,
    'operator-handoff-running',
    'must not race a live writer',
  );
  assert.equal(refused.status, 'WAITING');
  assert.equal(refused.code, 'OPERATOR_ADOPTION_PROVIDER_NOT_PAUSED');
  assert.equal(
    seeded.repositories.executions.get(execution.identity.executionId).status,
    'RUNNING',
  );
  seeded.db.close();
});

test('execution worker can abort a paused stalled provider attempt without fabricating provider completion', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-paused-provider-abort',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-paused-provider-abort' },
  );
  await worker.runExecution(execution.identity.executionId);
  provider.inspectSnapshot = {
    provider: provider.provider,
    providerSessionId: 'provider-session-1',
    status: 'PAUSED',
    observedAt: now(200),
  };

  const aborted = await worker.abortPausedProviderAttempt(
    execution.identity.executionId,
    'paused-provider-abort-1',
    'provider remained inert after bounded recovery attempts',
  );
  assert.equal(aborted.status, 'FAILED');
  assert.equal(aborted.code, 'PROVIDER_STALLED_OPERATOR_ABORT');
  const stored = seeded.repositories.executions.get(execution.identity.executionId);
  assert.equal(stored.status, 'FAILED');
  assert.equal(stored.retryable, true);
  assert.equal(stored.errorCode, 'PROVIDER_STALLED_OPERATOR_ABORT');
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'PAUSED',
  );
  const evidence = seeded.repositories.evidence.listByExecution(execution.identity.executionId);
  assert.ok(
    evidence.some(
      (item) =>
        item.kind === 'RECOVERY' &&
        item.payload.mode === 'operator-abort-paused-provider-attempt' &&
        item.payload.providerStatus === 'PAUSED',
    ),
  );
  assert.equal(
    evidence.some(
      (item) => item.kind === 'PROVIDER_OUTPUT' && item.name === 'terminal-provider-snapshot',
    ),
    false,
  );
  seeded.db.close();
});

test('execution worker resumes the same terminal implementation session once to finalize a dirty workspace', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-terminal-finalize',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchSnapshot = {
    provider: provider.provider,
    providerSessionId: 'terminal-finalize-session',
    status: 'SUCCEEDED',
    finalResponse: 'implemented but forgot finalization',
    observedAt: now(10),
  };
  provider.continueSnapshot = {
    provider: provider.provider,
    providerSessionId: 'terminal-finalize-session',
    status: 'RUNNING',
    observedAt: now(20),
  };
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-terminal-finalize' },
  );

  const descriptor = await workspace.provision({
    executionId: execution.identity.executionId,
    repositoryPath: seeded.plan.repositoryPath,
    sourceRevision: execution.identity.sourceRevision!,
    phase: 'IMPLEMENT',
  });
  workspace.completions.set(execution.identity.executionId, implementationCompletion(descriptor));
  workspace.implementationFailures.set(execution.identity.executionId, [
    new V4Error('WORKSPACE_DIRTY'),
  ]);

  const first = await worker.runExecution(execution.identity.executionId);
  assert.equal(first.status, 'RUNNING');
  assert.equal(first.code, 'PROVIDER_FINALIZATION_RUNNING');
  assert.equal(provider.continueCalls, 1);
  assert.match(provider.lastContinueInstruction ?? '', /commit every intended repository change/);
  assert.match(provider.lastContinueInstruction ?? '', /completion-evidence\.json/);
  assert.equal(
    seeded.repositories.executions.get(execution.identity.executionId).status,
    'RUNNING',
  );
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'RUNNING',
  );
  assert.equal(
    seeded.repositories.evidence
      .listByExecution(execution.identity.executionId)
      .filter((item) => item.kind === 'RECOVERY' && item.name === 'provider-finalization-requested')
      .length,
    1,
  );

  provider.inspectSnapshot = {
    provider: provider.provider,
    providerSessionId: 'terminal-finalize-session',
    status: 'SUCCEEDED',
    finalResponse: 'finalized',
    observedAt: now(30),
  };
  const completed = await worker.runExecution(execution.identity.executionId);
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(completed.resultRevision, 'result-sha');
  assert.equal(provider.continueCalls, 1);
  assert.equal(
    seeded.repositories.executions.get(execution.identity.executionId).status,
    'SUCCEEDED',
  );
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'SUCCEEDED',
  );
  seeded.db.close();
});

test('execution worker does not poison resource health when a provider no-op is caused by local Harness admission', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-local-harness-noop',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchSnapshot = {
    provider: provider.provider,
    providerSessionId: 'provider-local-harness-session',
    status: 'SUCCEEDED',
    finalResponse:
      'IMPLEMENT_TRANSPORT_ERROR\nHEADLESS_REVIEW_HARNESS_BLOCKED:harnessctl: No capability manifest matches project /workspace/repo.',
    observedAt: now(10),
  };
  const feedback = new FakeResourceFeedback();
  const selection = createExecutionResourceSelection(execution.identity.executionId, {
    capability: 'IMPLEMENTATION',
    phase: 'IMPLEMENT',
    modelFamily: 'gpt-5.6-luna',
    agentBackend: 'codex-acp',
    transport: 'PROVIDER_NATIVE',
    resourceId: 'chatgpt-business-primary',
    resourceTier: 'SUBSCRIPTION',
    modelRank: 30,
    resourceSequence: 120,
    resourceState: 'ACTIVE',
    selectionReason: 'STATIC_POLICY',
    bindingId: 'chatgpt-business-luna',
  });
  seeded.repositories.resourceSelections.create(selection);
  const descriptor = await workspace.provision({
    executionId: execution.identity.executionId,
    repositoryPath: seeded.plan.repositoryPath,
    sourceRevision: execution.identity.sourceRevision!,
    phase: 'IMPLEMENT',
  });
  workspace.implementationFailures.set(execution.identity.executionId, [
    new V4Error('WORKSPACE_IMPLEMENTATION_NOOP'),
  ]);
  workspace.completions.set(execution.identity.executionId, implementationCompletion(descriptor));
  const worker = new ExecutionWorker(seeded.repositories, workspace, [], {
    ownerId: 'worker-local-harness-noop',
    providerFactory: () => provider,
    resourceFeedback: feedback,
    requireResourceSelection: true,
  });

  const result = await worker.runExecution(execution.identity.executionId);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'AGENT_HARNESS_PROJECT_UNREGISTERED');
  const stored = seeded.repositories.executions.get(execution.identity.executionId);
  assert.equal(stored.errorCode, 'AGENT_HARNESS_PROJECT_UNREGISTERED');
  assert.equal(stored.retryable, false);
  assert.deepEqual(feedback.failures, []);
  seeded.db.close();
});

test('execution worker treats provider success without implementation evidence as retryable resource quality failure', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-provider-success-noop',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchSnapshot = {
    provider: provider.provider,
    providerSessionId: 'provider-success-noop-session',
    status: 'SUCCEEDED',
    observedAt: now(10),
  };
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-provider-success-noop' },
  );
  const descriptor = await workspace.provision({
    executionId: execution.identity.executionId,
    repositoryPath: seeded.plan.repositoryPath,
    sourceRevision: execution.identity.sourceRevision!,
    phase: 'IMPLEMENT',
  });
  workspace.implementationFailures.set(execution.identity.executionId, [
    new V4Error('WORKSPACE_IMPLEMENTATION_NOOP'),
  ]);
  workspace.completions.set(execution.identity.executionId, implementationCompletion(descriptor));

  const result = await worker.runExecution(execution.identity.executionId);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'WORKSPACE_IMPLEMENTATION_NOOP');
  const stored = seeded.repositories.executions.get(execution.identity.executionId);
  assert.equal(stored.status, 'FAILED');
  assert.equal(stored.retryable, true);
  seeded.db.close();
});

test('execution worker fails a still-dirty finalized implementation as retryable without looping continuation', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-finalize-still-dirty',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchSnapshot = {
    provider: provider.provider,
    providerSessionId: 'still-dirty-session',
    status: 'SUCCEEDED',
    observedAt: now(10),
  };
  provider.continueSnapshot = {
    provider: provider.provider,
    providerSessionId: 'still-dirty-session',
    status: 'SUCCEEDED',
    observedAt: now(20),
  };
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-still-dirty' },
  );
  const descriptor = await workspace.provision({
    executionId: execution.identity.executionId,
    repositoryPath: seeded.plan.repositoryPath,
    sourceRevision: execution.identity.sourceRevision!,
    phase: 'IMPLEMENT',
  });
  workspace.completions.set(execution.identity.executionId, implementationCompletion(descriptor));
  workspace.implementationFailures.set(execution.identity.executionId, [
    new V4Error('WORKSPACE_DIRTY'),
    new V4Error('WORKSPACE_DIRTY'),
  ]);

  const result = await worker.runExecution(execution.identity.executionId);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'WORKSPACE_DIRTY');
  assert.equal(provider.continueCalls, 1);
  const durable = seeded.repositories.executions.get(execution.identity.executionId);
  assert.equal(durable.status, 'FAILED');
  assert.equal(durable.retryable, true);
  assert.equal(
    seeded.repositories.evidence
      .listByExecution(execution.identity.executionId)
      .filter((item) => item.kind === 'RECOVERY' && item.name === 'provider-finalization-requested')
      .length,
    1,
  );
  seeded.db.close();
});

test('execution worker keeps review workspace failures strict and never asks the reviewer to mutate its workspace', async () => {
  const seeded = seed();
  const implementation = createExecution(seeded.repositories, {
    executionId: 'implementation-review-dirty',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const implementationWorkspace: WorkspaceDescriptor = {
    executionId: implementation.identity.executionId,
    hostPath: '/managed/implementation-review-dirty/repo',
    executionPath: '/workspace/implementation-review-dirty/repo',
    evidenceHostPath: '/managed/implementation-review-dirty/completion-evidence.json',
    evidenceExecutionPath: '/workspace/implementation-review-dirty/completion-evidence.json',
    sourceRepositoryPath: seeded.plan.repositoryPath,
    sourceRevision: 'base-sha',
    createdAt: now(),
  };
  succeedImplementationSession(seeded.repositories, implementation, implementationWorkspace);
  const review = seeded.repositories.reviews.create({
    idempotencyKey: 'review-dirty',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
    implementationExecutionId: implementation.identity.executionId,
    sourceRevision: 'result-sha',
  }).value!;
  const reviewer = createExecution(seeded.repositories, {
    executionId: 'reviewer-dirty',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
    phase: 'REVIEW',
    parentExecutionId: implementation.identity.executionId,
    sourceRevision: 'result-sha',
    route: 'review',
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeReviewProvider();
  provider.launchSnapshot = {
    provider: provider.provider,
    providerSessionId: 'review-dirty-session',
    status: 'SUCCEEDED',
    observedAt: now(100),
  };
  const descriptor = await workspace.provision({
    executionId: reviewer.identity.executionId,
    repositoryPath: seeded.plan.repositoryPath,
    sourceRevision: 'result-sha',
    phase: 'REVIEW',
    sourceWorkspace: implementationWorkspace,
  });
  workspace.completions.set(reviewer.identity.executionId, reviewCompletion(descriptor));
  const originalVerifyReview = workspace.verifyReview.bind(workspace);
  workspace.verifyReview = async () => {
    throw new V4Error('WORKSPACE_DIRTY');
  };
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'review', provider }],
    { ownerId: 'review-dirty-worker' },
  );
  const result = await worker.runExecution(reviewer.identity.executionId);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'WORKSPACE_DIRTY');
  assert.equal(provider.continueCalls, 0);
  assert.equal(seeded.repositories.executions.get(reviewer.identity.executionId).retryable, false);
  assert.equal(review.status, 'PENDING');
  workspace.verifyReview = originalVerifyReview;
  seeded.db.close();
});

test('execution worker can interrupt a stuck provider turn and continue the same durable session', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-interrupt-resume',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.continueObservedOffset = 600;
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-interrupt-resume' },
  );
  const launched = await worker.runExecution(execution.identity.executionId);
  assert.equal(launched.status, 'RUNNING');
  const resumed = await worker.continueExecution(
    execution.identity.executionId,
    'Resume the same bounded work.',
    { interruptCurrent: true },
  );
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(provider.launchCalls, 1);
  assert.equal(provider.interruptCalls, 1);
  assert.equal(provider.continueCalls, 1);
  assert.equal(provider.lastContinueInstruction, 'Resume the same bounded work.');
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'RUNNING',
  );
  seeded.db.close();
});

test('execution worker treats transient workspace Git progress probe failure as advisory while provider stays running', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-progress-git-advisory',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  workspace.progressFailures.set(execution.identity.executionId, [
    new V4Error('WORKSPACE_GIT_COMMAND_FAILED'),
  ]);
  const provider = new FakeProvider();
  provider.launchSnapshot = { ...provider.launchSnapshot, progressFingerprint: 'event-1' };
  provider.inspectSnapshot = { ...provider.inspectSnapshot, progressFingerprint: 'event-1' };
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-progress-git-advisory' },
  );

  const first = await worker.runExecution(execution.identity.executionId);
  assert.equal(first.status, 'RUNNING');
  assert.equal(
    seeded.repositories.executions.get(execution.identity.executionId).status,
    'RUNNING',
  );
  assert.equal(
    seeded.repositories.evidence
      .listByExecution(execution.identity.executionId)
      .filter((item) => item.name === 'workspace-progress-probe-degraded').length,
    1,
  );
  const second = await worker.runExecution(execution.identity.executionId);
  assert.equal(second.status, 'RUNNING');
  assert.equal(
    seeded.repositories.executions.get(execution.identity.executionId).status,
    'RUNNING',
  );
  assert.equal(
    seeded.repositories.evidence
      .listByExecution(execution.identity.executionId)
      .filter((item) => item.name === 'workspace-progress-probe-degraded').length,
    1,
  );
  seeded.db.close();
});

test('execution worker separates liveness heartbeats from meaningful progress and auto-replaces a stalled provider turn', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-auto-meaningful-stall',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  workspace.progressFingerprints.set(execution.identity.executionId, 'workspace-1');
  const provider = new FakeProvider();
  provider.launchSnapshot = {
    ...provider.launchSnapshot,
    progressFingerprint: 'event-1',
  };
  provider.inspectSnapshot = {
    ...provider.inspectSnapshot,
    progressFingerprint: 'event-1',
  };
  let clock = Date.now();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    {
      ownerId: 'worker-auto-meaningful-stall',
      meaningfulProgressTimeoutMs: 30_000,
      maxStallRecoveries: 1,
      now: () => new Date(clock),
    },
  );

  const launched = await worker.runExecution(execution.identity.executionId);
  assert.equal(launched.status, 'RUNNING');
  clock += 10_000;
  const heartbeatOnly = await worker.runExecution(execution.identity.executionId);
  assert.equal(heartbeatOnly.status, 'RUNNING');
  assert.equal(provider.replaceCalls, 0);
  clock += 21_000;
  const recovered = await worker.runExecution(execution.identity.executionId);
  assert.equal(recovered.code, 'PROVIDER_MEANINGFUL_PROGRESS_RECOVERED_RUNNING');
  assert.equal(provider.interruptCalls, 1);
  assert.equal(provider.replaceCalls, 1);
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId,
    'provider-session-2',
  );
  const evidence = seeded.repositories.evidence.listByExecution(execution.identity.executionId);
  assert.equal(evidence.filter((item) => item.name.startsWith('meaningful-progress-')).length, 1);
  assert.equal(
    evidence.filter((item) => item.name.startsWith('meaningful-stall-recovery-')).length,
    1,
  );
  seeded.db.close();
});

test('execution worker fails a meaningfully stalled turn retryably after the automatic recovery budget is exhausted', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-meaningful-stall-exhausted',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  workspace.progressFingerprints.set(execution.identity.executionId, 'workspace-static');
  const provider = new FakeProvider();
  provider.launchSnapshot = { ...provider.launchSnapshot, progressFingerprint: 'event-static' };
  provider.inspectSnapshot = { ...provider.inspectSnapshot, progressFingerprint: 'event-static' };
  let clock = Date.now();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    {
      ownerId: 'worker-meaningful-stall-exhausted',
      meaningfulProgressTimeoutMs: 30_000,
      maxStallRecoveries: 0,
      now: () => new Date(clock),
    },
  );
  await worker.runExecution(execution.identity.executionId);
  clock += 31_000;
  const failed = await worker.runExecution(execution.identity.executionId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.code, 'PROVIDER_MEANINGFUL_PROGRESS_STALLED');
  assert.equal(provider.replaceCalls, 0);
  assert.equal(provider.interruptCalls, 1);
  const durable = seeded.repositories.executions.get(execution.identity.executionId);
  assert.equal(durable.status, 'FAILED');
  assert.equal(durable.retryable, true);
  seeded.db.close();
});

test('execution worker resets the stall window only when provider or workspace progress fingerprint advances', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-progress-advance',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  workspace.progressFingerprints.set(execution.identity.executionId, 'workspace-1');
  const provider = new FakeProvider();
  provider.launchSnapshot = { ...provider.launchSnapshot, progressFingerprint: 'event-1' };
  provider.inspectSnapshot = { ...provider.inspectSnapshot, progressFingerprint: 'event-2' };
  let clock = Date.now();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    {
      ownerId: 'worker-progress-advance',
      meaningfulProgressTimeoutMs: 30_000,
      maxStallRecoveries: 1,
      now: () => new Date(clock),
    },
  );
  await worker.runExecution(execution.identity.executionId);
  clock += 31_000;
  const advanced = await worker.runExecution(execution.identity.executionId);
  assert.equal(advanced.status, 'RUNNING');
  assert.equal(provider.replaceCalls, 0);
  const progress = seeded.repositories.evidence
    .listByExecution(execution.identity.executionId)
    .filter((item) => item.name.startsWith('meaningful-progress-'));
  assert.equal(progress.length, 2);
  assert.notEqual(progress[0]?.payload.fingerprint, progress[1]?.payload.fingerprint);
  seeded.db.close();
});

test('execution worker replaces a stalled provider session without changing execution attempt or workspace', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-session-replace',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
    attempt: 3,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-session-replace' },
  );
  const launched = await worker.runExecution(execution.identity.executionId);
  assert.equal(launched.status, 'RUNNING');
  const before = seeded.repositories.sessions.get(execution.identity.executionId);
  const replaced = await worker.replaceStalledProviderSession(
    execution.identity.executionId,
    'replace-session-test-key',
    'Resume from the existing workspace and finish.',
    'stalled llm turn',
  );
  assert.equal(replaced.status, 'RUNNING');
  assert.equal(replaced.code, 'PROVIDER_SESSION_REPLACED_RUNNING');
  assert.equal(provider.interruptCalls, 1);
  assert.equal(provider.replaceCalls, 1);
  assert.equal(provider.lastReplacement?.previousProviderSessionId, before.providerSessionId);
  assert.equal(provider.lastReplacement?.workspace.hostPath, before.workspace.hostPath);
  assert.equal(
    provider.lastReplacement?.instruction,
    'Resume from the existing workspace and finish.',
  );
  const durableExecution = seeded.repositories.executions.get(execution.identity.executionId);
  const durableSession = seeded.repositories.sessions.get(execution.identity.executionId);
  assert.equal(durableExecution.identity.attempt, 3);
  assert.equal(durableExecution.identity.route, 'implementation');
  assert.equal(durableExecution.status, 'RUNNING');
  assert.equal(durableSession.providerSessionId, 'provider-session-2');
  assert.equal(durableSession.providerStatus, 'RUNNING');
  assert.equal(durableSession.workspace.hostPath, before.workspace.hostPath);
  assert.equal(
    seeded.repositories.evidence
      .listByExecution(execution.identity.executionId)
      .filter(
        (item) => item.kind === 'RECOVERY' && item.name.startsWith('provider-session-replacement-'),
      ).length,
    1,
  );
  const repeated = await worker.replaceStalledProviderSession(
    execution.identity.executionId,
    'replace-session-test-key',
    'This changed instruction must not create another provider session.',
    'replayed operator request',
  );
  assert.equal(repeated.status, 'RUNNING');
  assert.equal(repeated.code, 'PROVIDER_SESSION_REPLACEMENT_EXISTING_RUNNING');
  assert.equal(repeated.providerSessionId, 'provider-session-2');
  assert.equal(provider.replaceCalls, 1);
  assert.equal(provider.interruptCalls, 1);
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId,
    'provider-session-2',
  );
  seeded.db.close();
});

test('execution worker accepts the real OpenHands idle launch state and resumes the same session later', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-idle-launch',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchSnapshot = {
    provider: provider.provider,
    providerSessionId: 'idle-session',
    status: 'PAUSED',
    observedAt: now(10),
  };
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-idle' },
  );
  const launched = await worker.runExecution(execution.identity.executionId);
  assert.equal(launched.status, 'WAITING');
  assert.equal(launched.code, 'PROVIDER_PAUSED');
  assert.equal(
    seeded.repositories.executions.get(execution.identity.executionId).status,
    'RUNNING',
  );
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'PAUSED',
  );
  provider.inspectSnapshot = {
    provider: provider.provider,
    providerSessionId: 'idle-session',
    status: 'RUNNING',
    observedAt: now(20),
  };
  const resumed = await worker.runExecution(execution.identity.executionId);
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(provider.launchCalls, 1);
  assert.equal(provider.inspectCalls, 1);
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'RUNNING',
  );
  seeded.db.close();
});

test('execution worker recovers a provider session after launch response loss without a duplicate launch', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-response-loss',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchError = new Error('connection reset after create');
  provider.recoveredSnapshot = undefined;
  const originalRecover = provider.recover.bind(provider);
  provider.recover = async (input) => {
    const value = await originalRecover(input);
    if (provider.launchCalls > 0)
      return {
        provider: provider.provider,
        providerSessionId: 'recovered-session',
        status: 'RUNNING',
        observedAt: now(50),
      };
    return value;
  };
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-recovery' },
  );
  const result = await worker.runExecution(execution.identity.executionId);
  assert.equal(result.status, 'RUNNING');
  assert.equal(provider.launchCalls, 1);
  assert.equal(provider.recoverCalls, 2);
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId,
    'recovered-session',
  );
  seeded.db.close();
});

test('execution worker records retryable provider failure and preserves the same durable session', async () => {
  const seeded = seed();
  const execution = createExecution(seeded.repositories, {
    executionId: 'exec-provider-failure',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
  const workspace = new FakeWorkspace();
  const provider = new FakeProvider();
  provider.launchSnapshot = {
    provider: provider.provider,
    providerSessionId: 'failed-session',
    status: 'FAILED',
    errorCode: 'ServiceUnavailable',
    retryable: true,
    observedAt: now(50),
  };
  const worker = new ExecutionWorker(
    seeded.repositories,
    workspace,
    [{ route: 'implementation', provider }],
    { ownerId: 'worker-failure' },
  );
  const result = await worker.runExecution(execution.identity.executionId);
  assert.equal(result.status, 'FAILED');
  assert.equal(seeded.repositories.executions.get(execution.identity.executionId).status, 'FAILED');
  assert.equal(seeded.repositories.executions.get(execution.identity.executionId).retryable, true);
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerSessionId,
    'failed-session',
  );
  assert.equal(
    seeded.repositories.sessions.get(execution.identity.executionId).providerStatus,
    'FAILED',
  );
  seeded.db.close();
});

test('execution worker binds an independent reviewer and persists PASS or FAIL verdict at the exact revision', async () => {
  for (const verdict of ['PASS', 'FAIL'] as const) {
    const seeded = seed();
    const implementation = createExecution(seeded.repositories, {
      executionId: 'implementation-' + verdict,
      planId: seeded.plan.planId,
      workItemId: seeded.item.workItemId,
    });
    const implementationWorkspace: WorkspaceDescriptor = {
      executionId: implementation.identity.executionId,
      hostPath: '/managed/' + implementation.identity.executionId + '/repo',
      executionPath: '/workspace/' + implementation.identity.executionId + '/repo',
      evidenceHostPath:
        '/managed/' + implementation.identity.executionId + '/completion-evidence.json',
      evidenceExecutionPath:
        '/workspace/' + implementation.identity.executionId + '/completion-evidence.json',
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
    provider.launchSnapshot = {
      provider: provider.provider,
      providerSessionId: 'review-session-' + verdict,
      status: 'SUCCEEDED',
      finalResponse: verdict,
      observedAt: now(100),
    };
    const descriptor = await workspace.provision({
      executionId: reviewer.identity.executionId,
      repositoryPath: seeded.plan.repositoryPath,
      sourceRevision: 'result-sha',
      phase: 'REVIEW',
      sourceWorkspace: implementationWorkspace,
    });
    workspace.completions.set(reviewer.identity.executionId, reviewCompletion(descriptor, verdict));
    const worker = new ExecutionWorker(
      seeded.repositories,
      workspace,
      [{ route: 'review', provider }],
      { ownerId: 'review-worker-' + verdict },
    );
    const result = await worker.runExecution(reviewer.identity.executionId);
    assert.equal(result.status, 'SUCCEEDED');
    const durableReview = seeded.repositories.reviews.getById(review.reviewId);
    assert.equal(durableReview.reviewerExecutionId, reviewer.identity.executionId);
    assert.equal(durableReview.verdict, verdict);
    assert.equal(durableReview.status, verdict === 'PASS' ? 'PASSED' : 'FAILED');
    assert.equal(
      seeded.repositories.executions.get(reviewer.identity.executionId).resultRevision,
      'result-sha',
    );
    seeded.db.close();
  }
});

test('execution worker refuses non-independent review routes and releases a held lease', async () => {
  const seeded = seed();
  const implementation = createExecution(seeded.repositories, {
    executionId: 'implementation-for-route',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
  });
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
  seeded.repositories.reviews.create({
    idempotencyKey: 'route-review',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
    implementationExecutionId: implementation.identity.executionId,
    sourceRevision: 'result-sha',
  });
  const reviewer = createExecution(seeded.repositories, {
    executionId: 'reviewer-wrong-route',
    planId: seeded.plan.planId,
    workItemId: seeded.item.workItemId,
    phase: 'REVIEW',
    parentExecutionId: implementation.identity.executionId,
    sourceRevision: 'result-sha',
    route: 'wrong-review',
  });
  const worker = new ExecutionWorker(
    seeded.repositories,
    new FakeWorkspace(),
    [{ route: 'wrong-review', provider: new FakeProvider() }],
    { ownerId: 'wrong-route-worker' },
  );
  const result = await worker.runExecution(reviewer.identity.executionId);
  assert.equal(result.code, 'INDEPENDENT_REVIEW_PROVIDER_REQUIRED');
  const lease = seeded.repositories.executions.claimLease(
    reviewer.identity.executionId,
    'after-worker',
    1_000,
  );
  assert.ok(lease.value);
  seeded.repositories.executions.releaseLease(
    reviewer.identity.executionId,
    'after-worker',
    lease.value.leaseToken,
  );
  seeded.db.close();
});
