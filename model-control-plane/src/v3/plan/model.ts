import type { DeliveryStage, PlanDeliveryConfig } from '../delivery.js';

export type PlanStatus =
  'ORCHESTRATING' | 'PENDING' | 'RUNNING' | 'BLOCKED' | 'SUCCEEDED' | 'CANCELLED';
export type PlanNodeStatus = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'SUCCEEDED' | 'CANCELLED';

export interface DelegatePlanInput {
  projectKey: string;
  objective: string;
  repository: { path: string; baseRevision?: string };
  delivery?: Partial<PlanDeliveryConfig> & Pick<PlanDeliveryConfig, 'branch'>;
}

export interface CreatePlanInput {
  projectKey: string;
  objective: string;
  analysisSummary: string;
  repository: { path: string; baseRevision?: string };
  delivery?: Partial<PlanDeliveryConfig> & Pick<PlanDeliveryConfig, 'branch'>;
  batches: Array<{
    key: string;
    title: string;
    dependsOn?: string[];
    workItems: Array<{
      key: string;
      title: string;
      objective: string;
      acceptanceCriteria?: string[];
    }>;
  }>;
}

export interface PlanRecord {
  planId: string;
  commandKey: string;
  projectKey: string;
  objective: string;
  repositoryPath: string;
  baseRevision: string;
  currentRevision: string;
  delivery?: PlanDeliveryConfig;
  deliveryStage?: DeliveryStage;
  deliveryEvidence?: Record<string, unknown>;
  pullRequestUrl?: string;
  mergeRevision?: string;
  status: PlanStatus;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BatchRecord {
  batchId: string;
  planId: string;
  key: string;
  title: string;
  ordinal: number;
  dependsOn: string[];
  status: PlanNodeStatus;
  baseRevision?: string;
  integratedRevision?: string;
  integrationRef?: string;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkItemRecord {
  workItemId: string;
  planId: string;
  batchId: string;
  key: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  ordinal: number;
  status: PlanNodeStatus;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export function validatePlanEnvelope(input: DelegatePlanInput): void {
  if (!input.projectKey.trim()) throw new Error('PROJECT_KEY_REQUIRED');
  if (!input.objective.trim()) throw new Error('OBJECTIVE_REQUIRED');
  if (!input.repository.path.trim()) throw new Error('REPOSITORY_PATH_REQUIRED');
  if (input.delivery) {
    if (!input.delivery.branch.trim()) throw new Error('DELIVERY_BRANCH_REQUIRED');
    if (input.delivery.autoMerge !== true) throw new Error('DELIVERY_AUTO_MERGE_AUTHORIZATION_REQUIRED');
    if (
      input.delivery.mergeMethod &&
      !['merge', 'squash', 'rebase'].includes(input.delivery.mergeMethod)
    ) {
      throw new Error('DELIVERY_MERGE_METHOD_INVALID');
    }
  }
}

export function validatePlanGraph(input: CreatePlanInput): void {
  validatePlanEnvelope(input);
  if (!input.analysisSummary.trim()) throw new Error('PLAN_ANALYSIS_REQUIRED');
  if (input.batches.length === 0) throw new Error('PLAN_BATCHES_REQUIRED');

  const batchKeys = new Set<string>();
  const itemKeys = new Set<string>();
  for (const batch of input.batches) {
    if (!batch.key.trim() || batchKeys.has(batch.key)) throw new Error('PLAN_BATCH_KEY_INVALID');
    batchKeys.add(batch.key);
    if (batch.workItems.length === 0) throw new Error('PLAN_WORK_ITEMS_REQUIRED');
    for (const item of batch.workItems) {
      if (!item.key.trim() || itemKeys.has(item.key)) throw new Error('PLAN_WORK_ITEM_KEY_INVALID');
      itemKeys.add(item.key);
      if (!item.objective.trim()) throw new Error('PLAN_WORK_ITEM_OBJECTIVE_REQUIRED');
    }
  }
  for (const batch of input.batches) {
    if ((batch.dependsOn ?? []).some((dependency) => !batchKeys.has(dependency))) {
      throw new Error('PLAN_DEPENDENCY_NOT_FOUND');
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(input.batches.map((batch) => [batch.key, batch]));
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error('PLAN_DEPENDENCY_CYCLE');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of batchKeys) visit(key);
}
