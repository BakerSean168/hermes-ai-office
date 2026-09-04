import { createHash } from 'node:crypto';

import { isDeliveryComplete } from '../domain/delivery.js';
import { V4Error } from '../domain/errors.js';
import type { Execution, ExecutionPhase } from '../domain/execution.js';
import {
  createExecutionResourceSelection,
  type ExecutableProfile,
  type ExecutionResourceSelection,
  type ResourceTransport,
} from '../domain/resourceRouting.js';
import type { Plan } from '../domain/plan.js';
import type { Review } from '../domain/review.js';
import type { WorkItem } from '../domain/workGraph.js';
import type { V4Repositories } from '../persistence/repositories.js';
import type { ExecutionWorkerResult } from './executionWorker.js';
import type { DeliveryAutomationPort, WorkspaceProviderPort } from './contracts.js';
import { selectWorkItemWave } from './workItemWaves.js';
import type {
  ResourceSelectionExclusion,
  ResourceSelectionPolicy,
  ResourceSelectionRequest,
  ResourceSelectionResult,
} from './resourceSelector.js';

export interface ExecutionRunnerPort {
  runExecution(executionId: string): Promise<ExecutionWorkerResult>;
}

export interface PlanResourceSelectionPolicy {
  includeProviderNativeProfiles?: boolean;
  allowedPolicyKeys?: string[];
  allowedResourceIds?: string[];
  disallowedResourceIds?: string[];
  allowedTransports?: ResourceTransport[];
}

export interface PlanAutomationPolicy {
  /** Compatibility-only routes for executions created before resource routing. */
  implementationRoutes?: string[];
  reviewRoutes?: string[];
  resourceSelection?: PlanResourceSelectionPolicy;
  maxImplementationAttempts?: number;
  maxReviewAttempts?: number;
  maxInfrastructureAttempts?: number;
  maxRepairCycles?: number;
  maxParallelWorkItems?: number;
  requireDelivery?: boolean;
}

export interface PlanResourceSelectorPort {
  select(request: ResourceSelectionRequest): ResourceSelectionResult;
}

export interface PlanAutomationPolicyResolver {
  resolve(projectKey: string): PlanAutomationPolicy | undefined;
}

export interface PlanAutomationResult {
  planId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'RUNNING' | 'WAITING' | 'SKIPPED';
  code: string;
  workItemId?: string;
  executionId?: string;
  reviewId?: string;
  childPlanId?: string;
  revision?: string;
}

interface NormalizedPolicy {
  implementationRoutes: string[];
  reviewRoutes: string[];
  resourceSelection: PlanResourceSelectionPolicy;
  maxImplementationAttempts: number;
  maxReviewAttempts: number;
  maxInfrastructureAttempts: number;
  maxRepairCycles: number;
  maxParallelWorkItems: number;
  requireDelivery: boolean;
}

function normalizePolicy(
  policy: PlanAutomationPolicy,
  resourceSelectionEnabled = false,
): NormalizedPolicy {
  const implementationRoutes = [
    ...new Set((policy.implementationRoutes ?? []).map((item) => item.trim()).filter(Boolean)),
  ];
  const reviewRoutes = [
    ...new Set((policy.reviewRoutes ?? []).map((item) => item.trim()).filter(Boolean)),
  ];
  if (!resourceSelectionEnabled && implementationRoutes.length === 0)
    throw new V4Error('IMPLEMENTATION_ROUTE_REQUIRED');
  if (!resourceSelectionEnabled && reviewRoutes.length === 0)
    throw new V4Error('REVIEW_ROUTE_REQUIRED');
  const maxImplementationAttempts =
    policy.maxImplementationAttempts ?? Math.max(implementationRoutes.length, 3);
  const maxReviewAttempts = policy.maxReviewAttempts ?? Math.max(reviewRoutes.length, 2);
  const maxInfrastructureAttempts = policy.maxInfrastructureAttempts ?? 8;
  const maxRepairCycles = policy.maxRepairCycles ?? 3;
  const maxParallelWorkItems = policy.maxParallelWorkItems ?? 1;
  const requireDelivery = policy.requireDelivery ?? false;
  for (const [name, value] of Object.entries({
    maxImplementationAttempts,
    maxReviewAttempts,
    maxInfrastructureAttempts,
    maxRepairCycles,
    maxParallelWorkItems,
  })) {
    if (!Number.isInteger(value) || value < 1 || value > 20)
      throw new V4Error('PLAN_AUTOMATION_LIMIT_INVALID', name);
  }
  return {
    implementationRoutes,
    reviewRoutes,
    resourceSelection: policy.resourceSelection ?? {},
    maxImplementationAttempts,
    maxReviewAttempts,
    maxInfrastructureAttempts,
    maxRepairCycles,
    maxParallelWorkItems,
    requireDelivery,
  };
}

function stableId(prefix: string, ...parts: Array<string | number | undefined>): string {
  const digest = createHash('sha256')
    .update(parts.map((item) => String(item ?? '')).join('\0'))
    .digest('hex')
    .slice(0, 24);
  return prefix + '_' + digest;
}

function latest<T extends { createdAt: string }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
}

const FINALIZATION_RECOVERY_CODES = new Set([
  'WORKSPACE_DIRTY',
  'WORKSPACE_EVIDENCE_INVALID',
  'WORKSPACE_IMPLEMENTATION_EVIDENCE_MISMATCH',
]);
const REVIEW_RECOVERY_EVIDENCE_NAME = 'operator-review-recovery';

function routeUnavailableFailure(execution: Execution): boolean {
  const detail = execution.errorCode ?? '';
  return /(?:authentication|invalid api key|unauthorized|forbidden|http[_ ]?(?:401|403)|\b401\b|\b403\b|no deployments available|deployment unavailable)/i.test(
    detail,
  );
}

export class StaticPlanAutomationPolicyResolver implements PlanAutomationPolicyResolver {
  readonly overrides: ReadonlyMap<string, PlanAutomationPolicy>;
  readonly allowedProjectKeys?: ReadonlySet<string>;

  constructor(
    readonly defaultPolicy: PlanAutomationPolicy,
    overrides: Record<string, PlanAutomationPolicy> = {},
    allowedProjectKeys?: Iterable<string>,
  ) {
    this.overrides = new Map(Object.entries(overrides));
    const allowed = [...(allowedProjectKeys ?? [])].map((item) => item.trim()).filter(Boolean);
    this.allowedProjectKeys = allowed.length > 0 ? new Set(allowed) : undefined;
  }

  resolve(projectKey: string): PlanAutomationPolicy | undefined {
    if (this.allowedProjectKeys && !this.allowedProjectKeys.has(projectKey)) return undefined;
    return this.overrides.get(projectKey) ?? this.defaultPolicy;
  }
}

export class PlanAutomationRuntime {
  constructor(
    readonly repositories: V4Repositories,
    readonly runner: ExecutionRunnerPort,
    readonly workspace: WorkspaceProviderPort,
    readonly policies: PlanAutomationPolicyResolver,
    readonly delivery?: DeliveryAutomationPort,
    readonly resourceSelector?: PlanResourceSelectorPort,
  ) {}

  private resourceSelectionPolicy(policy: NormalizedPolicy): ResourceSelectionPolicy {
    const selection = policy.resourceSelection;
    return {
      allowProviderNative: true,
      ...(selection.allowedResourceIds ? { allowedResourceIds: selection.allowedResourceIds } : {}),
      ...(selection.disallowedResourceIds
        ? { disallowedResourceIds: selection.disallowedResourceIds }
        : {}),
      ...(selection.allowedPolicyKeys ? { allowedPolicyKeys: selection.allowedPolicyKeys } : {}),
      ...(selection.allowedTransports ? { allowedTransports: selection.allowedTransports } : {}),
    };
  }

  private selectionExclusions(executions: readonly Execution[]): ResourceSelectionExclusion[] {
    return executions.flatMap((execution) => {
      const selection = this.repositories.resourceSelections.get(execution.identity.executionId);
      return selection
        ? [
            {
              resourceId: selection.resourceId,
              ...(selection.bindingId ? { bindingId: selection.bindingId } : {}),
              modelFamily: selection.modelFamily,
            },
          ]
        : [];
    });
  }

  private resourceRetryAllowed(execution: Execution): boolean {
    const selection = this.repositories.resourceSelections.get(execution.identity.executionId);
    if (!selection) return false;
    const override = this.repositories.resourceStateOverrides.get(selection.resourceId);
    return Boolean(override && override.state !== 'ACTIVE');
  }

  private chargesProductAttempt(execution: Execution): boolean {
    if (execution.status === 'SUCCEEDED') return true;
    if (execution.retryable === true) return false;
    if (routeUnavailableFailure(execution) || this.resourceRetryAllowed(execution)) return false;
    const code = execution.errorCode ?? '';
    if (
      /^(?:OPENHANDS|PROVIDER|LLM|ANTIGRAVITY|CODEX|CLAUDE|DSH|ZCODE|RESOURCE_)/.test(code) ||
      /^(?:WORKSPACE_STORAGE_|WORKSPACE_CAPACITY_|WORKSPACE_EVIDENCE_|WORKSPACE_REVIEW_|WORKSPACE_IMPLEMENTATION_NOOP)/.test(
        code,
      )
    )
      return false;
    return execution.status !== 'CANCELLED';
  }

  private implementationAttemptUsage(executions: readonly Execution[]): {
    product: number;
    infrastructure: number;
  } {
    const failed = executions.filter((execution) => execution.status !== 'SUCCEEDED');
    const product = failed.filter((execution) => this.chargesProductAttempt(execution)).length;
    return { product, infrastructure: failed.length - product };
  }

  private reviewAttemptUsage(reviews: readonly Review[]): {
    product: number;
    infrastructure: number;
  } {
    let product = 0;
    let infrastructure = 0;
    for (const review of reviews) {
      if (review.verdict === 'INVALID' || review.status === 'STALE') {
        infrastructure += 1;
        continue;
      }
      if (review.reviewerExecutionId) {
        const reviewer = this.repositories.executions.get(review.reviewerExecutionId);
        if (
          (reviewer.status === 'FAILED' ||
            reviewer.status === 'BLOCKED' ||
            reviewer.status === 'CANCELLED') &&
          !this.chargesProductAttempt(reviewer)
        ) {
          infrastructure += 1;
          continue;
        }
      }
      if (review.status === 'CANCELLED' && !review.verdict) infrastructure += 1;
      else product += 1;
    }
    return { product, infrastructure };
  }

  private resourceRoute(profile: ExecutableProfile): string {
    return ['resource', profile.resourceId, profile.bindingId ?? profile.modelFamily]
      .join(':')
      .slice(0, 500);
  }

  private ensurePlanRunning(plan: Plan): Plan {
    if (plan.status !== 'WAITING_FOR_RESOURCE') return plan;
    const resumed = this.repositories.plans.compareAndSetStatus(
      plan.planId,
      'WAITING_FOR_RESOURCE',
      'RUNNING',
    );
    if (!resumed.value || resumed.status === 'rejected')
      throw new V4Error(resumed.reason ?? 'STALE_PLAN_STATUS');
    return resumed.value;
  }

  private createSelectedExecution(
    input: {
      plan: Plan;
      item: WorkItem;
      phase: ExecutionPhase;
      parentExecutionId?: string;
      attempt: number;
      sourceRevision: string;
      objective: string;
    },
    policy: NormalizedPolicy,
    legacyRoute: string,
    priorExecutions: readonly Execution[] = [],
    reuseSelection?: ExecutionResourceSelection,
  ): Execution {
    if (!this.resourceSelector) {
      return this.createExecution({ ...input, route: legacyRoute });
    }

    let profile: ExecutableProfile;
    if (reuseSelection) {
      profile = {
        capability: reuseSelection.capability,
        phase: input.phase,
        modelFamily: reuseSelection.modelFamily,
        agentBackend: reuseSelection.agentBackend,
        transport: reuseSelection.transport,
        resourceId: reuseSelection.resourceId,
        resourceTier: reuseSelection.resourceTier,
        modelRank: reuseSelection.modelRank,
        resourceSequence: reuseSelection.resourceSequence,
        resourceState: reuseSelection.resourceState,
        selectionReason: reuseSelection.selectionReason,
        ...(reuseSelection.bindingId ? { bindingId: reuseSelection.bindingId } : {}),
        ...(reuseSelection.deploymentId ? { deploymentId: reuseSelection.deploymentId } : {}),
        ...(reuseSelection.routeModel ? { routeModel: reuseSelection.routeModel } : {}),
        ...(reuseSelection.protocol ? { protocol: reuseSelection.protocol } : {}),
      };
    } else {
      const selected = this.resourceSelector.select({
        phase: input.phase,
        includeProviderNativeProfiles:
          policy.resourceSelection.includeProviderNativeProfiles === true,
        policy: this.resourceSelectionPolicy(policy),
        priorAttempts: this.selectionExclusions(priorExecutions),
      });
      if (selected.status !== 'SELECTED') throw new V4Error('NO_ELIGIBLE_RESOURCE');
      profile = selected.profile;
    }

    const runningPlan = this.ensurePlanRunning(input.plan);
    const execution = this.createExecution({
      ...input,
      plan: runningPlan,
      route: this.resourceRoute(profile),
    });
    const selection = createExecutionResourceSelection(
      execution.identity.executionId,
      profile,
      execution.createdAt,
    );
    this.repositories.resourceSelections.create(selection);
    return execution;
  }

  async runOnce(limit = 20): Promise<PlanAutomationResult[]> {
    const plans = [
      ...this.repositories.plans.listPlans({ status: 'READY', limit }),
      ...this.repositories.plans.listPlans({ status: 'RUNNING', limit }),
      ...this.repositories.plans.listPlans({ status: 'WAITING_FOR_RESOURCE', limit }),
      ...this.repositories.plans
        .listPlans({ status: 'SUCCEEDED', limit: 1000 })
        .filter((plan) => plan.delivery && !isDeliveryComplete(plan.delivery))
        .slice(0, limit),
    ];
    const unique = new Map(plans.map((plan) => [plan.planId, plan]));
    const results: PlanAutomationResult[] = [];
    for (const plan of unique.values()) {
      try {
        results.push(await this.runPlan(plan.planId));
      } catch (error) {
        results.push({
          planId: plan.planId,
          status: 'WAITING',
          code: error instanceof V4Error ? error.code : 'PLAN_AUTOMATION_CYCLE_FAILED',
        });
      }
    }
    return results;
  }

  async runPlan(planId: string): Promise<PlanAutomationResult> {
    try {
      return await this.runPlanInternal(planId);
    } catch (error) {
      if (!(error instanceof V4Error) || error.code !== 'NO_ELIGIBLE_RESOURCE') throw error;
      const plan = this.repositories.plans.getPlan(planId);
      if (plan.status === 'READY' || plan.status === 'RUNNING')
        this.repositories.plans.updateStatus(planId, 'WAITING_FOR_RESOURCE');
      return { planId, status: 'WAITING', code: 'WAITING_FOR_RESOURCE' };
    }
  }

  private async runPlanInternal(planId: string): Promise<PlanAutomationResult> {
    let plan = this.repositories.plans.getPlan(planId);
    const legacyDeliveryPending =
      plan.status === 'SUCCEEDED' && plan.delivery && !isDeliveryComplete(plan.delivery);
    if (
      plan.status !== 'READY' &&
      plan.status !== 'RUNNING' &&
      plan.status !== 'WAITING_FOR_RESOURCE' &&
      !legacyDeliveryPending
    ) {
      return { planId, status: 'SKIPPED', code: 'PLAN_NOT_AUTOMATABLE' };
    }
    const rawPolicy = this.policies.resolve(plan.projectKey);
    if (!rawPolicy) return { planId, status: 'WAITING', code: 'PLAN_POLICY_UNAVAILABLE' };
    const policy = normalizePolicy(rawPolicy, Boolean(this.resourceSelector));
    if (plan.status === 'READY') {
      const started = this.repositories.plans.compareAndSetStatus(planId, 'READY', 'RUNNING');
      if (started.status === 'rejected')
        return { planId, status: 'SKIPPED', code: started.reason ?? 'STALE_PLAN_STATUS' };
      plan = this.repositories.plans.getPlan(planId);
    }

    const active = this.repositories.executions
      .listByPlan(planId)
      .filter((execution) => execution.status === 'QUEUED' || execution.status === 'RUNNING');
    if (plan.status === 'WAITING_FOR_RESOURCE' && active.length > 0) {
      this.repositories.plans.updateStatus(planId, 'RUNNING');
      plan = this.repositories.plans.getPlan(planId);
    }
    for (const execution of active) {
      const result = await this.runner.runExecution(execution.identity.executionId);
      const durable = this.repositories.executions.get(execution.identity.executionId);
      const stillActive = durable.status === 'QUEUED' || durable.status === 'RUNNING';
      if (stillActive && (result.status === 'FAILED' || result.status === 'WAITING')) {
        return {
          planId,
          workItemId: durable.identity.workItemId,
          executionId: durable.identity.executionId,
          status: 'WAITING',
          code: result.code,
        };
      }
    }

    plan = this.repositories.plans.getPlan(planId);
    const graph = this.repositories.plans.getActiveGraphVersion(planId);
    if (!graph) return this.failPlan(plan, undefined, 'PLAN_GRAPH_MISSING');
    const items = this.repositories.plans.listWorkItems(planId, graph.graphVersionId);
    if (items.length === 0) return this.failPlan(plan, undefined, 'PLAN_GRAPH_EMPTY');
    if (items.every((item) => item.status === 'SUCCEEDED')) {
      return await this.completePlan(plan, policy);
    }

    const runningItems = items.filter((item) => item.status === 'RUNNING');
    if (runningItems.length > 0)
      return await this.reconcileRunningItem(plan, runningItems[0]!, policy);
    const failed = items.find((item) => item.status === 'FAILED' || item.status === 'BLOCKED');
    if (failed) return this.failPlan(plan, failed, 'WORK_ITEM_TERMINAL_FAILURE');

    const wave = selectWorkItemWave(items, plan.currentRevision, policy.maxParallelWorkItems);
    if (!wave) return this.failPlan(plan, undefined, 'WORK_GRAPH_DEADLOCK');
    const created: Execution[] = [];
    for (const candidate of wave.items) {
      const assigned = this.repositories.plans.assignWorkItemWave(
        candidate.workItemId,
        wave.wave,
        wave.baseRevision,
      );
      if (!assigned.value || assigned.status === 'rejected')
        throw new V4Error(assigned.reason ?? 'WORK_ITEM_WAVE_ASSIGNMENT_FAILED');
      const item = assigned.value;
      if (item.status !== 'RUNNING')
        this.repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
      created.push(
        this.createInitialExecution(
          plan,
          this.repositories.plans.getWorkItem(item.workItemId),
          policy,
        ),
      );
    }
    const first = created[0]!;
    return {
      planId,
      workItemId: first.identity.workItemId,
      executionId: first.identity.executionId,
      status: 'RUNNING',
      code: created.length > 1 ? 'IMPLEMENTATION_WAVE_QUEUED' : 'IMPLEMENTATION_QUEUED',
    };
  }

  async reconcilePlan(planId: string, mode = 'auto'): Promise<PlanAutomationResult> {
    if (mode === 'retry-review' || mode === 'retry_review')
      return this.reconcileFailedReview(planId);
    if (mode === 'retry-delivery' || mode === 'retry_delivery') return await this.runPlan(planId);
    if (mode !== 'auto') throw new V4Error('PLAN_RECONCILE_MODE_INVALID');
    let plan = this.repositories.plans.getPlan(planId);
    if (
      plan.status === 'READY' ||
      plan.status === 'RUNNING' ||
      (plan.status === 'SUCCEEDED' && plan.delivery && !isDeliveryComplete(plan.delivery))
    )
      return await this.runPlan(planId);
    if (plan.status !== 'FAILED')
      return { planId, status: 'SKIPPED', code: 'PLAN_NOT_RECOVERABLE' };

    const rawPolicy = this.policies.resolve(plan.projectKey);
    if (!rawPolicy) return { planId, status: 'WAITING', code: 'PLAN_POLICY_UNAVAILABLE' };
    const policy = normalizePolicy(rawPolicy, Boolean(this.resourceSelector));
    const graph = this.repositories.plans.getActiveGraphVersion(planId);
    if (!graph) throw new V4Error('PLAN_GRAPH_MISSING');
    const items = this.repositories.plans.listWorkItems(planId, graph.graphVersionId);
    const failedItems = items.filter(
      (item) => item.status === 'FAILED' || item.status === 'BLOCKED',
    );
    if (failedItems.length !== 1) throw new V4Error('PLAN_RECOVERY_WORK_ITEM_AMBIGUOUS');
    const item = failedItems[0]!;
    const executions = this.repositories.executions.listByPlan(planId);
    const active = executions.find(
      (execution) => execution.status === 'QUEUED' || execution.status === 'RUNNING',
    );
    if (active) {
      if (active.identity.workItemId !== item.workItemId)
        throw new V4Error('PLAN_RECOVERY_ACTIVE_EXECUTION_CONFLICT');
      this.reviveFailedPlan(plan, item);
      return {
        planId,
        workItemId: item.workItemId,
        executionId: active.identity.executionId,
        status: 'RUNNING',
        code: 'RECOVERY_EXECUTION_ACTIVE',
      };
    }

    const workItemReviews = this.repositories.reviews.listByWorkItem(item.workItemId);
    const latestReview = latest(workItemReviews);
    if (latestReview?.status === 'PASSED') {
      const reviewedCandidate = executions.find(
        (execution) => execution.identity.executionId === latestReview.implementationExecutionId,
      );
      if (
        !reviewedCandidate ||
        reviewedCandidate.status !== 'SUCCEEDED' ||
        !reviewedCandidate.resultRevision ||
        reviewedCandidate.resultRevision !== latestReview.reviewedSha
      ) {
        throw new V4Error('PLAN_REVIEWED_CANDIDATE_INVALID');
      }
      this.reviveFailedPlan(plan, item);
      const revivedPlan = this.repositories.plans.getPlan(planId);
      const revivedItem = this.repositories.plans.getWorkItem(item.workItemId);
      return await this.acceptReviewedCandidate(
        revivedPlan,
        revivedItem,
        reviewedCandidate,
        latestReview,
      );
    }

    const candidates = executions.filter(
      (execution) =>
        execution.identity.workItemId === item.workItemId &&
        (execution.identity.phase === 'IMPLEMENT' || execution.identity.phase === 'IMPLEMENT_FIX'),
    );
    const candidate = latest(candidates);
    if (!candidate) throw new V4Error('PLAN_RECOVERY_EXECUTION_MISSING');
    if (
      candidate.status !== 'FAILED' &&
      candidate.status !== 'BLOCKED' &&
      candidate.status !== 'CANCELLED'
    )
      throw new V4Error('PLAN_RECOVERY_EXECUTION_INVALID');
    const finalizationRecovery = Boolean(
      candidate.errorCode && FINALIZATION_RECOVERY_CODES.has(candidate.errorCode),
    );
    if (
      !candidate.retryable &&
      !finalizationRecovery &&
      !routeUnavailableFailure(candidate) &&
      !this.resourceRetryAllowed(candidate)
    )
      return {
        planId,
        workItemId: item.workItemId,
        executionId: candidate.identity.executionId,
        status: 'FAILED',
        code: 'IMPLEMENTATION_NOT_RETRYABLE',
      };

    let parentExecutionId: string;
    let sourceRevision: string;
    let attempts: number;
    if (candidate.identity.phase === 'IMPLEMENT') {
      const implementationAttempts = candidates.filter(
        (execution) => execution.identity.phase === 'IMPLEMENT',
      );
      attempts = implementationAttempts.length;
      const usage = this.implementationAttemptUsage(implementationAttempts);
      if (usage.product >= policy.maxImplementationAttempts)
        return {
          planId,
          workItemId: item.workItemId,
          executionId: candidate.identity.executionId,
          status: 'FAILED',
          code: 'IMPLEMENTATION_ATTEMPTS_EXHAUSTED',
        };
      if (usage.infrastructure >= policy.maxInfrastructureAttempts)
        return {
          planId,
          workItemId: item.workItemId,
          executionId: candidate.identity.executionId,
          status: 'FAILED',
          code: 'IMPLEMENTATION_INFRASTRUCTURE_ATTEMPTS_EXHAUSTED',
        };
      parentExecutionId = candidate.identity.executionId;
      if (!candidate.identity.sourceRevision)
        throw new V4Error('EXECUTION_SOURCE_REVISION_REQUIRED');
      sourceRevision = candidate.identity.sourceRevision;
    } else {
      const repairRoot = candidate.identity.parentExecutionId
        ? this.repositories.executions.get(candidate.identity.parentExecutionId)
        : undefined;
      if (!repairRoot?.resultRevision) throw new V4Error('REPAIR_PARENT_INVALID');
      const repairAttempts = candidates.filter(
        (execution) =>
          execution.identity.phase === 'IMPLEMENT_FIX' &&
          execution.identity.parentExecutionId === repairRoot.identity.executionId,
      );
      attempts = repairAttempts.length;
      const usage = this.implementationAttemptUsage(repairAttempts);
      if (usage.product >= policy.maxImplementationAttempts)
        return {
          planId,
          workItemId: item.workItemId,
          executionId: candidate.identity.executionId,
          status: 'FAILED',
          code: 'REPAIR_ATTEMPTS_EXHAUSTED',
        };
      if (usage.infrastructure >= policy.maxInfrastructureAttempts)
        return {
          planId,
          workItemId: item.workItemId,
          executionId: candidate.identity.executionId,
          status: 'FAILED',
          code: 'REPAIR_INFRASTRUCTURE_ATTEMPTS_EXHAUSTED',
        };
      parentExecutionId = repairRoot.identity.executionId;
      sourceRevision = repairRoot.resultRevision;
    }

    const legacyRoute = finalizationRecovery
      ? candidate.identity.route
      : (policy.implementationRoutes[
          Math.min(attempts, Math.max(0, policy.implementationRoutes.length - 1))
        ] ?? 'implementation');
    let recovery: Execution;
    try {
      recovery = this.createSelectedExecution(
        {
          plan,
          item,
          phase: candidate.identity.phase,
          parentExecutionId,
          attempt: candidate.identity.attempt + 1,
          sourceRevision,
          objective:
            candidate.identity.phase === 'IMPLEMENT' ? item.objective : candidate.objective,
        },
        policy,
        legacyRoute,
        candidates,
        finalizationRecovery
          ? this.repositories.resourceSelections.get(candidate.identity.executionId)
          : undefined,
      );
    } catch (error) {
      if (error instanceof V4Error && error.code === 'NO_ELIGIBLE_RESOURCE')
        return {
          planId,
          workItemId: item.workItemId,
          executionId: candidate.identity.executionId,
          status: 'WAITING',
          code: 'WAITING_FOR_RESOURCE',
        };
      throw error;
    }
    this.reviveFailedPlan(plan, item);
    plan = this.repositories.plans.getPlan(planId);
    return {
      planId,
      workItemId: item.workItemId,
      executionId: recovery.identity.executionId,
      status: 'RUNNING',
      code: finalizationRecovery
        ? 'FINALIZATION_RECOVERY_QUEUED'
        : 'IMPLEMENTATION_RECOVERY_QUEUED',
      revision: plan.currentRevision,
    };
  }

  private reconcileFailedReview(planId: string): PlanAutomationResult {
    const plan = this.repositories.plans.getPlan(planId);
    if (plan.status !== 'FAILED')
      return { planId, status: 'SKIPPED', code: 'PLAN_NOT_RECOVERABLE' };
    const rawPolicy = this.policies.resolve(plan.projectKey);
    if (!rawPolicy) return { planId, status: 'WAITING', code: 'PLAN_POLICY_UNAVAILABLE' };
    const policy = normalizePolicy(rawPolicy, Boolean(this.resourceSelector));
    const graph = this.repositories.plans.getActiveGraphVersion(planId);
    if (!graph) throw new V4Error('PLAN_GRAPH_MISSING');
    const failedItems = this.repositories.plans
      .listWorkItems(planId, graph.graphVersionId)
      .filter((item) => item.status === 'FAILED' || item.status === 'BLOCKED');
    if (failedItems.length !== 1) throw new V4Error('PLAN_RECOVERY_WORK_ITEM_AMBIGUOUS');
    const item = failedItems[0]!;
    const executions = this.repositories.executions.listByWorkItem(item.workItemId);
    if (
      executions.some(
        (execution) => execution.status === 'QUEUED' || execution.status === 'RUNNING',
      )
    )
      throw new V4Error('PLAN_RECOVERY_ACTIVE_EXECUTION_CONFLICT');
    const candidate = latest(
      executions.filter(
        (execution) =>
          (execution.identity.phase === 'IMPLEMENT' ||
            execution.identity.phase === 'IMPLEMENT_FIX') &&
          execution.status === 'SUCCEEDED' &&
          Boolean(execution.resultRevision),
      ),
    );
    if (!candidate?.resultRevision) throw new V4Error('PLAN_REVIEW_RECOVERY_CANDIDATE_MISSING');
    const reviews = this.repositories.reviews
      .listByWorkItem(item.workItemId)
      .filter((review) => review.implementationExecutionId === candidate.identity.executionId);
    const prior = latest(reviews);
    if (
      !prior ||
      (prior.status !== 'FAILED' && prior.status !== 'STALE' && prior.status !== 'CANCELLED')
    )
      throw new V4Error('PLAN_REVIEW_RECOVERY_NOT_REQUIRED');

    const existing = this.repositories.evidence.find(
      candidate.identity.executionId,
      'RECOVERY',
      REVIEW_RECOVERY_EVIDENCE_NAME,
    );
    const attemptValue = existing?.payload.attempt;
    const attempt = existing ? Number(attemptValue) : reviews.length + 1;
    if (!Number.isInteger(attempt) || attempt < 1)
      throw new V4Error('PLAN_REVIEW_RECOVERY_EVIDENCE_INVALID');
    const reviewId = stableId(
      'review',
      candidate.identity.executionId,
      candidate.resultRevision,
      attempt,
    );
    if (existing) {
      if (
        existing.payload.reviewId !== reviewId ||
        existing.payload.resultRevision !== candidate.resultRevision
      )
        throw new V4Error('PLAN_REVIEW_RECOVERY_EVIDENCE_INVALID');
    } else {
      this.repositories.evidence.append({
        executionId: candidate.identity.executionId,
        kind: 'RECOVERY',
        name: REVIEW_RECOVERY_EVIDENCE_NAME,
        sourceRevision: candidate.resultRevision,
        payload: {
          attempt,
          reviewId,
          resultRevision: candidate.resultRevision,
          priorReviewId: prior.reviewId,
          reason: 'independent-review-runtime-recovered',
        },
      });
    }
    const created = this.createReview(candidate, item, policy, attempt);
    if (created.review.reviewId !== reviewId)
      throw new V4Error('PLAN_REVIEW_RECOVERY_EVIDENCE_INVALID');
    this.reviveFailedPlan(plan, item);
    return {
      planId,
      workItemId: item.workItemId,
      executionId: created.execution.identity.executionId,
      reviewId,
      status: 'RUNNING',
      code: 'REVIEW_RECOVERY_QUEUED',
      revision: candidate.resultRevision,
    };
  }

  private reviveFailedPlan(plan: Plan, item: WorkItem): void {
    this.repositories.plans.recoverFailedPlanWorkItem(plan.planId, item.workItemId);
  }

  createInitialExecution(
    plan: Plan,
    workItem: WorkItem,
    rawPolicy?: PlanAutomationPolicy,
  ): Execution {
    const policy = normalizePolicy(
      rawPolicy ?? this.requirePolicy(plan.projectKey),
      Boolean(this.resourceSelector),
    );
    if (
      plan.status !== 'READY' &&
      plan.status !== 'RUNNING' &&
      plan.status !== 'WAITING_FOR_RESOURCE'
    )
      throw new V4Error('PLAN_NOT_AUTOMATABLE');
    if (workItem.planId !== plan.planId) throw new V4Error('EXECUTION_WORK_ITEM_MISMATCH');
    return this.createSelectedExecution(
      {
        plan,
        item: workItem,
        phase: 'IMPLEMENT',
        attempt: 1,
        sourceRevision: workItem.integrationBaseRevision ?? plan.currentRevision,
        objective: workItem.objective,
      },
      policy,
      policy.implementationRoutes[0] ?? 'implementation',
    );
  }

  private async reconcileRunningItem(
    plan: Plan,
    item: WorkItem,
    policy: NormalizedPolicy,
  ): Promise<PlanAutomationResult> {
    const executions = this.repositories.executions.listByWorkItem(item.workItemId);
    const active = executions.find(
      (execution) => execution.status === 'QUEUED' || execution.status === 'RUNNING',
    );
    if (active)
      return {
        planId: plan.planId,
        workItemId: item.workItemId,
        executionId: active.identity.executionId,
        status: 'RUNNING',
        code: 'EXECUTION_ACTIVE',
      };

    const candidates = executions.filter(
      (execution) =>
        execution.identity.phase === 'IMPLEMENT' || execution.identity.phase === 'IMPLEMENT_FIX',
    );
    const newestCandidate = latest(candidates);
    const recoveredCandidate = latest(
      candidates.filter((execution) => {
        if (execution.status !== 'SUCCEEDED' || !execution.resultRevision) return false;
        const evidence = this.repositories.evidence.find(
          execution.identity.executionId,
          'RECOVERY',
          REVIEW_RECOVERY_EVIDENCE_NAME,
        );
        return Boolean(
          evidence && (!newestCandidate || evidence.createdAt >= newestCandidate.createdAt),
        );
      }),
    );
    const candidate = recoveredCandidate ?? newestCandidate;
    if (!candidate) {
      const execution = this.createInitialExecution(plan, item, policy);
      return {
        planId: plan.planId,
        workItemId: item.workItemId,
        executionId: execution.identity.executionId,
        status: 'RUNNING',
        code: 'IMPLEMENTATION_QUEUED',
      };
    }
    if (
      candidate.status === 'FAILED' ||
      candidate.status === 'BLOCKED' ||
      candidate.status === 'CANCELLED'
    ) {
      return this.retryOrFailImplementation(plan, item, candidate, candidates, policy);
    }
    if (candidate.status !== 'SUCCEEDED' || !candidate.resultRevision)
      return this.failPlan(plan, item, 'IMPLEMENTATION_RESULT_INVALID');

    const reviews = this.repositories.reviews
      .listByWorkItem(item.workItemId)
      .filter((review) => review.implementationExecutionId === candidate.identity.executionId);
    const review = latest(reviews);
    if (!review) {
      const created = this.createReview(candidate, item, policy, 1);
      return {
        planId: plan.planId,
        workItemId: item.workItemId,
        executionId: created.execution.identity.executionId,
        reviewId: created.review.reviewId,
        status: 'RUNNING',
        code: 'REVIEW_QUEUED',
      };
    }
    if (review.status === 'PASSED')
      return await this.acceptReviewedCandidate(plan, item, candidate, review);
    if (review.status === 'FAILED')
      return this.createRepairOrFail(plan, item, candidate, review, candidates, policy);
    if (review.status === 'STALE') {
      const attempt = reviews.length + 1;
      const usage = this.reviewAttemptUsage(reviews);
      if (usage.product >= policy.maxReviewAttempts)
        return this.failPlan(plan, item, 'REVIEW_ATTEMPTS_EXHAUSTED');
      if (usage.infrastructure >= policy.maxInfrastructureAttempts)
        return this.failPlan(plan, item, 'REVIEW_INFRASTRUCTURE_ATTEMPTS_EXHAUSTED');
      const created = this.createReview(candidate, item, policy, attempt);
      return {
        planId: plan.planId,
        workItemId: item.workItemId,
        executionId: created.execution.identity.executionId,
        reviewId: created.review.reviewId,
        status: 'RUNNING',
        code: 'REVIEW_INVALID_RETRY_QUEUED',
      };
    }
    if (review.status === 'CANCELLED') return this.failPlan(plan, item, 'REVIEW_INVALID');

    if (!review.reviewerExecutionId) {
      const execution = this.createReviewerExecution(
        candidate,
        item,
        policy,
        reviews.length,
        review,
      );
      return {
        planId: plan.planId,
        workItemId: item.workItemId,
        executionId: execution.identity.executionId,
        reviewId: review.reviewId,
        status: 'RUNNING',
        code: 'REVIEW_EXECUTION_QUEUED',
      };
    }
    const reviewer = this.repositories.executions.get(review.reviewerExecutionId);
    if (
      reviewer.status === 'SUCCEEDED' &&
      (review.status === 'PENDING' || review.status === 'RUNNING')
    ) {
      const repaired = this.recoverReviewVerdict(review, reviewer);
      if (repaired.status === 'PASSED')
        return await this.acceptReviewedCandidate(plan, item, candidate, repaired);
      if (repaired.status === 'FAILED')
        return this.createRepairOrFail(plan, item, candidate, repaired, candidates, policy);
      if (repaired.status === 'STALE') {
        const attempt = reviews.length + 1;
        const usage = this.reviewAttemptUsage(reviews);
        if (usage.product >= policy.maxReviewAttempts)
          return this.failPlan(plan, item, 'REVIEW_ATTEMPTS_EXHAUSTED');
        if (usage.infrastructure >= policy.maxInfrastructureAttempts)
          return this.failPlan(plan, item, 'REVIEW_INFRASTRUCTURE_ATTEMPTS_EXHAUSTED');
        const created = this.createReview(candidate, item, policy, attempt);
        return {
          planId: plan.planId,
          workItemId: item.workItemId,
          executionId: created.execution.identity.executionId,
          reviewId: created.review.reviewId,
          status: 'RUNNING',
          code: 'REVIEW_INVALID_RETRY_QUEUED',
        };
      }
    }
    if (
      reviewer.status === 'FAILED' ||
      reviewer.status === 'BLOCKED' ||
      reviewer.status === 'CANCELLED'
    ) {
      const attempt = reviews.length + 1;
      const usage = this.reviewAttemptUsage(reviews);
      if (usage.product >= policy.maxReviewAttempts)
        return this.failPlan(plan, item, 'REVIEW_ATTEMPTS_EXHAUSTED');
      if (usage.infrastructure >= policy.maxInfrastructureAttempts)
        return this.failPlan(plan, item, 'REVIEW_INFRASTRUCTURE_ATTEMPTS_EXHAUSTED');
      if (review.status === 'PENDING' || review.status === 'RUNNING')
        this.repositories.reviews.updateStatus(review.reviewId, 'CANCELLED');
      const created = this.createReview(candidate, item, policy, attempt);
      return {
        planId: plan.planId,
        workItemId: item.workItemId,
        executionId: created.execution.identity.executionId,
        reviewId: created.review.reviewId,
        status: 'RUNNING',
        code: 'REVIEW_RETRY_QUEUED',
      };
    }
    return {
      planId: plan.planId,
      workItemId: item.workItemId,
      executionId: reviewer.identity.executionId,
      reviewId: review.reviewId,
      status: 'RUNNING',
      code: 'REVIEW_ACTIVE',
    };
  }

  private recoverReviewVerdict(review: Review, reviewer: Execution): Review {
    const evidence = this.repositories.evidence.find(
      reviewer.identity.executionId,
      'REVIEW',
      'review-verdict',
    );
    if (!evidence) throw new V4Error('REVIEW_COMPLETION_EVIDENCE_MISSING');
    const verdict = evidence.payload.verdict;
    const findings = evidence.payload.findings;
    if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'INVALID')
      throw new V4Error('WORKSPACE_REVIEW_VERDICT_INVALID');
    if (
      !Array.isArray(findings) ||
      !findings.every((finding) => typeof finding === 'string' && finding.length <= 8_000)
    )
      throw new V4Error('WORKSPACE_REVIEW_FINDINGS_INVALID');
    if (review.status === 'PENDING')
      this.repositories.reviews.updateStatus(review.reviewId, 'RUNNING');
    const result = this.repositories.reviews.recordVerdict(
      review.reviewId,
      verdict,
      findings as string[],
    );
    if (!result.value) throw new V4Error('REVIEW_VERDICT_PERSIST_FAILED');
    return result.value;
  }

  private retryOrFailImplementation(
    plan: Plan,
    item: WorkItem,
    candidate: Execution,
    candidates: Execution[],
    policy: NormalizedPolicy,
  ): PlanAutomationResult {
    if (
      !candidate.retryable &&
      !routeUnavailableFailure(candidate) &&
      !this.resourceRetryAllowed(candidate)
    )
      return this.failPlan(plan, item, 'IMPLEMENTATION_NOT_RETRYABLE');
    if (candidate.identity.phase === 'IMPLEMENT') {
      const implementationAttempts = candidates.filter(
        (execution) => execution.identity.phase === 'IMPLEMENT',
      );
      const attempts = implementationAttempts.length;
      const usage = this.implementationAttemptUsage(implementationAttempts);
      if (usage.product >= policy.maxImplementationAttempts)
        return this.failPlan(plan, item, 'IMPLEMENTATION_ATTEMPTS_EXHAUSTED');
      if (usage.infrastructure >= policy.maxInfrastructureAttempts)
        return this.failPlan(plan, item, 'IMPLEMENTATION_INFRASTRUCTURE_ATTEMPTS_EXHAUSTED');
      const legacyRoute =
        policy.implementationRoutes[
          Math.min(attempts, Math.max(0, policy.implementationRoutes.length - 1))
        ] ?? 'implementation';
      const execution = this.createSelectedExecution(
        {
          plan,
          item,
          phase: 'IMPLEMENT',
          parentExecutionId: candidate.identity.executionId,
          attempt: candidate.identity.attempt + 1,
          sourceRevision: candidate.identity.sourceRevision!,
          objective: item.objective,
        },
        policy,
        legacyRoute,
        candidates,
      );
      return {
        planId: plan.planId,
        workItemId: item.workItemId,
        executionId: execution.identity.executionId,
        status: 'RUNNING',
        code: 'IMPLEMENTATION_RETRY_QUEUED',
      };
    }
    const repairRoot = candidate.identity.parentExecutionId
      ? this.repositories.executions.get(candidate.identity.parentExecutionId)
      : undefined;
    if (!repairRoot?.resultRevision) return this.failPlan(plan, item, 'REPAIR_PARENT_INVALID');
    const repairExecutions = candidates.filter(
      (execution) =>
        execution.identity.phase === 'IMPLEMENT_FIX' &&
        execution.identity.parentExecutionId === repairRoot.identity.executionId,
    );
    const repairAttempts = repairExecutions.length;
    const repairUsage = this.implementationAttemptUsage(repairExecutions);
    if (repairUsage.product >= policy.maxImplementationAttempts)
      return this.failPlan(plan, item, 'REPAIR_ATTEMPTS_EXHAUSTED');
    if (repairUsage.infrastructure >= policy.maxInfrastructureAttempts)
      return this.failPlan(plan, item, 'REPAIR_INFRASTRUCTURE_ATTEMPTS_EXHAUSTED');
    const legacyRoute =
      policy.implementationRoutes[
        Math.min(repairAttempts, Math.max(0, policy.implementationRoutes.length - 1))
      ] ?? 'implementation';
    const execution = this.createSelectedExecution(
      {
        plan,
        item,
        phase: 'IMPLEMENT_FIX',
        parentExecutionId: repairRoot.identity.executionId,
        attempt: candidate.identity.attempt + 1,
        sourceRevision: repairRoot.resultRevision,
        objective: candidate.objective,
      },
      policy,
      legacyRoute,
      candidates,
    );
    return {
      planId: plan.planId,
      workItemId: item.workItemId,
      executionId: execution.identity.executionId,
      status: 'RUNNING',
      code: 'REPAIR_RETRY_QUEUED',
    };
  }

  private createReview(
    candidate: Execution,
    item: WorkItem,
    policy: NormalizedPolicy,
    attempt: number,
  ): { review: Review; execution: Execution } {
    if (!candidate.resultRevision) throw new V4Error('REVIEW_EXACT_RESULT_REQUIRED');
    const reviewId = stableId(
      'review',
      candidate.identity.executionId,
      candidate.resultRevision,
      attempt,
    );
    const review = this.repositories.reviews.create({
      reviewId,
      idempotencyKey: 'review:' + reviewId,
      planId: candidate.identity.planId,
      workItemId: item.workItemId,
      implementationExecutionId: candidate.identity.executionId,
      sourceRevision: candidate.resultRevision,
    }).value!;
    const execution = this.createReviewerExecution(candidate, item, policy, attempt, review);
    return { review, execution };
  }

  private createReviewerExecution(
    candidate: Execution,
    item: WorkItem,
    policy: NormalizedPolicy,
    attempt: number,
    review: Review,
  ): Execution {
    if (!candidate.resultRevision) throw new V4Error('REVIEW_EXACT_RESULT_REQUIRED');
    const index = Math.max(0, attempt - 1);
    const legacyRoute =
      policy.reviewRoutes[Math.min(index, Math.max(0, policy.reviewRoutes.length - 1))] ??
      'reasoning';
    const priorReviews = this.repositories.executions
      .listByWorkItem(item.workItemId)
      .filter((execution) => execution.identity.phase === 'REVIEW');
    const execution = this.createSelectedExecution(
      {
        plan: this.repositories.plans.getPlan(candidate.identity.planId),
        item,
        phase: 'REVIEW',
        parentExecutionId: candidate.identity.executionId,
        attempt: Math.max(1, attempt),
        sourceRevision: candidate.resultRevision,
        objective:
          'Independently review work item ' +
          item.itemKey +
          ' at exact revision ' +
          candidate.resultRevision +
          '.',
      },
      policy,
      legacyRoute,
      priorReviews,
    );
    const session = this.repositories.sessions.getOptional(execution.identity.executionId);
    if (session?.providerSessionId && !review.reviewerExecutionId)
      this.repositories.reviews.attachReviewerExecution(
        review.reviewId,
        execution.identity.executionId,
      );
    return execution;
  }

  private createRepairOrFail(
    plan: Plan,
    item: WorkItem,
    candidate: Execution,
    review: Review,
    candidates: Execution[],
    policy: NormalizedPolicy,
  ): PlanAutomationResult {
    if (!candidate.resultRevision) return this.failPlan(plan, item, 'REPAIR_PARENT_INVALID');
    const repairCycles = candidates.filter(
      (execution) => execution.identity.phase === 'IMPLEMENT_FIX',
    ).length;
    if (repairCycles >= policy.maxRepairCycles)
      return this.failPlan(plan, item, 'REPAIR_CYCLES_EXHAUSTED');
    const legacyRoute =
      policy.implementationRoutes[
        Math.min(repairCycles, Math.max(0, policy.implementationRoutes.length - 1))
      ] ?? 'implementation';
    const execution = this.createSelectedExecution(
      {
        plan,
        item,
        phase: 'IMPLEMENT_FIX',
        parentExecutionId: candidate.identity.executionId,
        attempt: candidate.identity.attempt + 1,
        sourceRevision: candidate.resultRevision,
        objective: [
          'Repair work item ' +
            item.itemKey +
            ' at exact revision ' +
            candidate.resultRevision +
            '.',
          ...(review.findings ?? []).map((finding) => '- ' + finding),
        ].join('\n'),
      },
      policy,
      legacyRoute,
      candidates,
    );
    return {
      planId: plan.planId,
      workItemId: item.workItemId,
      executionId: execution.identity.executionId,
      reviewId: review.reviewId,
      status: 'RUNNING',
      code: 'REPAIR_QUEUED',
    };
  }

  private createExecution(input: {
    plan: Plan;
    item: WorkItem;
    phase: ExecutionPhase;
    parentExecutionId?: string;
    attempt: number;
    route: string;
    sourceRevision: string;
    objective: string;
  }): Execution {
    const executionId = stableId(
      'execution',
      input.plan.planId,
      input.item.workItemId,
      input.phase,
      input.parentExecutionId,
      input.attempt,
      input.route,
      input.sourceRevision,
    );
    return this.repositories.executions.create({
      executionId,
      idempotencyKey: 'automation:' + executionId,
      identity: {
        executionId,
        planId: input.plan.planId,
        workItemId: input.item.workItemId,
        phase: input.phase,
        parentExecutionId: input.parentExecutionId,
        attempt: input.attempt,
        route: input.route,
        sourceRevision: input.sourceRevision,
      },
      objective: input.objective,
    }).value!;
  }

  private async acceptReviewedCandidate(
    plan: Plan,
    item: WorkItem,
    candidate: Execution,
    review: Review,
  ): Promise<PlanAutomationResult> {
    if (!candidate.resultRevision) return this.failPlan(plan, item, 'REVIEWED_REVISION_MISSING');
    const session = this.repositories.sessions.getOptional(candidate.identity.executionId);
    // A PASSED review can only be recorded after ReviewRepository validates the
    // canonical completion origin (provider SUCCEEDED or evidence-verified recovery).
    // Do not re-impose providerStatus=SUCCEEDED here: operator/evidence adoption
    // intentionally preserves PAUSED provider truth while accepting exact repo facts.
    if (!session) return this.failPlan(plan, item, 'IMPLEMENTATION_SESSION_NOT_SUCCEEDED');
    let integratedRevision = candidate.resultRevision;
    const integrationStrategy =
      this.workspace.integrationStrategyFor?.(plan.planId, plan.projectKey) ??
      this.workspace.integrationStrategy;
    if (integrationStrategy === 'PLAN_WORKTREE') {
      if (!item.integrationBaseRevision)
        return this.failPlan(plan, item, 'WORK_ITEM_WAVE_BASE_REQUIRED');
      const integrated = await this.workspace.integrateAcceptedRevision({
        repositoryPath: plan.repositoryPath,
        expectedRevision: plan.currentRevision,
        acceptedRevision: candidate.resultRevision,
        candidateWorkspace: session.workspace,
        planId: plan.planId,
        workItemId: item.workItemId,
        integrationBaseRevision: item.integrationBaseRevision,
      });
      if (!integrated.clean) return this.failPlan(plan, item, 'PLAN_INTEGRATION_WORKTREE_DIRTY');
      integratedRevision = integrated.headRevision;
    } else {
      const observation = await this.workspace.observeRepository(
        plan.repositoryPath,
        candidate.resultRevision,
      );
      if (observation.headRevision === plan.currentRevision) {
        if (!observation.clean) return this.failPlan(plan, item, 'PLAN_REPOSITORY_DIRTY');
        await this.workspace.integrateAcceptedRevision({
          repositoryPath: plan.repositoryPath,
          expectedRevision: plan.currentRevision,
          acceptedRevision: candidate.resultRevision,
          candidateWorkspace: session.workspace,
        });
      } else if (observation.headRevision === candidate.resultRevision) {
        if (!observation.clean) {
          await this.workspace.integrateAcceptedRevision({
            repositoryPath: plan.repositoryPath,
            expectedRevision: plan.currentRevision,
            acceptedRevision: candidate.resultRevision,
            candidateWorkspace: session.workspace,
          });
        }
      } else {
        return this.failPlan(
          plan,
          item,
          observation.clean ? 'PLAN_REPOSITORY_DIVERGED' : 'PLAN_REPOSITORY_DIRTY',
        );
      }
    }
    const current = this.repositories.plans.getPlan(plan.planId);
    if (current.currentRevision !== integratedRevision) {
      const advanced = this.repositories.plans.advanceAcceptedRevision(
        plan.planId,
        current.currentRevision,
        integratedRevision,
        'independent review ' + review.reviewId + ' passed',
      );
      if (advanced.status === 'rejected')
        return {
          planId: plan.planId,
          workItemId: item.workItemId,
          status: 'WAITING',
          code: advanced.reason ?? 'STALE_PLAN_REVISION',
        };
    }
    const accepted = this.repositories.plans.acceptWorkItemRevision(
      item.workItemId,
      candidate.resultRevision,
      integratedRevision,
    );
    if (accepted.status === 'rejected')
      return {
        planId: plan.planId,
        workItemId: item.workItemId,
        status: 'WAITING',
        code: accepted.reason ?? 'STALE_WORK_ITEM_STATUS',
      };
    const all = this.repositories.plans.listWorkItems(plan.planId);
    if (all.every((workItem) => workItem.status === 'SUCCEEDED')) {
      return await this.completePlan(
        this.repositories.plans.getPlan(plan.planId),
        normalizePolicy(this.requirePolicy(plan.projectKey), Boolean(this.resourceSelector)),
        {
          workItemId: item.workItemId,
          reviewId: review.reviewId,
        },
      );
    }
    return {
      planId: plan.planId,
      workItemId: item.workItemId,
      reviewId: review.reviewId,
      revision: integratedRevision,
      status: 'RUNNING',
      code: 'WORK_ITEM_ACCEPTED',
    };
  }

  private async completePlan(
    plan: Plan,
    policy: NormalizedPolicy,
    context: { workItemId?: string; reviewId?: string } = {},
  ): Promise<PlanAutomationResult> {
    let current = this.repositories.plans.getPlan(plan.planId);
    if (this.workspace.assertPlanSafety) await this.workspace.assertPlanSafety(current.planId);
    current = this.supersedeDeliveryFromVerifiedChild(current);
    if (current.delivery?.status === 'SUPERSEDED_PENDING_CHILD') {
      return {
        planId: current.planId,
        ...context,
        status: 'WAITING',
        code: 'DELIVERY_REPAIR_PENDING',
        childPlanId: current.delivery.supersededByPlanId,
        revision: current.delivery.headSha ?? current.currentRevision,
      };
    }
    if (policy.requireDelivery && !current.delivery) {
      return {
        planId: current.planId,
        ...context,
        status: 'WAITING',
        code: 'PLAN_DELIVERY_REQUIRED',
        revision: current.currentRevision,
      };
    }
    if (current.delivery && !isDeliveryComplete(current.delivery)) {
      if (!this.delivery) {
        return {
          planId: current.planId,
          ...context,
          status: 'WAITING',
          code: 'DELIVERY_RUNTIME_UNAVAILABLE',
          revision: current.currentRevision,
        };
      }
      try {
        if (this.workspace.assertPlanSafety) await this.workspace.assertPlanSafety(current.planId);
        const deliveryWorkspace = this.workspace.deliveryWorkspace
          ? await this.workspace.deliveryWorkspace(current.planId)
          : undefined;
        const observation = await this.delivery.advance(current, current.delivery, {
          ...(deliveryWorkspace ? { workspacePath: deliveryWorkspace } : {}),
        });
        const durable = this.repositories.plans.recordDeliveryObservation(
          current.planId,
          observation,
        ).value;
        if (!durable) throw new V4Error('DELIVERY_OBSERVATION_PERSIST_FAILED');
        current = this.repositories.plans.getPlan(current.planId);
        if (durable.status === 'CHECKS_FAILED')
          return this.createDeliveryRepair(
            current,
            durable.errorCode ?? 'DELIVERY_REQUIRED_CHECK_FAILED',
            context,
          );
        if (durable.status !== 'VERIFIED') {
          const code =
            durable.status === 'CHECKS_PENDING'
              ? 'DELIVERY_CHECKS_PENDING'
              : durable.status === 'PR_OPEN' && !durable.autoMerge
                ? 'DELIVERY_PR_OPEN_EXTERNAL_MERGE_REQUIRED'
                : 'DELIVERY_' + durable.status;
          return {
            planId: current.planId,
            ...context,
            status: 'WAITING',
            code,
            revision: current.currentRevision,
          };
        }
      } catch (error) {
        const code = error instanceof V4Error ? error.code : 'DELIVERY_AUTOMATION_FAILED';
        this.repositories.plans.recordDeliveryError(current.planId, code);
        if (code === 'DELIVERY_REQUIRED_CHECK_FAILED')
          return this.createDeliveryRepair(
            this.repositories.plans.getPlan(current.planId),
            code,
            context,
          );
        return {
          planId: current.planId,
          ...context,
          status: 'WAITING',
          code,
          revision: current.currentRevision,
        };
      }
    }
    if (current.status === 'RUNNING') {
      const completed = this.repositories.plans.compareAndSetStatus(
        current.planId,
        'RUNNING',
        'SUCCEEDED',
      );
      if (completed.status === 'rejected')
        return {
          planId: current.planId,
          ...context,
          status: 'WAITING',
          code: completed.reason ?? 'STALE_PLAN_STATUS',
        };
      current = this.repositories.plans.getPlan(current.planId);
    }
    return {
      planId: current.planId,
      ...context,
      status: 'SUCCEEDED',
      code:
        current.delivery?.status === 'SUPERSEDED'
          ? 'PLAN_DELIVERY_SUPERSEDED'
          : current.delivery
            ? 'PLAN_DELIVERED'
            : 'PLAN_SUCCEEDED_LOCAL_ONLY',
      revision: current.currentRevision,
    };
  }

  private supersedeDeliveryFromVerifiedChild(plan: Plan): Plan {
    if (!plan.delivery || isDeliveryComplete(plan.delivery) || plan.childPlanIds.length === 0)
      return plan;
    const expectedBase = plan.delivery.headSha ?? plan.currentRevision;
    const childIds = plan.delivery.supersededByPlanId
      ? [plan.delivery.supersededByPlanId]
      : plan.childPlanIds;
    const candidates = childIds
      .map((childPlanId) => this.repositories.plans.getPlan(childPlanId))
      .filter(
        (child) =>
          child.parentPlanId === plan.planId &&
          child.baseRevision === expectedBase &&
          child.status === 'SUCCEEDED' &&
          isDeliveryComplete(child.delivery) &&
          child.delivery!.remote === plan.delivery!.remote &&
          child.delivery!.branch === plan.delivery!.branch &&
          child.delivery!.targetBranch === plan.delivery!.targetBranch,
      );
    if (candidates.length === 0) return plan;
    if (candidates.length > 1) throw new V4Error('DELIVERY_SUPERSEDING_CHILD_AMBIGUOUS');
    this.repositories.plans.supersedeDelivery(plan.planId, candidates[0]!.planId);
    return this.repositories.plans.getPlan(plan.planId);
  }

  private createDeliveryRepair(
    plan: Plan,
    errorCode: string,
    context: { workItemId?: string; reviewId?: string },
  ): PlanAutomationResult {
    const delivery = plan.delivery;
    if (!delivery) throw new V4Error('PLAN_DELIVERY_REQUIRED');
    const deliveryHead = delivery.headSha ?? plan.currentRevision;
    const childPlanId = stableId(
      'delivery-repair',
      plan.planId,
      deliveryHead,
      errorCode,
      delivery.requiredChecks.join(','),
    );
    const objective = [
      'Repair delivery governance for exact delivery head ' + deliveryHead + '.',
      'Failure: ' + errorCode + '.',
      'Required checks: ' + (delivery.requiredChecks.join(', ') || '(repository defaults)') + '.',
      'Make only changes required to restore the failing delivery checks; preserve already-reviewed product behavior.',
      'Commit the repair and pass an independent exact-SHA review before delivery resumes.',
    ].join('\n');
    const child = this.repositories.plans.createChildPlan({
      parentPlanId: plan.planId,
      childPlanId,
      repositoryPath: plan.repositoryPath,
      objective,
      relation: 'FOLLOW_UP',
    }).plan;
    this.repositories.plans.attachDelivery(child.planId, {
      remote: delivery.remote,
      branch: delivery.branch,
      targetBranch: delivery.targetBranch,
      autoMerge: delivery.autoMerge,
      mergeMethod: delivery.mergeMethod,
      requiredChecks: delivery.requiredChecks,
    });
    let graph = this.repositories.plans.getActiveGraphVersion(child.planId);
    if (!graph)
      graph = this.repositories.plans.createGraphVersion({
        planId: child.planId,
        reason: 'delivery-required-check-repair',
      }).value;
    if (!graph) throw new V4Error('GRAPH_CREATE_FAILED');
    this.repositories.plans.appendGraphWorkItem({
      graphVersionId: graph.graphVersionId,
      itemKey: 'delivery-repair',
      title: 'Repair required delivery checks',
      objective,
      dependencies: [],
      acceptanceCriteria: [
        'Start from exact delivery head ' + deliveryHead,
        'Restore required delivery checks without unrelated product changes',
        'Commit the repair',
        'Pass independent exact-SHA review',
      ],
    });
    const durableChild = this.repositories.plans.getPlan(child.planId);
    if (durableChild.status === 'DRAFT')
      this.repositories.plans.updateStatus(child.planId, 'READY');
    this.repositories.plans.delegateDeliveryRepair(plan.planId, child.planId, errorCode);
    return {
      planId: plan.planId,
      ...context,
      status: 'WAITING',
      code: 'DELIVERY_REPAIR_QUEUED',
      childPlanId: child.planId,
      revision: deliveryHead,
    };
  }

  private failPlan(plan: Plan, item: WorkItem | undefined, code: string): PlanAutomationResult {
    if (item?.status === 'RUNNING')
      this.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
    const current = this.repositories.plans.getPlan(plan.planId);
    if (current.status === 'RUNNING')
      this.repositories.plans.compareAndSetStatus(plan.planId, 'RUNNING', 'FAILED');
    return { planId: plan.planId, workItemId: item?.workItemId, status: 'FAILED', code };
  }

  private requirePolicy(projectKey: string): PlanAutomationPolicy {
    const policy = this.policies.resolve(projectKey);
    if (!policy) throw new V4Error('PLAN_POLICY_UNAVAILABLE');
    return policy;
  }
}
