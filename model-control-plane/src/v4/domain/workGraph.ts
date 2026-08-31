import { InvalidTransitionError, V4Error, failClosed } from './errors.js';

export const WORK_ITEM_STATUSES = [
  'PENDING', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'SUPERSEDED',
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export interface WorkItem {
  workItemId: string;
  planId: string;
  graphVersionId: string;
  itemKey: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  status: WorkItemStatus;
  exactAcceptedRevision?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GraphVersion {
  graphVersionId: string;
  planId: string;
  version: number;
  parentGraphVersionId?: string;
  reason: string;
  triggeringObservationCursor?: number;
  status: 'ACTIVE' | 'SUPERSEDED';
  createdAt: string;
}

export interface ParentChildRelationship {
  relationshipId: string;
  parentPlanId: string;
  childPlanId: string;
  kind: 'SYSTEM_REPAIR' | 'INFRASTRUCTURE_REPAIR' | 'FOLLOW_UP';
  createdAt: string;
}

const TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  PENDING: ['READY', 'RUNNING', 'CANCELLED', 'SUPERSEDED'],
  READY: ['RUNNING', 'CANCELLED', 'SUPERSEDED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: ['READY', 'CANCELLED'],
  BLOCKED: ['READY', 'CANCELLED', 'SUPERSEDED'],
  CANCELLED: [],
  SUPERSEDED: [],
};

export function isTerminalWorkItemStatus(status: WorkItemStatus): boolean {
  return status === 'SUCCEEDED' || status === 'CANCELLED' || status === 'SUPERSEDED';
}

export function transitionWorkItem(item: WorkItem, next: WorkItemStatus, now: string): WorkItem {
  if (item.status === next) return { ...item, updatedAt: now };
  if (!TRANSITIONS[item.status].includes(next)) {
    throw new InvalidTransitionError('WorkItem', item.status, next);
  }
  return { ...item, status: next, updatedAt: now };
}

export function validateGraphItems(items: readonly Pick<WorkItem, 'itemKey' | 'dependencies'>[]): void {
  const names = new Set<string>();
  const graph = new Map<string, string[]>();
  for (const item of items) {
    failClosed(item.itemKey.trim().length > 0, 'GRAPH_ITEM_KEY_REQUIRED');
    failClosed(!names.has(item.itemKey), 'GRAPH_DUPLICATE_ITEM');
    names.add(item.itemKey);
    graph.set(item.itemKey, item.dependencies);
  }
  for (const [key, dependencies] of graph) {
    for (const dependency of dependencies) {
      failClosed(graph.has(dependency), 'GRAPH_DEPENDENCY_NOT_FOUND');
      failClosed(dependency !== key, 'GRAPH_SELF_DEPENDENCY');
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new V4Error('GRAPH_CYCLE', 'Graph dependency cycle at ' + key);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of graph.keys()) visit(key);
}
