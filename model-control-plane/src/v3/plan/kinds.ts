import type { WorkItemRecord } from '../plans.js';

export const INTEGRATION_REPAIR_ITEM_PREFIX = 'integration-repair-b';
export const BATCH_AGGREGATE_REVIEW_ITEM_PREFIX = 'batch-verify-b';
export const POST_MERGE_DELIVERY_REPAIR_ITEM_PREFIX = 'post-merge-fix-';
export const INTEGRATION_REPAIR_BACKEND = 'openhands-builtin';
export const INTEGRATION_REPAIR_MODEL_CLASS = 'gpt-5.6-sol';

export type PlanRecoveryMode = 'AUTO' | 'RETRY_REVIEW' | 'RETRY_DELIVERY' | 'SYNC_EXTERNAL';

export function isIntegrationRepairItem(item: Pick<WorkItemRecord, 'key'>): boolean {
  return item.key.startsWith(INTEGRATION_REPAIR_ITEM_PREFIX);
}

export function isBatchAggregateReviewItem(item: Pick<WorkItemRecord, 'key'>): boolean {
  return item.key.startsWith(BATCH_AGGREGATE_REVIEW_ITEM_PREFIX);
}

export function isPostMergeDeliveryRepairItem(item: Pick<WorkItemRecord, 'key'>): boolean {
  return item.key.startsWith(POST_MERGE_DELIVERY_REPAIR_ITEM_PREFIX);
}
