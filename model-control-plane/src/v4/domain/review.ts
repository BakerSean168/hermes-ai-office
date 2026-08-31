import { InvalidTransitionError, failClosed } from './errors.js';

export const REVIEW_STATUSES = ['PENDING', 'RUNNING', 'PASSED', 'FAILED', 'STALE', 'CANCELLED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface Review {
  reviewId: string;
  planId: string;
  workItemId?: string;
  implementationExecutionId: string;
  reviewerExecutionId?: string;
  sourceRevision: string;
  reviewedSha: string;
  status: ReviewStatus;
  verdict?: 'PASS' | 'FAIL' | 'INVALID';
  findings?: string[];
  createdAt: string;
  updatedAt: string;
}

const TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  PENDING: ['RUNNING', 'CANCELLED', 'STALE'],
  RUNNING: ['PASSED', 'FAILED', 'STALE', 'CANCELLED'],
  PASSED: [],
  FAILED: ['PENDING', 'CANCELLED', 'STALE'],
  STALE: ['PENDING', 'CANCELLED'],
  CANCELLED: [],
};

export function isTerminalReviewStatus(status: ReviewStatus): boolean {
  return status === 'PASSED' || status === 'CANCELLED';
}

export function transitionReview(review: Review, next: ReviewStatus, now: string): Review {
  if (review.status === next) return { ...review, updatedAt: now };
  if (!TRANSITIONS[review.status].includes(next)) {
    throw new InvalidTransitionError('Review', review.status, next);
  }
  return { ...review, status: next, updatedAt: now };
}

export function validateReviewLineage(review: Pick<Review, 'implementationExecutionId' | 'sourceRevision' | 'reviewedSha'>): void {
  failClosed(review.implementationExecutionId.length > 0, 'REVIEW_IMPLEMENTATION_REQUIRED');
  failClosed(review.sourceRevision.length > 0, 'REVIEW_SOURCE_REVISION_REQUIRED');
  failClosed(review.reviewedSha === review.sourceRevision, 'REVIEW_SHA_MISMATCH');
}
