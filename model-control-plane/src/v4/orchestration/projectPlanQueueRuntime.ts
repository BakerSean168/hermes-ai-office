import { isTerminalPlanStatus } from '../domain/plan.js';
import { V4Error } from '../domain/errors.js';
import type {
  RootPlanHandoffResult,
  RootPlanScheduleResult,
} from '../domain/projectPlanScheduling.js';
import type { V4Repositories } from '../persistence/repositories.js';

export interface ProjectPlanLifecyclePort {
  activate(rootPlanId: string): Promise<void>;
  retire(rootPlanId: string): Promise<void>;
}

export interface ProjectPlanQueueRuntimeResult {
  projectKey: string;
  releasedPlanId?: string;
  activatedPlanId?: string;
  code: string;
}

export class ProjectPlanQueueRuntime {
  private lifecycle?: ProjectPlanLifecyclePort;

  constructor(
    readonly repositories: V4Repositories,
    lifecycle?: ProjectPlanLifecyclePort,
  ) {
    this.lifecycle = lifecycle;
  }

  setLifecycle(lifecycle: ProjectPlanLifecyclePort | undefined): void {
    this.lifecycle = lifecycle;
  }

  bootstrapExistingRootPlans(): void {
    const candidates = this.repositories.plans
      .listPlans({ limit: 1000 })
      .filter(
        (plan) =>
          !plan.parentPlanId &&
          !isTerminalPlanStatus(plan.status) &&
          plan.status !== 'DRAFT' &&
          plan.status !== 'QUEUED',
      );
    const byProject = new Map<string, typeof candidates>();
    for (const plan of candidates) {
      const current = byProject.get(plan.projectKey) ?? [];
      current.push(plan);
      byProject.set(plan.projectKey, current);
    }
    for (const [projectKey, plans] of byProject) {
      if (plans.length > 1) throw new V4Error('PROJECT_PLAN_MULTIPLE_ACTIVE_ROOTS');
      const plan = plans[0]!;
      const lease = this.repositories.projectPlans.getLease(projectKey);
      if (!lease) {
        const acquired = this.repositories.projectPlans.tryAcquire(projectKey, plan.planId, 0);
        if (acquired.status === 'rejected')
          throw new V4Error(acquired.reason ?? 'PROJECT_PLAN_BOOTSTRAP_FAILED');
      } else if (
        lease.repositoryPath !== plan.repositoryPath ||
        (lease.activeRootPlanId && lease.activeRootPlanId !== plan.planId)
      ) {
        throw new V4Error('PROJECT_PLAN_BOOTSTRAP_CONFLICT');
      } else if (!lease.activeRootPlanId) {
        const acquired = this.repositories.projectPlans.tryAcquire(
          projectKey,
          plan.planId,
          lease.version,
        );
        if (acquired.status === 'rejected')
          throw new V4Error(acquired.reason ?? 'PROJECT_PLAN_BOOTSTRAP_FAILED');
      }
      this.ensureSupervisorActive(plan.planId);
    }
  }

  scheduleRootPlan(planId: string, priority = 0): RootPlanScheduleResult {
    const result = this.repositories.projectPlans.scheduleRootPlan(planId, priority);
    if (result.status === 'ACTIVE') this.ensureSupervisorActive(planId);
    return result;
  }

  async reconcile(): Promise<ProjectPlanQueueRuntimeResult[]> {
    const results: ProjectPlanQueueRuntimeResult[] = [];
    for (const lease of this.repositories.projectPlans.listLeases()) {
      try {
        const activePlanId = lease.activeRootPlanId;
        if (!activePlanId) {
          const claimed = this.repositories.projectPlans.claimNext(lease.projectKey, lease.version);
          if (claimed.status === 'updated' && claimed.value?.activeRootPlanId) {
            if (this.lifecycle) await this.lifecycle.activate(claimed.value.activeRootPlanId);
            this.ensureSupervisorActive(claimed.value.activeRootPlanId);
            results.push({
              projectKey: lease.projectKey,
              activatedPlanId: claimed.value.activeRootPlanId,
              code: 'PROJECT_PLAN_QUEUE_ACTIVATED',
            });
          }
          continue;
        }
        const plan = this.repositories.plans.getPlan(activePlanId);
        if (!isTerminalPlanStatus(plan.status)) {
          if (this.lifecycle) await this.lifecycle.activate(activePlanId);
          continue;
        }
        if (this.lifecycle) await this.lifecycle.retire(activePlanId);
        this.retireSupervisor(activePlanId);
        const handoff = this.repositories.projectPlans.releaseAndActivateNext(
          lease.projectKey,
          activePlanId,
          lease.version,
        );
        if (handoff.activatedPlanId) {
          if (this.lifecycle) await this.lifecycle.activate(handoff.activatedPlanId);
          this.ensureSupervisorActive(handoff.activatedPlanId);
        }
        results.push(this.handoffResult(lease.projectKey, handoff));
      } catch (error) {
        results.push({
          projectKey: lease.projectKey,
          code: error instanceof V4Error ? error.code : 'PROJECT_PLAN_LIFECYCLE_FAILED',
        });
      }
    }
    return results;
  }

  cancelQueued(planId: string): void {
    const result = this.repositories.projectPlans.cancelQueued(planId);
    if (result.status === 'rejected')
      throw new V4Error(result.reason ?? 'PROJECT_PLAN_QUEUE_CANCEL_FAILED');
  }

  private handoffResult(
    projectKey: string,
    handoff: RootPlanHandoffResult,
  ): ProjectPlanQueueRuntimeResult {
    return {
      projectKey,
      releasedPlanId: handoff.releasedPlanId,
      ...(handoff.activatedPlanId ? { activatedPlanId: handoff.activatedPlanId } : {}),
      code: handoff.activatedPlanId
        ? 'PROJECT_PLAN_HANDOFF_ACTIVATED'
        : 'PROJECT_PLAN_LEASE_RELEASED',
    };
  }

  private ensureSupervisorActive(planId: string): void {
    let supervisor = this.repositories.supervisors.getByPlanId(planId);
    if (!supervisor) {
      supervisor = this.repositories.supervisors.create({ planId }).value;
      if (!supervisor) throw new V4Error('SUPERVISOR_CREATE_FAILED');
    }
    if (supervisor.status === 'CREATED') {
      this.repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
    }
  }

  private retireSupervisor(planId: string): void {
    const supervisor = this.repositories.supervisors.getByPlanId(planId);
    if (!supervisor || supervisor.status === 'COMPLETED' || supervisor.status === 'CANCELLED')
      return;
    this.repositories.supervisors.updateStatus(supervisor.supervisorId, 'CANCELLED');
  }
}
