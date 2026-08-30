import { ExecutionLinkRepository } from '../correlation.js';
import { PLAN_LIMITS } from '../planConstants.js';
import type { BatchRecord, PlanRecord, WorkItemRecord } from '../plans.js';
import { PlanRepository } from '../plans.js';
import { reviewVerdict } from '../reviewVerdict.js';
import type { ExecutionLinkRecord } from '../types.js';
import type { WorkspaceProvisioningPort } from '../workspace.js';
import {
  INTEGRATION_REPAIR_BACKEND,
  INTEGRATION_REPAIR_MODEL_CLASS,
  isBatchAggregateReviewItem,
  isIntegrationRepairItem,
  isPostMergeDeliveryRepairItem,
  DEFAULT_PLAN_REVIEW_STRATEGY,
  type PlanReviewStrategy,
} from './kinds.js';
import { PLAN_TERMINAL_EXECUTION_STATUSES, type PlanExecutionPort } from './runtime.js';
import { WorkItemCoordinator } from './workItemCoordinator.js';

export class BatchCoordinator {
  readonly #repository: PlanRepository;
  readonly #links: ExecutionLinkRepository;
  readonly #workspace: WorkspaceProvisioningPort;
  readonly #executions: PlanExecutionPort;
  readonly #workItems: WorkItemCoordinator;
  readonly #reviewStrategy: PlanReviewStrategy;

  constructor(options: {
    repository: PlanRepository;
    links: ExecutionLinkRepository;
    workspace: WorkspaceProvisioningPort;
    executions: PlanExecutionPort;
    workItems: WorkItemCoordinator;
    reviewStrategy?: PlanReviewStrategy;
  }) {
    this.#repository = options.repository;
    this.#links = options.links;
    this.#workspace = options.workspace;
    this.#executions = options.executions;
    this.#workItems = options.workItems;
    this.#reviewStrategy = options.reviewStrategy ?? DEFAULT_PLAN_REVIEW_STRATEGY;
  }

  #allowUnreviewed(plan: PlanRecord): boolean {
    return this.#reviewStrategy === 'BATCH_ONLY' && plan.source.kind !== 'EXTERNAL_CHANGE';
  }

  #scheduleIntegrationRepair(
    plan: PlanRecord,
    batch: BatchRecord,
    items: WorkItemRecord[],
    reason: string,
    message: string,
  ): void {
    const originalItems = items.filter(
      (item) => !isIntegrationRepairItem(item) && !isBatchAggregateReviewItem(item),
    );
    const postMergeFailedRevision =
      originalItems.some(isPostMergeDeliveryRepairItem) && plan.mergeRevision
        ? plan.mergeRevision
        : undefined;
    const sources = originalItems.map((item, index) => {
      const external = this.#workItems.externalAdoptionEvidence(item);
      if (external) {
        return {
          kind: 'external' as const,
          index,
          itemKey: item.key,
          title: item.title,
          acceptanceCriteria: item.acceptanceCriteria,
          approvedRevision: external.revision,
          adoptionRef: external.ref,
        };
      }
      return {
        kind: 'execution' as const,
        index,
        itemKey: item.key,
        title: item.title,
        acceptanceCriteria: item.acceptanceCriteria,
        ...this.#workItems.approvedImplementationEvidence(item, {
          allowUnreviewed: this.#allowUnreviewed(plan),
        }),
      };
    });
    const aggregateReviewFailure = reason === 'BATCH_AGGREGATE_REVIEW_FAILED';
    const baseRevision =
      (aggregateReviewFailure ? batch.integratedRevision : undefined) ??
      batch.baseRevision ??
      plan.currentRevision;
    const sourceInstructions = sources
      .map((source) =>
        [
          `[${source.index}] ${source.itemKey} — ${source.title}`,
          `approved revision: ${source.approvedRevision}`,
          source.kind === 'external'
            ? `baseline: already present through external adoption ref ${source.adoptionRef}`
            : `workspace: ${source.workspaceRef}`,
          aggregateReviewFailure || source.kind === 'external'
            ? ''
            : `fetch: git fetch ${source.workspaceRef} ${source.approvedRevision}:refs/ai-office/incoming/${source.index}`,
          aggregateReviewFailure || source.kind === 'external'
            ? ''
            : `merge: git merge --no-ff --no-edit refs/ai-office/incoming/${source.index}`,
          source.acceptanceCriteria.length
            ? `acceptance: ${source.acceptanceCriteria.join(' | ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');
    const objective = aggregateReviewFailure
      ? [
          `Repair the integrated batch ${batch.key} after the aggregate reviewer found a semantic integration defect.`,
          `The repair workspace starts from integrated candidate revision ${baseRevision}, which already contains every independently reviewed source revision.`,
          'Address the aggregate reviewer findings directly in the combined codebase. Preserve the previously accepted behavior of every ticket while repairing cross-ticket contracts, wiring, ordering, migrations, ownership, or other combined semantics.',
          'Do not reset, revert, or rewrite away an approved ticket merely to make the aggregate review pass.',
          'Run focused regression checks for the reviewer findings and the affected ticket acceptance criteria, then commit the repair and leave the workspace clean.',
          '',
          sourceInstructions,
          '',
          'Aggregate review findings:',
          message.slice(0, PLAN_LIMITS.repairEvidenceCharacters),
        ].join('\n')
      : [
          `Resolve the semantic Git integration conflict for batch ${batch.key}.`,
          `The repair workspace starts from the batch base revision ${baseRevision}.`,
          'Integrate every independently reviewed implementation below into this one workspace. Fetch the exact approved revisions from their sibling workspaces and merge them in the listed order.',
          'Resolve conflicts according to repository contracts and ownership boundaries. Do not discard either side wholesale with ours/theirs merely to make Git clean.',
          'If two implementations made competing architecture choices, inspect the surrounding contracts and tests, choose one coherent ownership model, and adapt both tickets to it while preserving their accepted behavior.',
          'Do not modify the source worktree or sibling implementation workspaces.',
          'All listed approved revisions must remain Git ancestors of the final repair HEAD; the control plane verifies this mechanically before accepting the repair.',
          ...(postMergeFailedRevision
            ? [
                `This integration belongs to a post-merge delivery repair. Fetch/reconcile the current target branch and ensure already-merged revision ${postMergeFailedRevision} is also a Git ancestor of the final repair HEAD; this ancestry is mechanically enforced and cannot be bypassed by a second repair pass.`,
              ]
            : []),
          'Run focused regression tests covering the overlapping files plus the affected ticket acceptance criteria, then commit the resolved integration and leave the workspace clean.',
          '',
          sourceInstructions,
          '',
          `Conflict evidence (${reason}):`,
          message.slice(0, PLAN_LIMITS.errorDetailCharacters),
        ].join('\n');
    const repair = this.#repository.addBatchIntegrationRepairWorkItem(plan.planId, batch.batchId, {
      objective: objective.slice(0, 20_000),
      acceptanceCriteria: [
        'Every independently reviewed source revision is an ancestor of the final repair HEAD.',
        ...(postMergeFailedRevision
          ? [
              `The already-merged target revision ${postMergeFailedRevision} remains a Git ancestor of the final repair HEAD.`,
            ]
          : []),
        'No unresolved Git conflicts remain and the repair workspace is clean with a committed integration result.',
        'The overlapping repository contracts have one coherent architecture rather than duplicated competing implementations.',
        'Focused regression tests for all affected work items pass.',
        'The combined repair is independently reviewed before batch integration is accepted.',
      ],
      evidence: {
        reason,
        message: message.slice(0, PLAN_LIMITS.repairEvidenceCharacters),
        baseRevision,
        postMergeFailedRevision,
        sources: sources.map((source) => ({
          itemKey: source.itemKey,
          approvedRevision: source.approvedRevision,
          ...(source.kind === 'external'
            ? { adoptionRef: source.adoptionRef, sourceKind: 'EXTERNAL_BASELINE' }
            : { workspaceRef: source.workspaceRef, sourceKind: 'EXECUTION' }),
        })),
      },
    });
    if (!repair) {
      const blockedReason = 'BATCH_INTEGRATION_REPAIR_LIMIT_EXCEEDED';
      this.#repository.setBatchStatus(batch.batchId, 'BLOCKED', { blockedReason });
      this.#repository.setPlanStatus(plan.planId, 'BLOCKED', blockedReason);
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_INTEGRATION_BLOCKED',
        {
          reason: blockedReason,
          previousReason: reason,
          message: message.slice(0, PLAN_LIMITS.errorDetailCharacters),
        },
        { batchId: batch.batchId },
      );
      return;
    }
    this.#repository.setBatchStatus(batch.batchId, 'RUNNING');
    this.#repository.setPlanStatus(plan.planId, 'RUNNING');
    this.#repository.appendEvent(
      plan.planId,
      'BATCH_INTEGRATION_REPAIR_SCHEDULED',
      {
        reason,
        workItemKey: repair.key,
        modelClass: INTEGRATION_REPAIR_MODEL_CLASS,
        backend: INTEGRATION_REPAIR_BACKEND,
      },
      { batchId: batch.batchId, workItemId: repair.workItemId },
    );
  }

  async integrate(plan: PlanRecord, batch: BatchRecord, items: WorkItemRecord[]): Promise<void> {
    const originalItems = items.filter(
      (item) => !isIntegrationRepairItem(item) && !isBatchAggregateReviewItem(item),
    );
    const repairItems = items.filter(isIntegrationRepairItem);
    const repairItem = repairItems.at(-1);
    const externalBaseline = new Map(
      originalItems
        .map((item) => [item.workItemId, this.#workItems.externalAdoptionEvidence(item)] as const)
        .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] =>
          Boolean(entry[1]),
        ),
    );
    // External handoff/audit work is already present in the durable baseline.
    // Do not demand a synthetic implementation workspace for it; integrate only
    // work that actually has independent execution lineage. A zero-input batch
    // integration is an intentional no-op that pins a durable batch ref at the
    // current baseline before normal aggregate verification.
    const integrationItems = repairItem
      ? [repairItem]
      : originalItems.filter((item) => !externalBaseline.has(item.workItemId));
    let implementations: Array<{
      workspaceRef: string;
      repositoryRoot: string;
      sourceRevision: string;
      executionId: string;
    }>;
    let requiredAncestorRevisions: string[] | undefined;
    try {
      implementations = integrationItems.map((item) => {
        const evidence = this.#workItems.approvedImplementationEvidence(item, {
          allowUnreviewed: this.#allowUnreviewed(plan),
        });
        return {
          workspaceRef: evidence.workspaceRef,
          repositoryRoot: evidence.repositoryRoot,
          sourceRevision: evidence.sourceRevision,
          executionId: evidence.executionId,
        };
      });
      const postMergeRepairItem = integrationItems.find(isPostMergeDeliveryRepairItem);
      const postMergeFailedRevision =
        (postMergeRepairItem || originalItems.some(isPostMergeDeliveryRepairItem)) &&
        plan.mergeRevision
          ? plan.mergeRevision
          : undefined;
      requiredAncestorRevisions = repairItem
        ? [
            ...new Set([
              ...originalItems.map(
                (item) =>
                  externalBaseline.get(item.workItemId)?.revision ??
                  this.#workItems.approvedImplementationEvidence(item, {
                    allowUnreviewed: this.#allowUnreviewed(plan),
                  }).approvedRevision,
              ),
              ...(postMergeFailedRevision ? [postMergeFailedRevision] : []),
            ]),
          ]
        : postMergeFailedRevision
          ? [postMergeFailedRevision]
          : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'BATCH_INTEGRATION_EVIDENCE_MISSING';
      const reason = message.split(':', 1)[0] ?? 'BATCH_INTEGRATION_EVIDENCE_MISSING';
      this.#repository.setBatchStatus(batch.batchId, 'BLOCKED', { blockedReason: reason });
      this.#repository.setPlanStatus(plan.planId, 'BLOCKED', reason);
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_INTEGRATION_BLOCKED',
        { reason, message: message.slice(0, PLAN_LIMITS.errorDetailCharacters) },
        { batchId: batch.batchId },
      );
      return;
    }
    try {
      const integrated = await this.#workspace.integrateBatch({
        planId: plan.planId,
        batchKey: batch.key,
        repositoryPath: plan.repositoryPath,
        baseRevision: batch.baseRevision ?? plan.currentRevision,
        implementations,
        requiredAncestorRevisions,
      });
      const requiresAggregateReview = this.#allowUnreviewed(plan) || originalItems.length > 1;
      if (requiresAggregateReview) {
        this.#repository.setBatchIntegrationCandidate(
          batch.batchId,
          integrated.revision,
          integrated.ref,
        );
        this.#repository.appendEvent(
          plan.planId,
          'BATCH_INTEGRATION_CANDIDATE',
          {
            revision: integrated.revision,
            ref: integrated.ref,
            repaired: Boolean(repairItem),
            repairWorkItemKey: repairItem?.key,
            aggregateReviewRequired: true,
            externalBaselineItems: originalItems
              .filter((item) => externalBaseline.has(item.workItemId))
              .map((item) => item.key),
          },
          { batchId: batch.batchId },
        );
        return;
      }
      this.#repository.setBatchStatus(batch.batchId, 'SUCCEEDED', {
        integratedRevision: integrated.revision,
        integrationRef: integrated.ref,
      });
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_INTEGRATED',
        {
          revision: integrated.revision,
          ref: integrated.ref,
          repaired: Boolean(repairItem),
          repairWorkItemKey: repairItem?.key,
          aggregateReviewRequired: false,
          externalBaselineItems: originalItems
            .filter((item) => externalBaseline.has(item.workItemId))
            .map((item) => item.key),
        },
        { batchId: batch.batchId },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'BATCH_INTEGRATION_FAILED';
      const reason = message.split(':', 1)[0] ?? 'BATCH_INTEGRATION_FAILED';
      if (
        reason === 'BATCH_INTEGRATION_CONFLICT' ||
        reason === 'BATCH_INTEGRATION_REPAIR_INCOMPLETE'
      ) {
        this.#scheduleIntegrationRepair(plan, batch, items, reason, message);
        return;
      }
      this.#repository.setBatchStatus(batch.batchId, 'BLOCKED', { blockedReason: reason });
      this.#repository.setPlanStatus(plan.planId, 'BLOCKED', reason);
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_INTEGRATION_BLOCKED',
        { reason, message: message.slice(0, PLAN_LIMITS.errorDetailCharacters) },
        { batchId: batch.batchId },
      );
    }
  }

  async reconcileAggregateReview(
    plan: PlanRecord,
    batch: BatchRecord,
    items: WorkItemRecord[],
  ): Promise<void> {
    if (!batch.integratedRevision || !batch.integrationRef) {
      throw new Error('BATCH_INTEGRATION_CANDIDATE_MISSING');
    }
    const originalItems = items.filter(
      (item) => !isIntegrationRepairItem(item) && !isBatchAggregateReviewItem(item),
    );
    if (originalItems.length <= 1 && !this.#allowUnreviewed(plan)) return;
    const acceptanceSummary = originalItems
      .map((item) => {
        const criteria = item.acceptanceCriteria.length
          ? item.acceptanceCriteria.map((criterion) => `  - ${criterion}`).join('\n')
          : '  - (no explicit criterion)';
        return `${item.key} — ${item.title}\n${criteria}`;
      })
      .join('\n\n');
    const objective = [
      `Aggregate-review integrated batch ${batch.key}.`,
      `Batch base revision: ${batch.baseRevision ?? plan.currentRevision}.`,
      `Integrated candidate revision: ${batch.integratedRevision}.`,
      `Integration ref: ${batch.integrationRef}.`,
      'Review the COMBINED artifact for defects that individual ticket reviews cannot see: cross-ticket contract mismatch, duplicate ownership, incompatible architecture choices, host composition/wiring errors, ordering/migration conflicts, state-machine interactions, and regressions caused by the combination.',
      'Inspect the integrated diff from the batch base to the candidate and run focused verification across the overlapping/affected modules.',
      '',
      this.#allowUnreviewed(plan)
        ? 'Batch-review-only strategy is active: implementations below ran their own verification but have not received per-ticket model review. This independent batch review is the approval gate.'
        : 'Individually approved work items and acceptance criteria:',
      acceptanceSummary,
    ].join('\n');
    const aggregateItem = this.#repository.addBatchAggregateReviewWorkItem(
      plan.planId,
      batch.batchId,
      {
        candidateRevision: batch.integratedRevision,
        objective: objective.slice(0, 20_000),
        acceptanceCriteria: [
          'The integrated candidate preserves every work-item acceptance criterion.',
          'Cross-ticket contracts, ownership boundaries, dependency injection/composition, migrations, and state transitions are coherent as a combined artifact.',
          'No blocking regression is introduced by the implemented changes individually or by their combination.',
          'At least one focused aggregate verification command is executed against the integrated candidate.',
        ],
      },
    );
    const executionIds = this.#repository.executionIds(aggregateItem.workItemId);
    if (executionIds.length === 0) {
      await this.#workItems.launch(plan, batch, aggregateItem, 'BATCH_VERIFY', undefined, 1);
      return;
    }
    const records = executionIds
      .map((executionId) => this.#links.get(executionId))
      .filter((record): record is ExecutionLinkRecord => Boolean(record));
    const latest = records.at(-1);
    if (!latest) return;
    const snapshot = await this.#executions.get(latest.executionId);
    if (!snapshot || !PLAN_TERMINAL_EXECUTION_STATUSES.has(snapshot.status)) return;
    if (snapshot.status !== 'SUCCEEDED') {
      const attempts = records.filter((record) => record.phase === 'BATCH_VERIFY').length;
      const limit = snapshot.error?.retryable
        ? this.#workItems.retryAttemptLimit('BATCH_VERIFY')
        : PLAN_LIMITS.transportAttemptsPerParent;
      if (attempts < limit) {
        await this.#workItems.launch(
          plan,
          batch,
          aggregateItem,
          'BATCH_VERIFY',
          undefined,
          attempts + 1,
          this.#workItems.retryOverride('BATCH_VERIFY', records, {
            advanceModel: snapshot.error?.retryable === true,
          }),
        );
        return;
      }
      this.#workItems.block(
        plan.planId,
        batch.batchId,
        aggregateItem.workItemId,
        `BATCH_VERIFY_${snapshot.status}`,
        latest.executionId,
      );
      return;
    }
    const result = snapshot.result?.finalText ?? '';
    const verdict = reviewVerdict(result);
    if (verdict === 'UNKNOWN') {
      const attempts = records.filter((record) => record.phase === 'BATCH_VERIFY').length;
      if (attempts < this.#workItems.retryAttemptLimit('BATCH_VERIFY')) {
        await this.#workItems.launch(
          plan,
          batch,
          aggregateItem,
          'BATCH_VERIFY',
          undefined,
          attempts + 1,
          this.#workItems.retryOverride('BATCH_VERIFY', records),
        );
        return;
      }
      this.#workItems.block(
        plan.planId,
        batch.batchId,
        aggregateItem.workItemId,
        'BATCH_VERIFY_VERDICT_UNKNOWN',
        latest.executionId,
      );
      return;
    }
    this.#repository.setWorkItemStatus(aggregateItem.workItemId, 'SUCCEEDED');
    if (verdict === 'BLOCKING') {
      this.#repository.appendEvent(
        plan.planId,
        'BATCH_AGGREGATE_REVIEW_FAILED',
        {
          revision: batch.integratedRevision,
          findings: result.slice(0, PLAN_LIMITS.repairEvidenceCharacters),
        },
        {
          batchId: batch.batchId,
          workItemId: aggregateItem.workItemId,
          executionId: latest.executionId,
        },
      );
      this.#scheduleIntegrationRepair(plan, batch, items, 'BATCH_AGGREGATE_REVIEW_FAILED', result);
      return;
    }
    this.#repository.promoteBatchIntegration(batch.batchId);
    this.#repository.appendEvent(
      plan.planId,
      'BATCH_AGGREGATE_VERIFIED',
      { revision: batch.integratedRevision },
      {
        batchId: batch.batchId,
        workItemId: aggregateItem.workItemId,
        executionId: latest.executionId,
      },
    );
    this.#repository.appendEvent(
      plan.planId,
      'BATCH_INTEGRATED',
      {
        revision: batch.integratedRevision,
        ref: batch.integrationRef,
        aggregateReviewRequired: true,
        aggregateReviewExecutionId: latest.executionId,
      },
      { batchId: batch.batchId },
    );
  }
}
