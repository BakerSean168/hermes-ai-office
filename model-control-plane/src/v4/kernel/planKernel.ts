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
    const parent = this.repositories.plans.getPlan(input.parentPlanId);
    const result = this.repositories.plans.createPlan({
      planId: input.childPlanId,
      idempotencyKey: 'child-plan:' + input.parentPlanId + ':' + input.childPlanId,
      projectKey: parent.projectKey,
      objective: input.objective,
      repositoryPath: input.repositoryPath,
      baseRevision: parent.currentRevision,
      parentPlanId: parent.planId,
    });
    const child = result.value ?? this.repositories.plans.getPlan(input.childPlanId);
    const existingParent = this.repositories.relationships.getParent(child.planId);
    if (existingParent && existingParent !== parent.planId) throw new V4Error('PARENT_CHILD_PARENT_CONFLICT');
    const relationship = existingParent
      ? { value: { relationshipId: 'existing', parentPlanId: parent.planId, childPlanId: child.planId, kind: input.relation } }
      : this.repositories.relationships.createParentChild({ parentPlanId: parent.planId, childPlanId: child.planId, kind: input.relation });
    if (!relationship.value) throw new V4Error('PARENT_CHILD_CREATE_FAILED');
    return { plan: child, relationshipId: relationship.value.relationshipId };
  }

  ensureReadyGraph(planId: string, items: readonly {
    itemKey: string; title: string; objective: string; dependencies?: string[]; acceptanceCriteria?: string[];
  }[]): { graphVersionId: string; items: WorkItem[] } {
    const plan = this.repositories.plans.getPlan(planId);
    const existing = this.repositories.plans.getActiveGraphVersion(planId);
    if (existing) {
      const current = this.repositories.plans.listWorkItems(planId, existing.graphVersionId);
      if (current.length > 0) return { graphVersionId: existing.graphVersionId, items: current };
    }
    const normalized = items.map((item) => ({
      itemKey: item.itemKey,
      title: item.title,
      objective: item.objective,
      dependencies: item.dependencies ?? [],
      acceptanceCriteria: item.acceptanceCriteria ?? [],
    }));
    validateGraphItems(normalized);
    const graph = this.repositories.plans.createGraphVersion({ planId, reason: 'initial-plan-graph' }).value;
    if (!graph) throw new V4Error('GRAPH_CREATE_FAILED');
    const pending = [...normalized];
    const created: WorkItem[] = [];
    while (pending.length > 0) {
      const ready = pending.filter((item) => item.dependencies.every((dependency) => created.some((existingItem) => existingItem.itemKey === dependency)));
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
        });
        if (result.value) created.push(result.value);
      }
    }
    if (plan.status === 'DRAFT') this.repositories.plans.updateStatus(planId, 'READY');
    return { graphVersionId: graph.graphVersionId, items: created };
  }
}
