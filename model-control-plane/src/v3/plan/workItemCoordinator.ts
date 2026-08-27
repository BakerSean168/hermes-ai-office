import { ExecutionLinkRepository } from '../correlation.js';
import type { GitHubPullRequestRepairPublisherPort } from '../githubPrRepairPublisher.js';
import { PLAN_LIMITS } from '../planConstants.js';
import type { BatchRecord, PlanRecord, WorkItemRecord } from '../plans.js';
import { PlanRepository } from '../plans.js';
import { reviewVerdict } from '../reviewVerdict.js';
import type { ExecutionLinkRecord } from '../types.js';
import type { WorkspaceProvisioningPort } from '../workspace.js';
import {
  INTEGRATION_REPAIR_BACKEND,
  INTEGRATION_REPAIR_MODEL_CLASS,
  isIntegrationRepairItem,
  isPostMergeDeliveryRepairItem,
} from './kinds.js';
import { PLAN_TERMINAL_EXECUTION_STATUSES, type PlanExecutionPort } from './runtime.js';

export type PlanWorkerPhase =
  | 'ADOPT_CHANGE'
  | 'IMPLEMENT'
  | 'IMPLEMENT_FIX'
  | 'VERIFY_REVIEW'
  | 'BATCH_VERIFY';

export interface PhaseRetryPolicy {
  backendCandidates: string[];
  modelClasses: string[];
}

export interface WorkerLaunchOverride {
  backend?: string;
  modelClass?: string;
}

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
  readonly #workspace: WorkspaceProvisioningPort;
  readonly #pullRequestRepairPublisher?: GitHubPullRequestRepairPublisherPort;
  readonly #retryPolicies: Partial<Record<PlanWorkerPhase, PhaseRetryPolicy>>;

  constructor(options: {
    repository: PlanRepository;
    links: ExecutionLinkRepository;
    executions: PlanExecutionPort;
    workspace: WorkspaceProvisioningPort;
    pullRequestRepairPublisher?: GitHubPullRequestRepairPublisherPort;
    retryPolicies?: Partial<Record<PlanWorkerPhase, PhaseRetryPolicy>>;
  }) {
    this.#repository = options.repository;
    this.#links = options.links;
    this.#executions = options.executions;
    this.#workspace = options.workspace;
    this.#pullRequestRepairPublisher = options.pullRequestRepairPublisher;
    this.#retryPolicies = options.retryPolicies ?? {};
  }

  retryOverride(
    phase: PlanWorkerPhase,
    records: ExecutionLinkRecord[],
    options: { advanceModel?: boolean } = {},
  ): WorkerLaunchOverride | undefined {
    const policy = this.#retryPolicies[phase];
    if (!policy?.backendCandidates.length || !policy.modelClasses.length) return undefined;
    const latest = [...records].reverse().find((record) => record.phase === phase);
    const backendIndex = latest ? policy.backendCandidates.indexOf(latest.backend) : -1;
    const backend = policy.backendCandidates[(backendIndex + 1) % policy.backendCandidates.length];
    const currentModelIndex = latest ? policy.modelClasses.indexOf(latest.logicalModelClass) : -1;
    const sameParent = records.filter(
      (record) => record.phase === phase && record.previousExecutionId === latest?.previousExecutionId,
    );
    const triedBackendsForCurrentModel = new Set(
      sameParent
        .filter((record) => record.logicalModelClass === latest?.logicalModelClass)
        .map((record) => record.backend),
    );
    const exhaustedCurrentModelBackends =
      currentModelIndex >= 0 &&
      policy.backendCandidates.every((candidate) => triedBackendsForCurrentModel.has(candidate));
    let modelClass = currentModelIndex >= 0 ? policy.modelClasses[currentModelIndex] : policy.modelClasses[0];
    if (options.advanceModel || exhaustedCurrentModelBackends) {
      const nextIndex = currentModelIndex >= 0 ? currentModelIndex + 1 : 1;
      modelClass = policy.modelClasses[Math.min(nextIndex, policy.modelClasses.length - 1)];
    }
    return { backend, modelClass };
  }

  retryAttemptLimit(phase: PlanWorkerPhase): number {
    const policy = this.#retryPolicies[phase];
    if (!policy?.backendCandidates.length || !policy.modelClasses.length) {
      return PLAN_LIMITS.transportAttemptsPerParent;
    }
    return Math.max(
      PLAN_LIMITS.transportAttemptsPerParent,
      Math.min(
        PLAN_LIMITS.reviewRouteAttemptsPerParent,
        policy.backendCandidates.length * policy.modelClasses.length,
      ),
    );
  }

  sourceBackend(plan: PlanRecord, phase: PlanWorkerPhase): string | undefined {
    if (plan.source.kind !== 'EXTERNAL_CHANGE') return undefined;
    if (phase === 'VERIFY_REVIEW') return plan.source.reviewBackend;
    if (phase === 'IMPLEMENT_FIX') return plan.source.repairBackend;
    return undefined;
  }

  async launch(
    plan: PlanRecord,
    batch: BatchRecord,
    item: WorkItemRecord,
    phase: PlanWorkerPhase,
    previousExecutionId: string | undefined,
    attempt: number,
    override?: string | WorkerLaunchOverride,
    replayExisting = false,
  ) {
    const commandKey = `${plan.planId}:${batch.key}:${item.key}:${phase}:${attempt}`;
    const external = plan.source.kind === 'EXTERNAL_CHANGE';
    const externalReview = external && phase === 'VERIFY_REVIEW';
    const repositoryEntry = phase === 'ADOPT_CHANGE' || phase === 'IMPLEMENT' || phase === 'BATCH_VERIFY';
    const sourceOverride = this.sourceBackend(plan, phase);
    const launchOverride: WorkerLaunchOverride | undefined =
      typeof override === 'string' ? { backend: override } : override;
    const snapshot = await this.#executions.start(
      {
        phase,
        objective:
          phase === 'VERIFY_REVIEW'
            ? externalReview
              ? `Independently validate the external change and review ${item.title}: ${item.objective}`
              : `Independently review ${item.title}: ${item.objective}`
            : item.objective,
        projectKey: plan.projectKey,
        repository: {
          path: repositoryEntry ? plan.repositoryPath : '',
          baseRevision:
            phase === 'ADOPT_CHANGE' && plan.source.kind === 'EXTERNAL_CHANGE'
              ? plan.source.revision
              : phase === 'IMPLEMENT'
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
          reviewBaseRevision: phase === 'ADOPT_CHANGE' ? plan.baseRevision : undefined,
          changeOrigin: external ? 'EXTERNAL' : undefined,
        },
        override:
          (isIntegrationRepairItem(item) || isPostMergeDeliveryRepairItem(item)) &&
          phase !== 'VERIFY_REVIEW'
            ? {
                backend: INTEGRATION_REPAIR_BACKEND,
                modelClass: INTEGRATION_REPAIR_MODEL_CLASS,
              }
            : launchOverride || sourceOverride
              ? {
                  ...(sourceOverride ? { backend: sourceOverride } : {}),
                  ...(launchOverride ?? {}),
                }
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
      replayExisting ? 'EXECUTION_REPLAYED' : 'EXECUTION_STARTED',
      { phase, attempt },
      { batchId: batch.batchId, workItemId: item.workItemId, executionId: snapshot.executionId },
    );
    return snapshot;
  }

  async reconcile(plan: PlanRecord, batch: BatchRecord, item: WorkItemRecord): Promise<void> {
    const executionIds = this.#repository.executionIds(item.workItemId);
    if (executionIds.length === 0) {
      const phase = plan.source.kind === 'EXTERNAL_CHANGE' && batch.ordinal === 0
        ? 'ADOPT_CHANGE'
        : 'IMPLEMENT';
      await this.launch(plan, batch, item, phase, undefined, 1);
      return;
    }
    const records = executionIds
      .map((executionId) => this.#links.get(executionId))
      .filter((record): record is ExecutionLinkRecord => Boolean(record));
    const latest = records.at(-1);
    if (!latest) return;

    if (
      latest.phase === 'ADOPT_CHANGE' &&
      !PLAN_TERMINAL_EXECUTION_STATUSES.has(latest.statusCache) &&
      !latest.openhandsConversationId
    ) {
      await this.launch(
        plan,
        batch,
        item,
        'ADOPT_CHANGE',
        latest.previousExecutionId,
        latest.attempt ?? records.filter((record) => record.phase === 'ADOPT_CHANGE').length,
        undefined,
        true,
      );
      return;
    }

    const snapshot = await this.#executions.get(latest.executionId);
    if (!snapshot || !PLAN_TERMINAL_EXECUTION_STATUSES.has(snapshot.status)) return;

    if (snapshot.status !== 'SUCCEEDED') {
      const sameParentAttempts = records.filter(
        (record) =>
          record.phase === latest.phase && record.previousExecutionId === latest.previousExecutionId,
      ).length;
      const totalPhaseAttempts = records.filter((record) => record.phase === latest.phase).length;
      const attemptLimit =
        snapshot.error?.retryable && latest.phase === 'VERIFY_REVIEW'
          ? this.retryAttemptLimit('VERIFY_REVIEW')
          : snapshot.error?.retryable
            ? PLAN_LIMITS.retryableTransportAttemptsPerParent
            : PLAN_LIMITS.transportAttemptsPerParent;
      if (sameParentAttempts < attemptLimit) {
        const phase = latest.phase as PlanWorkerPhase;
        const retryOverride =
          phase === 'VERIFY_REVIEW' && plan.source.kind !== 'EXTERNAL_CHANGE'
            ? this.retryOverride(phase, records, { advanceModel: snapshot.error?.retryable === true })
            : this.sourceBackend(plan, phase);
        await this.launch(
          plan,
          batch,
          item,
          phase,
          latest.previousExecutionId,
          totalPhaseAttempts + 1,
          retryOverride,
        );
        return;
      }
      const reason = `${latest.phase}_${snapshot.status}`;
      this.block(plan.planId, batch.batchId, item.workItemId, reason, latest.executionId);
      return;
    }

    if (['ADOPT_CHANGE', 'IMPLEMENT', 'IMPLEMENT_FIX'].includes(latest.phase)) {
      const reviewAttempt = records.filter((record) => record.phase === 'VERIFY_REVIEW').length + 1;
      await this.launch(
        plan,
        batch,
        item,
        'VERIFY_REVIEW',
        latest.executionId,
        reviewAttempt,
        this.sourceBackend(plan, 'VERIFY_REVIEW'),
      );
      return;
    }

    const verdict = reviewVerdict(snapshot.result?.finalText ?? '', {
      allowInvalid: plan.source.kind === 'EXTERNAL_CHANGE' && batch.ordinal === 0,
    });
    if (verdict === 'INVALID') {
      this.block(
        plan.planId,
        batch.batchId,
        item.workItemId,
        'EXTERNAL_CHANGE_INVALID',
        latest.executionId,
      );
      return;
    }
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
      await this.launch(
        plan,
        batch,
        item,
        'IMPLEMENT_FIX',
        latest.executionId,
        fixAttempt,
        this.sourceBackend(plan, 'IMPLEMENT_FIX'),
      );
      return;
    }
    if (verdict === 'UNKNOWN') {
      const sameParentReviews = records.filter(
        (record) =>
          record.phase === 'VERIFY_REVIEW' && record.previousExecutionId === latest.previousExecutionId,
      ).length;
      if (sameParentReviews < this.retryAttemptLimit('VERIFY_REVIEW')) {
        const reviewAttempt = records.filter((record) => record.phase === 'VERIFY_REVIEW').length + 1;
        const retryOverride =
          plan.source.kind === 'EXTERNAL_CHANGE'
            ? this.sourceBackend(plan, 'VERIFY_REVIEW')
            : this.retryOverride('VERIFY_REVIEW', records);
        await this.launch(
          plan,
          batch,
          item,
          'VERIFY_REVIEW',
          latest.previousExecutionId,
          reviewAttempt,
          retryOverride,
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

    const reviewedImplementation = latest.previousExecutionId
      ? this.#links.get(latest.previousExecutionId)
      : null;
    if (
      plan.source.kind === 'EXTERNAL_CHANGE' &&
      plan.source.origin?.kind === 'GITHUB_PULL_REQUEST' &&
      reviewedImplementation?.phase === 'IMPLEMENT_FIX'
    ) {
      if (!this.#pullRequestRepairPublisher) {
        this.block(
          plan.planId,
          batch.batchId,
          item.workItemId,
          'GITHUB_PR_REPAIR_PUBLISHER_UNCONFIGURED',
          latest.executionId,
        );
        return;
      }
      if (!reviewedImplementation.workspaceRef) {
        this.block(
          plan.planId,
          batch.batchId,
          item.workItemId,
          'GITHUB_PR_REPAIR_WORKSPACE_MISSING',
          latest.executionId,
        );
        return;
      }
      try {
        const publication = await this.#pullRequestRepairPublisher.publish({
          planId: plan.planId,
          repositoryPath: plan.repositoryPath,
          workspacePath: this.#workspace.hostPathForWorkspaceRef(reviewedImplementation.workspaceRef),
          repository: plan.source.origin.repository,
          pullRequestNumber: plan.source.origin.pullRequestNumber,
          headRepository: plan.source.origin.headRepository,
          headRef: plan.source.origin.headRef,
          expectedHeadRevision: plan.source.revision,
          baseRef: plan.source.origin.baseRef,
          expectedBaseRevision: plan.baseRevision,
        });
        this.#repository.setExternalHeadRevision(plan.planId, publication.publishedRevision);
        this.#repository.appendEvent(
          plan.planId,
          'EXTERNAL_CHANGE_REPAIR_PUBLISHED',
          {
            previousRevision: publication.previousRevision,
            publishedRevision: publication.publishedRevision,
            auditRef: publication.auditRef,
            pullRequestUrl: plan.source.origin.pullRequestUrl,
          },
          {
            batchId: batch.batchId,
            workItemId: item.workItemId,
            executionId: reviewedImplementation.executionId,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = message.split(':', 1)[0] || 'GITHUB_PR_REPAIR_PUBLICATION_FAILED';
        this.block(plan.planId, batch.batchId, item.workItemId, reason, latest.executionId);
        return;
      }
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
          ['ADOPT_CHANGE', 'IMPLEMENT', 'IMPLEMENT_FIX'].includes(record.phase) &&
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
