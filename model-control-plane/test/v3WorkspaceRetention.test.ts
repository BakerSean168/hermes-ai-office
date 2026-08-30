import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecutionLinkRecord } from '../src/v3/types.js';
import { ExecutionWorkspaceRetention } from '../src/v3/workspaceRetention.js';
import type { WorkspaceProvisioningPort } from '../src/v3/workspace.js';

const NOW = 1_800_000_000_000;
const hour = 60 * 60_000;

function record(
  executionId: string,
  overrides: Partial<ExecutionLinkRecord> = {},
): ExecutionLinkRecord {
  return {
    executionId,
    idempotencyKey: executionId,
    projectKey: 'project',
    phase: 'IMPLEMENT',
    objectiveSummary: 'test',
    backend: 'openhands-builtin',
    transportMode: 'LITELLM_MANAGED',
    logicalModelClass: 'implementation-efficient',
    workspaceMode: 'isolated_write',
    sessionPolicy: 'fresh',
    workspaceRef: `/workspace/executions/${executionId}/repo`,
    selectionReasons: [],
    statusCache: 'SUCCEEDED',
    createdAt: NOW - 8 * hour,
    updatedAt: NOW - 7 * hour,
    startedAt: NOW - 8 * hour,
    endedAt: NOW - 7 * hour,
    ...overrides,
  };
}

test('workspace retention deletes expired terminal artifacts but preserves blocked and causal recovery state', async () => {
  const records = [
    record('old-success'),
    record('old-failure', { statusCache: 'FAILED', endedAt: NOW - 2 * hour }),
    record('recent-success', { endedAt: NOW - hour }),
    record('blocked-review', {
      phase: 'VERIFY_REVIEW',
      planId: 'blocked-plan',
      batchId: 'running-batch',
      workItemId: 'blocked-item',
      endedAt: NOW - 2 * hour,
    }),
    record('blocked-worker', {
      planId: 'blocked-plan',
      batchId: 'running-batch',
      workItemId: 'blocked-item',
      endedAt: NOW - 3 * hour,
      createdAt: NOW - 4 * hour,
    }),
    record('done-plan-worker', { planId: 'done-plan', endedAt: NOW - 2 * hour }),
    record('completed-batch-worker', {
      planId: 'blocked-plan',
      batchId: 'completed-batch',
      workItemId: 'completed-item',
      endedAt: NOW - 3 * hour,
      createdAt: NOW - 4 * hour,
    }),
    record('causal-parent', { endedAt: NOW - 20 * hour }),
    record('active-fix', {
      phase: 'IMPLEMENT_FIX',
      statusCache: 'RUNNING',
      endedAt: undefined,
      updatedAt: NOW,
      previousExecutionId: 'causal-parent',
      workspaceRef: '/workspace/executions/causal-parent/repo',
    }),
  ];
  const deleted: string[] = [];
  const pruned: string[] = [];
  const workspace = {
    async removeExecutionWorkspace(executionId: string) {
      deleted.push(executionId);
      return true;
    },
    async pruneExecutionArtifacts(input: { executionId: string }) {
      pruned.push(input.executionId);
      return true;
    },
  } as unknown as WorkspaceProvisioningPort;
  const retention = new ExecutionWorkspaceRetention({
    links: { list: () => records },
    plans: {
      get(planId: string) {
        if (planId === 'blocked-plan') return { status: 'BLOCKED' };
        if (planId === 'done-plan') return { status: 'SUCCEEDED' };
        return null;
      },
      batches(planId: string) {
        if (planId !== 'blocked-plan') return [];
        return [
          { batchId: 'running-batch', status: 'BLOCKED' as const },
          { batchId: 'completed-batch', status: 'SUCCEEDED' as const },
        ];
      },
    },
    workspace,
  });

  const summary = await retention.collect(NOW);

  assert.deepEqual(deleted.sort(), [
    'blocked-review',
    'completed-batch-worker',
    'done-plan-worker',
    'old-failure',
    'old-success',
  ]);
  assert.deepEqual(pruned.sort(), ['blocked-worker', 'recent-success']);
  assert.equal(pruned.includes('causal-parent'), false);
  assert.equal(deleted.includes('causal-parent'), false);
  assert.deepEqual(summary, { scanned: 9, pruned: 2, deleted: 5, protected: 2 });
});
