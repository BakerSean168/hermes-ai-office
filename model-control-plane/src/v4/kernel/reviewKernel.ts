import { V4Error } from '../domain/errors.js';
import type { Review } from '../domain/review.js';
import type { V4Repositories, MutationResult } from '../persistence/repositories.js';

export class ReviewKernel {
  constructor(readonly repositories: V4Repositories) {}

  request(input: {
    reviewId?: string;
    idempotencyKey: string;
    planId: string;
    workItemId?: string;
    implementationExecutionId: string;
    sourceRevision: string;
    reviewerExecutionId?: string;
  }): MutationResult<Review> {
    return this.repositories.reviews.create(input);
  }

  start(reviewId: string): MutationResult<Review> {
    return this.repositories.reviews.updateStatus(reviewId, 'RUNNING');
  }

  verdict(reviewId: string, verdict: 'PASS' | 'FAIL' | 'INVALID', findings: string[] = []): MutationResult<Review> {
    const review = this.repositories.reviews.getById(reviewId);
    if (verdict === 'PASS' && review.sourceRevision !== review.reviewedSha) throw new V4Error('REVIEW_EXACT_SHA_REQUIRED');
    return this.repositories.reviews.recordVerdict(reviewId, verdict, findings);
  }
}
