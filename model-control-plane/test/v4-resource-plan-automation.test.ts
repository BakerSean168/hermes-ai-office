import assert from 'node:assert/strict';
import test from 'node:test';

import { StaticResourceDirectory } from '../src/v4/adapters/resourceDirectory.js';
import type { ExecutionResource } from '../src/v4/domain/resourceRouting.js';
import {
  PlanAutomationRuntime,
  StaticPlanAutomationPolicyResolver,
  type ExecutionRunnerPort,
} from '../src/v4/orchestration/planAutomationRuntime.js';
import { ResourceSelector } from '../src/v4/orchestration/resourceSelector.js';
import type {
  WorkspaceProviderPort,
  WorkspaceProvisionInput,
} from '../src/v4/orchestration/contracts.js';
import { openV4Database } from '../src/v4/persistence/database.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';

function resource(
  resourceId: string,
  resourceSequence: number,
  modelFamily: string,
  routeModel: string,
): ExecutionResource {
  return {
    resourceId,
    displayName: resourceId,
    resourceTier: 'FREE',
    resourceSequence,
    state: 'ACTIVE',
    ready: true,
    commercialType: 'FREE',
    supplyOrigin: 'COMMUNITY_RELAY',
    resourceLifecycle: 'RECURRING',
    bindings: [
      {
        bindingId: resourceId + '-' + modelFamily,
        deploymentId: 'deployment-' + resourceId + '-' + modelFamily,
        modelFamily,
        routeModel,
        protocol: 'openai-chat-completions',
        transport: 'LITELLM_MANAGED',
        enabled: true,
        ready: true,
      },
    ],
  };
}

const unusedRunner: ExecutionRunnerPort = {
  runExecution: async () => {
    throw new Error('runner must not be called while test executions are manually terminalized');
  },
};

const unusedWorkspace: WorkspaceProviderPort = {
  observeRepository: async (repositoryPath: string, revision: string) => ({
    repositoryPath,
    rootPath: repositoryPath,
    headRevision: revision,
    clean: true,
    commitExists: true,
    observedAt: new Date().toISOString(),
  }),
  provision: async (_input: WorkspaceProvisionInput) => {
    throw new Error('workspace must not be provisioned in routing-only test');
  },
  verifyImplementation: async () => {
    throw new Error('not used');
  },
  verifyReview: async () => {
    throw new Error('not used');
  },
  integrateAcceptedRevision: async () => {
    throw new Error('not used');
  },
};

function seeded() {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    idempotencyKey: 'resource-plan',
    projectKey: 'resource-project',
    objective: 'exercise deterministic resource routing',
    repositoryPath: '/repository',
    baseRevision: 'base-sha',
  }).value!;
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'resource routing test',
  }).value!;
  repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'first',
    title: 'First',
    objective: 'Implement first',
    acceptanceCriteria: ['tests pass'],
    dependencies: [],
  });
  repositories.plans.updateStatus(plan.planId, 'READY');
  const selector = new ResourceSelector(
    new StaticResourceDirectory([
      resource('free-a', 101, 'deepseek-v4-flash', 'route-free-a-deepseek'),
      resource('free-b', 102, 'deepseek-v4-flash', 'route-free-b-deepseek'),
      resource('free-sol', 103, 'gpt-5.6-sol', 'route-free-sol'),
    ]),
  );
  const runtime = new PlanAutomationRuntime(
    repositories,
    unusedRunner,
    unusedWorkspace,
    new StaticPlanAutomationPolicyResolver({
      maxImplementationAttempts: 3,
      maxReviewAttempts: 3,
      maxRepairCycles: 2,
      requireDelivery: false,
    }),
    undefined,
    selector,
  );
  return { db, repositories, planId: plan.planId, runtime };
}

test('plan automation reselects the next deterministic resource and reasons without attempt-indexed models', async () => {
  const value = seeded();
  const first = await value.runtime.runPlan(value.planId);
  assert.equal(first.code, 'IMPLEMENTATION_QUEUED');
  const firstExecution = value.repositories.executions.get(first.executionId!);
  const firstSelection = value.repositories.resourceSelections.require(first.executionId!);
  assert.equal(firstSelection.resourceId, 'free-a');
  assert.equal(firstSelection.agentBackend, 'dsh-acp');
  assert.equal(firstSelection.routeModel, 'route-free-a-deepseek');
  assert.match(firstExecution.identity.route, /^resource:free-a:/);

  value.repositories.executions.updateStatus(first.executionId!, 'RUNNING');
  value.repositories.executions.recordResult(first.executionId!, {
    status: 'FAILED',
    errorCode: 'PROVIDER_UNAVAILABLE',
    retryable: true,
  });
  const retried = await value.runtime.runPlan(value.planId);
  assert.equal(retried.code, 'IMPLEMENTATION_RETRY_QUEUED');
  const retrySelection = value.repositories.resourceSelections.require(retried.executionId!);
  assert.equal(retrySelection.resourceId, 'free-b');
  assert.equal(retrySelection.modelFamily, 'deepseek-v4-flash');
  assert.notEqual(retrySelection.bindingId, firstSelection.bindingId);

  value.repositories.executions.updateStatus(retried.executionId!, 'RUNNING');
  value.repositories.executions.recordResult(retried.executionId!, {
    status: 'SUCCEEDED',
    resultRevision: 'result-sha',
    resultSummary: 'implemented',
  });
  const review = await value.runtime.runPlan(value.planId);
  assert.equal(review.code, 'REVIEW_QUEUED');
  const reviewExecution = value.repositories.executions.get(review.executionId!);
  const reviewSelection = value.repositories.resourceSelections.require(review.executionId!);
  assert.equal(reviewExecution.identity.phase, 'REVIEW');
  assert.equal(reviewSelection.capability, 'REASONING');
  assert.equal(reviewSelection.modelFamily, 'gpt-5.6-sol');
  assert.equal(reviewSelection.resourceId, 'free-sol');
  assert.equal(reviewSelection.agentBackend, 'codex-acp');
  assert.doesNotMatch(reviewExecution.identity.route, /codex-auto-review/);
  value.db.close();
});

test('plan automation repairs a crash between reviewer completion and review verdict persistence', async () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    idempotencyKey: 'review-recovery-plan',
    projectKey: 'resource-project',
    objective: 'recover exact review verdict',
    repositoryPath: '/repository',
    baseRevision: 'base-sha',
  }).value!;
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'review recovery test',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'first',
    title: 'First',
    objective: 'Implement first',
    acceptanceCriteria: ['tests pass'],
    dependencies: [],
  }).value!;
  repositories.plans.updateStatus(plan.planId, 'READY');
  let repositoryHead = 'base-sha';
  const workspace: WorkspaceProviderPort = {
    observeRepository: async (repositoryPath: string, revision: string) => ({
      repositoryPath,
      rootPath: repositoryPath,
      headRevision: repositoryHead,
      clean: true,
      commitExists: revision === 'result-sha' || revision === repositoryHead,
      observedAt: new Date().toISOString(),
    }),
    provision: async () => {
      throw new Error('not used');
    },
    verifyImplementation: async () => {
      throw new Error('not used');
    },
    verifyReview: async () => {
      throw new Error('not used');
    },
    integrateAcceptedRevision: async (input) => {
      repositoryHead = input.acceptedRevision;
      return {
        repositoryPath: input.repositoryPath,
        rootPath: input.repositoryPath,
        headRevision: input.acceptedRevision,
        clean: true,
        commitExists: true,
        observedAt: new Date().toISOString(),
      };
    },
  };
  const runtime = new PlanAutomationRuntime(
    repositories,
    unusedRunner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      maxImplementationAttempts: 2,
      maxReviewAttempts: 2,
      maxRepairCycles: 1,
      requireDelivery: false,
    }),
    undefined,
    new ResourceSelector(
      new StaticResourceDirectory([
        resource('free-a', 101, 'deepseek-v4-flash', 'route-free-a-deepseek'),
        resource('free-sol', 103, 'gpt-5.6-sol', 'route-free-sol'),
      ]),
    ),
  );

  const queued = await runtime.runPlan(plan.planId);
  const implementation = repositories.executions.get(queued.executionId!);
  const implementationWorkspace = {
    executionId: implementation.identity.executionId,
    hostPath: '/managed/implementation/repo',
    executionPath: '/workspace/implementation/repo',
    evidenceHostPath: '/managed/implementation/completion-evidence.json',
    evidenceExecutionPath: '/workspace/implementation/completion-evidence.json',
    sourceRepositoryPath: '/repository',
    sourceRevision: 'base-sha',
    createdAt: new Date().toISOString(),
  };
  repositories.sessions.create({
    executionId: implementation.identity.executionId,
    phase: 'IMPLEMENT',
    provider: 'dsh-acp',
    workspace: implementationWorkspace,
    sourceRevision: 'base-sha',
  });
  repositories.sessions.attachProviderSession(implementation.identity.executionId, 'impl-session');
  repositories.sessions.complete(implementation.identity.executionId, {
    status: 'SUCCEEDED',
    finalResponse: 'implemented',
    completedAt: new Date().toISOString(),
  });
  repositories.executions.updateStatus(implementation.identity.executionId, 'RUNNING');
  repositories.executions.recordResult(implementation.identity.executionId, {
    status: 'SUCCEEDED',
    resultRevision: 'result-sha',
    resultSummary: 'implemented',
  });

  const reviewQueued = await runtime.runPlan(plan.planId);
  const reviewer = repositories.executions.get(reviewQueued.executionId!);
  const review = repositories.reviews.listByWorkItem(item.workItemId)[0]!;
  const reviewWorkspace = {
    executionId: reviewer.identity.executionId,
    hostPath: '/managed/review/repo',
    executionPath: '/workspace/review/repo',
    evidenceHostPath: '/managed/review/completion-evidence.json',
    evidenceExecutionPath: '/workspace/review/completion-evidence.json',
    sourceRepositoryPath: '/repository',
    sourceRevision: 'result-sha',
    createdAt: new Date().toISOString(),
  };
  repositories.sessions.create({
    executionId: reviewer.identity.executionId,
    phase: 'REVIEW',
    provider: 'codex-acp',
    workspace: reviewWorkspace,
    sourceRevision: 'result-sha',
  });
  repositories.sessions.attachProviderSession(reviewer.identity.executionId, 'review-session');
  repositories.sessions.complete(reviewer.identity.executionId, {
    status: 'SUCCEEDED',
    finalResponse: 'PASS',
    completedAt: new Date().toISOString(),
  });
  repositories.reviews.attachReviewerExecution(review.reviewId, reviewer.identity.executionId);
  repositories.reviews.updateStatus(review.reviewId, 'RUNNING');
  repositories.executions.updateStatus(reviewer.identity.executionId, 'RUNNING');
  repositories.executions.recordResult(reviewer.identity.executionId, {
    status: 'SUCCEEDED',
    resultRevision: 'result-sha',
    resultSummary: 'PASS',
  });
  repositories.evidence.append({
    executionId: reviewer.identity.executionId,
    kind: 'REVIEW',
    name: 'review-verdict',
    sourceRevision: 'result-sha',
    payload: { verdict: 'PASS', reviewedSha: 'result-sha', findings: [] },
  });

  const recovered = await runtime.runPlan(plan.planId);
  assert.equal(recovered.status, 'SUCCEEDED');
  assert.equal(repositories.reviews.getById(review.reviewId).status, 'PASSED');
  assert.equal(repositories.plans.getPlan(plan.planId).status, 'SUCCEEDED');
  assert.equal(repositoryHead, 'result-sha');
  db.close();
});
