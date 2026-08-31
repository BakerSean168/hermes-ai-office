import { V4Error } from '../domain/errors.js';
import { validateGraphItems, type WorkItem } from '../domain/workGraph.js';
import type { V4Repositories } from '../persistence/repositories.js';

export class WorkGraphKernel {
  constructor(readonly repositories: V4Repositories) {}

  replanRemainder(input: {
    planId: string;
    reason: string;
    observationCursor: number;
    items: Array<{ itemKey: string; title: string; objective: string; dependencies: string[]; acceptanceCriteria: string[] }>;
  }): { graphVersionId: string; items: WorkItem[] } {
    validateGraphItems(input.items);
    const old = this.repositories.plans.getActiveGraphVersion(input.planId);
    if (old) this.repositories.plans.rejectCompletedWorkRemoval(old.graphVersionId, input.items.map((item) => item.itemKey));
    const graph = this.repositories.plans.createGraphVersion({
      planId: input.planId,
      reason: input.reason,
      parentGraphVersionId: old?.graphVersionId,
      triggeringObservationCursor: input.observationCursor,
    }).value;
    if (!graph) throw new V4Error('GRAPH_CREATE_FAILED');
    const items: WorkItem[] = [];
    const pending = [...input.items];
    const createdKeys = new Set<string>();
    while (pending.length > 0) {
      const ready = pending.filter((item) => item.dependencies.every((dependency) => createdKeys.has(dependency)));
      if (ready.length === 0) throw new V4Error('GRAPH_DEPENDENCY_CYCLE');
      for (const item of ready) {
        pending.splice(pending.indexOf(item), 1);
        const created = this.repositories.plans.appendGraphWorkItem({ ...item, graphVersionId: graph.graphVersionId });
        if (created.value) {
          items.push(created.value);
          createdKeys.add(item.itemKey);
        }
      }
    }
    return { graphVersionId: graph.graphVersionId, items };
  }

  updateWorkItem(workItemId: string, status: WorkItem['status']): WorkItem {
    const result = this.repositories.plans.updateWorkItemStatus(workItemId, status);
    if (!result.value) throw new V4Error('WORK_ITEM_UPDATE_FAILED');
    return result.value;
  }
}
