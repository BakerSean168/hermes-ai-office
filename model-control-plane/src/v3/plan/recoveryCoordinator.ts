import { ExecutionLinkRepository } from '../correlation.js';
import { PlanRepository } from '../plans.js';
import { reviewVerdict } from '../reviewVerdict.js';
import type { ExecutionLinkRecord } from '../types.js';
import { ExternalProgressReconciler } from './externalProgress.js';
import { isBatchAggregateReviewItem, type PlanRecoveryMode } from './kinds.js';
import { WorkItemCoordinator } from './workItemCoordinator.js';

export class PlanRecoveryCoordinator {
  readonly #repository: PlanRepository;
  readonly #links: ExecutionLinkRepository;
  readonly #workItems: WorkItemCoordinator;
  readonly #externalProgress: ExternalProgressReconciler;

  constructor(options: {
    repository: PlanRepository;
    links: ExecutionLinkRepository;
    workItems: WorkItemCoordinator;
    externalProgress: ExternalProgressReconciler;
  }) {
    this.#repository = options.repository;
    this.#links = options.links;
    this.#workItems = options.workItems;
    this.#externalProgress = options.externalProgress;
  }

  async recover(planId: string, recoveryMode: PlanRecoveryMode = 'AUTO'): Promise<void> {
    const blocked = this.#repository.get(planId);
    if (blocked?.status !== 'BLOCKED') return;
    const batches = this.#repository.batches(planId);
    const batch = batches.find((candidate) => candidate.status === 'BLOCKED');
    if (!batch && blocked.delivery?.autoMerge && blocked.deliveryStage === 'BLOCKED') {
      const deliveryFixLimitExceeded = blocked.blockedReason === 'DELIVERY_FIX_LIMIT_EXCEEDED';
      if (deliveryFixLimitExceeded && recoveryMode !== 'RETRY_DELIVERY') return;
      if (!deliveryFixLimitExceeded && recoveryMode === 'RETRY_DELIVERY') return;
      if (deliveryFixLimitExceeded) {
        const repairAttempts = batches.filter((candidate) =>
          candidate.key.startsWith('delivery-fix-'),
        ).length;
        this.#repository.appendEvent(planId, 'PLAN_DELIVERY_REPAIR_RETRY_AUTHORIZED', {
          previousReason: blocked.blockedReason,
          authorizedAttempt: repairAttempts + 1,
        });
      }
      this.#repository.setPlanStatus(planId, 'RUNNING');
      this.#repository.setDeliveryState(planId, { stage: 'PENDING' });
      this.#repository.appendEvent(planId, 'PLAN_DELIVERY_RECOVERY_REQUESTED', {
        previousReason: blocked.blockedReason,
        recoveryMode,
      });
      return;
    }
    if (!batch) return;
    if (recoveryMode === 'SYNC_EXTERNAL') {
      const handled = await this.#externalProgress.reconcile(blocked, batch);
      if (handled) return;
    }
    const items = this.#repository.workItems(batch.batchId);
    if (items.every((item) => item.status === 'SUCCEEDED')) {
      this.#repository.setPlanStatus(planId, 'RUNNING');
      this.#repository.setBatchStatus(batch.batchId, 'RUNNING');
      this.#repository.appendEvent(
        planId,
        'BATCH_INTEGRATION_RECOVERY_REQUESTED',
        { previousReason: blocked.blockedReason },
        { batchId: batch.batchId },
      );
      return;
    }
    const retryable = items.filter((item) => item.status === 'BLOCKED');
    const aggregateReview = retryable.find(isBatchAggregateReviewItem);
    if (aggregateReview) {
      const records = this.#repository
        .executionIds(aggregateReview.workItemId)
        .map((executionId) => this.#links.get(executionId))
        .filter((record): record is ExecutionLinkRecord => Boolean(record));
      const latest = records.at(-1);
      if (!latest || latest.phase !== 'BATCH_VERIFY') {
        throw new Error('BATCH_VERIFY_RECOVERY_EVIDENCE_MISSING');
      }
      const attempt = records.filter((record) => record.phase === 'BATCH_VERIFY').length + 1;
      this.#repository.setPlanStatus(planId, 'RUNNING');
      this.#repository.setBatchStatus(batch.batchId, 'RUNNING');
      this.#repository.setWorkItemStatus(aggregateReview.workItemId, 'RUNNING');
      this.#repository.appendEvent(
        planId,
        'BATCH_AGGREGATE_REVIEW_RECOVERY_REQUESTED',
        { previousReason: aggregateReview.blockedReason, attempt },
        { batchId: batch.batchId, workItemId: aggregateReview.workItemId },
      );
      await this.#workItems.launch(
        blocked,
        batch,
        aggregateReview,
        'BATCH_VERIFY',
        undefined,
        attempt,
        'openhands-builtin',
      );
      return;
    }

    if (recoveryMode === 'RETRY_REVIEW') {
      const targets = retryable.map((item) => {
        const records = this.#repository
          .executionIds(item.workItemId)
          .map((executionId) => this.#links.get(executionId))
          .filter((record): record is ExecutionLinkRecord => Boolean(record));
        const implementation = [...records]
          .reverse()
          .find(
            (record) =>
              ['IMPLEMENT', 'IMPLEMENT_FIX'].includes(record.phase) &&
              record.statusCache === 'SUCCEEDED' &&
              Boolean(record.workspaceRef),
          );
        return { item, records, implementation };
      });
      if (targets.some((target) => !target.implementation)) {
        throw new Error('PLAN_REVIEW_RECOVERY_IMPLEMENTATION_MISSING');
      }

      this.#repository.setPlanStatus(planId, 'RUNNING');
      this.#repository.setBatchStatus(batch.batchId, 'RUNNING');
      for (const target of targets) {
        const implementation = target.implementation!;
        const attempt =
          target.records.filter((record) => record.phase === 'VERIFY_REVIEW').length + 1;
        this.#repository.setWorkItemStatus(target.item.workItemId, 'RUNNING');
        this.#repository.appendEvent(
          planId,
          'WORK_ITEM_RECOVERY_REQUESTED',
          {
            previousReason: target.item.blockedReason,
            recoveryMode,
            phase: 'VERIFY_REVIEW',
            attempt,
            implementationExecutionId: implementation.executionId,
          },
          { batchId: batch.batchId, workItemId: target.item.workItemId },
        );
        await this.#workItems.launch(
          blocked,
          batch,
          target.item,
          'VERIFY_REVIEW',
          implementation.executionId,
          attempt,
        );
      }
      return;
    }

    this.#repository.setPlanStatus(planId, 'RUNNING');
    this.#repository.setBatchStatus(batch.batchId, 'RUNNING');
    for (const item of retryable) {
      const records = this.#repository
        .executionIds(item.workItemId)
        .map((executionId) => this.#links.get(executionId))
        .filter((record): record is ExecutionLinkRecord => Boolean(record));
      const latest = records.at(-1);
      if (!latest || !['IMPLEMENT', 'IMPLEMENT_FIX', 'VERIFY_REVIEW'].includes(latest.phase)) {
        continue;
      }
      const recoverReviewLimit =
        item.blockedReason === 'REVIEW_FIX_LIMIT_EXCEEDED' &&
        latest.phase === 'VERIFY_REVIEW' &&
        reviewVerdict(latest.resultText ?? '') === 'BLOCKING';
      const phase = recoverReviewLimit
        ? 'IMPLEMENT_FIX'
        : (latest.phase as 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'VERIFY_REVIEW');
      const previousExecutionId = recoverReviewLimit
        ? latest.executionId
        : latest.previousExecutionId;
      const attempt = records.filter((record) => record.phase === phase).length + 1;
      this.#repository.setWorkItemStatus(item.workItemId, 'RUNNING');
      this.#repository.appendEvent(
        planId,
        'WORK_ITEM_RECOVERY_REQUESTED',
        { previousReason: item.blockedReason, phase, attempt },
        { batchId: batch.batchId, workItemId: item.workItemId },
      );
      await this.#workItems.launch(
        blocked,
        batch,
        item,
        phase,
        previousExecutionId,
        attempt,
        phase === 'VERIFY_REVIEW' ? 'openhands-builtin' : undefined,
      );
    }
  }
}
