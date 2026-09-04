import { V4Error, failClosed } from './errors.js';

export const DELIVERY_STATUSES = [
  'PENDING',
  'PUSHED',
  'PR_OPEN',
  'CHECKS_PENDING',
  'CHECKS_FAILED',
  'SUPERSEDED_PENDING_CHILD',
  'READY_TO_MERGE',
  'MERGED',
  'VERIFIED',
  'SUPERSEDED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DeliveryMergeMethod = 'merge' | 'squash' | 'rebase';

export interface PlanDeliveryConfig {
  remote: string;
  branch: string;
  targetBranch: string;
  autoMerge: boolean;
  mergeMethod: DeliveryMergeMethod;
  requiredChecks: string[];
}

export interface PlanDelivery extends PlanDeliveryConfig {
  planId: string;
  status: DeliveryStatus;
  headSha?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  mergeSha?: string;
  errorCode?: string;
  supersededByPlanId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryObservation {
  status: DeliveryStatus;
  headSha?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  mergeSha?: string;
  errorCode?: string;
}

export function validatePlanDeliveryConfig(config: PlanDeliveryConfig): void {
  failClosed(config.remote.trim().length > 0 && config.remote.length <= 200, 'DELIVERY_REMOTE_REQUIRED');
  failClosed(config.branch.trim().length > 0 && config.branch.length <= 500, 'DELIVERY_BRANCH_REQUIRED');
  failClosed(config.targetBranch.trim().length > 0 && config.targetBranch.length <= 500, 'DELIVERY_TARGET_BRANCH_REQUIRED');
  failClosed(config.branch !== config.targetBranch, 'DELIVERY_BRANCH_TARGET_CONFLICT');
  failClosed(['merge', 'squash', 'rebase'].includes(config.mergeMethod), 'DELIVERY_MERGE_METHOD_INVALID');
  failClosed(Array.isArray(config.requiredChecks) && config.requiredChecks.length <= 100, 'DELIVERY_REQUIRED_CHECKS_INVALID');
  const checks = config.requiredChecks.map((item) => item.trim());
  failClosed(checks.every((item) => item.length > 0 && item.length <= 500), 'DELIVERY_REQUIRED_CHECKS_INVALID');
  failClosed(new Set(checks).size === checks.length, 'DELIVERY_REQUIRED_CHECKS_DUPLICATE');
}

export function isDeliveryComplete(delivery: PlanDelivery | undefined): boolean {
  return delivery?.status === 'VERIFIED' || delivery?.status === 'SUPERSEDED';
}

// Legacy low-level delivery policy kept for the kernel/governance surface. Plan delivery
// automation uses PlanDeliveryConfig/PlanDelivery above as its durable contract.
export interface DeliveryPolicy {
  targetRepository: string;
  baseBranch: string;
  expectedHeadSha?: string;
  requiredChecks: string[];
  autoMerge: boolean;
  deploymentEnabled: boolean;
}

export interface DeliveryEvidence {
  approvedSha: string;
  reviewId: string;
  requiredChecks: Array<{ name: string; conclusion: 'SUCCESS' | 'FAILURE' | 'PENDING' }>;
  verifiedAt: string;
  mergeAttempted: boolean;
  postMergeVerified: boolean;
  rollbackEvidenceRef?: string;
}

export function assertDeliveryGate(policy: DeliveryPolicy, evidence: DeliveryEvidence, currentHeadSha: string): void {
  failClosed(policy.autoMerge, 'DELIVERY_AUTHORIZATION_REQUIRED');
  failClosed(evidence.approvedSha === currentHeadSha, 'DELIVERY_SHA_STALE');
  if (policy.expectedHeadSha !== undefined && policy.expectedHeadSha !== currentHeadSha) {
    throw new V4Error('DELIVERY_EXPECTED_SHA_MISMATCH');
  }
  failClosed(evidence.reviewId.length > 0, 'DELIVERY_REVIEW_REQUIRED');
  failClosed(evidence.requiredChecks.every((check) => check.conclusion === 'SUCCESS'), 'DELIVERY_CHECKS_REQUIRED');
  failClosed(!evidence.mergeAttempted, 'DELIVERY_ALREADY_ATTEMPTED');
}
