import { createHash } from 'node:crypto';

import { V4Error } from '../domain/errors.js';
import type { Execution, ExecutionPhase } from '../domain/execution.js';
import type { Plan } from '../domain/plan.js';
import type { Review } from '../domain/review.js';
import type { WorkItem } from '../domain/workGraph.js';
import type { V4Repositories } from '../persistence/repositories.js';
import type { ExecutionWorkerResult } from './executionWorker.js';
import type { WorkspaceProviderPort } from './contracts.js';

export interface ExecutionRunnerPort {
  runExecution(executionId: string): Promise<ExecutionWorkerResult>;
}

export interface PlanAutomationPolicy {
  implementationRoutes: string[];
  reviewRoutes: string[];
  maxImplementationAttempts?: number;
  maxReviewAttempts?: number;
  maxRepairCycles?: number;
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
}

function normalizePolicy(policy: PlanAutomationPolicy): NormalizedPolicy {
  const implementationRoutes = [...new Set(policy.implementationRoutes.map((item) => item.trim()).filter(Boolean))];
  const reviewRoutes = [...new Set(policy.reviewRoutes.map((item) => item.trim()).filter(Boolean))];
  if (implementationRoutes.length === 0) throw new V4Error('IMPLEMENTATION_ROUTE_REQUIRED');
  if (reviewRoutes.length === 0) throw new V4Error('REVIEW_ROUTE_REQUIRED');
  const maxImplementationAttempts = policy.maxImplementationAttempts ?? Math.max(implementationRoutes.length, 3);
  const maxReviewAttempts = policy.maxReviewAttempts ?? Math.max(reviewRoutes.length, 2);
  const maxRepairCycles = policy.maxRepairCycles ?? 3;
  for (const [name, value] of Object.entries({ maxImplementationAttempts, maxReviewAttempts, maxRepairCycles })) {
    if (!Number.isInteger(value) || value < 1 || value > 20) throw new V4Error('PLAN_AUTOMATION_LIMIT_INVALID', name);
  }
  return { implementationRoutes, reviewRoutes, maxImplementationAttempts, maxReviewAttempts, maxRepairCycles };
}

function stableId(prefix: string, ...parts: Array<string | number | undefined>): string {
  const digest = createHash('sha256').update(parts.map((item) => String(item ?? '')).join('\0')).digest('hex').slice(0, 24);
  return prefix + '_' + digest;
}

function latest<T extends { createdAt: string }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
}

export class StaticPlanAutomationPolicyResolver implements PlanAutomationPolicyResolver {
  readonly overrides: ReadonlyMap<string, PlanAutomationPolicy>;

  constructor(readonly defaultPolicy: PlanAutomationPolicy, overrides: Record<string, PlanAutomationPolicy> = {}) {
    this.overrides = new Map(Object.entries(overrides));
  }

  resolve(projectKey: string): PlanAutomationPolicy {
    return this.overrides.get(projectKey) ?? this.defaultPolicy;
  }
}

export class PlanAutomationRuntime {
  constructor(
    readonly repositories: V4Repositories,
    readonly runner: ExecutionRunnerPort,
    readonly workspace: WorkspaceProviderPort,
    readonly policies: PlanAutomationPolicyResolver,
  ) {}

  async runOnce(limit = 20): Promise<PlanAutomationResult[]> {
    const plans = [
      ...this.repositories.plans.listPlans({ status: 'READY', limit }),
      ...this.repositories.plans.listPlans({ status: 'RUNNING', limit }),
    ];
    const unique = new Map(plans.map((plan) => [plan.planId, plan]));
    const results: PlanAutomationResult[] = [];
    for (const plan of unique.values()) results.push(await this.runPlan(plan.planId));
    return results;
  }

  async runPlan(planId: string): Promise<PlanAutomationResult> {
    let plan = this.repositories.plans.getPlan(planId);
    if (plan.status !== 'READY' && plan.status !== 'RUNNING') {
      return { planId, status: 'SKIPPED', code: 'PLAN_NOT_AUTOMATABLE' };
    }
    const rawPolicy = this.policies.resolve(plan.projectKey);
    if (!rawPolicy) return { planId, status: 'WAITING', code: 'PLAN_POLICY_UNAVAILABLE' };
    const policy = normalizePolicy(rawPolicy);
    if (plan.status === 'READY') {
      const started = this.repositories.plans.compareAndSetStatus(planId, 'READY', 'RUNNING');
      if (started.status === 'rejected') return { planId, status: 'SKIPPED', code: started.reason ?? 'STALE_PLAN_STATUS' };
      plan = this.repositories.plans.getPlan(planId);
    }

    const active = this.repositories.executions.listByPlan(planId).filter((execution) => execution.status === 'QUEUED' || execution.status === 'RUNNING');
    for (const execution of active) await this.runner.runExecution(execution.identity.executionId);

    plan = this.repositories.plans.getPlan(planId);
    const graph = this.repositories.plans.getActiveGraphVersion(planId);
    if (!graph) return this.failPlan(plan, undefined, 'PLAN_GRAPH_MISSING');
    const items = this.repositories.plans.listWorkItems(planId, graph.graphVersionId);
    if (items.length === 0) return this.failPlan(plan, undefined, 'PLAN_GRAPH_EMPTY');
    if (items.every((item) => item.status === 'SUCCEEDED')) {
      if (plan.status === 'RUNNING') this.repositories.plans.compareAndSetStatus(planId, 'RUNNING', 'SUCCEEDED');
      return { planId, status: 'SUCCEEDED', code: 'PLAN_SUCCEEDED', revision: this.repositories.plans.getPlan(planId).currentRevision };
    }

    const running = items.find((item) => item.status === 'RUNNING');
    if (running) return await this.reconcileRunningItem(plan, running, policy);
    const failed = items.find((item) => item.status === 'FAILED' || item.status === 'BLOCKED');
    if (failed) return this.failPlan(plan, failed, 'WORK_ITEM_TERMINAL_FAILURE');

    const byKey = new Map(items.map((item) => [item.itemKey, item]));
    const runnable = items.find((item) =>
      (item.status === 'PENDING' || item.status === 'READY')
      && item.dependencies.every((dependency) => byKey.get(dependency)?.status === 'SUCCEEDED'));
    if (!runnable) return this.failPlan(plan, undefined, 'WORK_GRAPH_DEADLOCK');
    if (runnable.status !== 'RUNNING') this.repositories.plans.updateWorkItemStatus(runnable.workItemId, 'RUNNING');
    const execution = this.createInitialExecution(plan, runnable, policy);
    return { planId, workItemId: runnable.workItemId, executionId: execution.identity.executionId, status: 'RUNNING', code: 'IMPLEMENTATION_QUEUED' };
  }

  createInitialExecution(plan: Plan, workItem: WorkItem, rawPolicy?: PlanAutomationPolicy): Execution {
    const policy = normalizePolicy(rawPolicy ?? this.requirePolicy(plan.projectKey));
    if (plan.status !== 'READY' && plan.status !== 'RUNNING') throw new V4Error('PLAN_NOT_AUTOMATABLE');
    if (workItem.planId !== plan.planId) throw new V4Error('EXECUTION_WORK_ITEM_MISMATCH');
    const route = policy.implementationRoutes[0]!;
    const executionId = stableId('execution', plan.planId, workItem.workItemId, 'IMPLEMENT', 1, route, plan.currentRevision);
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

  private async reconcileRunningItem(plan: Plan, item: WorkItem, policy: NormalizedPolicy): Promise<PlanAutomationResult> {
    const executions = this.repositories.executions.listByWorkItem(item.workItemId);
    const active = executions.find((execution) => execution.status === 'QUEUED' || execution.status === 'RUNNING');
    if (active) return { planId: plan.planId, workItemId: item.workItemId, executionId: active.identity.executionId, status: 'RUNNING', code: 'EXECUTION_ACTIVE' };

    const candidates = executions.filter((execution) => execution.identity.phase === 'IMPLEMENT' || execution.identity.phase === 'IMPLEMENT_FIX');
    const candidate = latest(candidates);
    if (!candidate) {
      const execution = this.createInitialExecution(plan, item, policy);
      return { planId: plan.planId, workItemId: item.workItemId, executionId: execution.identity.executionId, status: 'RUNNING', code: 'IMPLEMENTATION_QUEUED' };
    }
    if (candidate.status === 'FAILED' || candidate.status === 'BLOCKED' || candidate.status === 'CANCELLED') {
      return this.retryOrFailImplementation(plan, item, candidate, candidates, policy);
    }
    if (candidate.status !== 'SUCCEEDED' || !candidate.resultRevision) return this.failPlan(plan, item, 'IMPLEMENTATION_RESULT_INVALID');

    const reviews = this.repositories.reviews.listByWorkItem(item.workItemId).filter((review) => review.implementationExecutionId === candidate.identity.executionId);
    const review = latest(reviews);
    if (!review) {
      const created = this.createReview(candidate, item, policy, 1);
      return { planId: plan.planId, workItemId: item.workItemId, executionId: created.execution.identity.executionId, reviewId: created.review.reviewId, status: 'RUNNING', code: 'REVIEW_QUEUED' };
    }
    if (review.status === 'PASSED') return await this.acceptReviewedCandidate(plan, item, candidate, review);
    if (review.status === 'FAILED') return this.createRepairOrFail(plan, item, candidate, review, candidates, policy);
    if (review.status === 'STALE' || review.status === 'CANCELLED') return this.failPlan(plan, item, 'REVIEW_INVALID');

    if (!review.reviewerExecutionId) {
      const execution = this.createReviewerExecution(candidate, item, policy, reviews.length, review);
      return { planId: plan.planId, workItemId: item.workItemId, executionId: execution.identity.executionId, reviewId: review.reviewId, status: 'RUNNING', code: 'REVIEW_EXECUTION_QUEUED' };
    }
    const reviewer = this.repositories.executions.get(review.reviewerExecutionId);
    if (reviewer.status === 'FAILED' || reviewer.status === 'BLOCKED' || reviewer.status === 'CANCELLED') {
      const attempt = reviews.length + 1;
      if (attempt > policy.maxReviewAttempts) return this.failPlan(plan, item, 'REVIEW_ATTEMPTS_EXHAUSTED');
      if (review.status === 'PENDING' || review.status === 'RUNNING') this.repositories.reviews.updateStatus(review.reviewId, 'CANCELLED');
      const created = this.createReview(candidate, item, policy, attempt);
      return { planId: plan.planId, workItemId: item.workItemId, executionId: created.execution.identity.executionId, reviewId: created.review.reviewId, status: 'RUNNING', code: 'REVIEW_RETRY_QUEUED' };
    }
    return { planId: plan.planId, workItemId: item.workItemId, executionId: reviewer.identity.executionId, reviewId: review.reviewId, status: 'RUNNING', code: 'REVIEW_ACTIVE' };
  }

  private retryOrFailImplementation(plan: Plan, item: WorkItem, candidate: Execution, candidates: Execution[], policy: NormalizedPolicy): PlanAutomationResult {
    if (!candidate.retryable) return this.failPlan(plan, item, 'IMPLEMENTATION_NOT_RETRYABLE');
    if (candidate.identity.phase === 'IMPLEMENT') {
      const attempts = candidates.filter((execution) => execution.identity.phase === 'IMPLEMENT').length;
      if (attempts >= policy.maxImplementationAttempts) return this.failPlan(plan, item, 'IMPLEMENTATION_ATTEMPTS_EXHAUSTED');
      const route = policy.implementationRoutes[Math.min(attempts, policy.implementationRoutes.length - 1)]!;
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
      return { planId: plan.planId, workItemId: item.workItemId, executionId: execution.identity.executionId, status: 'RUNNING', code: 'IMPLEMENTATION_RETRY_QUEUED' };
    }
    const repairRoot = candidate.identity.parentExecutionId ? this.repositories.executions.get(candidate.identity.parentExecutionId) : undefined;
    if (!repairRoot?.resultRevision) return this.failPlan(plan, item, 'REPAIR_PARENT_INVALID');
    const repairAttempts = candidates.filter((execution) => execution.identity.phase === 'IMPLEMENT_FIX' && execution.identity.parentExecutionId === repairRoot.identity.executionId).length;
    if (repairAttempts >= policy.maxImplementationAttempts) return this.failPlan(plan, item, 'REPAIR_ATTEMPTS_EXHAUSTED');
    const route = policy.implementationRoutes[Math.min(repairAttempts, policy.implementationRoutes.length - 1)]!;
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
    return { planId: plan.planId, workItemId: item.workItemId, executionId: execution.identity.executionId, status: 'RUNNING', code: 'REPAIR_RETRY_QUEUED' };
  }

  private createReview(candidate: Execution, item: WorkItem, policy: NormalizedPolicy, attempt: number): { review: Review; execution: Execution } {
    if (!candidate.resultRevision) throw new V4Error('REVIEW_EXACT_RESULT_REQUIRED');
    const reviewId = stableId('review', candidate.identity.executionId, candidate.resultRevision, attempt);
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

  private createReviewerExecution(candidate: Execution, item: WorkItem, policy: NormalizedPolicy, attempt: number, review: Review): Execution {
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
      objective: 'Independently review work item ' + item.itemKey + ' at exact revision ' + candidate.resultRevision + '.',
    });
    const session = this.repositories.sessions.getOptional(execution.identity.executionId);
    if (session?.providerSessionId && !review.reviewerExecutionId) this.repositories.reviews.attachReviewerExecution(review.reviewId, execution.identity.executionId);
    return execution;
  }

  private createRepairOrFail(plan: Plan, item: WorkItem, candidate: Execution, review: Review, candidates: Execution[], policy: NormalizedPolicy): PlanAutomationResult {
    if (!candidate.resultRevision) return this.failPlan(plan, item, 'REPAIR_PARENT_INVALID');
    const repairCycles = candidates.filter((execution) => execution.identity.phase === 'IMPLEMENT_FIX').length;
    if (repairCycles >= policy.maxRepairCycles) return this.failPlan(plan, item, 'REPAIR_CYCLES_EXHAUSTED');
    const route = policy.implementationRoutes[Math.min(repairCycles, policy.implementationRoutes.length - 1)]!;
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
    return { planId: plan.planId, workItemId: item.workItemId, executionId: execution.identity.executionId, reviewId: review.reviewId, status: 'RUNNING', code: 'REPAIR_QUEUED' };
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
    const executionId = stableId('execution', input.plan.planId, input.item.workItemId, input.phase, input.parentExecutionId, input.attempt, input.route, input.sourceRevision);
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

  private async acceptReviewedCandidate(plan: Plan, item: WorkItem, candidate: Execution, review: Review): Promise<PlanAutomationResult> {
    if (!candidate.resultRevision) return this.failPlan(plan, item, 'REVIEWED_REVISION_MISSING');
    const session = this.repositories.sessions.getOptional(candidate.identity.executionId);
    if (!session || session.providerStatus !== 'SUCCEEDED') return this.failPlan(plan, item, 'IMPLEMENTATION_SESSION_NOT_SUCCEEDED');
    const observation = await this.workspace.observeRepository(plan.repositoryPath, candidate.resultRevision);
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
      const advanced = this.repositories.plans.advanceAcceptedRevision(plan.planId, current.currentRevision, candidate.resultRevision, 'independent review ' + review.reviewId + ' passed');
      if (advanced.status === 'rejected') return { planId: plan.planId, workItemId: item.workItemId, status: 'WAITING', code: advanced.reason ?? 'STALE_PLAN_REVISION' };
    }
    const accepted = this.repositories.plans.acceptWorkItemRevision(item.workItemId, candidate.resultRevision);
    if (accepted.status === 'rejected') return { planId: plan.planId, workItemId: item.workItemId, status: 'WAITING', code: accepted.reason ?? 'STALE_WORK_ITEM_STATUS' };
    const all = this.repositories.plans.listWorkItems(plan.planId);
    if (all.every((workItem) => workItem.status === 'SUCCEEDED')) {
      this.repositories.plans.compareAndSetStatus(plan.planId, 'RUNNING', 'SUCCEEDED');
      return { planId: plan.planId, workItemId: item.workItemId, reviewId: review.reviewId, revision: candidate.resultRevision, status: 'SUCCEEDED', code: 'PLAN_SUCCEEDED' };
    }
    return { planId: plan.planId, workItemId: item.workItemId, reviewId: review.reviewId, revision: candidate.resultRevision, status: 'RUNNING', code: 'WORK_ITEM_ACCEPTED' };
  }

  private failPlan(plan: Plan, item: WorkItem | undefined, code: string): PlanAutomationResult {
    if (item?.status === 'RUNNING') this.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
    const current = this.repositories.plans.getPlan(plan.planId);
    if (current.status === 'RUNNING') this.repositories.plans.compareAndSetStatus(plan.planId, 'RUNNING', 'FAILED');
    return { planId: plan.planId, workItemId: item?.workItemId, status: 'FAILED', code };
  }

  private requirePolicy(projectKey: string): PlanAutomationPolicy {
    const policy = this.policies.resolve(projectKey);
    if (!policy) throw new V4Error('PLAN_POLICY_UNAVAILABLE');
    return policy;
  }
}
