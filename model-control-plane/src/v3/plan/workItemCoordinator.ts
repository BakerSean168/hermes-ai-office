import { ExecutionLinkRepository } from '../correlation.js';
import { PLAN_LIMITS } from '../planConstants.js';
import type { BatchRecord, PlanRecord, WorkItemRecord } from '../plans.js';
import { PlanRepository } from '../plans.js';
import { reviewVerdict } from '../reviewVerdict.js';
import type { ExecutionLinkRecord } from '../types.js';
import {
  INTEGRATION_REPAIR_BACKEND,
  INTEGRATION_REPAIR_MODEL_CLASS,
  isIntegrationRepairItem,
  isPostMergeDeliveryRepairItem,
} from './kinds.js';
import { PLAN_TERMINAL_EXECUTION_STATUSES, type PlanExecutionPort } from './runtime.js';

export type PlanWorkerPhase = 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'VERIFY_REVIEW' | 'BATCH_VERIFY';

export interface ApprovedImplementationEvidence {
  workspaceRef: string;
  sourceRevision: string;
  executionId: string;
  approvedRevision: string;
}

export class WorkItemCoordinator {
  readonly #repository: PlanRepository;
  readonly #links: ExecutionLinkRepository;
  readonly #executions: PlanExecutionPort;

  constructor(options: {
    repository: PlanRepository;
    links: ExecutionLinkRepository;
    executions: PlanExecutionPort;
  }) {
    this.#repository = options.repository;
    this.#links = options.links;
    this.#executions = options.executions;
  }

  async launch(
    plan: PlanRecord,
    batch: BatchRecord,
    item: WorkItemRecord,
    phase: PlanWorkerPhase,
    previousExecutionId: string | undefined,
    attempt: number,
    overrideBackend?: string,
  ) {
    const commandKey = `${plan.planId}:${batch.key}:${item.key}:${phase}:${attempt}`;
    const snapshot = await this.#executions.start(
      {
        phase,
        objective:
          phase === 'VERIFY_REVIEW'
            ? `Independently review ${item.title}: ${item.objective}`
            : item.objective,
        projectKey: plan.projectKey,
        repository: {
          path: phase === 'IMPLEMENT' || phase === 'BATCH_VERIFY' ? plan.repositoryPath : '',
          baseRevision:
            phase === 'IMPLEMENT'
              ? isIntegrationRepairItem(item) && batch.integratedRevision
                ? batch.integratedRevision
                : (batch.baseRevision ?? plan.currentRevision)
              : phase === 'BATCH_VERIFY'
                ? batch.integratedRevision
                : undefined,
        },
        context: {
          previousExecutionId,
          acceptanceCriteria: item.acceptanceCriteria,
        },
        override:
          (isIntegrationRepairItem(item) || isPostMergeDeliveryRepairItem(item)) &&
          phase !== 'VERIFY_REVIEW'
            ? {
                backend: INTEGRATION_REPAIR_BACKEND,
                modelClass: INTEGRATION_REPAIR_MODEL_CLASS,
              }
            : overrideBackend
              ? { backend: overrideBackend }
              : undefined,
        await: false,
        plan: {
          planId: plan.planId,
          batchId: batch.batchId,
          workItemId: item.workItemId,
          attempt,
          commandKey,
        },
      },
      commandKey,
    );
    this.#repository.setWorkItemStatus(item.workItemId, 'RUNNING');
    this.#repository.appendEvent(
      plan.planId,
      'EXECUTION_STARTED',
      { phase, attempt },
      { batchId: batch.batchId, workItemId: item.workItemId, executionId: snapshot.executionId },
    );
    return snapshot;
  }

  async reconcile(plan: PlanRecord, batch: BatchRecord, item: WorkItemRecord): Promise<void> {
    const executionIds = this.#repository.executionIds(item.workItemId);
    if (executionIds.length === 0) {
      await this.launch(plan, batch, item, 'IMPLEMENT', undefined, 1);
      return;
    }
    const records = executionIds
      .map((executionId) => this.#links.get(executionId))
      .filter((record): record is ExecutionLinkRecord => Boolean(record));
    const latest = records.at(-1);
    if (!latest) return;
    const snapshot = await this.#executions.get(latest.executionId);
    if (!snapshot || !PLAN_TERMINAL_EXECUTION_STATUSES.has(snapshot.status)) return;

    if (snapshot.status !== 'SUCCEEDED') {
      const sameParentAttempts = records.filter(
        (record) =>
          record.phase === latest.phase && record.previousExecutionId === latest.previousExecutionId,
      ).length;
      const totalPhaseAttempts = records.filter((record) => record.phase === latest.phase).length;
      const attemptLimit = snapshot.error?.retryable
        ? PLAN_LIMITS.retryableTransportAttemptsPerParent
        : PLAN_LIMITS.transportAttemptsPerParent;
      if (sameParentAttempts < attemptLimit) {
        await this.launch(
          plan,
          batch,
          item,
          latest.phase as 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'VERIFY_REVIEW',
          latest.previousExecutionId,
          totalPhaseAttempts + 1,
          latest.phase === 'VERIFY_REVIEW' ? 'openhands-builtin' : undefined,
        );
        return;
      }
      const reason = `${latest.phase}_${snapshot.status}`;
      this.block(plan.planId, batch.batchId, item.workItemId, reason, latest.executionId);
      return;
    }

    if (latest.phase === 'IMPLEMENT' || latest.phase === 'IMPLEMENT_FIX') {
      const reviewAttempt = records.filter((record) => record.phase === 'VERIFY_REVIEW').length + 1;
      await this.launch(plan, batch, item, 'VERIFY_REVIEW', latest.executionId, reviewAttempt);
      return;
    }

    const verdict = reviewVerdict(snapshot.result?.finalText ?? '');
    if (verdict === 'BLOCKING') {
      const completedFixCycles = new Set(
        records
          .filter((record) => record.phase === 'IMPLEMENT_FIX' && record.previousExecutionId)
          .map((record) => record.previousExecutionId),
      ).size;
      const fixCycle = completedFixCycles + 1;
      if (fixCycle > PLAN_LIMITS.reviewFixAttempts) {
        this.block(
          plan.planId,
          batch.batchId,
          item.workItemId,
          'REVIEW_FIX_LIMIT_EXCEEDED',
          latest.executionId,
        );
        return;
      }
      const fixAttempt = records.filter((record) => record.phase === 'IMPLEMENT_FIX').length + 1;
      await this.launch(plan, batch, item, 'IMPLEMENT_FIX', latest.executionId, fixAttempt);
      return;
    }
    if (verdict === 'UNKNOWN') {
      const sameParentReviews = records.filter(
        (record) =>
          record.phase === 'VERIFY_REVIEW' && record.previousExecutionId === latest.previousExecutionId,
      ).length;
      if (sameParentReviews < PLAN_LIMITS.transportAttemptsPerParent) {
        const reviewAttempt = records.filter((record) => record.phase === 'VERIFY_REVIEW').length + 1;
        await this.launch(
          plan,
          batch,
          item,
          'VERIFY_REVIEW',
          latest.previousExecutionId,
          reviewAttempt,
          'openhands-builtin',
        );
        return;
      }
      this.block(
        plan.planId,
        batch.batchId,
        item.workItemId,
        'REVIEW_VERDICT_UNKNOWN',
        latest.executionId,
      );
      return;
    }
    this.#repository.setWorkItemStatus(item.workItemId, 'SUCCEEDED');
    if (isIntegrationRepairItem(item)) this.#repository.clearBatchIntegrationCandidate(batch.batchId);
    this.#repository.appendEvent(
      plan.planId,
      'WORK_ITEM_VERIFIED',
      {},
      { batchId: batch.batchId, workItemId: item.workItemId, executionId: latest.executionId },
    );
  }

  block(
    planId: string,
    batchId: string,
    workItemId: string,
    reason: string,
    executionId?: string,
  ): void {
    this.#repository.setWorkItemStatus(workItemId, 'BLOCKED', reason);
    this.#repository.setBatchStatus(batchId, 'BLOCKED', { blockedReason: reason });
    this.#repository.setPlanStatus(planId, 'BLOCKED', reason);
    this.#repository.appendEvent(
      planId,
      'WORK_ITEM_BLOCKED',
      { reason },
      { batchId, workItemId, executionId },
    );
  }

  approvedImplementationEvidence(item: WorkItemRecord): ApprovedImplementationEvidence {
    const records = this.#repository
      .executionIds(item.workItemId)
      .map((executionId) => this.#links.get(executionId))
      .filter((record): record is ExecutionLinkRecord => Boolean(record));
    const implementation = [...records]
      .reverse()
      .find(
        (record) =>
          (record.phase === 'IMPLEMENT' || record.phase === 'IMPLEMENT_FIX') &&
          record.statusCache === 'SUCCEEDED',
      );
    const approvedReview = [...records]
      .reverse()
      .find(
        (record) =>
          record.phase === 'VERIFY_REVIEW' &&
          record.statusCache === 'SUCCEEDED' &&
          reviewVerdict(record.resultText ?? '') === 'APPROVED',
      );
    if (!implementation?.workspaceRef || !implementation.sourceRevision || !approvedReview?.sourceRevision) {
      throw new Error('BATCH_INTEGRATION_EVIDENCE_MISSING');
    }
    return {
      workspaceRef: implementation.workspaceRef,
      sourceRevision: implementation.sourceRevision,
      executionId: implementation.executionId,
      approvedRevision: approvedReview.sourceRevision,
    };
  }
}
