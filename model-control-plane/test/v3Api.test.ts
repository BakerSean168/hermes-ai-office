import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane } from '../src/app.js';
import type {
  ExecutionHostPort,
  ExecutionHostSnapshot,
  ModelGatewayPort,
} from '../src/v3/ports.js';
import type { WorkspaceProvisioningPort } from '../src/v3/workspace.js';

class FakeHost implements ExecutionHostPort {
  creates = 0;
  createdRepositories: string[] = [];
  createdObjectives: string[] = [];
  status: ExecutionHostSnapshot['status'] = 'RUNNING';
  finalText = 'INVESTIGATION_OK';
  async health() {
    return 'OK' as const;
  }
  async createExecution(input: Parameters<ExecutionHostPort['createExecution']>[0]) {
    this.creates += 1;
    this.createdRepositories.push(input.repositoryPath);
    this.createdObjectives.push(input.objective);
    return {
      conversationId: '22222222-2222-4222-8222-222222222222',
      status: this.status,
      startedAt: '2026-08-21T15:00:00Z',
    };
  }
  async getExecution() {
    return {
      conversationId: '22222222-2222-4222-8222-222222222222',
      status: this.status,
      finalText: this.status === 'SUCCEEDED' ? this.finalText : undefined,
      startedAt: '2026-08-21T15:00:00Z',
      updatedAt: '2026-08-21T15:00:05Z',
      usage: {
        source: 'OPENHANDS_REPORTED' as const,
        input: 100,
        output: 10,
        calls: 1,
      },
    };
  }
  async cancelExecution() {
    this.status = 'PAUSED';
    return this.getExecution('ignored');
  }
  async continueExecution() {
    this.status = 'RUNNING';
    return this.getExecution('ignored');
  }
}

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
      sourceRevision: 'abc123',
    };
  },
};

const gateway: ModelGatewayPort = {
  async summary() {
    return {
      health: 'OK',
      logicalModels: ['planning-premium', 'implementation-efficient', 'review-premium'],
    };
  },
};

test('V3 API provides an idempotent thin execution facade without changing V2', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'codex-acp': false,
      'opencode-acp': false,
    },
  });

  try {
    const first = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-test-1' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Investigate startup blank screen.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
        hermes: { profile: 'memoflow', sessionId: 'session-1', turnId: 'turn-1' },
      },
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json();
    assert.equal(firstBody.phase, 'INVESTIGATE_PLAN');
    assert.equal(firstBody.selection.backend, 'openhands-builtin');
    assert.equal(firstBody.selection.transportMode, 'LITELLM_MANAGED');
    assert.equal(firstBody.status, 'RUNNING');
    assert.equal(firstBody.sourceHealth.langfuse, 'UNCONFIGURED');
    assert.equal(host.creates, 1);

    const replay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-test-1' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Investigate startup blank screen.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().executionId, firstBody.executionId);
    assert.equal(host.creates, 1);

    host.status = 'SUCCEEDED';
    const completed = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${firstBody.executionId}`,
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json().status, 'SUCCEEDED');
    assert.equal(completed.json().result.finalText, 'INVESTIGATION_OK');
    assert.equal(completed.json().usage.input, 100);
    assert.equal(completed.json().timing.durationMs, 5_000);

    const v2Health = await runtime.app.inject({ method: 'GET', url: '/api/v2/health' });
    assert.equal(v2Health.statusCode, 200);
    assert.equal(v2Health.json().apiVersion, 2);
  } finally {
    await runtime.app.close();
  }
});

test('V3 review prompt preserves read-only evidence and directs write-requiring checks to disposable scratch', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'codex-acp': false,
      'opencode-acp': false,
    },
  });

  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-review-source' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement the approved change.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(implementation.statusCode, 201);
    const implementationId = implementation.json().executionId;
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    host.status = 'RUNNING';
    const review = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-review-scratch-rule' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Independently verify the implementation.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    assert.equal(review.statusCode, 201);
    const lastObjective = host.createdObjectives.at(-1) ?? '';
    assert.match(lastObjective, /intentionally physically read-only/);
    assert.match(lastObjective, /fresh temporary directory under \/tmp/);
    assert.match(
      lastObjective,
      /Do not classify read-only permission errors as implementation defects/,
    );
    assert.match(lastObjective, /short separate terminal tool invocations/);
  } finally {
    await runtime.app.close();
  }
});

test('V3 cancel keeps product status CANCELLED when OpenHands pause is the transport primitive', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'codex-acp': false,
      'opencode-acp': false,
    },
  });

  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-cancel-status' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Long running investigation.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const executionId = started.json().executionId;
    const cancelled = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/executions/${executionId}/cancel`,
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, 'CANCELLED');

    const reread = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${executionId}`,
    });
    assert.equal(reread.json().status, 'CANCELLED');
  } finally {
    await runtime.app.close();
  }
});

test('V3 IMPLEMENT_FIX reuses the reviewed implementation workspace and receives reviewer findings through causal lineage', async () => {
  const host = new FakeHost();
  const provisions: Array<{
    executionId: string;
    repositoryPath: string;
    workspaceMode: string;
  }> = [];
  const reuseWorkspace: WorkspaceProvisioningPort = {
    hostPathForExecution(executionId) {
      return `/host/workspaces/executions/${executionId}/repo`;
    },
    hostPathForWorkspaceRef(workspaceRef) {
      assert.match(workspaceRef, /^\/workspace\/executions\//);
      return `/host${workspaceRef}`;
    },
    async provision(input) {
      provisions.push({
        executionId: input.executionId,
        repositoryPath: input.repositoryPath,
        workspaceMode: input.workspaceMode,
      });
      return {
        hostPath: `/host/workspaces/executions/${input.executionId}/repo`,
        executionPath: `/workspace/executions/${input.executionId}/repo`,
        branch:
          input.workspaceMode === 'isolated_write' ? `ai-office/${input.executionId}` : undefined,
        sourceRevision: 'abc123',
      };
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: reuseWorkspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });

  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-fix-base' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement the change.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const implementationBody = implementation.json();
    const implementationId = implementationBody.executionId;
    const implementationWorkspace = implementationBody.result.workspaceRef;
    assert.equal(provisions.length, 1);

    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    // Old lineage (fix -> implementation) is invalid because it loses the reviewer as causal parent.
    const invalidDirectFix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-invalid-direct-fix' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'This must be rejected.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    assert.equal(invalidDirectFix.statusCode, 422);
    assert.equal(invalidDirectFix.json().error.code, 'PREVIOUS_EXECUTION_NOT_REVIEW');

    host.status = 'RUNNING';
    const blockingReview = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-blocking-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Review the implementation and report the blocking finding.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    assert.equal(blockingReview.statusCode, 201);
    const blockingReviewId = blockingReview.json().executionId;
    assert.equal(provisions.length, 2);
    assert.equal(provisions[1]?.workspaceMode, 'review_snapshot');
    assert.equal(provisions[1]?.repositoryPath, `/host${implementationWorkspace}`);

    host.finalText = 'BLOCKED: focused review finding';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${blockingReviewId}`,
    });

    // previousResult is intentionally omitted: the control plane hydrates it from the review execution.
    const fix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-fix-1' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'Address only the review finding.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: blockingReviewId },
        await: false,
      },
    });
    assert.equal(fix.statusCode, 201);
    const fixBody = fix.json();
    assert.equal(fixBody.result.workspaceRef, implementationWorkspace);
    assert.equal(host.createdRepositories.at(-1), implementationWorkspace);
    assert.match(host.createdObjectives.at(-1) ?? '', /BLOCKED: focused review finding/);
    assert.equal(
      provisions.length,
      2,
      'fix must reuse the implementation tree, not clone another writer tree',
    );

    const listAfterFix = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/executions?limit=20',
    });
    const fixListItem = listAfterFix
      .json()
      .items.find((item: any) => item.executionId === fixBody.executionId);
    assert.equal(fixListItem.previousExecutionId, blockingReviewId);

    host.finalText = 'FIXED';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${fixBody.executionId}`,
    });

    host.status = 'RUNNING';
    const finalReview = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-review-after-fix' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Review the fixed implementation.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: fixBody.executionId },
        await: false,
      },
    });
    assert.equal(finalReview.statusCode, 201);
    assert.equal(provisions.length, 3);
    assert.equal(provisions[2]?.workspaceMode, 'review_snapshot');
    assert.equal(provisions[2]?.repositoryPath, `/host${implementationWorkspace}`);
  } finally {
    await runtime.app.close();
  }
});

test('V3 FINALIZE is deterministic, internal, idempotent, and does not launch another agent', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });

  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-impl' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement the change.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const implementationId = implementation.json().executionId;
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    const review = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Review independently.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    const reviewId = review.json().executionId;
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${reviewId}`,
    });
    const createsBeforeFinalize = host.creates;

    const finalized = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-1' },
      payload: {
        phase: 'FINALIZE',
        objective: 'Close the verified development run.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: reviewId },
      },
    });
    assert.equal(finalized.statusCode, 201);
    const body = finalized.json();
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(body.selection.backend, 'control-plane-finalizer');
    assert.equal(body.selection.transportMode, 'INTERNAL');
    assert.equal(body.selection.modelClass, 'deterministic-finalize-v1');
    assert.match(body.result.finalText, /^FINALIZED/m);
    assert.match(body.result.finalText, new RegExp(reviewId));
    assert.match(body.result.finalText, /INVESTIGATION_OK/);
    assert.equal(host.creates, createsBeforeFinalize, 'finalize must not launch OpenHands/ACP');

    const replay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-1' },
      payload: {
        phase: 'FINALIZE',
        objective: 'Close the verified development run.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: reviewId },
      },
    });
    assert.equal(replay.json().executionId, body.executionId);
    assert.equal(replay.json().result.finalText, body.result.finalText);
    assert.equal(host.creates, createsBeforeFinalize);
  } finally {
    await runtime.app.close();
  }
});

test('V3 continuation phases derive their workspace from causal previousExecutionId without a repeated repository path', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });
  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-continuation-base' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement the change.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const implementationId = implementation.json().executionId;
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    host.status = 'RUNNING';
    const review = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-continuation-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Review it.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    assert.equal(review.statusCode, 201);
    const reviewId = review.json().executionId;
    host.finalText = 'BLOCKED: review finding';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({ method: 'GET', url: `/api/v3/development/executions/${reviewId}` });

    const fix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-continuation-fix' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'Fix the finding.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: reviewId },
        await: false,
      },
    });
    assert.equal(fix.statusCode, 201);
    assert.match(host.createdObjectives.at(-1) ?? '', /BLOCKED: review finding/);
  } finally {
    await runtime.app.close();
  }
});

test('V3 API preserves Hermes execution hints as auditable policy evidence', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-hints-evidence' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement with explicit execution hints.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        hints: {
          complexity: 'HIGH',
          risk: 'MEDIUM',
          quality: 'PREMIUM',
          budget: 'LOW',
          parallelism: 3,
        },
        await: false,
      },
    });
    assert.equal(response.statusCode, 201);
    const reasons = response.json().selection.reasons;
    assert.ok(reasons.includes('hint:complexity:HIGH'));
    assert.ok(reasons.includes('hint:risk:MEDIUM'));
    assert.ok(reasons.includes('hint:quality:PREMIUM'));
    assert.ok(reasons.includes('hint:budget:LOW'));
    assert.ok(reasons.includes('hint:parallelism:3'));
  } finally {
    await runtime.app.close();
  }
});

test('V3 execution list exposes public status semantics without correlation internals', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });
  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-list-public-shape' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'List projection probe.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(started.statusCode, 201);
    const listed = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/executions?projectKey=memo-flow&limit=10',
    });
    assert.equal(listed.statusCode, 200);
    const item = listed.json().items[0];
    assert.equal(item.status, 'RUNNING');
    assert.equal(item.projectKey, 'memo-flow');
    assert.equal(item.phase, 'IMPLEMENT');
    assert.equal(item.selection.backend, 'opencode-acp');
    assert.equal('statusCache' in item, false);
    assert.equal('idempotencyKey' in item, false);
  } finally {
    await runtime.app.close();
  }
});

test('V3 writer admission allows two isolated writers per project and rejects the third', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });
  try {
    const startWriter = (key: string) =>
      runtime.app.inject({
        method: 'POST',
        url: '/api/v3/development/executions',
        headers: { 'idempotency-key': key },
        payload: {
          phase: 'IMPLEMENT',
          objective: `Parallel writer ${key}`,
          projectKey: 'parallel-project',
          repository: { path: '/tmp/fake-repo' },
          await: false,
        },
      });
    const first = await startWriter('parallel-writer-1');
    const second = await startWriter('parallel-writer-2');
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.notEqual(first.json().result.workspaceRef, second.json().result.workspaceRef);

    const third = await startWriter('parallel-writer-3');
    assert.equal(third.statusCode, 409);
    assert.equal(third.json().error.code, 'WRITER_CONCURRENCY_PROJECT_LIMIT');
    assert.equal(host.creates, 2);
  } finally {
    await runtime.app.close();
  }
});

test('V3 writer admission enforces the global active writer cap across projects', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });
  try {
    for (let i = 1; i <= 4; i += 1) {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/v3/development/executions',
        headers: { 'idempotency-key': `global-writer-${i}` },
        payload: {
          phase: 'IMPLEMENT',
          objective: `Writer ${i}`,
          projectKey: `project-${i}`,
          repository: { path: '/tmp/fake-repo' },
          await: false,
        },
      });
      assert.equal(response.statusCode, 201);
    }
    const blocked = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'global-writer-5' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Writer 5',
        projectKey: 'project-5',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error.code, 'WRITER_CONCURRENCY_GLOBAL_LIMIT');
    assert.equal(host.creates, 4);
  } finally {
    await runtime.app.close();
  }
});

test('V3 IMPLEMENT_FIX enforces a single writer lease for the implementation workspace referenced by the review', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });
  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'lease-base-implementation' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Create the implementation to be fixed.',
        projectKey: 'lease-project',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const implementationId = implementation.json().executionId;
    const implementationWorkspace = implementation.json().result.workspaceRef;
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    host.status = 'RUNNING';
    const review = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'lease-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Report the focused finding.',
        projectKey: 'lease-project',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    const reviewId = review.json().executionId;
    host.status = 'SUCCEEDED';
    host.finalText = 'BLOCKED: lease finding';
    await runtime.app.inject({ method: 'GET', url: `/api/v3/development/executions/${reviewId}` });

    host.status = 'RUNNING';
    const firstFix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'lease-fix-1' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'Apply the first focused fix.',
        projectKey: 'lease-project',
        context: { previousExecutionId: reviewId, previousResult: 'BLOCKED: lease finding' },
        await: false,
      },
    });
    assert.equal(firstFix.statusCode, 201);
    assert.equal(firstFix.json().result.workspaceRef, implementationWorkspace);

    const competingFix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'lease-fix-2' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'Competing fix must not share the mutable tree.',
        projectKey: 'lease-project',
        context: { previousExecutionId: reviewId, previousResult: 'BLOCKED: lease finding' },
        await: false,
      },
    });
    assert.equal(competingFix.statusCode, 409);
    assert.equal(competingFix.json().error.code, 'WORKSPACE_WRITER_LEASE_CONFLICT');
    assert.equal(host.creates, 3, 'only implementation, review, and first fix should launch');
  } finally {
    await runtime.app.close();
  }
});

test('V3 execution list reconciles non-terminal cached state from the execution host', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });
  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-list-reconcile' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Finish upstream without an explicit GET.',
        projectKey: 'reconcile-project',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(started.json().status, 'RUNNING');
    host.status = 'SUCCEEDED';

    const listed = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/executions?projectKey=reconcile-project&limit=10',
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items[0].status, 'SUCCEEDED');
    assert.equal(listed.json().items[0].usage.input, 100);
  } finally {
    await runtime.app.close();
  }
});

test('V3 continue resumes only a PAUSED execution through the existing OpenHands conversation', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-acp': false,
    },
  });
  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-continue-base' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Pause and continue this execution.',
        projectKey: 'continue-project',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const executionId = started.json().executionId;

    const rejectedWhileRunning = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/executions/${executionId}/messages`,
      payload: { message: 'Do not inject while running.' },
    });
    assert.equal(rejectedWhileRunning.statusCode, 409);
    assert.equal(rejectedWhileRunning.json().error.code, 'EXECUTION_NOT_CONTINUABLE');

    host.status = 'PAUSED';
    const paused = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${executionId}`,
    });
    assert.equal(paused.json().status, 'PAUSED');

    const continued = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/executions/${executionId}/messages`,
      payload: { message: 'Continue from the existing evidence and finish.' },
    });
    assert.equal(continued.statusCode, 200);
    assert.equal(continued.json().status, 'RUNNING');
    assert.equal(continued.json().executionId, executionId);
  } finally {
    await runtime.app.close();
  }
});

test('V3 runtime summary exposes only safe execution-plane health and logical models', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'codex-acp': false,
      'opencode-acp': false,
    },
  });
  try {
    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/runtime-summary',
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.sourceHealth.openhands, 'OK');
    assert.equal(body.sourceHealth.litellm, 'OK');
    assert.equal(body.sourceHealth.observability, 'UNCONFIGURED');
    assert.equal(body.sourceHealth.langfuse, 'UNCONFIGURED');
    assert.deepEqual(body.logicalModels, [
      'planning-premium',
      'implementation-efficient',
      'review-premium',
    ]);
    assert.ok(body.enabledBackends.includes('openhands-builtin'));
    assert.ok(body.enabledBackends.includes('control-plane-finalizer'));
    assert.equal(body.enabledBackends.includes('codex-acp'), false);
    assert.equal(body.enabledBackends.includes('opencode-acp'), false);
    assert.deepEqual(body.concurrency, {
      max_active_writers: 4,
      max_active_writers_per_project: 2,
    });
    assert.equal(JSON.stringify(body).includes('apiKey'), false);
    assert.equal(JSON.stringify(body).includes('masterKey'), false);
  } finally {
    await runtime.app.close();
  }
});

test('V3 readiness refuses to count probe volume as representative cutover evidence', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    initialSync: false,
    v3Enabled: true,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'codex-acp': false,
      'opencode-acp': false,
    },
  });
  try {
    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/readiness',
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, 'NOT_READY');
    assert.equal(body.ready, false);
    assert.equal(body.gates.representativeWorkflows.current, 1);
    assert.equal(body.gates.representativeWorkflows.required, 10);
    assert.equal(body.gates.representativeWorkflows.pass, false);
    assert.equal(body.gates.providerFallback.pass, true);
    assert.equal(body.gates.gatewayReconnect.pass, true);
    assert.equal(body.gates.rollback.pass, true);
    assert.equal(body.gates.fixLoop.pass, false);
    assert.match(body.unknownMetrics.representativeHumanCorrectionRate, /^UNKNOWN:/);
    assert.match(body.unknownMetrics.maintenanceComplexity, /^UNKNOWN:/);
    assert.match(body.unknownMetrics.operatorInterventions, /^UNKNOWN:/);
  } finally {
    await runtime.app.close();
  }
});
