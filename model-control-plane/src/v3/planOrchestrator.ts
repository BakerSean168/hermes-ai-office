import { ExecutionLinkRepository } from './correlation.js';
import type { PlanDeliveryPort } from './delivery.js';
import type { GitHubGovernanceStatusPort } from './githubGovernanceStatus.js';
import type { GitHubPullRequestRepairPublisherPort } from './githubPrRepairPublisher.js';
import {
  PlanRepository,
  type CreatePlanInput,
  type DelegatePlanInput,
} from './plans.js';
import { PLAN_LIMITS } from './planConstants.js';
import {
  isBatchAggregateReviewItem,
  isIntegrationRepairItem,
  type PlanRecoveryMode,
} from './plan/kinds.js';
import { BatchCoordinator } from './plan/batchCoordinator.js';
import { ExternalProgressReconciler } from './plan/externalProgress.js';
import { GovernanceCoordinator } from './plan/governanceCoordinator.js';
import { parseOrchestrationProposal } from './plan/protocol.js';
import { PlanRecoveryCoordinator } from './plan/recoveryCoordinator.js';
import { PLAN_TERMINAL_EXECUTION_STATUSES, type PlanExecutionPort } from './plan/runtime.js';
import { WorkItemCoordinator } from './plan/workItemCoordinator.js';
import type {
  DevelopmentExecutionSnapshot,
  ExecutionLinkRecord,
  ExecutionSelection,
} from './types.js';
import type { WorkspaceProvisioningPort } from './workspace.js';

export type { PlanRecoveryMode } from './plan/kinds.js';

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
  readonly #externalProgress: ExternalProgressReconciler;
  readonly #workItems: WorkItemCoordinator;
  readonly #batches: BatchCoordinator;
  readonly #recovery: PlanRecoveryCoordinator;
  readonly #governance: GovernanceCoordinator;
  readonly #planReconcileTails = new Map<string, Promise<void>>();

  constructor(options: {
    repository: PlanRepository;
    links: ExecutionLinkRepository;
    workspace: WorkspaceProvisioningPort;
    delivery?: PlanDeliveryPort;
    pullRequestRepairPublisher?: GitHubPullRequestRepairPublisherPort;
    governanceStatus?: GitHubGovernanceStatusPort;
    executions: PlanExecutionPort;
  }) {
    this.#repository = options.repository;
    this.#links = options.links;
    this.#workspace = options.workspace;
    this.#delivery = options.delivery;
    this.#executions = options.executions;
    this.#externalProgress = new ExternalProgressReconciler({
      repository: this.#repository,
      workspace: this.#workspace,
      executions: this.#executions,
    });
    this.#workItems = new WorkItemCoordinator({
      repository: this.#repository,
      links: this.#links,
      executions: this.#executions,
      workspace: this.#workspace,
      pullRequestRepairPublisher: options.pullRequestRepairPublisher,
    });
    this.#batches = new BatchCoordinator({
      repository: this.#repository,
      links: this.#links,
      workspace: this.#workspace,
      executions: this.#executions,
      workItems: this.#workItems,
    });
    this.#recovery = new PlanRecoveryCoordinator({
      repository: this.#repository,
      links: this.#links,
      workItems: this.#workItems,
      externalProgress: this.#externalProgress,
    });
    this.#governance = new GovernanceCoordinator({
      repository: this.#repository,
      status: options.governanceStatus,
    });
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

  async #getPlanSummary(planId: string) {
    const plan = this.#repository.get(planId);
    if (!plan) return null;
    const batches = [];
    for (const batch of this.#repository.batches(planId)) {
      const workItems = [];
      for (const item of this.#repository.workItems(batch.batchId)) {
        const executionId = this.#repository.executionIds(item.workItemId).at(-1);
        const record = executionId ? this.#links.get(executionId) : null;
        workItems.push({
          ...item,
          executions: record ? [durableSnapshot(record)] : [],
        });
      }
      batches.push({ ...batch, workItems });
    }
    return { ...plan, batches };
  }

  async listPlans(limit: number = PLAN_LIMITS.listResults, summaryOnly = false) {
    const items = [];
    for (const plan of this.#repository.list(limit)) {
      const projection = summaryOnly
        ? await this.#getPlanSummary(plan.planId)
        : await this.getPlan(plan.planId, false);
      if (projection) items.push(projection);
    }
    return items;
  }

  async cancelPlan(planId: string) {
    return this.#enqueuePlanOperation(planId, async () => {
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
    });
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
        mergeRevision: 'mergeRevision' in result ? result.mergeRevision : undefined,
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
        await this.#workItems.reconcile(plan, currentBatch, item);
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
      await this.#batches.integrate(plan, afterWork, refreshed);
      return;
    }

    const originalItems = refreshed.filter(
      (item) => !isIntegrationRepairItem(item) && !isBatchAggregateReviewItem(item),
    );
    if (originalItems.length > 1) {
      await this.#batches.reconcileAggregateReview(plan, afterWork, refreshed);
    }
  }

  #enqueuePlanOperation<T>(planId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#planReconcileTails.get(planId) ?? Promise.resolve();
    const current = predecessor.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#planReconcileTails.set(planId, tail);
    const cleanup = () => {
      if (this.#planReconcileTails.get(planId) === tail) this.#planReconcileTails.delete(planId);
    };
    void tail.then(cleanup, cleanup);
    return current;
  }

  #enqueuePlanReconciliation(
    planId: string,
    recoverBlocked: boolean,
    recoveryMode: PlanRecoveryMode = 'AUTO',
  ): Promise<void> {
    return this.#enqueuePlanOperation(planId, async () => {
      if (recoverBlocked) await this.#recovery.recover(planId, recoveryMode);
      await this.#reconcilePlan(planId);
      await this.#governance.reconcile(planId);
    });
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
