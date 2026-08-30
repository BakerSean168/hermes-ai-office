import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ExecutionLinkRepository } from '../src/v3/correlation.js';
import { PlanRecoveryCoordinator } from '../src/v3/plan/recoveryCoordinator.js';
import { PlanRepository } from '../src/v3/plans.js';
import type { ExternalProgressReconciler } from '../src/v3/plan/externalProgress.js';
import type { WorkItemCoordinator } from '../src/v3/plan/workItemCoordinator.js';

const integrationRepairInput = {
  objective: 'Repair the aggregate batch defect.',
  acceptanceCriteria: ['The repaired batch is independently reviewed.'],
  evidence: { reason: 'BATCH_AGGREGATE_REVIEW_FAILED' },
};

test('integration repair exhaustion requires explicit one-at-a-time authorization', async () => {
  const db = new DatabaseSync(':memory:');
  const repository = new PlanRepository(db);
  const links = new ExecutionLinkRepository(db);
  const recovery = new PlanRecoveryCoordinator({
    repository,
    links,
    workItems: {} as WorkItemCoordinator,
    externalProgress: {} as ExternalProgressReconciler,
  });

  const { plan } = repository.create(
    {
      projectKey: 'memoflow',
      objective: 'Exercise bounded integration repair recovery.',
      analysisSummary: 'Operator authorization must extend only one repair attempt at a time.',
      repository: { path: '/repo', baseRevision: 'base' },
      batches: [
        {
          key: 'batch-1',
          title: 'Batch',
          workItems: [{ key: 'item', title: 'Item', objective: 'Implement.' }],
        },
      ],
    },
    'integration-repair-retry-plan',
  );
  const batch = repository.batches(plan.planId)[0]!;
  const original = repository.workItems(batch.batchId)[0]!;
  repository.setWorkItemStatus(original.workItemId, 'SUCCEEDED');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const repair = repository.addBatchIntegrationRepairWorkItem(
      plan.planId,
      batch.batchId,
      integrationRepairInput,
    );
    assert.ok(repair);
    assert.equal(repair.key, `integration-repair-b1-${attempt}`);
    repository.setWorkItemStatus(repair.workItemId, 'SUCCEEDED');
  }
  assert.equal(
    repository.addBatchIntegrationRepairWorkItem(
      plan.planId,
      batch.batchId,
      integrationRepairInput,
    ),
    null,
  );

  const block = () => {
    repository.setBatchStatus(batch.batchId, 'BLOCKED', {
      blockedReason: 'BATCH_INTEGRATION_REPAIR_LIMIT_EXCEEDED',
    });
    repository.setPlanStatus(plan.planId, 'BLOCKED', 'BATCH_INTEGRATION_REPAIR_LIMIT_EXCEEDED');
  };

  block();
  await recovery.recover(plan.planId, 'AUTO');
  assert.equal(repository.get(plan.planId)?.status, 'BLOCKED');
  assert.equal(
    repository
      .events(plan.planId)
      .filter((event) => event.type === 'BATCH_INTEGRATION_REPAIR_RETRY_AUTHORIZED').length,
    0,
  );

  await recovery.recover(plan.planId, 'RETRY_INTEGRATION_REPAIR');
  assert.equal(repository.get(plan.planId)?.status, 'RUNNING');
  assert.equal(repository.batches(plan.planId)[0]?.status, 'RUNNING');
  let authorizations = repository
    .events(plan.planId)
    .filter((event) => event.type === 'BATCH_INTEGRATION_REPAIR_RETRY_AUTHORIZED');
  assert.equal(authorizations.length, 1);
  assert.deepEqual(authorizations[0]?.detail, {
    previousReason: 'BATCH_INTEGRATION_REPAIR_LIMIT_EXCEEDED',
    authorizedAttempt: 4,
  });

  const fourth = repository.addBatchIntegrationRepairWorkItem(
    plan.planId,
    batch.batchId,
    integrationRepairInput,
  );
  assert.ok(fourth);
  assert.equal(fourth.key, 'integration-repair-b1-4');
  repository.setWorkItemStatus(fourth.workItemId, 'SUCCEEDED');
  assert.equal(
    repository.addBatchIntegrationRepairWorkItem(
      plan.planId,
      batch.batchId,
      integrationRepairInput,
    ),
    null,
  );

  block();
  await recovery.recover(plan.planId, 'RETRY_INTEGRATION_REPAIR');
  authorizations = repository
    .events(plan.planId)
    .filter((event) => event.type === 'BATCH_INTEGRATION_REPAIR_RETRY_AUTHORIZED');
  assert.equal(authorizations.length, 2);
  assert.deepEqual(authorizations[1]?.detail, {
    previousReason: 'BATCH_INTEGRATION_REPAIR_LIMIT_EXCEEDED',
    authorizedAttempt: 5,
  });

  const fifth = repository.addBatchIntegrationRepairWorkItem(
    plan.planId,
    batch.batchId,
    integrationRepairInput,
  );
  assert.ok(fifth);
  assert.equal(fifth.key, 'integration-repair-b1-5');
});
