import { ExecutionLinkRepository } from './correlation.js';
import type { PlanDeliveryPort } from './delivery.js';
import {
  PlanRepository,
  type CreatePlanInput,
  type DelegatePlanInput,
  type WorkItemRecord,
} from './plans.js';
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

const INTEGRATION_REPAIR_ITEM_PREFIX = 'integration-repair-b';
const BATCH_AGGREGATE_REVIEW_ITEM_PREFIX = 'batch-verify-b';
const INTEGRATION_REPAIR_BACKEND = 'openhands-builtin';
const INTEGRATION_REPAIR_MODEL_CLASS = 'gpt-5.6-sol';

function isIntegrationRepairItem(item: Pick<WorkItemRecord, 'key'>): boolean {
  return item.key.startsWith(INTEGRATION_REPAIR_ITEM_PREFIX);
}

function isBatchAggregateReviewItem(item: Pick<WorkItemRecord, 'key'>): boolean {
  return item.key.startsWith(BATCH_AGGREGATE_REVIEW_ITEM_PREFIX);
}

export type PlanRecoveryMode = 'AUTO' | 'RETRY_REVIEW' | 'RETRY_DELIVERY';

interface OrchestrationProposal {
  analysisSummary: string;
  batches: CreatePlanInput['batches'];
}

function parseOrchestrationProposal(finalText: string): OrchestrationProposal {
  let text = finalText.trim();
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('PLAN_ORCHESTRATION_JSON_MISSING');
  const parsed = JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>;
  const analysisSummary = String(parsed.analysisSummary ?? '').trim();
  if (!analysisSummary) throw new Error('PLAN_ANALYSIS_REQUIRED');
  if (!Array.isArray(parsed.batches) || parsed.batches.length === 0) {
    throw new Error('PLAN_BATCHES_REQUIRED');
  }
  const batches = parsed.batches.slice(0, 24).map((rawBatch) => {
    if (!rawBatch || typeof rawBatch !== 'object' || Array.isArray(rawBatch)) {
      throw new Error('PLAN_BATCH_INVALID');
    }
    const batch = rawBatch as Record<string, unknown>;
    if (!Array.isArray(batch.workItems) || batch.workItems.length === 0) {
      throw new Error('PLAN_WORK_ITEMS_REQUIRED');
    }
    return {
      key: String(batch.key ?? '')
        .trim()
        .slice(0, 160),
      title: String(batch.title ?? batch.key ?? '')
        .trim()
        .slice(0, 500),
      dependsOn: Array.isArray(batch.dependsOn)
        ? batch.dependsOn.map((item) => String(item).trim().slice(0, 160)).filter(Boolean)
        : [],
      workItems: batch.workItems.slice(0, 48).map((rawItem) => {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          throw new Error('PLAN_WORK_ITEM_INVALID');
        }
        const item = rawItem as Record<string, unknown>;
        return {
          key: String(item.key ?? '')
            .trim()
            .slice(0, 160),
          title: String(item.title ?? item.key ?? '')
            .trim()
            .slice(0, 500),
          objective: String(item.objective ?? '')
            .trim()
            .slice(0, 20_000),
          acceptanceCriteria: Array.isArray(item.acceptanceCriteria)
            ? item.acceptanceCriteria
                .map((criterion) => String(criterion).trim().slice(0, 2_000))
                .filter(Boolean)
                .slice(0, 24)
            : [],
        };
      }),
    };
  });
  return { analysisSummary: analysisSummary.slice(0, 12_000), batches };
}

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

  async delegatePlan(input: DelegatePlanInput, commandKey: string) {
    if (!commandKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    const { plan } = this.#repository.createDelegatedDraft(input, commandKey);
    try {
      await this.#ensureOrchestration(plan.planId);
    } catch (error) {
      // The durable plan identity is the public acknowledgement boundary. A transient
      // supervisor/provider outage must not make Hermes believe delegation itself was lost;
      // periodic reconciliation will retry the ORCHESTRATE launch from this same planId.
      this.#repository.appendEvent(plan.planId, 'PLAN_ORCHESTRATION_START_DEFERRED', {
        reason: (error instanceof Error ? error.message : String(error)).slice(
          0,
          PLAN_LIMITS.errorDetailCharacters,
        ),
      });
    }
    return (await this.getPlan(plan.planId))!;
  }

  async #startOrchestration(
    plan: Exclude<ReturnType<PlanRepository['get']>, null>,
    attempt: number,
    correction?: string,
  ): Promise<DevelopmentExecutionSnapshot> {
    const commandKey = `${plan.planId}:ORCHESTRATE:${attempt}`;
    const schemaExample = JSON.stringify({
      analysisSummary: 'Repository-backed summary justifying the graph.',
      batches: [
        {
          key: 'batch-1',
          title: 'Outcome-oriented batch title',
          dependsOn: [],
          workItems: [
            {
              key: 'ticket-1',
              title: 'Outcome-oriented ticket title',
              objective: 'Concrete implementation objective grounded in the repository.',
              acceptanceCriteria: ['Observable verification criterion.'],
            },
          ],
        },
      ],
    });
    const objective = [
      plan.objective,
      '',
      'Produce the complete execution graph for the durable AI Office plan.',
      'Inspect the repository and any active plan documents before deciding the graph.',
      'Do not launch coding workers in ORCHESTRATE; the durable Control Plane launches implementation and review only after this graph validates.',
      'Use dependency edges to expose safe parallelism: independent work belongs in the same dependency-ready batch; dependent work goes in later batches.',
      'Return only one JSON object, with camelCase fields exactly matching this shape:',
      schemaExample,
      correction ? `Previous orchestration output was invalid: ${correction}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const snapshot = await this.#executions.start(
      {
        phase: 'ORCHESTRATE',
        objective,
        projectKey: plan.projectKey,
        repository: { path: plan.repositoryPath, baseRevision: plan.baseRevision },
        await: false,
      },
      commandKey,
    );
    this.#repository.appendEvent(
      plan.planId,
      'PLAN_ORCHESTRATION_STARTED',
      { attempt },
      { executionId: snapshot.executionId },
    );
    return snapshot;
  }

  async #ensureOrchestration(planId: string): Promise<void> {
    const plan = this.#repository.get(planId);
    if (!plan || plan.status !== 'ORCHESTRATING') return;
    const starts = this.#repository
      .events(planId)
      .filter((event) => event.type === 'PLAN_ORCHESTRATION_STARTED');
    if (starts.length === 0) await this.#startOrchestration(plan, 1);
  }

  async #reconcileOrchestration(
    plan: Exclude<ReturnType<PlanRepository['get']>, null>,
  ): Promise<void> {
    const starts = this.#repository
      .events(plan.planId)
      .filter((event) => event.type === 'PLAN_ORCHESTRATION_STARTED');
    if (starts.length === 0) {
      await this.#startOrchestration(plan, 1);
      return;
    }
    const latest = starts.at(-1)!;
    const executionId = String(latest.executionId ?? '');
    if (!executionId) throw new Error('PLAN_ORCHESTRATION_EXECUTION_MISSING');
    const snapshot = await this.#executions.get(executionId);
    if (!snapshot || !PLAN_TERMINAL_EXECUTION_STATUSES.has(snapshot.status)) return;
    const attempt = starts.length;
    if (snapshot.status !== 'SUCCEEDED') {
      const limit = snapshot.error?.retryable
        ? PLAN_LIMITS.retryableTransportAttemptsPerParent
        : PLAN_LIMITS.transportAttemptsPerParent;
      if (attempt < limit) {
        await this.#startOrchestration(plan, attempt + 1, snapshot.error?.code ?? snapshot.status);
        return;
      }
      this.#repository.setPlanStatus(plan.planId, 'BLOCKED', 'PLAN_ORCHESTRATION_FAILED');
      this.#repository.appendEvent(
        plan.planId,
        'PLAN_ORCHESTRATION_BLOCKED',
        { reason: snapshot.error?.code ?? snapshot.status, attempt },
        { executionId },
      );
      return;
    }
    try {
      const proposal = parseOrchestrationProposal(snapshot.result?.finalText ?? '');
      this.#repository.materializeDelegatedPlan(plan.planId, proposal);
      this.#repository.appendEvent(
        plan.planId,
        'PLAN_ORCHESTRATION_ACCEPTED',
        { attempt },
        { executionId },
      );
      await this.#reconcilePlan(plan.planId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt < PLAN_LIMITS.transportAttemptsPerParent) {
        await this.#startOrchestration(plan, attempt + 1, reason.slice(0, 500));
        return;
      }
      this.#repository.setPlanStatus(plan.planId, 'BLOCKED', 'PLAN_ORCHESTRATION_INVALID');
      this.#repository.appendEvent(
        plan.planId,
        'PLAN_ORCHESTRATION_BLOCKED',
        { reason: reason.slice(0, PLAN_LIMITS.errorDetailCharacters), attempt },
        { executionId },
      );
    }
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
    const events = this.#repository.events(planId);
    const orchestrationEvent = [...events]
      .reverse()
      .find((event) => event.type === 'PLAN_ORCHESTRATION_STARTED');
    const orchestrationExecutionId = orchestrationEvent?.executionId
      ? String(orchestrationEvent.executionId)
      : undefined;
    const orchestration = orchestrationExecutionId
      ? hydrateExecutions
        ? await this.#executions.get(orchestrationExecutionId)
        : (() => {
            const record = this.#links.get(orchestrationExecutionId);
            return record ? durableSnapshot(record) : null;
          })()
      : null;
    return {
      ...plan,
      orchestration,
      batches,
      events,
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
    const orchestrationIds = this.#repository
      .events(planId)
      .filter((event) => event.type === 'PLAN_ORCHESTRATION_STARTED' && event.executionId)
      .map((event) => String(event.executionId));
    for (const executionId of orchestrationIds) {
      const record = this.#links.get(executionId);
      if (record && !PLAN_TERMINAL_EXECUTION_STATUSES.has(record.statusCache)) {
        try {
          await this.#executions.cancel(executionId);
        } catch {
          // The plan cancellation below remains authoritative even if a remote supervisor is unreachable.
        }
      }
    }
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
    phase: 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'VERIFY_REVIEW' | 'BATCH_VERIFY',
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
          isIntegrationRepairItem(item) && phase !== 'VERIFY_REVIEW'
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
    if (isIntegrationRepairItem(item)) {
      this.#repository.clearBatchIntegrationCandidate(batch.batchId);
    }
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

  #approvedImplementationEvidence(item: WorkItemRecord): {
    workspaceRef: string;
    sourceRevision: string;
    executionId: string;
    approvedRevision: string;
  } {
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
    if (
      !implementation?.workspaceRef ||
      !implementation.sourceRevision ||
      !approvedReview?.sourceRevision
    ) {
      throw new Error('BATCH_INTEGRATION_EVIDENCE_MISSING');
    }
    return {
      workspaceRef: implementation.workspaceRef,
      sourceRevision: implementation.sourceRevision,
      executionId: implementation.executionId,
      approvedRevision: approvedReview.sourceRevision,
    };
  }

  #scheduleBatchIntegrationRepair(
    plan: Exclude<ReturnType<PlanRepository['get']>, null>,
    batch: ReturnType<PlanRepository['batches']>[number],
    items: WorkItemRecord[],
    reason: string,
    message: string,
  ): void {
    const originalItems = items.filter(
      (item) => !isIntegrationRepairItem(item) && !isBatchAggregateReviewItem(item),
    );
    const sources = originalItems.map((item, index) => ({
      index,
      itemKey: item.key,
      title: item.title,
      acceptanceCriteria: item.acceptanceCriteria,
      ...this.#approvedImplementationEvidence(item),
    }));
    const aggregateReviewFailure = reason === 'BATCH_AGGREGATE_REVIEW_FAILED';
    const baseRevision =
      (aggregateReviewFailure ? batch.integratedRevision : undefined) ??
      batch.baseRevision ??
      plan.currentRevision;
    const sourceInstructions = sources
      .map((source) =>
        [
          `[${source.index}] ${source.itemKey} — ${source.title}`,
          `approved revision: ${source.approvedRevision}`,
          `workspace: ${source.workspaceRef}`,
          aggregateReviewFailure
            ? ''
            : `fetch: git fetch ${source.workspaceRef} ${source.approvedRevision}:refs/ai-office/incoming/${source.index}`,
          aggregateReviewFailure
            ? ''
            : `merge: git merge --no-ff --no-edit refs/ai-office/incoming/${source.index}`,
          source.acceptanceCriteria.length
            ? `acceptance: ${source.acceptanceCriteria.join(' | ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');
    const objective = aggregateReviewFailure
      ? [
          `Repair the integrated batch ${batch.key} after the aggregate reviewer found a semantic integration defect.`,
          `The repair workspace starts from integrated candidate revision ${baseRevision}, which already contains every independently reviewed source revision.`,
          'Address the aggregate reviewer findings directly in the combined codebase. Preserve the previously accepted behavior of every ticket while repairing cross-ticket contracts, wiring, ordering, migrations, ownership, or other combined semantics.',
          'Do not reset, revert, or rewrite away an approved ticket merely to make the aggregate review pass.',
          'Run focused regression checks for the reviewer findings and the affected ticket acceptance criteria, then commit the repair and leave the workspace clean.',
          '',
          sourceInstructions,
          '',
          'Aggregate review findings:',
          message.slice(0, PLAN_LIMITS.repairEvidenceCharacters),
        ].join('\n')
      : [
          `Resolve the semantic Git integration conflict for batch ${batch.key}.`,
          `The repair workspace starts from the batch base revision ${baseRevision}.`,
          'Integrate every independently reviewed implementation below into this one workspace. Fetch the exact approved revisions from their sibling workspaces and merge them in the listed order.',
          'Resolve conflicts according to repository contracts and ownership boundaries. Do not discard either side wholesale with ours/theirs merely to make Git clean.',
          'If two implementations made competing architecture choices, inspect the surrounding contracts and tests, choose one coherent ownership model, and adapt both tickets to it while preserving their accepted behavior.',
          'Do not modify the source worktree or sibling implementation workspaces.',
          'All listed approved revisions must remain Git ancestors of the final repair HEAD; the control plane verifies this mechanically before accepting the repair.',
          'Run focused regression tests covering the overlapping files plus the affected ticket acceptance criteria, then commit the resolved integration and leave the workspace clean.',
          '',
          sourceInstructions,
          '',
          `Conflict evidence (${reason}):`,
          message.slice(0, PLAN_LIMITS.errorDetailCharacters),
        ].join('\n');
    const repair = this.#repository.addBatchIntegrationRepairWorkItem(plan.planId, batch.batchId, {
      objective: objective.slice(0, 20_000),
      acceptanceCriteria: [
        'Every independently reviewed source revision is an ancestor of the final repair HEAD.',
        'No unresolved Git conflicts remain and the repair workspace is clean with a committed integration result.',
        'The overlapping repository contracts have one coherent architecture rather than duplicated competing implementations.',
        'Focused regression tests for all affected work items pass.',
        'The combined repair is independently reviewed before batch integration is accepted.',
      ],
      evidence: {
        reason,
        message: message.slice(0, PLAN_LIMITS.repairEvidenceCharacters),
        baseRevision,
        sources: sources.map((source) => ({
          itemKey: source.itemKey,
          approvedRevision: source.approvedRevision,
          workspaceRef: source.workspaceRef,
        })),
      },
    });
    if (!repair) {
      const blockedReason = 'BATCH_INTEGRATION_REPAIR_LIMIT_EXCEEDED';
      this.#repository.setBatchStatus(batch.batchId, 'BLOCKED', {
        blockedReason,
      });
      this.#repository.setPlanStatus(plan.planId, 'BLOCKED', blockedReason);
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_INTEGRATION_BLOCKED',
        {
          reason: blockedReason,
          previousReason: reason,
          message: message.slice(0, PLAN_LIMITS.errorDetailCharacters),
        },
        { batchId: batch.batchId },
      );
      return;
    }
    this.#repository.setBatchStatus(batch.batchId, 'RUNNING');
    this.#repository.setPlanStatus(plan.planId, 'RUNNING');
    this.#repository.appendEvent(
      plan.planId,
      'BATCH_INTEGRATION_REPAIR_SCHEDULED',
      {
        reason,
        workItemKey: repair.key,
        modelClass: INTEGRATION_REPAIR_MODEL_CLASS,
        backend: INTEGRATION_REPAIR_BACKEND,
      },
      { batchId: batch.batchId, workItemId: repair.workItemId },
    );
  }

  async #integrateBatch(
    plan: Exclude<ReturnType<PlanRepository['get']>, null>,
    batch: ReturnType<PlanRepository['batches']>[number],
    items: WorkItemRecord[],
  ): Promise<void> {
    const originalItems = items.filter(
      (item) => !isIntegrationRepairItem(item) && !isBatchAggregateReviewItem(item),
    );
    const repairItems = items.filter(isIntegrationRepairItem);
    const repairItem = repairItems.at(-1);
    const integrationItems = repairItem ? [repairItem] : originalItems;
    const implementations = integrationItems.map((item) => {
      const evidence = this.#approvedImplementationEvidence(item);
      return {
        workspaceRef: evidence.workspaceRef,
        sourceRevision: evidence.sourceRevision,
        executionId: evidence.executionId,
      };
    });
    const requiredAncestorRevisions = repairItem
      ? [
          ...new Set(
            originalItems.map(
              (item) => this.#approvedImplementationEvidence(item).approvedRevision,
            ),
          ),
        ]
      : undefined;
    try {
      const integrated = await this.#workspace.integrateBatch({
        planId: plan.planId,
        batchKey: batch.key,
        repositoryPath: plan.repositoryPath,
        baseRevision: batch.baseRevision ?? plan.currentRevision,
        implementations,
        requiredAncestorRevisions,
      });
      const requiresAggregateReview = originalItems.length > 1;
      if (requiresAggregateReview) {
        this.#repository.setBatchIntegrationCandidate(
          batch.batchId,
          integrated.revision,
          integrated.ref,
        );
        this.#repository.appendEvent(
          plan.planId,
          'BATCH_INTEGRATION_CANDIDATE',
          {
            revision: integrated.revision,
            ref: integrated.ref,
            repaired: Boolean(repairItem),
            repairWorkItemKey: repairItem?.key,
            aggregateReviewRequired: true,
          },
          { batchId: batch.batchId },
        );
        return;
      }
      this.#repository.setBatchStatus(batch.batchId, 'SUCCEEDED', {
        integratedRevision: integrated.revision,
        integrationRef: integrated.ref,
      });
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_INTEGRATED',
        {
          revision: integrated.revision,
          ref: integrated.ref,
          repaired: Boolean(repairItem),
          repairWorkItemKey: repairItem?.key,
          aggregateReviewRequired: false,
        },
        { batchId: batch.batchId },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'BATCH_INTEGRATION_FAILED';
      const reason = message.split(':', 1)[0] ?? 'BATCH_INTEGRATION_FAILED';
      if (
        reason === 'BATCH_INTEGRATION_CONFLICT' ||
        reason === 'BATCH_INTEGRATION_REPAIR_INCOMPLETE'
      ) {
        this.#scheduleBatchIntegrationRepair(plan, batch, items, reason, message);
        return;
      }
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

  async #reconcileBatchAggregateReview(
    plan: Exclude<ReturnType<PlanRepository['get']>, null>,
    batch: ReturnType<PlanRepository['batches']>[number],
    items: WorkItemRecord[],
  ): Promise<void> {
    if (!batch.integratedRevision || !batch.integrationRef) {
      throw new Error('BATCH_INTEGRATION_CANDIDATE_MISSING');
    }
    const originalItems = items.filter(
      (item) => !isIntegrationRepairItem(item) && !isBatchAggregateReviewItem(item),
    );
    if (originalItems.length <= 1) return;
    const acceptanceSummary = originalItems
      .map((item) => {
        const criteria = item.acceptanceCriteria.length
          ? item.acceptanceCriteria.map((criterion) => `  - ${criterion}`).join('\n')
          : '  - (no explicit criterion)';
        return `${item.key} — ${item.title}\n${criteria}`;
      })
      .join('\n\n');
    const objective = [
      `Aggregate-review integrated batch ${batch.key}.`,
      `Batch base revision: ${batch.baseRevision ?? plan.currentRevision}.`,
      `Integrated candidate revision: ${batch.integratedRevision}.`,
      `Integration ref: ${batch.integrationRef}.`,
      'Review the COMBINED artifact for defects that individual ticket reviews cannot see: cross-ticket contract mismatch, duplicate ownership, incompatible architecture choices, host composition/wiring errors, ordering/migration conflicts, state-machine interactions, and regressions caused by the combination.',
      'Inspect the integrated diff from the batch base to the candidate and run focused verification across the overlapping/affected modules.',
      '',
      'Individually approved work items and acceptance criteria:',
      acceptanceSummary,
    ].join('\n');
    const aggregateItem = this.#repository.addBatchAggregateReviewWorkItem(
      plan.planId,
      batch.batchId,
      {
        candidateRevision: batch.integratedRevision,
        objective: objective.slice(0, 20_000),
        acceptanceCriteria: [
          'The integrated candidate preserves every individually approved work-item acceptance criterion.',
          'Cross-ticket contracts, ownership boundaries, dependency injection/composition, migrations, and state transitions are coherent as a combined artifact.',
          'No blocking regression is introduced only by combining the independently reviewed changes.',
          'At least one focused aggregate verification command is executed against the integrated candidate.',
        ],
      },
    );
    const executionIds = this.#repository.executionIds(aggregateItem.workItemId);
    if (executionIds.length === 0) {
      await this.#launchPlanPhase(plan, batch, aggregateItem, 'BATCH_VERIFY', undefined, 1);
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
      const attempts = records.filter((record) => record.phase === 'BATCH_VERIFY').length;
      const limit = snapshot.error?.retryable
        ? PLAN_LIMITS.retryableTransportAttemptsPerParent
        : PLAN_LIMITS.transportAttemptsPerParent;
      if (attempts < limit) {
        await this.#launchPlanPhase(
          plan,
          batch,
          aggregateItem,
          'BATCH_VERIFY',
          undefined,
          attempts + 1,
          'openhands-builtin',
        );
        return;
      }
      const reason = `BATCH_VERIFY_${snapshot.status}`;
      this.#blockWorkItem(
        plan.planId,
        batch.batchId,
        aggregateItem.workItemId,
        reason,
        latest.executionId,
      );
      return;
    }
    const result = snapshot.result?.finalText ?? '';
    const verdict = reviewVerdict(result);
    if (verdict === 'UNKNOWN') {
      const attempts = records.filter((record) => record.phase === 'BATCH_VERIFY').length;
      if (attempts < PLAN_LIMITS.transportAttemptsPerParent) {
        await this.#launchPlanPhase(
          plan,
          batch,
          aggregateItem,
          'BATCH_VERIFY',
          undefined,
          attempts + 1,
          'openhands-builtin',
        );
        return;
      }
      this.#blockWorkItem(
        plan.planId,
        batch.batchId,
        aggregateItem.workItemId,
        'BATCH_VERIFY_VERDICT_UNKNOWN',
        latest.executionId,
      );
      return;
    }
    this.#repository.setWorkItemStatus(aggregateItem.workItemId, 'SUCCEEDED');
    if (verdict === 'BLOCKING') {
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_AGGREGATE_REVIEW_FAILED',
        {
          revision: batch.integratedRevision,
          findings: result.slice(0, PLAN_LIMITS.repairEvidenceCharacters),
        },
        {
          batchId: batch.batchId,
          workItemId: aggregateItem.workItemId,
          executionId: latest.executionId,
        },
      );
      this.#scheduleBatchIntegrationRepair(
        plan,
        batch,
        items,
        'BATCH_AGGREGATE_REVIEW_FAILED',
        result,
      );
      return;
    }
    this.#repository.promoteBatchIntegration(batch.batchId);
    this.#repository.appendEvent(
      plan.planId,
      'BATCH_AGGREGATE_VERIFIED',
      { revision: batch.integratedRevision },
      {
        batchId: batch.batchId,
        workItemId: aggregateItem.workItemId,
        executionId: latest.executionId,
      },
    );
    this.#repository.appendEvent(
      plan.planId,
      'BATCH_INTEGRATED',
      {
        revision: batch.integratedRevision,
        ref: batch.integrationRef,
        aggregateReviewRequired: true,
        aggregateReviewExecutionId: latest.executionId,
      },
      { batchId: batch.batchId },
    );
  }

  async #reconcilePlan(planId: string): Promise<void> {
    const plan = this.#repository.get(planId);
    if (!plan) return;
    if (plan.status === 'ORCHESTRATING') {
      await this.#reconcileOrchestration(plan);
      return;
    }
    if (!['PENDING', 'RUNNING'].includes(plan.status)) return;
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
        const repairEvidence = {
          reason: result.reason,
          stage: result.stage,
          ...result.evidence,
        };
        const repair = this.#repository.addDeliveryRepairBatch(plan.planId, repairEvidence);
        if (!repair) {
          this.#repository.setDeliveryState(plan.planId, {
            stage: 'BLOCKED',
            evidence: repairEvidence,
            pullRequestUrl: result.pullRequestUrl,
          });
          this.#repository.setPlanStatus(plan.planId, 'BLOCKED', 'DELIVERY_FIX_LIMIT_EXCEEDED');
          this.#repository.appendEvent(plan.planId, 'PLAN_DELIVERY_BLOCKED', {
            ...repairEvidence,
            repairReason: result.reason,
            reason: 'DELIVERY_FIX_LIMIT_EXCEEDED',
          });
        } else {
          this.#repository.setDeliveryState(plan.planId, {
            stage: 'PENDING',
            evidence: repairEvidence,
            pullRequestUrl: result.pullRequestUrl,
          });
          this.#repository.appendEvent(plan.planId, 'PLAN_DELIVERY_REPAIR_SCHEDULED', {
            batchId: repair.batchId,
            ...repairEvidence,
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
      if (isBatchAggregateReviewItem(item) || item.status === 'SUCCEEDED') continue;
      try {
        await this.#reconcileWorkItem(plan, currentBatch, item);
      } catch (error) {
        const code = error instanceof Error ? (error.message.split(':', 1)[0] ?? '') : '';
        if (!code.includes('CONCURRENCY') && !code.includes('LEASE_CONFLICT')) throw error;
      }
    }
    const refreshed = this.#repository.workItems(batch.batchId);
    const implementationItems = refreshed.filter((item) => !isBatchAggregateReviewItem(item));
    if (!implementationItems.every((item) => item.status === 'SUCCEEDED')) return;

    const afterWork = this.#repository
      .batches(plan.planId)
      .find((item) => item.batchId === batch.batchId)!;
    if (!afterWork.integratedRevision || !afterWork.integrationRef) {
      await this.#integrateBatch(plan, afterWork, refreshed);
      return;
    }

    const originalItems = refreshed.filter(
      (item) => !isIntegrationRepairItem(item) && !isBatchAggregateReviewItem(item),
    );
    if (originalItems.length > 1) {
      await this.#reconcileBatchAggregateReview(plan, afterWork, refreshed);
    }
  }

  async #recoverBlockedPlan(
    planId: string,
    recoveryMode: PlanRecoveryMode = 'AUTO',
  ): Promise<void> {
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
      await this.#launchPlanPhase(
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
