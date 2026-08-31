import { V4Error, failClosed } from './errors.js';

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
