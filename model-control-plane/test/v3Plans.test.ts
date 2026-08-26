import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildControlPlane } from '../src/app.js';
import type { PlanDeliveryPort, PlanDeliveryResult } from '../src/v3/delivery.js';
import type { GitHubGovernanceStatusPort } from '../src/v3/githubGovernanceStatus.js';
import type { GitHubPullRequestRepairPublisherPort } from '../src/v3/githubPrRepairPublisher.js';
import type {
  ExecutionHostCreateInput,
  ExecutionHostPort,
  ExecutionHostSnapshot,
} from '../src/v3/ports.js';
import type { WorkspaceProvisioningPort } from '../src/v3/workspace.js';

class PlanHost implements ExecutionHostPort {
  readonly executions: Map<string, ExecutionHostSnapshot>;
  readonly getBarriers = new Map<string, Promise<void>>();
  creates = 0;
  gets = 0;
  lastCreateInput?: ExecutionHostCreateInput;
  cancelFailure?: Error;

  constructor(executions = new Map<string, ExecutionHostSnapshot>()) {
    this.executions = executions;
  }

  async health() {
    return 'OK' as const;
  }

  async createExecution(input: ExecutionHostCreateInput) {
    this.creates += 1;
    this.lastCreateInput = input;
    const conversationId = `conversation-${this.creates}`;
    const snapshot: ExecutionHostSnapshot = { conversationId, status: 'RUNNING' };
    this.executions.set(conversationId, snapshot);
    return snapshot;
  }

  async getExecution(conversationId: string) {
    this.gets += 1;
    await this.getBarriers.get(conversationId);
    const snapshot = this.executions.get(conversationId);
    if (!snapshot) throw new Error('missing fake execution');
    return snapshot;
  }

  blockGet(conversationId: string, barrier: Promise<void>) {
    this.getBarriers.set(conversationId, barrier);
  }

  async cancelExecution(conversationId: string) {
    if (this.cancelFailure) throw this.cancelFailure;
    const snapshot = await this.getExecution(conversationId);
    snapshot.status = 'PAUSED';
    return snapshot;
  }

  succeed(conversationId: string, finalText: string) {
    const snapshot = this.executions.get(conversationId);
    if (!snapshot) throw new Error('missing fake execution');
    snapshot.status = 'SUCCEEDED';
    snapshot.finalText = finalText;
  }

  timeout(conversationId: string) {
    const snapshot = this.executions.get(conversationId);
    if (!snapshot) throw new Error('missing fake execution');
    snapshot.status = 'STUCK';
  }

  fail(conversationId: string, error: { code: string; detail?: string; retryable: boolean }) {
    const snapshot = this.executions.get(conversationId);
    if (!snapshot) throw new Error('missing fake execution');
    snapshot.status = 'FAILED';
    snapshot.error = error;
  }
}

test('plan reconciliation is serialized per plan without blocking unrelated plans', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-plan-queues-'));
  const host = new PlanHost();
  const runtime = await buildControlPlane({
    dbFile: path.join(directory, 'control-plane.sqlite'),
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  });
  try {
    const create = (projectKey: string) =>
      runtime.v3.createPlan(
        {
          projectKey,
          objective: `Implement ${projectKey}.`,
          analysisSummary: 'One independently verifiable work item.',
          repository: { path: '/tmp/repository', baseRevision: 'base-revision' },
          batches: [
            {
              key: 'batch',
              title: 'Batch',
              workItems: [{ key: 'item', title: 'Item', objective: 'Implement the item.' }],
            },
          ],
        },
        `create-${projectKey}`,
      );
    const first = await create('slow-plan');
    const second = await create('independent-plan');
    const firstConversation =
      first.batches[0]?.workItems[0]?.executions[0]?.refs.openhandsConversationId;
    assert.ok(firstConversation);
    let release!: () => void;
    host.blockGet(
      firstConversation,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const stalled = runtime.v3.reconcilePlans(first.planId);
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('unrelated plan reconciliation blocked')),
        250,
      );
      timer.unref();
    });
    await Promise.race([runtime.v3.reconcilePlans(second.planId), timeout]);
    release();
    await stalled;
  } finally {
    await runtime.app.close();
  }
});

let integrationFailuresRemaining = 0;
let integrationCount = 0;

const workspace: WorkspaceProvisioningPort = {
  hostPathForExecution(executionId) {
    return `/tmp/${executionId}`;
  },
  hostPathForWorkspaceRef(workspaceRef) {
    return `/host${workspaceRef}`;
  },
  async prepareWriterExecution() {
    return { startRevision: 'writer-start' };
  },
  async verifyWriterCompletion() {
    return { startRevision: 'writer-start', headRevision: 'writer-head' };
  },
  async provision(input) {
    return {
      hostPath: `/tmp/${input.executionId}`,
      executionPath: `/workspace/${input.executionId}`,
      branch:
        input.workspaceMode === 'isolated_write' ? `ai-office/${input.executionId}` : undefined,
      sourceRevision: input.baseRevision ?? 'base-revision',
    };
  },
  async integrateBatch(input) {
    if (integrationFailuresRemaining > 0) {
      integrationFailuresRemaining -= 1;
      throw new Error('BATCH_INTEGRATION_FAILED:simulated ownership failure');
    }
    integrationCount += 1;
    return {
      revision: `integrated-${integrationCount}`,
      ref: `refs/ai-office/plans/${input.planId}/batches/${input.batchKey}`,
    };
  },
};

test('durable plans retry a writer instead of reviewing a no-commit success', async () => {
  const host = new PlanHost();
  const noCommitWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    async verifyWriterCompletion() {
      throw new Error('WRITER_COMPLETION_NO_COMMIT');
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: noCommitWorkspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  });

  try {
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'writer-no-commit-plan' },
      payload: {
        projectKey: 'writer-gate-plan',
        objective: 'Require a real implementation commit before review.',
        analysisSummary: 'One work item characterizes writer completion.',
        repository: { path: '/tmp/fake-repo', baseRevision: 'base-revision' },
        batches: [
          {
            key: 'batch',
            title: 'Batch',
            workItems: [{ key: 'item', title: 'Item', objective: 'Implement a real change.' }],
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    const planId = created.json().planId as string;

    await runtime.v3.reconcilePlans(planId);
    let body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const firstWriter = body.batches[0].workItems[0].executions[0];
    assert.equal(firstWriter.phase, 'IMPLEMENT');

    host.succeed(firstWriter.refs.openhandsConversationId, 'Planned only; no commit produced.');
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const executions = body.batches[0].workItems[0].executions;
    assert.equal(executions.length, 2);
    assert.equal(executions[0].status, 'FAILED');
    assert.equal(executions[0].error.code, 'WRITER_COMPLETION_NO_COMMIT');
    assert.equal(executions[1].phase, 'IMPLEMENT');
    assert.equal(
      executions.some((execution: { phase: string }) => execution.phase === 'VERIFY_REVIEW'),
      false,
    );
    assert.equal(host.creates, 2);
  } finally {
    await runtime.app.close();
  }
});

class PlanDelivery implements PlanDeliveryPort {
  readonly results: PlanDeliveryResult[];
  calls = 0;

  constructor(results: PlanDeliveryResult[]) {
    this.results = results;
  }

  async reconcile() {
    const result = this.results[Math.min(this.calls, this.results.length - 1)];
    this.calls += 1;
    if (!result) throw new Error('missing fake delivery result');
    return result;
  }
}

test('a durable plan survives worker timeout, failed review, integration failure, and gateway restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-plan-'));
  const dbFile = path.join(directory, 'control-plane.sqlite');
  const host = new PlanHost();
  integrationFailuresRemaining = 1;
  integrationCount = 0;
  const options = {
    dbFile,
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  } as const;

  let runtime = await buildControlPlane(options);
  try {
    const legacyOrchestration = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'legacy-orchestration' },
      payload: {
        phase: 'ORCHESTRATE',
        projectKey: 'pixel-agents',
        objective: 'Bypass durable plan creation.',
        repository: { path: '/home/ubuntu/projects/pixel-agents' },
      },
    });
    assert.equal(legacyOrchestration.statusCode, 400);
    assert.equal(legacyOrchestration.json().error.code, 'V3_ORCHESTRATE_REQUIRES_DURABLE_PLAN');

    const missingAnalysis = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'missing-analysis' },
      payload: {
        projectKey: 'pixel-agents',
        objective: 'Create an unanalyzed plan.',
        repository: { path: '/home/ubuntu/projects/pixel-agents' },
        batches: [
          {
            key: 'batch',
            title: 'Batch',
            workItems: [{ key: 'item', title: 'Item', objective: 'Implement.' }],
          },
        ],
      },
    });
    assert.equal(missingAnalysis.statusCode, 400);
    assert.equal(missingAnalysis.json().error.code, 'PLAN_ANALYSIS_REQUIRED');

    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'simple-plan' },
      payload: {
        projectKey: 'pixel-agents',
        objective: 'Add and verify a small status endpoint.',
        analysisSummary: 'Two dependent batches isolate implementation from documentation.',
        repository: { path: '/home/ubuntu/projects/pixel-agents', baseRevision: 'base-revision' },
        batches: [
          {
            key: 'batch-1',
            title: 'Implement endpoint',
            workItems: [
              {
                key: 'item-1',
                title: 'Add status endpoint',
                objective: 'Add a small status endpoint with a focused test.',
                acceptanceCriteria: ['The endpoint returns a stable status payload.'],
              },
            ],
          },
          {
            key: 'batch-2',
            title: 'Document endpoint',
            dependsOn: ['batch-1'],
            workItems: [
              {
                key: 'item-2',
                title: 'Document status endpoint',
                objective: 'Document the verified status endpoint.',
                acceptanceCriteria: ['The API documentation includes the endpoint.'],
              },
            ],
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    const planId = created.json().planId as string;

    const getsBeforeProjection = host.gets;
    const durableProjection = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/plans/${planId}`,
    });
    assert.equal(durableProjection.statusCode, 200);
    assert.equal(host.gets, getsBeforeProjection);
    const hydratedProjection = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/plans/${planId}?hydrate=true`,
    });
    assert.equal(hydratedProjection.statusCode, 200);
    assert.equal(host.gets, getsBeforeProjection + 1);

    await runtime.v3.reconcilePlans();
    let plan = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/plans/${planId}`,
    });
    let body = plan.json();
    const firstImplementation = body.batches[0].workItems[0].executions[0];
    assert.equal(firstImplementation.phase, 'IMPLEMENT');
    assert.equal(host.creates, 1);
    assert.match(host.lastCreateInput?.objective ?? '', /commit all intended changes to Git/);

    host.timeout(firstImplementation.refs.openhandsConversationId);
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const retriedImplementation = body.batches[0].workItems[0].executions[1];
    assert.equal(retriedImplementation.phase, 'IMPLEMENT');
    assert.equal(host.creates, 2);

    host.succeed(retriedImplementation.refs.openhandsConversationId, 'IMPLEMENTED');
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const firstReview = body.batches[0].workItems[0].executions[2];
    assert.equal(firstReview.phase, 'VERIFY_REVIEW');

    host.succeed(
      firstReview.refs.openhandsConversationId,
      'Review completed without a strict verdict.',
    );
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const fallbackReview = body.batches[0].workItems[0].executions[3];
    assert.equal(fallbackReview.phase, 'VERIFY_REVIEW');
    assert.equal(fallbackReview.selection.backend, 'openhands-builtin');

    host.fail(fallbackReview.refs.openhandsConversationId, {
      code: 'LLMServiceUnavailableError',
      detail: 'Error code: 503 - No available channel',
      retryable: true,
    });
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const retriedFallbackReview = body.batches[0].workItems[0].executions[4];
    const failedFallbackReview = body.batches[0].workItems[0].executions[3];
    assert.equal(retriedFallbackReview.phase, 'VERIFY_REVIEW');
    assert.equal(retriedFallbackReview.selection.backend, 'openhands-builtin');
    assert.equal(failedFallbackReview.error.code, 'LLMServiceUnavailableError');
    assert.equal(failedFallbackReview.error.retryable, true);

    host.succeed(
      retriedFallbackReview.refs.openhandsConversationId,
      'FAIL\nMissing negative-path test.',
    );
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const fix = body.batches[0].workItems[0].executions[5];
    assert.equal(fix.phase, 'IMPLEMENT_FIX');
    assert.match(host.lastCreateInput?.objective ?? '', /commit all intended fixes to Git/);

    host.succeed(fix.refs.openhandsConversationId, 'FIXED');
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const secondReview = body.batches[0].workItems[0].executions[6];
    assert.equal(secondReview.phase, 'VERIFY_REVIEW');

    host.succeed(
      secondReview.refs.openhandsConversationId,
      'PASS\nAll acceptance criteria verified.',
    );
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'BLOCKED');
    assert.equal(body.blockedReason, 'BATCH_INTEGRATION_FAILED');
    const createsBeforeRestart = host.creates;
    await runtime.app.close();

    const restartedHost = new PlanHost(host.executions);
    restartedHost.creates = host.creates;
    runtime = await buildControlPlane({ ...options, v3ExecutionHost: restartedHost });
    await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/plans/${planId}/reconcile`,
    });
    await runtime.v3.reconcilePlans();
    plan = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/plans/${planId}`,
    });
    body = plan.json();
    assert.equal(body.batches[0].status, 'SUCCEEDED');
    assert.equal(body.batches[1].status, 'RUNNING');
    assert.equal(body.batches[1].baseRevision, body.batches[0].integratedRevision);
    assert.equal(restartedHost.creates, createsBeforeRestart + 1);
    assert.equal(
      body.batches[0].workItems[0].executions.filter(
        (execution: { phase: string }) => execution.phase === 'IMPLEMENT',
      ).length,
      2,
    );
    const getsBeforeList = restartedHost.gets;
    const listed = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/plans?limit=10',
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(restartedHost.gets, getsBeforeList);
  } finally {
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('review fix limits support review-only recovery before an explicitly authorized extra fix', async () => {
  const host = new PlanHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': false,
    },
  });
  try {
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'review-cycle-recovery' },
      payload: {
        projectKey: 'pixel-agents',
        objective: 'Exercise bounded review-fix recovery.',
        analysisSummary: 'One work item isolates review-cycle accounting.',
        repository: { path: '/tmp/fake-repo', baseRevision: 'base-revision' },
        batches: [
          {
            key: 'batch',
            title: 'Batch',
            workItems: [{ key: 'item', title: 'Item', objective: 'Implement and repair.' }],
          },
        ],
      },
    });
    const planId = created.json().planId as string;
    const body = async () =>
      (
        await runtime.app.inject({
          method: 'GET',
          url: `/api/v3/development/plans/${planId}`,
        })
      ).json();
    const latest = async () => (await body()).batches[0].workItems[0].executions.at(-1);

    await runtime.v3.reconcilePlans(planId);
    host.succeed((await latest()).refs.openhandsConversationId, 'IMPLEMENTED');
    await runtime.v3.reconcilePlans(planId);

    host.succeed((await latest()).refs.openhandsConversationId, 'FAIL\nCycle one.');
    await runtime.v3.reconcilePlans(planId);
    host.timeout((await latest()).refs.openhandsConversationId);
    await runtime.v3.reconcilePlans(planId);
    assert.equal((await latest()).phase, 'IMPLEMENT_FIX');
    host.succeed((await latest()).refs.openhandsConversationId, 'FIXED ONE');
    await runtime.v3.reconcilePlans(planId);

    host.succeed((await latest()).refs.openhandsConversationId, 'FAIL\nCycle two.');
    await runtime.v3.reconcilePlans(planId);
    host.succeed((await latest()).refs.openhandsConversationId, 'FIXED TWO');
    await runtime.v3.reconcilePlans(planId);

    host.succeed((await latest()).refs.openhandsConversationId, 'FAIL\nCycle three.');
    await runtime.v3.reconcilePlans(planId);
    assert.equal((await latest()).phase, 'IMPLEMENT_FIX');
    host.succeed((await latest()).refs.openhandsConversationId, 'FIXED THREE');
    await runtime.v3.reconcilePlans(planId);

    host.succeed((await latest()).refs.openhandsConversationId, 'FAIL\nCycle four.');
    await runtime.v3.reconcilePlans(planId);
    assert.equal((await body()).blockedReason, 'REVIEW_FIX_LIMIT_EXCEEDED');
    const fixCountBeforeReviewRetry = (await body()).batches[0].workItems[0].executions.filter(
      (execution: { phase: string }) => execution.phase === 'IMPLEMENT_FIX',
    ).length;

    const invalidRecovery = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/plans/${planId}/reconcile`,
      payload: { mode: 'invented' },
    });
    assert.equal(invalidRecovery.statusCode, 400);
    assert.equal(invalidRecovery.json().error.code, 'PLAN_RECOVERY_MODE_INVALID');

    const reviewRetry = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/plans/${planId}/reconcile`,
      payload: { mode: 'retry_review' },
    });
    assert.equal(reviewRetry.statusCode, 202);
    await runtime.v3.reconcilePlans(planId);
    assert.equal((await body()).status, 'RUNNING');
    assert.equal((await latest()).phase, 'VERIFY_REVIEW');
    assert.equal(
      (await body()).batches[0].workItems[0].executions.filter(
        (execution: { phase: string }) => execution.phase === 'IMPLEMENT_FIX',
      ).length,
      fixCountBeforeReviewRetry,
    );
    assert.match(JSON.stringify((await body()).events), /RETRY_REVIEW/);

    host.succeed(
      (await latest()).refs.openhandsConversationId,
      'FAIL\nReview-only recovery found a real defect.',
    );
    await runtime.v3.reconcilePlans(planId);
    assert.equal((await body()).blockedReason, 'REVIEW_FIX_LIMIT_EXCEEDED');

    const recovered = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/plans/${planId}/reconcile`,
    });
    assert.equal(recovered.statusCode, 202);
    assert.deepEqual(recovered.json(), {
      planId,
      accepted: true,
      status: 'BLOCKED',
      statusUrl: `/api/v3/development/plans/${planId}`,
    });
    await runtime.v3.reconcilePlans(planId);
    assert.equal((await body()).status, 'RUNNING');
    assert.equal((await latest()).phase, 'IMPLEMENT_FIX');
    assert.match(JSON.stringify((await body()).events), /WORK_ITEM_RECOVERY_REQUESTED/);
  } finally {
    await runtime.app.close();
  }
});

test('a delivery-authorized plan is not complete until remote and post-merge checks pass', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-delivery-'));
  const host = new PlanHost();
  const delivery = new PlanDelivery([
    {
      outcome: 'NEEDS_FIX',
      stage: 'MERGE',
      reason: 'DELIVERY_MERGE_CONFLICT',
      pullRequestUrl: 'https://github.test/example/repo/pull/42',
      evidence: {
        mergeStateStatus: 'DIRTY',
        mergeable: 'CONFLICTING',
        branch: 'feature/ship',
        targetBranch: 'main',
        expectedRevision: 'integrated-1',
      },
    },
    {
      outcome: 'WAITING',
      stage: 'CHECKS',
      pullRequestUrl: 'https://github.test/example/repo/pull/42',
      evidence: { pending: ['ci'] },
    },
    {
      outcome: 'WAITING',
      stage: 'POST_MERGE_CHECKS',
      pullRequestUrl: 'https://github.test/example/repo/pull/42',
      evidence: { pending: ['main-smoke'] },
    },
    {
      outcome: 'SUCCEEDED',
      stage: 'SUCCEEDED',
      pullRequestUrl: 'https://github.test/example/repo/pull/42',
      mergeRevision: 'merged-revision',
      evidence: { passed: ['main-smoke'] },
    },
  ]);
  integrationFailuresRemaining = 0;
  integrationCount = 0;
  const runtime = await buildControlPlane({
    dbFile: path.join(directory, 'control-plane.sqlite'),
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3Delivery: delivery,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  });
  try {
    const rejected = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'delivery-without-authorization' },
      payload: {
        projectKey: 'example',
        objective: 'Ship the change.',
        analysisSummary: 'One reviewed batch is sufficient for this delivery.',
        repository: { path: '/repo', baseRevision: 'base' },
        delivery: { branch: 'feature/ship', autoMerge: false },
        batches: [
          {
            key: 'batch',
            title: 'Batch',
            workItems: [{ key: 'item', title: 'Item', objective: 'Implement.' }],
          },
        ],
      },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().error.code, 'DELIVERY_AUTO_MERGE_AUTHORIZATION_REQUIRED');

    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'delivery-plan' },
      payload: {
        projectKey: 'example',
        objective: 'Ship the change.',
        analysisSummary: 'One reviewed batch is sufficient for this delivery.',
        repository: { path: '/repo', baseRevision: 'base' },
        delivery: {
          branch: 'feature/ship',
          targetBranch: 'main',
          autoMerge: true,
          mergeMethod: 'merge',
        },
        batches: [
          {
            key: 'batch',
            title: 'Batch',
            workItems: [{ key: 'item', title: 'Item', objective: 'Implement.' }],
          },
        ],
      },
    });
    const planId = created.json().planId as string;
    let body = created.json();
    const implementation = body.batches[0].workItems[0].executions[0];
    host.succeed(implementation.refs.openhandsConversationId, 'IMPLEMENTED');
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const review = body.batches[0].workItems[0].executions.at(-1);
    host.succeed(review.refs.openhandsConversationId, 'PASS\nVerified.');

    await runtime.v3.reconcilePlans(planId);
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'RUNNING');
    assert.equal(body.batches[1].key, 'delivery-fix-1');
    assert.equal(body.batches[1].status, 'PENDING');
    assert.match(body.batches[1].title, /merge conflict/i);
    assert.match(body.batches[1].workItems[0].title, /merge conflict/i);
    assert.match(body.batches[1].workItems[0].objective, /target branch/i);
    assert.match(body.batches[1].workItems[0].objective, /DELIVERY_MERGE_CONFLICT/);
    assert.deepEqual(body.deliveryEvidence, {
      reason: 'DELIVERY_MERGE_CONFLICT',
      stage: 'MERGE',
      mergeStateStatus: 'DIRTY',
      mergeable: 'CONFLICTING',
      branch: 'feature/ship',
      targetBranch: 'main',
      expectedRevision: 'integrated-1',
    });

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const repairImplementation = body.batches[1].workItems[0].executions[0];
    assert.equal(repairImplementation.phase, 'IMPLEMENT');
    host.succeed(repairImplementation.refs.openhandsConversationId, 'FIXED CI');
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const repairReview = body.batches[1].workItems[0].executions.at(-1);
    host.succeed(repairReview.refs.openhandsConversationId, 'PASS\nCI repair verified.');
    await runtime.v3.reconcilePlans(planId);
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'RUNNING');
    assert.equal(body.deliveryStage, 'CHECKS');
    assert.equal(body.pullRequestUrl, 'https://github.test/example/repo/pull/42');

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'RUNNING');
    assert.equal(body.deliveryStage, 'POST_MERGE_CHECKS');

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(body.deliveryStage, 'SUCCEEDED');
    assert.equal(body.mergeRevision, 'merged-revision');
    assert.equal(body.events.at(-1).type, 'PLAN_SUCCEEDED');
  } finally {
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('plan-scoped cancellation stops active workers and survives repeated requests', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-plan-cancel-'));
  const host = new PlanHost();
  const runtime = await buildControlPlane({
    dbFile: path.join(directory, 'control-plane.sqlite'),
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3BackendAvailability: { 'opencode-acp': true },
  });
  try {
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'cancel-plan' },
      payload: {
        projectKey: 'example',
        objective: 'Cancel this plan.',
        analysisSummary: 'A single active work item exercises plan cancellation.',
        repository: { path: '/repo', baseRevision: 'base' },
        batches: [
          {
            key: 'batch',
            title: 'Batch',
            workItems: [{ key: 'item', title: 'Item', objective: 'Wait for cancellation.' }],
          },
        ],
      },
    });
    const planId = created.json().planId as string;
    const executionId = created.json().batches[0].workItems[0].executions[0].executionId;
    const cancelled = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/plans/${planId}/cancel`,
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, 'CANCELLED');
    assert.equal(cancelled.json().batches[0].status, 'CANCELLED');
    assert.equal(cancelled.json().batches[0].workItems[0].status, 'CANCELLED');
    assert.equal(cancelled.json().batches[0].workItems[0].executions[0].status, 'CANCELLED');
    assert.equal(host.executions.get(`conversation-1`)?.status, 'PAUSED');

    const repeated = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/plans/${planId}/cancel`,
    });
    assert.equal(repeated.json().status, 'CANCELLED');
    assert.equal(
      repeated.json().events.filter((event: { type: string }) => event.type === 'PLAN_CANCELLED')
        .length,
      1,
    );
    assert.equal(executionId.startsWith('exec_'), true);
  } finally {
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('plan cancellation remains durable when an execution host cannot cancel a worker', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-plan-cancel-failure-'));
  const host = new PlanHost();
  host.cancelFailure = new Error('gateway unavailable');
  const runtime = await buildControlPlane({
    dbFile: path.join(directory, 'control-plane.sqlite'),
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3BackendAvailability: { 'opencode-acp': true },
  });
  try {
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'cancel-plan-host-failure' },
      payload: {
        projectKey: 'example',
        objective: 'Cancel durably despite a failed host call.',
        analysisSummary: 'A host failure must not roll back durable cancellation intent.',
        repository: { path: '/repo', baseRevision: 'base' },
        batches: [
          {
            key: 'batch',
            title: 'Batch',
            workItems: [{ key: 'item', title: 'Item', objective: 'Wait for cancellation.' }],
          },
        ],
      },
    });
    const planId = created.json().planId as string;

    const cancelled = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/plans/${planId}/cancel`,
    });

    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, 'CANCELLED');
    assert.equal(
      cancelled
        .json()
        .events.some((event: { type: string }) => event.type === 'PLAN_WORKER_CANCEL_FAILED'),
      true,
    );
    await runtime.v3.reconcilePlans(planId);
    assert.equal((await runtime.v3.getPlan(planId))?.status, 'CANCELLED');
  } finally {
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('delivery repair exhaustion requires an explicit one-at-a-time retry_delivery authorization', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-delivery-retry-'));
  const host = new PlanHost();
  const failedQualityGate: PlanDeliveryResult = {
    outcome: 'NEEDS_FIX',
    stage: 'CHECKS',
    reason: 'DELIVERY_CHECKS_FAILED',
    pullRequestUrl: 'https://github.test/example/repo/pull/99',
    evidence: { failed: ['Repository quality gate'], pending: [], passed: ['commit-lint'] },
  };
  const delivery = new PlanDelivery([
    failedQualityGate,
    failedQualityGate,
    failedQualityGate,
    failedQualityGate,
    failedQualityGate,
  ]);
  integrationFailuresRemaining = 0;
  integrationCount = 0;
  const runtime = await buildControlPlane({
    dbFile: path.join(directory, 'control-plane.sqlite'),
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3Delivery: delivery,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  });
  const body = async () =>
    (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
  let planId = '';

  try {
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'delivery-retry-plan' },
      payload: {
        projectKey: 'example',
        objective: 'Exercise explicit delivery recovery.',
        analysisSummary: 'One reviewed batch is delivered through bounded repair attempts.',
        repository: { path: '/repo', baseRevision: 'base' },
        delivery: {
          branch: 'feature/retry-delivery',
          targetBranch: 'main',
          autoMerge: true,
          mergeMethod: 'merge',
        },
        batches: [
          {
            key: 'batch',
            title: 'Batch',
            workItems: [{ key: 'item', title: 'Item', objective: 'Implement.' }],
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    planId = created.json().planId as string;

    let current = created.json();
    const implementation = current.batches[0].workItems[0].executions[0];
    host.succeed(implementation.refs.openhandsConversationId, 'IMPLEMENTED');
    await runtime.v3.reconcilePlans(planId);
    current = await body();
    const review = current.batches[0].workItems[0].executions.at(-1);
    host.succeed(review.refs.openhandsConversationId, 'PASS\nVerified.');
    await runtime.v3.reconcilePlans(planId);
    await runtime.v3.reconcilePlans(planId);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      current = await body();
      assert.equal(current.batches[attempt].key, `delivery-fix-${attempt}`);
      await runtime.v3.reconcilePlans(planId);
      current = await body();
      const repairImplementation = current.batches[attempt].workItems[0].executions[0];
      host.succeed(repairImplementation.refs.openhandsConversationId, `FIXED ${attempt}`);
      await runtime.v3.reconcilePlans(planId);
      current = await body();
      const repairReview = current.batches[attempt].workItems[0].executions.at(-1);
      host.succeed(repairReview.refs.openhandsConversationId, `PASS\nRepair ${attempt} verified.`);
      await runtime.v3.reconcilePlans(planId);
      await runtime.v3.reconcilePlans(planId);
    }

    current = await body();
    assert.equal(current.status, 'BLOCKED');
    assert.equal(current.blockedReason, 'DELIVERY_FIX_LIMIT_EXCEEDED');
    assert.equal(current.batches.length, 4);

    await runtime.v3.reconcilePlans(planId, true, 'AUTO');
    current = await body();
    assert.equal(current.status, 'BLOCKED');
    assert.equal(
      current.events.filter(
        (event: { type: string }) => event.type === 'PLAN_DELIVERY_REPAIR_RETRY_AUTHORIZED',
      ).length,
      0,
    );

    const authorized = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/plans/${planId}/reconcile`,
      payload: { mode: 'retry_delivery' },
    });
    assert.equal(authorized.statusCode, 202);
    await runtime.v3.reconcilePlans(planId);

    current = await body();
    assert.equal(current.status, 'RUNNING');
    assert.equal(current.batches.length, 5);
    assert.equal(current.batches[4].key, 'delivery-fix-4');
    const authorizations = current.events.filter(
      (event: { type: string }) => event.type === 'PLAN_DELIVERY_REPAIR_RETRY_AUTHORIZED',
    );
    assert.equal(authorizations.length, 1);
    assert.deepEqual(authorizations[0].detail, {
      previousReason: 'DELIVERY_FIX_LIMIT_EXCEEDED',
      authorizedAttempt: 4,
    });
  } finally {
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('external change plans adopt the existing revision, review first, and repair only after a blocking review', async () => {
  const host = new PlanHost();
  integrationCount = 0;
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  });

  try {
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'external-change-review-first' },
      payload: {
        projectKey: 'digital-biome',
        objective: 'Review an externally proposed fix before allowing any AI writer.',
        analysisSummary: 'The change already exists at the supplied external revision.',
        repository: { path: '/tmp/repository', baseRevision: 'base-revision' },
        source: { kind: 'EXTERNAL_CHANGE', revision: 'external-head-revision' },
        batches: [
          {
            key: 'external-pr',
            title: 'Review external PR',
            workItems: [
              {
                key: 'external-pr-change',
                title: 'Validate and review external PR change',
                objective: 'Confirm the claimed problem is real and the proposed repair preserves contracts.',
                acceptanceCriteria: [
                  'The claimed problem is supported by repository evidence.',
                  'The proposed repair preserves protected contracts.',
                ],
              },
            ],
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    const planId = created.json().planId as string;

    let body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const adopted = body.batches[0].workItems[0].executions[0];
    assert.equal(adopted.phase, 'ADOPT_CHANGE');
    assert.equal(adopted.status, 'SUCCEEDED');
    assert.equal(host.creates, 0);

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const firstReview = body.batches[0].workItems[0].executions[1];
    assert.equal(firstReview.phase, 'VERIFY_REVIEW');
    assert.equal(host.creates, 1);
    assert.match(host.lastCreateInput?.objective ?? '', /external change/i);
    assert.match(host.lastCreateInput?.objective ?? '', /problem.*valid/i);

    host.succeed(firstReview.refs.openhandsConversationId, 'FAIL\nThe repair breaks the content schema contract.');
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const fix = body.batches[0].workItems[0].executions[2];
    assert.equal(fix.phase, 'IMPLEMENT_FIX');

    host.succeed(fix.refs.openhandsConversationId, 'FIXED');
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const secondReview = body.batches[0].workItems[0].executions[3];
    assert.equal(secondReview.phase, 'VERIFY_REVIEW');
    assert.match(host.lastCreateInput?.objective ?? '', /This is an external change review/);
    assert.match(host.lastCreateInput?.objective ?? '', /PASS, FAIL, or INVALID/);

    host.succeed(secondReview.refs.openhandsConversationId, 'PASS\nProblem validity and contract preservation verified.');
    await runtime.v3.reconcilePlans(planId);
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(body.currentRevision, 'integrated-1');
  } finally {
    await runtime.app.close();
  }
});

test('an invalid external change is blocked without launching a repair writer', async () => {
  const host = new PlanHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  });

  try {
    const plan = await runtime.v3.createPlan(
      {
        projectKey: 'digital-biome',
        objective: 'Reject a false-positive external change.',
        analysisSummary: 'Review the existing external change before any repair.',
        repository: { path: '/tmp/repository', baseRevision: 'base-revision' },
        source: { kind: 'EXTERNAL_CHANGE', revision: 'external-head-revision' },
        batches: [
          {
            key: 'external-pr',
            title: 'Review external PR',
            workItems: [
              {
                key: 'external-pr-change',
                title: 'Validate external PR',
                objective: 'Verify whether the claimed defect actually exists.',
              },
            ],
          },
        ],
      },
      'external-change-invalid',
    );
    await runtime.v3.reconcilePlans(plan.planId);
    let body = (await runtime.v3.getPlan(plan.planId, true))!;
    const review = body.batches[0]!.workItems[0]!.executions[1]!;
    host.succeed(review.refs.openhandsConversationId!, 'INVALID\nThe claimed defect is not reproducible from repository evidence.');

    await runtime.v3.reconcilePlans(plan.planId);
    body = (await runtime.v3.getPlan(plan.planId, true))!;
    assert.equal(body.status, 'BLOCKED');
    assert.equal(body.blockedReason, 'EXTERNAL_CHANGE_INVALID');
    assert.equal(body.batches[0]!.workItems[0]!.executions.length, 2);
    assert.equal(
      body.batches[0]!.workItems[0]!.executions.some((execution) => execution.phase === 'IMPLEMENT_FIX'),
      false,
    );
  } finally {
    await runtime.app.close();
  }
});

test('external change plans can opt into Antigravity review and repair without changing task defaults', async () => {
  const host = new PlanHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
      'antigravity-review': true,
      'antigravity-worker': true,
    },
  });

  try {
    const plan = await runtime.v3.createPlan(
      {
        projectKey: 'digital-biome',
        objective: 'Review and repair an external PR with Antigravity.',
        analysisSummary: 'External review uses explicit provider-native routing.',
        repository: { path: '/tmp/repository', baseRevision: 'base-revision' },
        source: {
          kind: 'EXTERNAL_CHANGE',
          revision: 'external-head-revision',
          reviewBackend: 'antigravity-review',
          repairBackend: 'antigravity-worker',
        },
        batches: [
          {
            key: 'external-pr',
            title: 'Review external PR',
            workItems: [
              {
                key: 'external-pr-change',
                title: 'Validate external PR',
                objective: 'Verify the defect and implementation quality.',
              },
            ],
          },
        ],
      },
      'external-antigravity-routing',
    );

    await runtime.v3.reconcilePlans(plan.planId);
    let body = (await runtime.v3.getPlan(plan.planId, true))!;
    const review = body.batches[0]!.workItems[0]!.executions[1]!;
    assert.equal(review.phase, 'VERIFY_REVIEW');
    assert.equal(review.selection.backend, 'antigravity-review');
    assert.equal(review.selection.transportMode, 'PROVIDER_NATIVE');
    assert.equal(review.selection.modelClass, 'gemini-3.1-pro-high');

    host.succeed(review.refs.openhandsConversationId!, 'FAIL\nOne blocking defect remains.');
    await runtime.v3.reconcilePlans(plan.planId);
    body = (await runtime.v3.getPlan(plan.planId, true))!;
    const repair = body.batches[0]!.workItems[0]!.executions[2]!;
    assert.equal(repair.phase, 'IMPLEMENT_FIX');
    assert.equal(repair.selection.backend, 'antigravity-worker');
    assert.equal(repair.selection.transportMode, 'PROVIDER_NATIVE');
    assert.equal(repair.selection.modelClass, 'gemini-3.7-flash-high');
  } finally {
    await runtime.app.close();
  }
});

test('a reviewed GitHub PR repair is published to the PR head before the plan can verify successfully', async () => {
  const host = new PlanHost();
  const ORIGINAL = '1111111111111111111111111111111111111111';
  const REPAIRED = '3333333333333333333333333333333333333333';
  const publications: Parameters<GitHubPullRequestRepairPublisherPort['publish']>[0][] = [];
  const governanceCalls: Array<{ revision: string; planStatus: string; stale: boolean }> = [];
  let repairHeadStillPropagating = true;
  const governanceStatus: GitHubGovernanceStatusPort = {
    async publish(input) {
      const stale =
        input.expectedHeadRevision === REPAIRED &&
        input.planStatus === 'SUCCEEDED' &&
        repairHeadStillPropagating;
      if (stale) repairHeadStillPropagating = false;
      governanceCalls.push({
        revision: input.expectedHeadRevision,
        planStatus: input.planStatus,
        stale,
      });
      return {
        revision: input.expectedHeadRevision,
        state: stale ? 'pending' : input.planStatus === 'SUCCEEDED' ? 'success' : 'pending',
        stale,
        observedHeadRevision: stale ? ORIGINAL : input.expectedHeadRevision,
        published: !stale,
      };
    },
  };
  const publisher: GitHubPullRequestRepairPublisherPort = {
    async publish(input) {
      publications.push(input);
      return {
        previousRevision: input.expectedHeadRevision,
        publishedRevision: REPAIRED,
        auditRef: `refs/ai-office/external/github/pr-42/repairs/${input.planId}/${REPAIRED}`,
      };
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3PullRequestRepairPublisher: publisher,
    v3GovernanceStatus: governanceStatus,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  });

  try {
    const plan = await runtime.v3.createPlan(
      {
        projectKey: 'digital-biome',
        objective: 'Repair a GitHub PR only after independent review.',
        analysisSummary: 'GitHub-origin external change.',
        repository: { path: '/tmp/repository', baseRevision: '2222222222222222222222222222222222222222' },
        source: {
          kind: 'EXTERNAL_CHANGE',
          revision: ORIGINAL,
          origin: {
            kind: 'GITHUB_PULL_REQUEST',
            repository: 'example/project',
            pullRequestNumber: 42,
            pullRequestUrl: 'https://github.com/example/project/pull/42',
            title: 'External proposal',
            author: 'jules',
            headRef: 'jules/fix-42',
            baseRef: 'main',
            headRepository: 'example/project',
          },
        },
        batches: [
          {
            key: 'external-pr',
            title: 'Review external PR',
            workItems: [
              {
                key: 'external-pr-change',
                title: 'Validate external PR',
                objective: 'Verify and repair only confirmed blocking defects.',
              },
            ],
          },
        ],
      },
      'github-repair-publication',
    );

    await runtime.v3.reconcilePlans(plan.planId);
    let body = (await runtime.v3.getPlan(plan.planId, true))!;
    const firstReview = body.batches[0]!.workItems[0]!.executions[1]!;
    host.succeed(firstReview.refs.openhandsConversationId!, 'FAIL\nA blocking regression remains.');
    await runtime.v3.reconcilePlans(plan.planId);

    body = (await runtime.v3.getPlan(plan.planId, true))!;
    const fix = body.batches[0]!.workItems[0]!.executions[2]!;
    host.succeed(fix.refs.openhandsConversationId!, 'FIXED');
    await runtime.v3.reconcilePlans(plan.planId);

    body = (await runtime.v3.getPlan(plan.planId, true))!;
    const secondReview = body.batches[0]!.workItems[0]!.executions[3]!;
    host.succeed(secondReview.refs.openhandsConversationId!, 'PASS\nThe repaired change is valid.');
    await runtime.v3.reconcilePlans(plan.planId);

    body = (await runtime.v3.getPlan(plan.planId, true))!;
    assert.equal(publications.length, 1);
    assert.equal(publications[0]!.expectedHeadRevision, ORIGINAL);
    assert.equal(publications[0]!.repository, 'example/project');
    assert.equal(publications[0]!.headRef, 'jules/fix-42');
    assert.match(publications[0]!.workspacePath, /^\/host\/workspace\//);
    assert.equal(body.externalHeadRevision, REPAIRED);
    assert.equal(body.status, 'RUNNING');

    // The next plan reconciliation observes the integrated batch, transitions the
    // plan to SUCCEEDED, and attempts the repaired-head governance publication.
    await runtime.v3.reconcilePlans(plan.planId);
    body = (await runtime.v3.getPlan(plan.planId, true))!;
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(governanceCalls.at(-1)?.revision, REPAIRED);
    assert.equal(governanceCalls.at(-1)?.stale, true);
    assert.equal(body.governanceStatusRevision, REPAIRED);
    assert.notEqual(body.governanceStatusPlanStatus, 'SUCCEEDED');

    // A stale PR API read immediately after our own repair push is propagation lag,
    // not a durable publication. The periodic path must retry and only fingerprint
    // the repaired head after GitHub observes that exact revision.
    await runtime.v3.reconcilePlans();
    body = (await runtime.v3.getPlan(plan.planId, true))!;
    assert.equal(
      governanceCalls.filter(
        (call) => call.revision === REPAIRED && call.planStatus === 'SUCCEEDED',
      ).length,
      2,
    );
    assert.equal(governanceCalls.at(-1)?.stale, false);
    assert.equal(body.governanceStatusRevision, REPAIRED);
    assert.equal(body.governanceStatusPlanStatus, 'SUCCEEDED');
    assert.ok(
      body.events.some(
        (event: Record<string, unknown>) => event.type === 'EXTERNAL_CHANGE_REPAIR_PUBLISHED',
      ),
    );
  } finally {
    await runtime.app.close();
  }
});

test('terminal GitHub governance status is retried durably after a transient reporting failure', async () => {
  const host = new PlanHost();
  const HEAD = '1111111111111111111111111111111111111111';
  const BASE = '2222222222222222222222222222222222222222';
  const calls: Array<{ planStatus: string; revision: string }> = [];
  let failFirstSuccess = true;
  const governanceStatus: GitHubGovernanceStatusPort = {
    async publish(input) {
      calls.push({ planStatus: input.planStatus, revision: input.expectedHeadRevision });
      if (input.planStatus === 'SUCCEEDED' && failFirstSuccess) {
        failFirstSuccess = false;
        throw new Error('simulated GitHub outage');
      }
      return {
        revision: input.expectedHeadRevision,
        state: input.planStatus === 'SUCCEEDED' ? 'success' : 'pending',
        stale: false,
      };
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3GovernanceStatus: governanceStatus,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  });

  try {
    const plan = await runtime.v3.createPlan(
      {
        projectKey: 'digital-biome',
        objective: 'Publish durable GitHub governance state.',
        analysisSummary: 'Review-only GitHub PR path.',
        repository: { path: '/tmp/repository', baseRevision: BASE },
        source: {
          kind: 'EXTERNAL_CHANGE',
          revision: HEAD,
          origin: {
            kind: 'GITHUB_PULL_REQUEST',
            repository: 'example/project',
            pullRequestNumber: 42,
            pullRequestUrl: 'https://github.com/example/project/pull/42',
            title: 'External proposal',
            author: 'jules',
            headRef: 'jules/fix-42',
            baseRef: 'main',
            headRepository: 'example/project',
          },
        },
        batches: [
          {
            key: 'external-pr',
            title: 'Review external PR',
            workItems: [
              {
                key: 'external-pr-change',
                title: 'Validate external PR',
                objective: 'Approve only after independent verification.',
              },
            ],
          },
        ],
      },
      'github-governance-durable-status',
    );
    assert.equal(plan.governanceStatusRequired, true);
    assert.equal(calls.at(-1)?.planStatus, 'RUNNING');

    await runtime.v3.reconcilePlans(plan.planId);
    let body = (await runtime.v3.getPlan(plan.planId, true))!;
    const review = body.batches[0]!.workItems[0]!.executions[1]!;
    host.succeed(review.refs.openhandsConversationId!, 'PASS\nThe external change is valid.');
    await runtime.v3.reconcilePlans(plan.planId);
    await runtime.v3.reconcilePlans(plan.planId);

    body = (await runtime.v3.getPlan(plan.planId, true))!;
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(body.governanceStatusPlanStatus, 'RUNNING');
    assert.equal(calls.filter((call) => call.planStatus === 'SUCCEEDED').length, 1);

    // No plan ID: proves a terminal plan with a stale reporting fingerprint is
    // still selected by PlanRepository.active() and retried by the periodic path.
    await runtime.v3.reconcilePlans();
    body = (await runtime.v3.getPlan(plan.planId, true))!;
    assert.equal(body.governanceStatusRevision, HEAD);
    assert.equal(body.governanceStatusPlanStatus, 'SUCCEEDED');
    assert.equal(calls.filter((call) => call.planStatus === 'SUCCEEDED').length, 2);
  } finally {
    await runtime.app.close();
  }
});
