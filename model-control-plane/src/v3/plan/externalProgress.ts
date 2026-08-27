import type { BatchRecord, PlanRecord } from '../plans.js';
import { PlanRepository } from '../plans.js';
import type { ExternalProgressCandidate, WorkspaceProvisioningPort } from '../workspace.js';
import { parseExternalProgressAudit } from './protocol.js';
import { PLAN_TERMINAL_EXECUTION_STATUSES, type PlanExecutionPort } from './runtime.js';

const EXTERNAL_PROGRESS_AUDIT_BACKEND = 'openhands-builtin';
const EXTERNAL_PROGRESS_AUDIT_MODEL_CLASS = 'gpt-5.6-sol';

type ExternalProgressTarget = {
  key: string;
  title: string;
  status: string;
  objective: string;
  acceptanceCriteria: string[];
};
const EXTERNAL_PROGRESS_TERMINAL_EVENTS = new Set([
  'EXTERNAL_PROGRESS_SYNC_FAILED',
  'EXTERNAL_PROGRESS_SYNC_REJECTED',
  'EXTERNAL_PROGRESS_CANDIDATE_MOVED',
  'EXTERNAL_PROGRESS_ADOPTED',
]);

export class ExternalProgressReconciler {
  readonly #repository: PlanRepository;
  readonly #workspace: WorkspaceProvisioningPort;
  readonly #executions: PlanExecutionPort;

  constructor(options: {
    repository: PlanRepository;
    workspace: WorkspaceProvisioningPort;
    executions: PlanExecutionPort;
  }) {
    this.#repository = options.repository;
    this.#workspace = options.workspace;
    this.#executions = options.executions;
  }

  #pendingSync(planId: string): Record<string, unknown> | undefined {
    const events = this.#repository.events(planId);
    const started = [...events].reverse().find((event) => event.type === 'EXTERNAL_PROGRESS_SYNC_STARTED');
    if (!started) return undefined;
    const startedId = Number(started.eventId ?? 0);
    const closed = events.some(
      (event) => Number(event.eventId ?? 0) > startedId && EXTERNAL_PROGRESS_TERMINAL_EVENTS.has(String(event.type)),
    );
    return closed ? undefined : started;
  }

  hasPendingAudit(planId: string): boolean {
    return Boolean(this.#pendingSync(planId));
  }

  #targets(plan: PlanRecord, blockedBatch: BatchRecord) {
    const batches = this.#repository.batches(plan.planId);
    const allItems = batches.flatMap((batch) => this.#repository.workItems(batch.batchId));
    const targetItems = batches
      .filter((batch) => batch.ordinal >= blockedBatch.ordinal && batch.status !== 'CANCELLED')
      .flatMap((batch) => this.#repository.workItems(batch.batchId))
      .filter((item) => item.status !== 'CANCELLED');
    return {
      allItems,
      targetKeys: new Set(targetItems.map((item) => item.key)),
      targets: targetItems.map((item) => ({
        key: item.key,
        title: item.title,
        status: item.status,
        objective: item.objective.slice(0, 1_600),
        acceptanceCriteria: item.acceptanceCriteria,
      })),
    };
  }

  #objective(
    plan: PlanRecord,
    blockedBatch: BatchRecord,
    candidate: ExternalProgressCandidate,
    targets: ExternalProgressTarget[],
  ): string {
    const schemaExample = JSON.stringify({
      candidateRevision: candidate.revision,
      safeToAdopt: true,
      analysisSummary: 'Repository-backed assessment of the external continuation.',
      blockedBatch: {
        key: blockedBatch.key,
        resolved: true,
        evidence: 'Evidence that the previously blocked batch is coherently integrated.',
      },
      workItems: targets.map((item) => ({
        key: item.key,
        status: 'VERIFIED_COMPLETE',
        evidence: 'Concrete code/test evidence for this work item.',
      })),
      risks: [],
    });
    return [
      'Reconcile externally completed engineering work back into this durable Pixel Agent plan before continuing.',
      `Durable plan: ${plan.planId}`,
      `Previous durable revision: ${plan.currentRevision}`,
      `Mechanically selected descendant ref: ${candidate.ref}`,
      `Candidate revision: ${candidate.revision}`,
      `Commits ahead: ${candidate.aheadBy}`,
      `Previously blocked batch: ${blockedBatch.key} (${plan.blockedReason ?? blockedBatch.blockedReason ?? 'BLOCKED'})`,
      '',
      'Mechanically observed commit subjects:',
      ...candidate.commitSubjects.map((subject) => `- ${subject}`),
      '',
      'Work items that must be checked against repository evidence:',
      JSON.stringify(targets),
      '',
      'Rules:',
      '- Keep the repository read-only. Inspect the candidate revision, active plan docs, diffs, implementation, and focused tests where practical.',
      '- Commit messages are discovery hints only; never mark a work item complete from its subject alone.',
      '- VERIFIED_COMPLETE requires concrete repository evidence that the supplied acceptance criteria are satisfied at the candidate revision.',
      '- blockedBatch.resolved may be true only if the combined candidate resolves the former integration block and preserves the already-reviewed work together.',
      '- safeToAdopt may be true only if this candidate is a coherent continuation of the durable revision and adopting the whole candidate as the new baseline is safe.',
      '- If evidence is incomplete, use NOT_VERIFIED. Do not invent completion.',
      '- Return only one JSON object with camelCase fields exactly matching this shape:',
      schemaExample,
    ].join('\n');
  }

  async #applyCompletedAudit(
    plan: PlanRecord,
    blockedBatch: BatchRecord,
    candidate: ExternalProgressCandidate,
    executionId: string,
    finalText: string,
    targetKeys: Set<string>,
    allItemKeys: string[],
  ): Promise<void> {
    let audit;
    try {
      audit = parseExternalProgressAudit(finalText, candidate.revision, blockedBatch.key, targetKeys);
    } catch (error) {
      this.#repository.appendEvent(
        plan.planId,
        'EXTERNAL_PROGRESS_SYNC_FAILED',
        {
          reason: error instanceof Error ? error.message : String(error),
          candidateRevision: candidate.revision,
        },
        { batchId: blockedBatch.batchId, executionId },
      );
      return;
    }
    if (!audit.safeToAdopt || !audit.blockedBatch.resolved) {
      this.#repository.appendEvent(
        plan.planId,
        'EXTERNAL_PROGRESS_SYNC_REJECTED',
        {
          candidateRevision: candidate.revision,
          candidateRef: candidate.ref,
          safeToAdopt: audit.safeToAdopt,
          blockedBatchResolved: audit.blockedBatch.resolved,
          blockedBatchEvidence: audit.blockedBatch.evidence,
          risks: audit.risks,
        },
        { batchId: blockedBatch.batchId, executionId },
      );
      return;
    }
    const currentCandidate = await this.#workspace.discoverExternalProgress!({
      repositoryPath: plan.repositoryPath,
      currentRevision: plan.currentRevision,
      workItemKeys: allItemKeys,
    });
    if (!currentCandidate || currentCandidate.revision !== candidate.revision) {
      this.#repository.appendEvent(
        plan.planId,
        'EXTERNAL_PROGRESS_CANDIDATE_MOVED',
        {
          auditedRevision: candidate.revision,
          auditedRef: candidate.ref,
          currentRevision: currentCandidate?.revision ?? null,
          currentRef: currentCandidate?.ref ?? null,
          reason: 'EXTERNAL_PROGRESS_CHANGED_DURING_AUDIT',
        },
        { batchId: blockedBatch.batchId, executionId },
      );
      return;
    }
    const verifiedWorkItems = audit.workItems
      .filter((item) => item.status === 'VERIFIED_COMPLETE')
      .map((item) => ({ key: item.key, evidence: item.evidence }));
    this.#repository.adoptExternalProgress(plan.planId, {
      revision: candidate.revision,
      ref: candidate.ref,
      blockedBatchKey: blockedBatch.key,
      verifiedWorkItems,
      auditExecutionId: executionId,
      analysisSummary: audit.analysisSummary,
      evidenceSource: 'AUDIT',
    });
  }

  async #harvestPending(
    plan: PlanRecord,
    blockedBatch: BatchRecord,
    pending: Record<string, unknown>,
    targetKeys: Set<string>,
    allItemKeys: string[],
  ): Promise<boolean> {
    const executionId = String(pending.executionId ?? '').trim();
    const detail =
      pending.detail && typeof pending.detail === 'object' && !Array.isArray(pending.detail)
        ? (pending.detail as Record<string, unknown>)
        : {};
    const revision = String(detail.candidateRevision ?? '').trim();
    const ref = String(detail.candidateRef ?? '').trim();
    if (!executionId || !revision || !ref) {
      this.#repository.appendEvent(plan.planId, 'EXTERNAL_PROGRESS_SYNC_FAILED', {
        reason: 'EXTERNAL_PROGRESS_PENDING_EVIDENCE_INVALID',
        candidateRevision: revision || null,
      });
      return true;
    }
    const snapshot = await this.#executions.get(executionId);
    if (!snapshot) {
      this.#repository.appendEvent(
        plan.planId,
        'EXTERNAL_PROGRESS_SYNC_FAILED',
        { reason: 'EXTERNAL_PROGRESS_AUDIT_EXECUTION_MISSING', candidateRevision: revision },
        { batchId: blockedBatch.batchId, executionId },
      );
      return true;
    }
    if (!PLAN_TERMINAL_EXECUTION_STATUSES.has(snapshot.status)) return true;
    if (snapshot.status !== 'SUCCEEDED' || !snapshot.result?.finalText) {
      this.#repository.appendEvent(
        plan.planId,
        'EXTERNAL_PROGRESS_SYNC_FAILED',
        {
          reason: snapshot.error?.code ?? `EXTERNAL_PROGRESS_AUDIT_${snapshot.status}`,
          candidateRevision: revision,
        },
        { batchId: blockedBatch.batchId, executionId },
      );
      return true;
    }
    await this.#applyCompletedAudit(
      plan,
      blockedBatch,
      {
        revision,
        ref,
        aheadBy: Number(detail.aheadBy ?? 0),
        matchedWorkItemKeys: Array.isArray(detail.matchedWorkItemKeys)
          ? detail.matchedWorkItemKeys.map(String)
          : [],
        commitSubjects: [],
      },
      executionId,
      snapshot.result.finalText,
      targetKeys,
      allItemKeys,
    );
    return true;
  }

  async reconcile(plan: PlanRecord, blockedBatch: BatchRecord): Promise<boolean> {
    if (!this.#workspace.discoverExternalProgress) {
      this.#repository.appendEvent(plan.planId, 'EXTERNAL_PROGRESS_SYNC_UNAVAILABLE', {
        previousReason: plan.blockedReason,
      });
      return false;
    }
    const { allItems, targetKeys, targets } = this.#targets(plan, blockedBatch);
    const allItemKeys = allItems.map((item) => item.key);
    const pending = this.#pendingSync(plan.planId);
    if (pending) {
      return this.#harvestPending(plan, blockedBatch, pending, targetKeys, allItemKeys);
    }

    const candidate = await this.#workspace.discoverExternalProgress({
      repositoryPath: plan.repositoryPath,
      currentRevision: plan.currentRevision,
      workItemKeys: allItemKeys,
    });
    if (!candidate) {
      this.#repository.appendEvent(plan.planId, 'EXTERNAL_PROGRESS_SYNC_NO_CANDIDATE', {
        previousReason: plan.blockedReason,
        currentRevision: plan.currentRevision,
      });
      return false;
    }

    const priorSyncAttempts = this.#repository
      .events(plan.planId)
      .filter((event) => {
        if (event.type !== 'EXTERNAL_PROGRESS_SYNC_STARTED') return false;
        const detail = event.detail;
        return (
          detail !== null &&
          typeof detail === 'object' &&
          !Array.isArray(detail) &&
          String((detail as Record<string, unknown>).candidateRevision ?? '') === candidate.revision
        );
      }).length;
    const auditAttempt = priorSyncAttempts + 1;
    const commandKey = `${plan.planId}:EXTERNAL_PROGRESS:${candidate.revision}:${auditAttempt}`;
    const snapshot = await this.#executions.start(
      {
        phase: 'INVESTIGATE_PLAN',
        objective: this.#objective(plan, blockedBatch, candidate, targets),
        projectKey: plan.projectKey,
        repository: { path: plan.repositoryPath, baseRevision: candidate.revision },
        hints: { risk: 'HIGH', quality: 'PREMIUM', budget: 'NORMAL' },
        override: {
          backend: EXTERNAL_PROGRESS_AUDIT_BACKEND,
          modelClass: EXTERNAL_PROGRESS_AUDIT_MODEL_CLASS,
        },
        await: false,
      },
      commandKey,
    );
    this.#repository.appendEvent(
      plan.planId,
      'EXTERNAL_PROGRESS_SYNC_STARTED',
      {
        candidateRevision: candidate.revision,
        candidateRef: candidate.ref,
        aheadBy: candidate.aheadBy,
        matchedWorkItemKeys: candidate.matchedWorkItemKeys,
        attempt: auditAttempt,
      },
      { batchId: blockedBatch.batchId, executionId: snapshot.executionId },
    );
    return true;
  }
}
