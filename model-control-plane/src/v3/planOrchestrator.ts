import { ExecutionLinkRepository } from './correlation.js';
import type { PlanDeliveryPort } from './delivery.js';
import { PlanRepository, type CreatePlanInput, type WorkItemRecord } from './plans.js';
import { PLAN_LIMITS } from './planConstants.js';
import { reviewVerdict } from './reviewVerdict.js';
import type {
  DevelopmentExecutionSnapshot,
  ExecutionLinkRecord,
  ExecutionSelection,
  StartDevelopmentExecutionInput,
} from './types.js';
import type { WorkspaceProvisioningPort } from './workspace.js';

const PLAN_TERMINAL_EXECUTION_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED']);

export type PlanRecoveryMode = 'AUTO' | 'RETRY_REVIEW';

interface PlanExecutionPort {
  start(
    input: StartDevelopmentExecutionInput,
    idempotencyKey: string,
  ): Promise<DevelopmentExecutionSnapshot>;
  get(executionId: string): Promise<DevelopmentExecutionSnapshot | null>;
  cancel(executionId: string): Promise<DevelopmentExecutionSnapshot | null>;
}

function selectionFromRecord(record: ExecutionLinkRecord): ExecutionSelection {
  return {
    backend: record.backend,
    modelClass: record.logicalModelClass,
    transportMode: record.transportMode,
    workspaceMode: record.workspaceMode,
    sessionPolicy: record.sessionPolicy,
    reasons: record.selectionReasons,
  };
}

function durableSnapshot(record: ExecutionLinkRecord): DevelopmentExecutionSnapshot {
  const ended = PLAN_TERMINAL_EXECUTION_STATUSES.has(record.statusCache);
  return {
    executionId: record.executionId,
    projectKey: record.projectKey,
    phase: record.phase,
    objectiveSummary: record.objectiveSummary,
    status: record.statusCache,
    selection: selectionFromRecord(record),
    result: record.resultText
      ? {
          finalText: record.resultText,
          workspaceRef: record.workspaceRef,
          git: { branch: record.gitBranch ?? null },
        }
      : null,
    error: record.errorCode
      ? {
          code: record.errorCode,
          ...(record.errorDetail ? { detail: record.errorDetail } : {}),
          retryable: record.errorRetryable === true,
        }
      : null,
    timing: {
      startedAt: new Date(record.startedAt ?? record.createdAt).toISOString(),
      endedAt: ended ? new Date(record.endedAt ?? record.updatedAt).toISOString() : undefined,
      durationMs: ended
        ? Math.max(0, (record.endedAt ?? record.updatedAt) - (record.startedAt ?? record.createdAt))
        : undefined,
    },
    usage: record.observedUsage ?? null,
    refs: {
      openhandsConversationId: record.openhandsConversationId,
      langfuseTraceId: record.langfuseTraceId,
      upstream: { routeUsage: record.observedRoutes ?? [] },
    },
    sourceHealth: {
      openhands: 'UNCONFIGURED',
      litellm: 'UNCONFIGURED',
      observability: 'UNCONFIGURED',
      langfuse: 'UNCONFIGURED',
    },
  };
}

export class DurablePlanOrchestrator {
  readonly #repository: PlanRepository;
  readonly #links: ExecutionLinkRepository;
  readonly #workspace: WorkspaceProvisioningPort;
  readonly #delivery?: PlanDeliveryPort;
  readonly #executions: PlanExecutionPort;
  readonly #planReconcileTails = new Map<string, Promise<void>>();

  constructor(options: {
    repository: PlanRepository;
    links: ExecutionLinkRepository;
    workspace: WorkspaceProvisioningPort;
    delivery?: PlanDeliveryPort;
    executions: PlanExecutionPort;
  }) {
    this.#repository = options.repository;
    this.#links = options.links;
    this.#workspace = options.workspace;
    this.#delivery = options.delivery;
    this.#executions = options.executions;
  }

  async createPlan(input: CreatePlanInput, commandKey: string) {
    if (!commandKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    const { plan, created } = this.#repository.create(input, commandKey);
    if (created) await this.reconcilePlans(plan.planId);
    return (await this.getPlan(plan.planId))!;
  }

  async getPlan(planId: string, hydrateExecutions = false) {
    const plan = this.#repository.get(planId);
    if (!plan) return null;
    const batches = [];
    for (const batch of this.#repository.batches(planId)) {
      const workItems = [];
      for (const item of this.#repository.workItems(batch.batchId)) {
        const executions = [];
        for (const executionId of this.#repository.executionIds(item.workItemId)) {
          const snapshot = hydrateExecutions
            ? await this.#executions.get(executionId)
            : (() => {
                const record = this.#links.get(executionId);
                return record ? durableSnapshot(record) : null;
              })();
          if (snapshot) executions.push(snapshot);
        }
        workItems.push({ ...item, executions });
      }
      batches.push({ ...batch, workItems });
    }
    return {
      ...plan,
      batches,
      events: this.#repository.events(planId),
    };
  }

  async listPlans(limit: number = PLAN_LIMITS.listResults) {
    const items = [];
    for (const plan of this.#repository.list(limit)) {
      const projection = await this.getPlan(plan.planId, false);
      if (projection) items.push(projection);
    }
    return items;
  }

  async cancelPlan(planId: string) {
    const plan = this.#repository.get(planId);
    if (!plan) return null;
    if (['SUCCEEDED', 'CANCELLED'].includes(plan.status)) return this.getPlan(planId);
    this.#repository.cancel(planId);
    for (const batch of this.#repository.batches(planId)) {
      for (const item of this.#repository.workItems(batch.batchId)) {
        for (const executionId of this.#repository.executionIds(item.workItemId)) {
          const record = this.#links.get(executionId);
          if (record && !PLAN_TERMINAL_EXECUTION_STATUSES.has(record.statusCache)) {
            try {
              await this.#executions.cancel(executionId);
            } catch (error) {
              this.#repository.appendEvent(
                planId,
                'PLAN_WORKER_CANCEL_FAILED',
                {
                  message: (error instanceof Error ? error.message : String(error)).slice(
                    0,
                    PLAN_LIMITS.errorDetailCharacters,
                  ),
                },
                { batchId: batch.batchId, workItemId: item.workItemId, executionId },
              );
            }
          }
        }
      }
    }
    return this.getPlan(planId);
  }

  async #launchPlanPhase(
    plan: ReturnType<PlanRepository['get']> extends infer Value ? Exclude<Value, null> : never,
    batch: ReturnType<PlanRepository['batches']>[number],
    item: WorkItemRecord,
    phase: 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'VERIFY_REVIEW',
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
          path: phase === 'IMPLEMENT' ? plan.repositoryPath : '',
          baseRevision:
            phase === 'IMPLEMENT' ? (batch.baseRevision ?? plan.currentRevision) : undefined,
        },
        context: {
          previousExecutionId,
          acceptanceCriteria: item.acceptanceCriteria,
        },
        override: overrideBackend ? { backend: overrideBackend } : undefined,
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

  async #reconcileWorkItem(
    plan: Exclude<ReturnType<PlanRepository['get']>, null>,
    batch: ReturnType<PlanRepository['batches']>[number],
    item: WorkItemRecord,
  ): Promise<void> {
    const executionIds = this.#repository.executionIds(item.workItemId);
    if (executionIds.length === 0) {
      await this.#launchPlanPhase(plan, batch, item, 'IMPLEMENT', undefined, 1);
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
          record.phase === latest.phase &&
          record.previousExecutionId === latest.previousExecutionId,
      ).length;
      const totalPhaseAttempts = records.filter((record) => record.phase === latest.phase).length;
      const attemptLimit = snapshot.error?.retryable
        ? PLAN_LIMITS.retryableTransportAttemptsPerParent
        : PLAN_LIMITS.transportAttemptsPerParent;
      if (sameParentAttempts < attemptLimit) {
        await this.#launchPlanPhase(
          plan,
          batch,
          item,
          latest.phase as 'IMPLEMENT' | 'VERIFY_REVIEW',
          latest.previousExecutionId,
          totalPhaseAttempts + 1,
          latest.phase === 'VERIFY_REVIEW' ? 'openhands-builtin' : undefined,
        );
        return;
      }
      const reason = `${latest.phase}_${snapshot.status}`;
      this.#blockWorkItem(plan.planId, batch.batchId, item.workItemId, reason, latest.executionId);
      return;
    }

    if (latest.phase === 'IMPLEMENT' || latest.phase === 'IMPLEMENT_FIX') {
      const reviewAttempt = records.filter((record) => record.phase === 'VERIFY_REVIEW').length + 1;
      await this.#launchPlanPhase(
        plan,
        batch,
        item,
        'VERIFY_REVIEW',
        latest.executionId,
        reviewAttempt,
      );
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
        const reason = 'REVIEW_FIX_LIMIT_EXCEEDED';
        this.#blockWorkItem(
          plan.planId,
          batch.batchId,
          item.workItemId,
          reason,
          latest.executionId,
        );
        return;
      }
      const fixAttempt = records.filter((record) => record.phase === 'IMPLEMENT_FIX').length + 1;
      await this.#launchPlanPhase(
        plan,
        batch,
        item,
        'IMPLEMENT_FIX',
        latest.executionId,
        fixAttempt,
      );
      return;
    }
    if (verdict === 'UNKNOWN') {
      const sameParentReviews = records.filter(
        (record) =>
          record.phase === 'VERIFY_REVIEW' &&
          record.previousExecutionId === latest.previousExecutionId,
      ).length;
      if (sameParentReviews < PLAN_LIMITS.transportAttemptsPerParent) {
        const reviewAttempt =
          records.filter((record) => record.phase === 'VERIFY_REVIEW').length + 1;
        await this.#launchPlanPhase(
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
      const reason = 'REVIEW_VERDICT_UNKNOWN';
      this.#blockWorkItem(plan.planId, batch.batchId, item.workItemId, reason, latest.executionId);
      return;
    }
    this.#repository.setWorkItemStatus(item.workItemId, 'SUCCEEDED');
    this.#repository.appendEvent(
      plan.planId,
      'WORK_ITEM_VERIFIED',
      {},
      {
        batchId: batch.batchId,
        workItemId: item.workItemId,
        executionId: latest.executionId,
      },
    );
  }

  #blockWorkItem(
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
      {
        batchId,
        workItemId,
        executionId,
      },
    );
  }

  async #integrateBatch(
    plan: Exclude<ReturnType<PlanRepository['get']>, null>,
    batch: ReturnType<PlanRepository['batches']>[number],
    items: WorkItemRecord[],
  ): Promise<void> {
    const implementations = items.map((item) => {
      const records = this.#repository
        .executionIds(item.workItemId)
        .map((executionId) => this.#links.get(executionId))
        .filter((record): record is ExecutionLinkRecord => Boolean(record));
      const implementation = [...records]
        .reverse()
        .find((record) => record.phase === 'IMPLEMENT' || record.phase === 'IMPLEMENT_FIX');
      if (!implementation?.workspaceRef || !implementation.sourceRevision) {
        throw new Error('BATCH_INTEGRATION_EVIDENCE_MISSING');
      }
      return {
        workspaceRef: implementation.workspaceRef,
        sourceRevision: implementation.sourceRevision,
        executionId: implementation.executionId,
      };
    });
    try {
      const integrated = await this.#workspace.integrateBatch({
        planId: plan.planId,
        batchKey: batch.key,
        repositoryPath: plan.repositoryPath,
        baseRevision: batch.baseRevision ?? plan.currentRevision,
        implementations,
      });
      this.#repository.setBatchStatus(batch.batchId, 'SUCCEEDED', {
        integratedRevision: integrated.revision,
        integrationRef: integrated.ref,
      });
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_INTEGRATED',
        { revision: integrated.revision, ref: integrated.ref },
        { batchId: batch.batchId },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'BATCH_INTEGRATION_FAILED';
      const reason = message.split(':', 1)[0] ?? 'BATCH_INTEGRATION_FAILED';
      this.#repository.setBatchStatus(batch.batchId, 'BLOCKED', { blockedReason: reason });
      this.#repository.setPlanStatus(plan.planId, 'BLOCKED', reason);
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_INTEGRATION_BLOCKED',
        { reason, message: message.slice(0, PLAN_LIMITS.errorDetailCharacters) },
        { batchId: batch.batchId },
      );
    }
  }

  async #reconcilePlan(planId: string): Promise<void> {
    const plan = this.#repository.get(planId);
    if (!plan || !['PENDING', 'RUNNING'].includes(plan.status)) return;
    if (plan.status === 'PENDING') this.#repository.setPlanStatus(plan.planId, 'RUNNING');
    const batches = this.#repository.batches(plan.planId);
    if (batches.every((batch) => batch.status === 'SUCCEEDED')) {
      if (!plan.delivery) {
        this.#repository.setPlanStatus(plan.planId, 'SUCCEEDED');
        this.#repository.appendEvent(plan.planId, 'PLAN_SUCCEEDED', {
          revision: plan.currentRevision,
        });
        return;
      }
      if (!this.#delivery) {
        this.#repository.setDeliveryState(plan.planId, {
          stage: 'BLOCKED',
          evidence: { reason: 'DELIVERY_ADAPTER_UNCONFIGURED' },
        });
        this.#repository.setPlanStatus(plan.planId, 'BLOCKED', 'DELIVERY_ADAPTER_UNCONFIGURED');
        this.#repository.appendEvent(plan.planId, 'PLAN_DELIVERY_BLOCKED', {
          reason: 'DELIVERY_ADAPTER_UNCONFIGURED',
        });
        return;
      }
      const result = await this.#delivery.reconcile({
        planId: plan.planId,
        repositoryPath: plan.repositoryPath,
        objective: plan.objective,
        revision: plan.currentRevision,
        config: plan.delivery,
      });
      this.#repository.setDeliveryState(plan.planId, {
        stage: result.stage,
        evidence: result.evidence,
        pullRequestUrl: result.pullRequestUrl,
        mergeRevision: result.outcome === 'SUCCEEDED' ? result.mergeRevision : undefined,
      });
      if (result.outcome === 'NEEDS_FIX') {
        const repair = this.#repository.addDeliveryRepairBatch(plan.planId, result.evidence);
        if (!repair) {
          this.#repository.setDeliveryState(plan.planId, {
            stage: 'BLOCKED',
            evidence: result.evidence,
            pullRequestUrl: result.pullRequestUrl,
          });
          this.#repository.setPlanStatus(plan.planId, 'BLOCKED', 'DELIVERY_FIX_LIMIT_EXCEEDED');
          this.#repository.appendEvent(plan.planId, 'PLAN_DELIVERY_BLOCKED', {
            reason: 'DELIVERY_FIX_LIMIT_EXCEEDED',
            ...result.evidence,
          });
        } else {
          this.#repository.setDeliveryState(plan.planId, {
            stage: 'PENDING',
            evidence: result.evidence,
            pullRequestUrl: result.pullRequestUrl,
          });
          this.#repository.appendEvent(plan.planId, 'PLAN_DELIVERY_REPAIR_SCHEDULED', {
            batchId: repair.batchId,
            ...result.evidence,
          });
        }
      } else if (result.outcome === 'BLOCKED') {
        this.#repository.setPlanStatus(plan.planId, 'BLOCKED', result.reason);
        this.#repository.appendEvent(plan.planId, 'PLAN_DELIVERY_BLOCKED', {
          reason: result.reason,
          ...result.evidence,
        });
      } else if (result.outcome === 'SUCCEEDED') {
        this.#repository.setPlanStatus(plan.planId, 'SUCCEEDED');
        this.#repository.appendEvent(plan.planId, 'PLAN_SUCCEEDED', {
          integratedRevision: plan.currentRevision,
          mergeRevision: result.mergeRevision,
          pullRequestUrl: result.pullRequestUrl,
          postMergeChecks: result.evidence,
        });
      } else if (plan.deliveryStage !== result.stage) {
        this.#repository.appendEvent(plan.planId, 'PLAN_DELIVERY_WAITING', {
          stage: result.stage,
          ...result.evidence,
        });
      }
      return;
    }
    const succeededKeys = new Set(
      batches.filter((batch) => batch.status === 'SUCCEEDED').map((batch) => batch.key),
    );
    const batch = batches.find(
      (candidate) =>
        ['PENDING', 'RUNNING'].includes(candidate.status) &&
        candidate.dependsOn.every((dependency) => succeededKeys.has(dependency)),
    );
    if (!batch) return;
    if (batch.status === 'PENDING') {
      this.#repository.setBatchStatus(batch.batchId, 'RUNNING', {
        baseRevision: plan.currentRevision,
      });
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_STARTED',
        { baseRevision: plan.currentRevision },
        {
          batchId: batch.batchId,
        },
      );
    }
    const currentBatch = this.#repository
      .batches(plan.planId)
      .find((item) => item.batchId === batch.batchId)!;
    const items = this.#repository.workItems(batch.batchId);
    for (const item of items) {
      if (item.status !== 'SUCCEEDED') {
        try {
          await this.#reconcileWorkItem(plan, currentBatch, item);
        } catch (error) {
          const code = error instanceof Error ? (error.message.split(':', 1)[0] ?? '') : '';
          if (!code.includes('CONCURRENCY') && !code.includes('LEASE_CONFLICT')) throw error;
        }
      }
    }
    const refreshed = this.#repository.workItems(batch.batchId);
    if (refreshed.every((item) => item.status === 'SUCCEEDED')) {
      await this.#integrateBatch(plan, currentBatch, refreshed);
    }
  }

  async #recoverBlockedPlan(
    planId: string,
    recoveryMode: PlanRecoveryMode = 'AUTO',
  ): Promise<void> {
    const blocked = this.#repository.get(planId);
    if (blocked?.status !== 'BLOCKED') return;
    const batch = this.#repository
      .batches(planId)
      .find((candidate) => candidate.status === 'BLOCKED');
    if (!batch && blocked.delivery?.autoMerge && blocked.deliveryStage === 'BLOCKED') {
      this.#repository.setPlanStatus(planId, 'RUNNING');
      this.#repository.setDeliveryState(planId, { stage: 'PENDING' });
      this.#repository.appendEvent(planId, 'PLAN_DELIVERY_RECOVERY_REQUESTED', {
        previousReason: blocked.blockedReason,
      });
      return;
    }
    if (!batch) return;
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
        await this.#launchPlanPhase(
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
      await this.#launchPlanPhase(
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

  #enqueuePlanReconciliation(
    planId: string,
    recoverBlocked: boolean,
    recoveryMode: PlanRecoveryMode = 'AUTO',
  ): Promise<void> {
    const predecessor = this.#planReconcileTails.get(planId) ?? Promise.resolve();
    const current = predecessor
      .catch(() => undefined)
      .then(async () => {
        if (recoverBlocked) await this.#recoverBlockedPlan(planId, recoveryMode);
        await this.#reconcilePlan(planId);
      });
    this.#planReconcileTails.set(planId, current);
    void current
      .finally(() => {
        if (this.#planReconcileTails.get(planId) === current) {
          this.#planReconcileTails.delete(planId);
        }
      })
      .catch(() => undefined);
    return current;
  }

  async reconcilePlans(
    planId?: string,
    recoverBlocked = false,
    recoveryMode: PlanRecoveryMode = 'AUTO',
  ): Promise<void> {
    if (planId) {
      await this.#enqueuePlanReconciliation(planId, recoverBlocked, recoveryMode);
      return;
    }
    await Promise.all(
      this.#repository.active().map((plan) => this.#enqueuePlanReconciliation(plan.planId, false)),
    );
  }
}
