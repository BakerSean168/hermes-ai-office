import { V4Error } from '../domain/errors.js';
import type { CreatePlanInput, Plan, PlanStatus } from '../domain/plan.js';
import { validateGraphItems, type WorkItem } from '../domain/workGraph.js';
import type { V4Repositories, MutationResult } from '../persistence/repositories.js';

export class PlanKernel {
  constructor(readonly repositories: V4Repositories) {}

  createPlan(input: CreatePlanInput): MutationResult<Plan> {
    return this.repositories.plans.createPlan(input);
  }

  transition(planId: string, next: PlanStatus): MutationResult<Plan> {
    return this.repositories.plans.updateStatus(planId, next);
  }

  createChildPlan(input: {
    parentPlanId: string;
    childPlanId: string;
    repositoryPath: string;
    objective: string;
    relation: 'SYSTEM_REPAIR' | 'INFRASTRUCTURE_REPAIR' | 'FOLLOW_UP';
  }): { plan: Plan; relationshipId: string } {
    return this.repositories.plans.createChildPlan(input);
  }

  ensureReadyGraph(
    planId: string,
    items: readonly {
      itemKey: string;
      title: string;
      objective: string;
      dependencies?: string[];
      acceptanceCriteria?: string[];
      parallelSafe?: boolean;
      writeScopes?: string[];
      conflictKeys?: string[];
    }[],
    options: { activate?: boolean } = {},
  ): { graphVersionId: string; items: WorkItem[] } {
    const plan = this.repositories.plans.getPlan(planId);
    const existing = this.repositories.plans.getActiveGraphVersion(planId);
    if (existing) {
      const current = this.repositories.plans.listWorkItems(planId, existing.graphVersionId);
      if (current.length > 0) {
        if (plan.status === 'DRAFT' && options.activate !== false)
          this.repositories.plans.updateStatus(planId, 'READY');
        return { graphVersionId: existing.graphVersionId, items: current };
      }
    }
    const normalized = items.map((item) => ({
      itemKey: item.itemKey,
      title: item.title,
      objective: item.objective,
      dependencies: item.dependencies ?? [],
      acceptanceCriteria: item.acceptanceCriteria ?? [],
      parallelSafe: item.parallelSafe ?? false,
      writeScopes: item.writeScopes ?? [],
      conflictKeys: item.conflictKeys ?? [],
    }));
    validateGraphItems(normalized);
    const graph = this.repositories.plans.createGraphVersion({
      planId,
      reason: 'initial-plan-graph',
    }).value;
    if (!graph) throw new V4Error('GRAPH_CREATE_FAILED');
    const pending = [...normalized];
    const created: WorkItem[] = [];
    while (pending.length > 0) {
      const ready = pending.filter((item) =>
        item.dependencies.every((dependency) =>
          created.some((existingItem) => existingItem.itemKey === dependency),
        ),
      );
      if (ready.length === 0) throw new V4Error('GRAPH_DEPENDENCY_CYCLE');
      for (const item of ready) {
        pending.splice(pending.indexOf(item), 1);
        const result = this.repositories.plans.appendGraphWorkItem({
          graphVersionId: graph.graphVersionId,
          itemKey: item.itemKey,
          title: item.title,
          objective: item.objective,
          dependencies: item.dependencies,
          acceptanceCriteria: item.acceptanceCriteria,
          parallelSafe: item.parallelSafe,
          writeScopes: item.writeScopes,
          conflictKeys: item.conflictKeys,
        });
        if (result.value) created.push(result.value);
      }
    }
    if (plan.status === 'DRAFT' && options.activate !== false)
      this.repositories.plans.updateStatus(planId, 'READY');
    return { graphVersionId: graph.graphVersionId, items: created };
  }
}
