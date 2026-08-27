import { PlanRepository } from '../plans.js';
import type { WorkspaceProvisioningPort } from '../workspace.js';
import { parsePlanHandoff, type PlanHandoffV1 } from './handoff.js';
import { isBatchAggregateReviewItem, isIntegrationRepairItem, isPostMergeDeliveryRepairItem } from './kinds.js';

export class HandoffReconciler {
  readonly #repository: PlanRepository;
  readonly #workspace: WorkspaceProvisioningPort;

  constructor(options: { repository: PlanRepository; workspace: WorkspaceProvisioningPort }) {
    this.#repository = options.repository;
    this.#workspace = options.workspace;
  }

  async resume(planId: string, rawHandoff: unknown): Promise<{
    handoff: PlanHandoffV1;
    adoptedWorkItems: string[];
    adoptedBatches: string[];
    aheadBy: number;
  }> {
    const plan = this.#repository.get(planId);
    if (!plan) throw new Error('PLAN_NOT_FOUND');
    if (plan.status !== 'BLOCKED') throw new Error('HANDOFF_PLAN_NOT_BLOCKED');
    const blockedBatch = this.#repository
      .batches(planId)
      .find((batch) => batch.status === 'BLOCKED');
    if (!blockedBatch) throw new Error('HANDOFF_BLOCKED_BATCH_MISSING');

    const handoff = parsePlanHandoff(rawHandoff, planId);
    if (handoff.baseRevision !== plan.currentRevision.toLowerCase()) {
      throw new Error('HANDOFF_BASE_REVISION_MISMATCH');
    }
    if (!this.#workspace.verifyExternalHandoff) {
      throw new Error('HANDOFF_VERIFICATION_UNAVAILABLE');
    }

    const knownItems = new Map(
      this.#repository
        .batches(planId)
        .flatMap((batch) => this.#repository.workItems(batch.batchId))
        .map((item) => [item.key, item] as const),
    );
    for (const completed of handoff.completedWorkItems) {
      const item = knownItems.get(completed.key);
      if (!item) throw new Error('HANDOFF_WORK_ITEM_UNKNOWN');
      if (
        isIntegrationRepairItem(item) ||
        isBatchAggregateReviewItem(item) ||
        isPostMergeDeliveryRepairItem(item)
      ) {
        throw new Error('HANDOFF_SYSTEM_WORK_ITEM_NOT_ALLOWED');
      }
      if (item.status === 'CANCELLED') throw new Error('HANDOFF_WORK_ITEM_CANCELLED');
    }
    if (handoff.recommendedNextWorkItem && !knownItems.has(handoff.recommendedNextWorkItem)) {
      throw new Error('HANDOFF_NEXT_WORK_ITEM_UNKNOWN');
    }

    const verification = await this.#workspace.verifyExternalHandoff({
      repositoryPath: plan.repositoryPath,
      baseRevision: handoff.baseRevision,
      headRevision: handoff.headRevision,
      ref: handoff.ref,
    });
    const ref = verification.ref ?? handoff.headRevision;
    this.#repository.appendEvent(planId, 'HANDOFF_VALIDATED', {
      schemaVersion: handoff.schemaVersion,
      baseRevision: handoff.baseRevision,
      headRevision: handoff.headRevision,
      ref,
      aheadBy: verification.aheadBy,
      completedWorkItems: handoff.completedWorkItems.map((item) => item.key),
      recommendedNextWorkItem: handoff.recommendedNextWorkItem ?? null,
      attestation: 'OPERATOR_SUBMITTED',
    });

    const result = this.#repository.adoptExternalProgress(planId, {
      revision: handoff.headRevision,
      ref,
      blockedBatchKey: blockedBatch.key,
      verifiedWorkItems: handoff.completedWorkItems.map((item) => ({
        key: item.key,
        evidence:
          item.evidence.join('\n').trim() ||
          `Operator-submitted AI_OFFICE_HANDOFF_V1 attests ${item.key} complete at ${handoff.headRevision}.`,
      })),
      analysisSummary:
        handoff.summary ??
        `Operator-submitted AI_OFFICE_HANDOFF_V1 adopts ${verification.aheadBy} committed descendant change(s) without a model-backed repository audit.`,
      evidenceSource: 'HANDOFF',
    });
    this.#repository.appendEvent(planId, 'HANDOFF_ADOPTED', {
      revision: handoff.headRevision,
      ref,
      aheadBy: verification.aheadBy,
      adoptedWorkItems: result.adoptedWorkItems,
      adoptedBatches: result.adoptedBatches,
      recommendedNextWorkItem: handoff.recommendedNextWorkItem ?? null,
      attestation: 'OPERATOR_SUBMITTED',
    });
    return { handoff, ...result, aheadBy: verification.aheadBy };
  }
}
