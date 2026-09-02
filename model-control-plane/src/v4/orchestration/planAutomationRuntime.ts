import { createHash } from 'node:crypto';

import { V4Error } from '../domain/errors.js';
import type { Execution, ExecutionPhase } from '../domain/execution.js';
import type { Plan } from '../domain/plan.js';
import type { Review } from '../domain/review.js';
import type { WorkItem } from '../domain/workGraph.js';
import type { V4Repositories } from '../persistence/repositories.js';
import type { ExecutionWorkerResult } from './executionWorker.js';
import type { DeliveryAutomationPort, WorkspaceProviderPort } from './contracts.js';

export interface ExecutionRunnerPort {
  runExecution(executionId: string): Promise<ExecutionWorkerResult>;
}

export interface PlanAutomationPolicy {
  implementationRoutes: string[];
  reviewRoutes: string[];
  maxImplementationAttempts?: number;
  maxReviewAttempts?: number;
  maxRepairCycles?: number;
  requireDelivery?: boolean;
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
  revision?: string;
}

interface NormalizedPolicy {
  implementationRoutes: string[];
  reviewRoutes: string[];
  maxImplementationAttempts: number;
  maxReviewAttempts: number;
  maxRepairCycles: number;
  requireDelivery: boolean;
}

function normalizePolicy(policy: PlanAutomationPolicy): NormalizedPolicy {
  const implementationRoutes = [
    ...new Set(policy.implementationRoutes.map((item) => item.trim()).filter(Boolean)),
  ];
  const reviewRoutes = [...new Set(policy.reviewRoutes.map((item) => item.trim()).filter(Boolean))];
  if (implementationRoutes.length === 0) throw new V4Error('IMPLEMENTATION_ROUTE_REQUIRED');
  if (reviewRoutes.length === 0) throw new V4Error('REVIEW_ROUTE_REQUIRED');
  const maxImplementationAttempts =
    policy.maxImplementationAttempts ?? Math.max(implementationRoutes.length, 3);
  const maxReviewAttempts = policy.maxReviewAttempts ?? Math.max(reviewRoutes.length, 2);
  const maxRepairCycles = policy.maxRepairCycles ?? 3;
  const requireDelivery = policy.requireDelivery ?? false;
  for (const [name, value] of Object.entries({
    maxImplementationAttempts,
    maxReviewAttempts,
    maxRepairCycles,
  })) {
    if (!Number.isInteger(value) || value < 1 || value > 20)
      throw new V4Error('PLAN_AUTOMATION_LIMIT_INVALID', name);
  }
  return {
    implementationRoutes,
    reviewRoutes,
    maxImplementationAttempts,
    maxReviewAttempts,
    maxRepairCycles,
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
  return /(?:authentication|invalid api key|unauthorized|forbidden|http[_ ]?(?:401|403)|\b401\b|\b403\b|no deployments available|deployment unavailable)/i.test(detail);
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
  ) {}

  async runOnce(limit = 20): Promise<PlanAutomationResult[]> {
    const plans = [
      ...this.repositories.plans.listPlans({ status: 'READY', limit }),
      ...this.repositories.plans.listPlans({ status: 'RUNNING', limit }),
      ...this.repositories.plans.listPlans({ status: 'SUCCEEDED', limit: 1000 }).filter((plan) => plan.delivery && plan.delivery.status !== 'VERIFIED').slice(0, limit),
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
    let plan = this.repositories.plans.getPlan(planId);
    const legacyDeliveryPending = plan.status === 'SUCCEEDED' && plan.delivery && plan.delivery.status !== 'VERIFIED';
    if (plan.status !== 'READY' && plan.status !== 'RUNNING' && !legacyDeliveryPending) {
      return { planId, status: 'SKIPPED', code: 'PLAN_NOT_AUTOMATABLE' };
    }
    const rawPolicy = this.policies.resolve(plan.projectKey);
    if (!rawPolicy) return { planId, status: 'WAITING', code: 'PLAN_POLICY_UNAVAILABLE' };
    const policy = normalizePolicy(rawPolicy);
    if (plan.status === 'READY') {
      const started = this.repositories.plans.compareAndSetStatus(planId, 'READY', 'RUNNING');
      if (started.status === 'rejected')
        return { planId, status: 'SKIPPED', code: started.reason ?? 'STALE_PLAN_STATUS' };
      plan = this.repositories.plans.getPlan(planId);
    }

    const active = this.repositories.executions
      .listByPlan(planId)
      .filter((execution) => execution.status === 'QUEUED' || execution.status === 'RUNNING');
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

    const running = items.find((item) => item.status === 'RUNNING');
    if (running) return await this.reconcileRunningItem(plan, running, policy);
    const failed = items.find((item) => item.status === 'FAILED' || item.status === 'BLOCKED');
    if (failed) return this.failPlan(plan, failed, 'WORK_ITEM_TERMINAL_FAILURE');

    const byKey = new Map(items.map((item) => [item.itemKey, item]));
    const runnable = items.find(
      (item) =>
        (item.status === 'PENDING' || item.status === 'READY') &&
        item.dependencies.every((dependency) => byKey.get(dependency)?.status === 'SUCCEEDED'),
    );
    if (!runnable) return this.failPlan(plan, undefined, 'WORK_GRAPH_DEADLOCK');
    if (runnable.status !== 'RUNNING')
      this.repositories.plans.updateWorkItemStatus(runnable.workItemId, 'RUNNING');
    const execution = this.createInitialExecution(plan, runnable, policy);
    return {
      planId,
      workItemId: runnable.workItemId,
      executionId: execution.identity.executionId,
      status: 'RUNNING',
      code: 'IMPLEMENTATION_QUEUED',
    };
  }

  async reconcilePlan(planId: string, mode = 'auto'): Promise<PlanAutomationResult> {
    if (mode === 'retry-review' || mode === 'retry_review') return this.reconcileFailedReview(planId);
    if (mode === 'retry-delivery' || mode === 'retry_delivery') return await this.runPlan(planId);
    if (mode !== 'auto') throw new V4Error('PLAN_RECONCILE_MODE_INVALID');
    let plan = this.repositories.plans.getPlan(planId);
    if (plan.status === 'READY' || plan.status === 'RUNNING' || (plan.status === 'SUCCEEDED' && plan.delivery && plan.delivery.status !== 'VERIFIED')) return await this.runPlan(planId);
    if (plan.status !== 'FAILED')
      return { planId, status: 'SKIPPED', code: 'PLAN_NOT_RECOVERABLE' };

    const rawPolicy = this.policies.resolve(plan.projectKey);
    if (!rawPolicy) return { planId, status: 'WAITING', code: 'PLAN_POLICY_UNAVAILABLE' };
    const policy = normalizePolicy(rawPolicy);
    const graph = this.repositories.plans.getActiveGraphVersion(planId);
    if (!graph) throw new V4Error('PLAN_GRAPH_MISSING');
    const items = this.repositories.plans.listWorkItems(planId, graph.graphVersionId);
    const failedItems = items.filter((item) => item.status === 'FAILED' || item.status === 'BLOCKED');
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
    const finalizationRecovery =
      Boolean(candidate.errorCode && FINALIZATION_RECOVERY_CODES.has(candidate.errorCode));
    if (!candidate.retryable && !finalizationRecovery && !routeUnavailableFailure(candidate))
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
      attempts = candidates.filter((execution) => execution.identity.phase === 'IMPLEMENT').length;
      if (attempts >= policy.maxImplementationAttempts)
        return {
          planId,
          workItemId: item.workItemId,
          executionId: candidate.identity.executionId,
          status: 'FAILED',
          code: 'IMPLEMENTATION_ATTEMPTS_EXHAUSTED',
        };
      parentExecutionId = candidate.identity.executionId;
      if (!candidate.identity.sourceRevision) throw new V4Error('EXECUTION_SOURCE_REVISION_REQUIRED');
      sourceRevision = candidate.identity.sourceRevision;
    } else {
      const repairRoot = candidate.identity.parentExecutionId
        ? this.repositories.executions.get(candidate.identity.parentExecutionId)
        : undefined;
      if (!repairRoot?.resultRevision) throw new V4Error('REPAIR_PARENT_INVALID');
      attempts = candidates.filter(
        (execution) =>
          execution.identity.phase === 'IMPLEMENT_FIX' &&
          execution.identity.parentExecutionId === repairRoot.identity.executionId,
      ).length;
      if (attempts >= policy.maxImplementationAttempts)
        return {
          planId,
          workItemId: item.workItemId,
          executionId: candidate.identity.executionId,
          status: 'FAILED',
          code: 'REPAIR_ATTEMPTS_EXHAUSTED',
        };
      parentExecutionId = repairRoot.identity.executionId;
      sourceRevision = repairRoot.resultRevision;
    }

    const route = finalizationRecovery
      ? candidate.identity.route
      : policy.implementationRoutes[Math.min(attempts, policy.implementationRoutes.length - 1)]!;
    const recovery = this.createExecution({
      plan,
      item,
      phase: candidate.identity.phase,
      parentExecutionId,
      attempt: candidate.identity.attempt + 1,
      route,
      sourceRevision,
      objective: candidate.identity.phase === 'IMPLEMENT' ? item.objective : candidate.objective,
    });
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
    const policy = normalizePolicy(rawPolicy);
    const graph = this.repositories.plans.getActiveGraphVersion(planId);
    if (!graph) throw new V4Error('PLAN_GRAPH_MISSING');
    const failedItems = this.repositories.plans
      .listWorkItems(planId, graph.graphVersionId)
      .filter((item) => item.status === 'FAILED' || item.status === 'BLOCKED');
    if (failedItems.length !== 1) throw new V4Error('PLAN_RECOVERY_WORK_ITEM_AMBIGUOUS');
    const item = failedItems[0]!;
    const executions = this.repositories.executions.listByWorkItem(item.workItemId);
    if (executions.some((execution) => execution.status === 'QUEUED' || execution.status === 'RUNNING'))
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
    if (!prior || (prior.status !== 'FAILED' && prior.status !== 'STALE' && prior.status !== 'CANCELLED'))
      throw new V4Error('PLAN_REVIEW_RECOVERY_NOT_REQUIRED');

    const existing = this.repositories.evidence.find(
      candidate.identity.executionId,
      'RECOVERY',
      REVIEW_RECOVERY_EVIDENCE_NAME,
    );
    const attemptValue = existing?.payload.attempt;
    const attempt = existing
      ? Number(attemptValue)
      : reviews.length + 1;
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
    const policy = normalizePolicy(rawPolicy ?? this.requirePolicy(plan.projectKey));
    if (plan.status !== 'READY' && plan.status !== 'RUNNING')
      throw new V4Error('PLAN_NOT_AUTOMATABLE');
    if (workItem.planId !== plan.planId) throw new V4Error('EXECUTION_WORK_ITEM_MISMATCH');
    const route = policy.implementationRoutes[0]!;
    const executionId = stableId(
      'execution',
      plan.planId,
      workItem.workItemId,
      'IMPLEMENT',
      1,
      route,
      plan.currentRevision,
    );
    return this.repositories.executions.create({
      executionId,
      idempotencyKey: 'initial:' + executionId,
      identity: {
        executionId,
        planId: plan.planId,
        workItemId: workItem.workItemId,
        phase: 'IMPLEMENT',
        attempt: 1,
        route,
        sourceRevision: plan.currentRevision,
      },
      objective: workItem.objective,
    }).value!;
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
        return Boolean(evidence && (!newestCandidate || evidence.createdAt >= newestCandidate.createdAt));
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
      if (attempt > policy.maxReviewAttempts)
        return this.failPlan(plan, item, 'REVIEW_ATTEMPTS_EXHAUSTED');
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
    if (review.status === 'CANCELLED')
      return this.failPlan(plan, item, 'REVIEW_INVALID');

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
      reviewer.status === 'FAILED' ||
      reviewer.status === 'BLOCKED' ||
      reviewer.status === 'CANCELLED'
    ) {
      const attempt = reviews.length + 1;
      if (attempt > policy.maxReviewAttempts)
        return this.failPlan(plan, item, 'REVIEW_ATTEMPTS_EXHAUSTED');
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

  private retryOrFailImplementation(
    plan: Plan,
    item: WorkItem,
    candidate: Execution,
    candidates: Execution[],
    policy: NormalizedPolicy,
  ): PlanAutomationResult {
    if (!candidate.retryable && !routeUnavailableFailure(candidate)) return this.failPlan(plan, item, 'IMPLEMENTATION_NOT_RETRYABLE');
    if (candidate.identity.phase === 'IMPLEMENT') {
      const attempts = candidates.filter(
        (execution) => execution.identity.phase === 'IMPLEMENT',
      ).length;
      if (attempts >= policy.maxImplementationAttempts)
        return this.failPlan(plan, item, 'IMPLEMENTATION_ATTEMPTS_EXHAUSTED');
      const route =
        policy.implementationRoutes[Math.min(attempts, policy.implementationRoutes.length - 1)]!;
      const execution = this.createExecution({
        plan,
        item,
        phase: 'IMPLEMENT',
        parentExecutionId: candidate.identity.executionId,
        attempt: candidate.identity.attempt + 1,
        route,
        sourceRevision: candidate.identity.sourceRevision!,
        objective: item.objective,
      });
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
    const repairAttempts = candidates.filter(
      (execution) =>
        execution.identity.phase === 'IMPLEMENT_FIX' &&
        execution.identity.parentExecutionId === repairRoot.identity.executionId,
    ).length;
    if (repairAttempts >= policy.maxImplementationAttempts)
      return this.failPlan(plan, item, 'REPAIR_ATTEMPTS_EXHAUSTED');
    const route =
      policy.implementationRoutes[
        Math.min(repairAttempts, policy.implementationRoutes.length - 1)
      ]!;
    const execution = this.createExecution({
      plan,
      item,
      phase: 'IMPLEMENT_FIX',
      parentExecutionId: repairRoot.identity.executionId,
      attempt: candidate.identity.attempt + 1,
      route,
      sourceRevision: repairRoot.resultRevision,
      objective: candidate.objective,
    });
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
    const route = policy.reviewRoutes[Math.min(index, policy.reviewRoutes.length - 1)]!;
    const execution = this.createExecution({
      plan: this.repositories.plans.getPlan(candidate.identity.planId),
      item,
      phase: 'REVIEW',
      parentExecutionId: candidate.identity.executionId,
      attempt: Math.max(1, attempt),
      route,
      sourceRevision: candidate.resultRevision,
      objective:
        'Independently review work item ' +
        item.itemKey +
        ' at exact revision ' +
        candidate.resultRevision +
        '.',
    });
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
    const route =
      policy.implementationRoutes[Math.min(repairCycles, policy.implementationRoutes.length - 1)]!;
    const execution = this.createExecution({
      plan,
      item,
      phase: 'IMPLEMENT_FIX',
      parentExecutionId: candidate.identity.executionId,
      attempt: candidate.identity.attempt + 1,
      route,
      sourceRevision: candidate.resultRevision,
      objective: [
        'Repair work item ' + item.itemKey + ' at exact revision ' + candidate.resultRevision + '.',
        ...(review.findings ?? []).map((finding) => '- ' + finding),
      ].join('\n'),
    });
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
    if (!session || session.providerStatus !== 'SUCCEEDED')
      return this.failPlan(plan, item, 'IMPLEMENTATION_SESSION_NOT_SUCCEEDED');
    const observation = await this.workspace.observeRepository(
      plan.repositoryPath,
      candidate.resultRevision,
    );
    if (!observation.clean) return this.failPlan(plan, item, 'PLAN_REPOSITORY_DIRTY');
    if (observation.headRevision === plan.currentRevision) {
      await this.workspace.integrateAcceptedRevision({
        repositoryPath: plan.repositoryPath,
        expectedRevision: plan.currentRevision,
        acceptedRevision: candidate.resultRevision,
        candidateWorkspace: session.workspace,
      });
    } else if (observation.headRevision !== candidate.resultRevision) {
      return this.failPlan(plan, item, 'PLAN_REPOSITORY_DIVERGED');
    }
    const current = this.repositories.plans.getPlan(plan.planId);
    if (current.currentRevision !== candidate.resultRevision) {
      const advanced = this.repositories.plans.advanceAcceptedRevision(
        plan.planId,
        current.currentRevision,
        candidate.resultRevision,
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
      return await this.completePlan(this.repositories.plans.getPlan(plan.planId), normalizePolicy(this.requirePolicy(plan.projectKey)), {
        workItemId: item.workItemId,
        reviewId: review.reviewId,
      });
    }
    return {
      planId: plan.planId,
      workItemId: item.workItemId,
      reviewId: review.reviewId,
      revision: candidate.resultRevision,
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
    if (policy.requireDelivery && !current.delivery) {
      return { planId: current.planId, ...context, status: 'WAITING', code: 'PLAN_DELIVERY_REQUIRED', revision: current.currentRevision };
    }
    if (current.delivery && current.delivery.status !== 'VERIFIED') {
      if (!this.delivery) {
        return { planId: current.planId, ...context, status: 'WAITING', code: 'DELIVERY_RUNTIME_UNAVAILABLE', revision: current.currentRevision };
      }
      try {
        const observation = await this.delivery.advance(current, current.delivery);
        const durable = this.repositories.plans.recordDeliveryObservation(current.planId, observation).value;
        if (!durable) throw new V4Error('DELIVERY_OBSERVATION_PERSIST_FAILED');
        current = this.repositories.plans.getPlan(current.planId);
        if (durable.status !== 'VERIFIED') {
          const code = durable.status === 'CHECKS_PENDING'
            ? 'DELIVERY_CHECKS_PENDING'
            : durable.status === 'PR_OPEN' && !durable.autoMerge
              ? 'DELIVERY_PR_OPEN_EXTERNAL_MERGE_REQUIRED'
              : 'DELIVERY_' + durable.status;
          return { planId: current.planId, ...context, status: 'WAITING', code, revision: current.currentRevision };
        }
      } catch (error) {
        const code = error instanceof V4Error ? error.code : 'DELIVERY_AUTOMATION_FAILED';
        this.repositories.plans.recordDeliveryError(current.planId, code);
        return { planId: current.planId, ...context, status: 'WAITING', code, revision: current.currentRevision };
      }
    }
    if (current.status === 'RUNNING') {
      const completed = this.repositories.plans.compareAndSetStatus(current.planId, 'RUNNING', 'SUCCEEDED');
      if (completed.status === 'rejected') return { planId: current.planId, ...context, status: 'WAITING', code: completed.reason ?? 'STALE_PLAN_STATUS' };
      current = this.repositories.plans.getPlan(current.planId);
    }
    return {
      planId: current.planId,
      ...context,
      status: 'SUCCEEDED',
      code: current.delivery ? 'PLAN_DELIVERED' : 'PLAN_SUCCEEDED_LOCAL_ONLY',
      revision: current.currentRevision,
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
