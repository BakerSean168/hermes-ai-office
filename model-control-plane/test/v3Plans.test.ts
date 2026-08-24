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
  readonly executions = new Map<string, ExecutionHostSnapshot>();
  creates = 0;
  gets = 0;
  lastCreateInput?: ExecutionHostCreateInput;

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
    const snapshot = this.executions.get(conversationId);
    if (!snapshot) throw new Error('missing fake execution');
    return snapshot;
  }

  async cancelExecution(conversationId: string) {
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
}

let integrationFailuresRemaining = 0;
let integrationCount = 0;

const workspace: WorkspaceProvisioningPort = {
  hostPathForExecution(executionId) {
    return `/tmp/${executionId}`;
  },
  hostPathForWorkspaceRef(workspaceRef) {
    return `/host${workspaceRef}`;
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

test('a durable plan automatically reviews, fixes, and resumes without duplicate writers', async () => {
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
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/plans',
      headers: { 'idempotency-key': 'simple-plan' },
      payload: {
        projectKey: 'pixel-agents',
        objective: 'Add and verify a small status endpoint.',
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

    host.succeed(firstImplementation.refs.openhandsConversationId, 'IMPLEMENTED');
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const firstReview = body.batches[0].workItems[0].executions[1];
    assert.equal(firstReview.phase, 'VERIFY_REVIEW');

    host.succeed(
      firstReview.refs.openhandsConversationId,
      'Review completed without a strict verdict.',
    );
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const fallbackReview = body.batches[0].workItems[0].executions[2];
    assert.equal(fallbackReview.phase, 'VERIFY_REVIEW');
    assert.equal(fallbackReview.selection.backend, 'openhands-builtin');

    host.succeed(fallbackReview.refs.openhandsConversationId, 'FAIL\nMissing negative-path test.');
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const fix = body.batches[0].workItems[0].executions[3];
    assert.equal(fix.phase, 'IMPLEMENT_FIX');
    assert.match(host.lastCreateInput?.objective ?? '', /commit all intended fixes to Git/);

    host.succeed(fix.refs.openhandsConversationId, 'FIXED');
    await runtime.v3.reconcilePlans();
    body = (
      await runtime.app.inject({ method: 'GET', url: `/api/v3/development/plans/${planId}` })
    ).json();
    const secondReview = body.batches[0].workItems[0].executions[4];
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

    runtime = await buildControlPlane(options);
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
    assert.equal(host.creates, createsBeforeRestart + 1);
    assert.equal(
      body.batches[0].workItems[0].executions.filter(
        (execution: { phase: string }) => execution.phase === 'IMPLEMENT',
      ).length,
      1,
    );
    const getsBeforeList = host.gets;
    const listed = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/plans?limit=10',
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(host.gets, getsBeforeList);
  } finally {
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a delivery-authorized plan is not complete until remote and post-merge checks pass', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-delivery-'));
  const host = new PlanHost();
  const delivery = new PlanDelivery([
    {
      outcome: 'NEEDS_FIX',
      stage: 'CHECKS',
      reason: 'DELIVERY_CHECKS_FAILED',
      pullRequestUrl: 'https://github.test/example/repo/pull/42',
      evidence: { failed: ['ci'] },
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
