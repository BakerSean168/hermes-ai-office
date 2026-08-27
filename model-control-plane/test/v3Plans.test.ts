import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildControlPlane } from '../src/app.js';
import type { PlanDeliveryPort, PlanDeliveryResult } from '../src/v3/delivery.js';
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

test('delegated plans persist an orchestration identity before OpenHands materializes the graph', async () => {
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
    const request = () =>
      runtime.app.inject({
        method: 'POST',
        url: '/api/v3/development/delegations',
        headers: { 'idempotency-key': 'delegate-body-sense-active-plan' },
        payload: {
          projectKey: 'bodysense',
          objective: 'Implement the engineering work in the current active plan.',
          repository: { path: '/tmp/repository', baseRevision: 'base-revision' },
        },
      });

    const first = await request();
    assert.equal(first.statusCode, 202);
    const delegated = first.json();
    assert.match(delegated.planId, /^plan_/);
    assert.equal(delegated.status, 'ORCHESTRATING');
    assert.deepEqual(delegated.batches, []);
    assert.equal(delegated.orchestration.phase, 'ORCHESTRATE');
    assert.equal(delegated.orchestration.status, 'RUNNING');
    assert.equal(host.creates, 1);
    assert.equal(host.lastCreateInput?.phase, 'ORCHESTRATE');

    const second = await request();
    assert.equal(second.statusCode, 202);
    assert.equal(second.json().planId, delegated.planId);
    assert.equal(host.creates, 1);

    const conversationId = delegated.orchestration.refs.openhandsConversationId as string;
    host.succeed(
      conversationId,
      JSON.stringify({
        analysisSummary: 'One implementation ticket is sufficient after repository inspection.',
        batches: [
          {
            key: 'implementation',
            title: 'Implementation',
            dependsOn: [],
            workItems: [
              {
                key: 'change',
                title: 'Implement change',
                objective: 'Implement and verify the requested change.',
                acceptanceCriteria: ['Focused regression passes.'],
              },
            ],
          },
        ],
      }),
    );
    await runtime.v3.reconcilePlans(delegated.planId);

    const materialized = (
      await runtime.app.inject({
        method: 'GET',
        url: `/api/v3/development/plans/${delegated.planId}`,
      })
    ).json();
    assert.equal(materialized.status, 'RUNNING');
    assert.equal(materialized.batches.length, 1);
    assert.equal(materialized.batches[0].workItems.length, 1);
    assert.equal(materialized.batches[0].workItems[0].executions[0].phase, 'IMPLEMENT');
    assert.equal(host.creates, 2);
    assert.ok(
      materialized.events.some((event: { type: string }) => event.type === 'PLAN_ORCHESTRATED'),
    );
  } finally {
    await runtime.app.close();
  }
});

test('delegated orchestration survives a control-plane restart without duplicating the supervisor', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-delegation-restart-'));
  const dbFile = path.join(directory, 'control-plane.sqlite');
  const host = new PlanHost();
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
    const delegated = (
      await runtime.app.inject({
        method: 'POST',
        url: '/api/v3/development/delegations',
        headers: { 'idempotency-key': 'delegate-restart-proof' },
        payload: {
          projectKey: 'digital-biome',
          objective: 'Delegate a durable one-ticket change.',
          repository: { path: '/tmp/repository', baseRevision: 'base-revision' },
        },
      })
    ).json();
    const planId = delegated.planId as string;
    const orchestrationConversation = delegated.orchestration.refs
      .openhandsConversationId as string;
    assert.equal(host.creates, 1);

    await runtime.app.close();
    runtime = await buildControlPlane(options);
    await runtime.v3.reconcilePlans(planId);
    let resumed = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(resumed.status, 'ORCHESTRATING');
    assert.equal(resumed.orchestration.refs.openhandsConversationId, orchestrationConversation);
    assert.equal(host.creates, 1);

    host.succeed(
      orchestrationConversation,
      JSON.stringify({
        analysisSummary: 'Repository evidence supports one independent ticket.',
        batches: [
          {
            key: 'batch',
            title: 'Batch',
            dependsOn: [],
            workItems: [
              {
                key: 'item',
                title: 'Item',
                objective: 'Implement the requested change.',
                acceptanceCriteria: ['Focused verification passes.'],
              },
            ],
          },
        ],
      }),
    );
    await runtime.v3.reconcilePlans(planId);
    resumed = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(resumed.status, 'RUNNING');
    assert.equal(resumed.batches[0].workItems[0].executions[0].phase, 'IMPLEMENT');
    assert.equal(host.creates, 2);
  } finally {
    await runtime.app.close();
  }
});

test('delegated orchestration retries invalid supervisor output without starting a writer', async () => {
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
    const delegated = (
      await runtime.app.inject({
        method: 'POST',
        url: '/api/v3/development/delegations',
        headers: { 'idempotency-key': 'delegate-invalid-first-output' },
        payload: {
          projectKey: 'memo-flow',
          objective: 'Delegate a bounded refactor.',
          repository: { path: '/tmp/repository', baseRevision: 'base-revision' },
        },
      })
    ).json();
    host.succeed(
      delegated.orchestration.refs.openhandsConversationId,
      'I inspected it; looks good.',
    );
    await runtime.v3.reconcilePlans(delegated.planId);
    let body = (
      await runtime.app.inject({
        method: 'GET',
        url: `/api/v3/development/plans/${delegated.planId}`,
      })
    ).json();
    assert.equal(body.status, 'ORCHESTRATING');
    assert.equal(body.batches.length, 0);
    assert.equal(host.creates, 2);
    assert.equal(body.orchestration.phase, 'ORCHESTRATE');
    assert.equal(body.orchestration.status, 'RUNNING');
    assert.equal(
      body.events.filter((event: { type: string }) => event.type === 'PLAN_ORCHESTRATION_STARTED')
        .length,
      2,
    );
  } finally {
    await runtime.app.close();
  }
});

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

    const standaloneBatchVerify = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'standalone-batch-verify' },
      payload: {
        phase: 'BATCH_VERIFY',
        projectKey: 'pixel-agents',
        objective: 'Bypass durable batch candidate governance.',
        repository: { path: '/home/ubuntu/projects/pixel-agents', baseRevision: 'base-revision' },
      },
    });
    assert.equal(standaloneBatchVerify.statusCode, 400);
    assert.equal(standaloneBatchVerify.json().error.code, 'V3_BATCH_VERIFY_REQUIRES_DURABLE_PLAN');

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

    const summarized = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/plans?limit=10&view=summary',
    });
    assert.equal(summarized.statusCode, 200);
    const summaryPlan = summarized.json().items.find((item: { planId: string }) => item.planId === planId);
    assert.ok(summaryPlan);
    assert.equal('events' in summaryPlan, false);
    assert.equal('orchestration' in summaryPlan, false);
    for (const summaryBatch of summaryPlan.batches) {
      for (const summaryItem of summaryBatch.workItems) {
        assert.ok(summaryItem.executions.length <= 1);
      }
    }
    assert.equal(restartedHost.gets, getsBeforeList);

    const invalidView = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/plans?view=everything',
    });
    assert.equal(invalidView.statusCode, 400);
    assert.equal(invalidView.json().error.code, 'PLAN_LIST_VIEW_INVALID');
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

test('batch Git conflicts schedule a premium LLM integration repair and only integrate the reviewed combined head', async () => {
  const host = new PlanHost();
  let integrationCalls = 0;
  const seenIntegrationInputs: Array<Parameters<WorkspaceProvisioningPort['integrateBatch']>[0]> =
    [];
  const conflictWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    async integrateBatch(input) {
      integrationCalls += 1;
      seenIntegrationInputs.push(input);
      if (integrationCalls === 1) {
        throw new Error(
          'BATCH_INTEGRATION_CONFLICT:GIT_COMMAND_FAILED:CONFLICT (content): Merge conflict in shared.ts',
        );
      }
      return {
        revision: 'integrated-after-repair',
        ref: `refs/ai-office/plans/${input.planId}/batches/${input.batchKey}`,
      };
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: conflictWorkspace,
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
      headers: { 'idempotency-key': 'batch-integration-repair-plan' },
      payload: {
        projectKey: 'memoflow',
        objective: 'Implement two independently reviewable changes that overlap at integration.',
        analysisSummary:
          'The two business changes are independent but may touch shared composition.',
        repository: { path: '/tmp/memoflow', baseRevision: 'base-revision' },
        batches: [
          {
            key: 'batch-1',
            title: 'Parallel business changes',
            workItems: [
              {
                key: 'task-change',
                title: 'Task change',
                objective: 'Implement the Task behavior.',
                acceptanceCriteria: ['Task behavior is correct.'],
              },
              {
                key: 'goal-change',
                title: 'Goal change',
                objective: 'Implement the Goal behavior.',
                acceptanceCriteria: ['Goal behavior is correct.'],
              },
            ],
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
    const originalItems = body.batches[0].workItems;
    assert.equal(originalItems.length, 2);
    for (const item of originalItems) {
      const implementation = item.executions[0];
      assert.equal(implementation.phase, 'IMPLEMENT');
      host.succeed(implementation.refs.openhandsConversationId, 'IMPLEMENTED');
    }

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    for (const item of body.batches[0].workItems) {
      const review = item.executions.at(-1);
      assert.equal(review.phase, 'VERIFY_REVIEW');
      host.succeed(review.refs.openhandsConversationId, 'PASS\nIndependently verified.');
    }

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'RUNNING');
    assert.equal(body.batches[0].status, 'RUNNING');
    assert.equal(integrationCalls, 1);
    assert.equal(body.batches[0].workItems.length, 3);
    const repairItem = body.batches[0].workItems.find((item: { key: string }) =>
      item.key.startsWith('integration-repair-b1-'),
    );
    assert.ok(repairItem);
    assert.equal(repairItem.status, 'PENDING');
    assert.match(repairItem.objective, /semantic Git integration conflict/);
    assert.match(repairItem.objective, /all listed approved revisions must remain Git ancestors/i);
    assert.match(repairItem.objective, /task-change/);
    assert.match(repairItem.objective, /goal-change/);

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const runningRepair = body.batches[0].workItems.find((item: { key: string }) =>
      item.key.startsWith('integration-repair-b1-'),
    );
    const repairImplementation = runningRepair.executions[0];
    assert.equal(repairImplementation.phase, 'IMPLEMENT');
    assert.equal(repairImplementation.selection.backend, 'openhands-builtin');
    assert.equal(repairImplementation.selection.modelClass, 'gpt-5.6-sol');
    host.succeed(repairImplementation.refs.openhandsConversationId, 'INTEGRATED AND COMMITTED');

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const repairReview = body.batches[0].workItems
      .find((item: { key: string }) => item.key.startsWith('integration-repair-b1-'))
      .executions.at(-1);
    assert.equal(repairReview.phase, 'VERIFY_REVIEW');
    host.succeed(repairReview.refs.openhandsConversationId, 'PASS\nCombined repair verified.');

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.batches[0].status, 'RUNNING');
    assert.equal(body.batches[0].integratedRevision, 'integrated-after-repair');
    assert.equal(integrationCalls, 2);
    assert.equal(seenIntegrationInputs[0]?.implementations.length, 2);
    assert.equal(seenIntegrationInputs[1]?.implementations.length, 1);
    assert.deepEqual(seenIntegrationInputs[1]?.requiredAncestorRevisions, ['HEAD']);

    // A successful Git integration is only a candidate. Multi-item batches require
    // one premium aggregate semantic review before the revision becomes canonical.
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const batchReviewItem = body.batches[0].workItems.find((item: { key: string }) =>
      item.key.startsWith('batch-verify-b1-'),
    );
    assert.ok(batchReviewItem);
    const batchReview = batchReviewItem.executions.at(-1);
    assert.equal(batchReview.phase, 'BATCH_VERIFY');
    assert.equal(batchReview.selection.backend, 'codex-review-headless');
    assert.equal(batchReview.selection.modelClass, 'gpt-5.6-sol');
    assert.match(
      batchReviewItem.objective,
      /Integrated candidate revision: integrated-after-repair/,
    );
    host.succeed(
      batchReview.refs.openhandsConversationId,
      'PASS\nCombined batch semantics verified.',
    );

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.batches[0].status, 'SUCCEEDED');
    assert.equal(body.status, 'RUNNING');

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(body.currentRevision, 'integrated-after-repair');
    assert.equal(body.blockedReason, undefined);
  } finally {
    await runtime.app.close();
  }
});

test('clean multi-item integration is aggregate-reviewed and semantic FAIL schedules a premium repair before promotion', async () => {
  const host = new PlanHost();
  let integrationCalls = 0;
  const provisionInputs: Array<Parameters<WorkspaceProvisioningPort['provision']>[0]> = [];
  const semanticWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    async provision(input) {
      provisionInputs.push(input);
      return workspace.provision(input);
    },
    async integrateBatch(input) {
      integrationCalls += 1;
      return {
        revision: `aggregate-candidate-${integrationCalls}`,
        ref: `refs/ai-office/plans/${input.planId}/batches/${input.batchKey}`,
      };
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: semanticWorkspace,
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
      headers: { 'idempotency-key': 'aggregate-semantic-review-plan' },
      payload: {
        projectKey: 'memoflow',
        objective: 'Combine two independently reviewed changes safely.',
        analysisSummary: 'The batch is intentionally parallel and requires aggregate semantics.',
        repository: { path: '/tmp/memoflow', baseRevision: 'base-revision' },
        batches: [
          {
            key: 'batch-1',
            title: 'Parallel changes',
            workItems: [
              {
                key: 'task',
                title: 'Task behavior',
                objective: 'Implement Task behavior.',
                acceptanceCriteria: ['Task behavior remains correct after integration.'],
              },
              {
                key: 'goal',
                title: 'Goal behavior',
                objective: 'Implement Goal behavior.',
                acceptanceCriteria: ['Goal behavior remains correct after integration.'],
              },
            ],
          },
        ],
      },
    });
    const planId = created.json().planId as string;

    await runtime.v3.reconcilePlans(planId);
    let body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    for (const item of body.batches[0].workItems) {
      host.succeed(item.executions[0].refs.openhandsConversationId, 'IMPLEMENTED');
    }

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    for (const item of body.batches[0].workItems) {
      host.succeed(item.executions.at(-1).refs.openhandsConversationId, 'PASS\nTicket verified.');
    }

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.batches[0].status, 'RUNNING');
    assert.equal(body.batches[0].integratedRevision, 'aggregate-candidate-1');
    assert.equal(body.currentRevision, 'base-revision');

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const firstAggregateItem = body.batches[0].workItems.find((item: { key: string }) =>
      item.key.startsWith('batch-verify-b1-'),
    );
    const firstAggregateReview = firstAggregateItem.executions.at(-1);
    assert.equal(firstAggregateReview.phase, 'BATCH_VERIFY');
    assert.equal(firstAggregateReview.selection.backend, 'codex-review-headless');
    assert.equal(firstAggregateReview.selection.modelClass, 'gpt-5.6-sol');
    host.succeed(
      firstAggregateReview.refs.openhandsConversationId,
      'FAIL\nTask and Goal register competing ownership for the same shared adapter.',
    );

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.batches[0].status, 'RUNNING');
    assert.equal(body.currentRevision, 'base-revision');
    const repair = body.batches[0].workItems.find((item: { key: string }) =>
      item.key.startsWith('integration-repair-b1-'),
    );
    assert.ok(repair);
    assert.match(
      repair.objective,
      /starts from integrated candidate revision aggregate-candidate-1/,
    );
    assert.match(repair.objective, /competing ownership/);

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const repairRunning = body.batches[0].workItems.find((item: { key: string }) =>
      item.key.startsWith('integration-repair-b1-'),
    );
    const repairImplementation = repairRunning.executions[0];
    assert.equal(repairImplementation.phase, 'IMPLEMENT');
    assert.equal(repairImplementation.selection.backend, 'openhands-builtin');
    assert.equal(repairImplementation.selection.modelClass, 'gpt-5.6-sol');
    assert.ok(
      provisionInputs.some(
        (input) =>
          input.workspaceMode === 'isolated_write' &&
          input.baseRevision === 'aggregate-candidate-1',
      ),
    );
    host.succeed(repairImplementation.refs.openhandsConversationId, 'REPAIRED');

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const repairReview = body.batches[0].workItems
      .find((item: { key: string }) => item.key.startsWith('integration-repair-b1-'))
      .executions.at(-1);
    assert.equal(repairReview.phase, 'VERIFY_REVIEW');
    host.succeed(repairReview.refs.openhandsConversationId, 'PASS\nRepair verified.');

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.batches[0].integratedRevision, 'aggregate-candidate-2');
    assert.equal(body.batches[0].status, 'RUNNING');
    assert.equal(integrationCalls, 2);

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const aggregateItems = body.batches[0].workItems.filter((item: { key: string }) =>
      item.key.startsWith('batch-verify-b1-'),
    );
    assert.equal(aggregateItems.length, 2);
    const secondAggregateReview = aggregateItems.at(-1).executions.at(-1);
    assert.equal(secondAggregateReview.phase, 'BATCH_VERIFY');
    host.succeed(
      secondAggregateReview.refs.openhandsConversationId,
      'PASS\nCombined semantics verified.',
    );

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.batches[0].status, 'SUCCEEDED');
    assert.equal(body.currentRevision, 'aggregate-candidate-2');
    assert.ok(
      body.events.some((event: { type: string }) => event.type === 'BATCH_AGGREGATE_REVIEW_FAILED'),
    );
    assert.ok(
      body.events.some((event: { type: string }) => event.type === 'BATCH_AGGREGATE_VERIFIED'),
    );
  } finally {
    await runtime.app.close();
  }
});

test('failed post-merge checks launch a premium follow-up repair and require the failed merge revision as an ancestor', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-post-merge-repair-'));
  const host = new PlanHost();
  const seenIntegrations: Array<Parameters<WorkspaceProvisioningPort['integrateBatch']>[0]> = [];
  let localIntegrationCount = 0;
  const postMergeWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    async integrateBatch(input) {
      seenIntegrations.push(input);
      localIntegrationCount += 1;
      return {
        revision: `post-merge-integrated-${localIntegrationCount}`,
        ref: `refs/ai-office/plans/${input.planId}/batches/${input.batchKey}`,
      };
    },
  };
  const delivery = new PlanDelivery([
    {
      outcome: 'NEEDS_FIX',
      stage: 'POST_MERGE_CHECKS',
      reason: 'DELIVERY_POST_MERGE_CHECKS_FAILED',
      pullRequestUrl: 'https://github.test/example/repo/pull/50',
      mergeRevision: 'merge-bad-1',
      evidence: {
        reason: 'DELIVERY_POST_MERGE_CHECKS_FAILED',
        mergeRevision: 'merge-bad-1',
        branch: 'feature/ship',
        targetBranch: 'main',
        pullRequestNumber: 50,
        failed: ['main-smoke'],
        passed: ['typecheck'],
        pending: [],
      },
    },
    {
      outcome: 'WAITING',
      stage: 'CHECKS',
      pullRequestUrl: 'https://github.test/example/repo/pull/51',
      evidence: { pending: ['ci'], failed: [], passed: [] },
    },
    {
      outcome: 'WAITING',
      stage: 'POST_MERGE_CHECKS',
      pullRequestUrl: 'https://github.test/example/repo/pull/51',
      evidence: { pending: ['main-smoke'], failed: [], passed: ['typecheck'] },
    },
    {
      outcome: 'SUCCEEDED',
      stage: 'SUCCEEDED',
      pullRequestUrl: 'https://github.test/example/repo/pull/51',
      mergeRevision: 'merge-good-2',
      evidence: { pending: [], failed: [], passed: ['main-smoke', 'typecheck'] },
    },
  ]);
  const runtime = await buildControlPlane({
    dbFile: path.join(directory, 'control-plane.sqlite'),
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: postMergeWorkspace,
    v3Delivery: delivery,
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
      headers: { 'idempotency-key': 'post-merge-repair-plan' },
      payload: {
        projectKey: 'example',
        objective: 'Ship and recover safely from a main-branch CI regression.',
        analysisSummary: 'One implementation batch followed by protected delivery.',
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
            workItems: [
              {
                key: 'item',
                title: 'Item',
                objective: 'Implement the change.',
                acceptanceCriteria: ['The requested behavior is implemented.'],
              },
            ],
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    const planId = created.json().planId as string;
    host.succeed(
      created.json().batches[0].workItems[0].executions[0].refs.openhandsConversationId,
      'IMPLEMENTED',
    );

    await runtime.v3.reconcilePlans(planId);
    let body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const firstReview = body.batches[0].workItems[0].executions.at(-1);
    host.succeed(firstReview.refs.openhandsConversationId, 'PASS\nVerified.');

    await runtime.v3.reconcilePlans(planId); // integrate original batch
    await runtime.v3.reconcilePlans(planId); // observe failed post-merge checks and schedule repair
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'RUNNING');
    assert.equal(body.mergeRevision, 'merge-bad-1');
    assert.equal(body.deliveryStage, 'PENDING');
    assert.equal(body.batches[1].key, 'delivery-fix-1');
    assert.match(body.batches[1].title, /post-merge/i);
    const repairItem = body.batches[1].workItems[0];
    assert.equal(repairItem.key, 'post-merge-fix-1');
    assert.match(repairItem.objective, /follow-up repair after the previous pull request already merged/i);
    assert.match(repairItem.objective, /merge-bad-1/);
    assert.match(repairItem.objective, /current target branch/i);
    assert.deepEqual(body.deliveryEvidence, {
      reason: 'DELIVERY_POST_MERGE_CHECKS_FAILED',
      stage: 'POST_MERGE_CHECKS',
      mergeRevision: 'merge-bad-1',
      branch: 'feature/ship',
      targetBranch: 'main',
      pullRequestNumber: 50,
      failed: ['main-smoke'],
      passed: ['typecheck'],
      pending: [],
    });

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const repairImplementation = body.batches[1].workItems[0].executions[0];
    assert.equal(repairImplementation.phase, 'IMPLEMENT');
    assert.equal(repairImplementation.selection.backend, 'openhands-builtin');
    assert.equal(repairImplementation.selection.modelClass, 'gpt-5.6-sol');
    host.succeed(repairImplementation.refs.openhandsConversationId, 'FOLLOW-UP FIX COMMITTED');

    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const repairReview = body.batches[1].workItems[0].executions.at(-1);
    assert.equal(repairReview.phase, 'VERIFY_REVIEW');
    assert.equal(repairReview.selection.backend, 'codex-review-headless');
    assert.equal(repairReview.selection.modelClass, 'gpt-5.6-sol');
    host.succeed(repairReview.refs.openhandsConversationId, 'PASS\nFollow-up repair verified.');

    await runtime.v3.reconcilePlans(planId); // integrate repair
    assert.deepEqual(seenIntegrations.at(-1)?.requiredAncestorRevisions, ['merge-bad-1']);

    await runtime.v3.reconcilePlans(planId); // new repair PR checks
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.deliveryStage, 'CHECKS');
    assert.equal(body.pullRequestUrl, 'https://github.test/example/repo/pull/51');

    await runtime.v3.reconcilePlans(planId); // new merge, post-merge checks pending
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.deliveryStage, 'POST_MERGE_CHECKS');

    await runtime.v3.reconcilePlans(planId); // follow-up post-merge checks pass
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(body.deliveryStage, 'SUCCEEDED');
    assert.equal(body.mergeRevision, 'merge-good-2');
    assert.equal(delivery.calls, 4);
  } finally {
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('sync_external audits descendant work, adopts verified progress, and continues from the new repository baseline', async () => {
  const host = new PlanHost();
  let failIntegration = true;
  let discoveryCalls = 0;
  const externalWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    async discoverExternalProgress() {
      discoveryCalls += 1;
      return {
        revision: 'external-revision-2',
        ref: 'core-vnext/external-continuation',
        aheadBy: 4,
        matchedWorkItemKeys: ['EXTERNAL-2'],
        commitSubjects: [
          'fix(blocker): reconcile blocked integration BLOCKER-1',
          'feat(external): complete planned ticket EXTERNAL-2',
        ],
      };
    },
    async integrateBatch(input) {
      if (failIntegration && input.batchKey === 'batch-1') {
        failIntegration = false;
        throw new Error('BATCH_INTEGRATION_FAILED:simulated shared composition conflict');
      }
      return {
        revision: `integrated-${input.batchKey}`,
        ref: `refs/ai-office/plans/${input.planId}/batches/${input.batchKey}`,
      };
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: externalWorkspace,
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
      headers: { 'idempotency-key': 'external-progress-plan' },
      payload: {
        projectKey: 'memoflow',
        objective: 'Continue a durable plan after external engineering progress.',
        analysisSummary: 'Three sequential tickets.',
        repository: { path: '/tmp/memoflow', baseRevision: 'base-revision' },
        batches: [
          {
            key: 'batch-1',
            title: 'Previously blocked integration',
            workItems: [
              {
                key: 'BLOCKER-1',
                title: 'Blocked ticket',
                objective: 'Implement blocked ticket.',
                acceptanceCriteria: ['Blocked behavior is correct.'],
              },
            ],
          },
          {
            key: 'batch-2',
            title: 'Externally completed ticket',
            dependsOn: ['batch-1'],
            workItems: [
              {
                key: 'EXTERNAL-2',
                title: 'External ticket',
                objective: 'Implement external ticket.',
                acceptanceCriteria: ['External behavior is correct.'],
              },
            ],
          },
          {
            key: 'batch-3',
            title: 'Remaining Pixel Agent work',
            dependsOn: ['batch-2'],
            workItems: [
              {
                key: 'REMAIN-3',
                title: 'Remaining ticket',
                objective: 'Implement remaining ticket.',
                acceptanceCriteria: ['Remaining behavior is correct.'],
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
    const implementation = body.batches[0].workItems[0].executions[0];
    host.succeed(implementation.refs.openhandsConversationId, 'IMPLEMENTED');
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const review = body.batches[0].workItems[0].executions[1];
    host.succeed(review.refs.openhandsConversationId, 'PASS\nVerified.');
    await runtime.v3.reconcilePlans(planId);
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'BLOCKED');
    assert.equal(body.blockedReason, 'BATCH_INTEGRATION_FAILED');

    const recoveryRequest = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/plans/${planId}/reconcile`,
      payload: { mode: 'sync_external' },
    });
    assert.equal(recoveryRequest.statusCode, 202);
    assert.equal(recoveryRequest.json().accepted, true);
    for (let index = 0; index < 100 && host.lastCreateInput?.phase !== 'INVESTIGATE_PLAN'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(host.lastCreateInput?.phase, 'INVESTIGATE_PLAN');
    const auditConversationId = `conversation-${host.creates}`;
    host.succeed(
      auditConversationId,
      JSON.stringify({
        candidateRevision: 'external-revision-2',
        safeToAdopt: true,
        analysisSummary: 'The descendant branch resolves batch-1 and fully implements EXTERNAL-2.',
        blockedBatch: {
          key: 'batch-1',
          resolved: true,
          evidence: 'Combined code and focused tests resolve the former integration conflict.',
        },
        workItems: [
          {
            key: 'BLOCKER-1',
            status: 'VERIFIED_COMPLETE',
            evidence: 'Previously reviewed implementation remains correct in the combined candidate.',
          },
          {
            key: 'EXTERNAL-2',
            status: 'VERIFIED_COMPLETE',
            evidence: 'Candidate code and focused test satisfy acceptance criteria.',
          },
          {
            key: 'REMAIN-3',
            status: 'NOT_VERIFIED',
            evidence: 'No repository evidence that the remaining ticket is complete.',
          },
        ],
        risks: [],
      }),
    );
    await runtime.v3.reconcilePlans(planId);

    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    assert.equal(body.status, 'RUNNING');
    assert.equal(body.currentRevision, 'external-revision-2');
    assert.equal(body.batches[0].status, 'SUCCEEDED');
    assert.equal(body.batches[0].integratedRevision, 'external-revision-2');
    assert.equal(body.batches[1].status, 'SUCCEEDED');
    assert.equal(body.batches[1].workItems[0].status, 'SUCCEEDED');
    assert.equal(body.batches[2].status, 'RUNNING');
    assert.equal(body.batches[2].baseRevision, 'external-revision-2');
    assert.equal(body.batches[2].workItems[0].executions[0].phase, 'IMPLEMENT');
    assert.ok(body.events.some((event: { type: string }) => event.type === 'EXTERNAL_PROGRESS_ADOPTED'));
    const syncEvent = body.events.find(
      (event: { type: string }) => event.type === 'EXTERNAL_PROGRESS_SYNC_STARTED',
    );
    assert.ok(syncEvent?.executionId);
    assert.equal(syncEvent.detail?.attempt, 1);
    const auditExecution = (
      await runtime.app.inject({
        method: 'GET',
        url: `/api/v3/development/executions/${syncEvent.executionId}`,
      })
    ).json();
    assert.equal(auditExecution.phase, 'INVESTIGATE_PLAN');
    assert.equal(auditExecution.selection.backend, 'openhands-builtin');
    assert.equal(auditExecution.selection.modelClass, 'gpt-5.6-sol');
    assert.equal(discoveryCalls, 2, 'candidate must be re-discovered before adoption');
  } finally {
    await runtime.app.close();
  }
});
