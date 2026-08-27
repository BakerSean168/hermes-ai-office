import { setTimeout as sleep } from 'node:timers/promises';

import type { BatchRecord, PlanRecord } from '../plans.js';
import { PlanRepository } from '../plans.js';
import type { WorkspaceProvisioningPort } from '../workspace.js';
import { parseExternalProgressAudit } from './protocol.js';
import { PLAN_TERMINAL_EXECUTION_STATUSES, type PlanExecutionPort } from './runtime.js';

const EXTERNAL_PROGRESS_AUDIT_BACKEND = 'openhands-builtin';
const EXTERNAL_PROGRESS_AUDIT_MODEL_CLASS = 'gpt-5.6-sol';
const EXTERNAL_PROGRESS_AUDIT_TIMEOUT_MS = 12 * 60_000;

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

  async reconcile(plan: PlanRecord, blockedBatch: BatchRecord): Promise<boolean> {
    if (!this.#workspace.discoverExternalProgress) {
      this.#repository.appendEvent(plan.planId, 'EXTERNAL_PROGRESS_SYNC_UNAVAILABLE', {
        previousReason: plan.blockedReason,
      });
      return false;
    }
    const batches = this.#repository.batches(plan.planId);
    const allItems = batches.flatMap((batch) => this.#repository.workItems(batch.batchId));
    const candidate = await this.#workspace.discoverExternalProgress({
      repositoryPath: plan.repositoryPath,
      currentRevision: plan.currentRevision,
      workItemKeys: allItems.map((item) => item.key),
    });
    if (!candidate) {
      this.#repository.appendEvent(plan.planId, 'EXTERNAL_PROGRESS_SYNC_NO_CANDIDATE', {
        previousReason: plan.blockedReason,
        currentRevision: plan.currentRevision,
      });
      return false;
    }

    const targetItems = batches
      .filter((batch) => batch.ordinal >= blockedBatch.ordinal && batch.status !== 'CANCELLED')
      .flatMap((batch) => this.#repository.workItems(batch.batchId))
      .filter((item) => item.status !== 'CANCELLED');
    const targetKeys = new Set(targetItems.map((item) => item.key));
    const targets = targetItems.map((item) => ({
      key: item.key,
      title: item.title,
      status: item.status,
      objective: item.objective.slice(0, 1_600),
      acceptanceCriteria: item.acceptanceCriteria,
    }));
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
    const objective = [
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
    let snapshot = await this.#executions.start(
      {
        phase: 'INVESTIGATE_PLAN',
        objective,
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

    const deadline = Date.now() + EXTERNAL_PROGRESS_AUDIT_TIMEOUT_MS;
    while (!PLAN_TERMINAL_EXECUTION_STATUSES.has(snapshot.status) && Date.now() < deadline) {
      await sleep(2_000);
      const refreshed = await this.#executions.get(snapshot.executionId);
      if (!refreshed) throw new Error('EXTERNAL_PROGRESS_AUDIT_EXECUTION_MISSING');
      snapshot = refreshed;
    }
    if (!PLAN_TERMINAL_EXECUTION_STATUSES.has(snapshot.status)) {
      this.#repository.appendEvent(
        plan.planId,
        'EXTERNAL_PROGRESS_SYNC_FAILED',
        { reason: 'EXTERNAL_PROGRESS_AUDIT_TIMEOUT', candidateRevision: candidate.revision },
        { batchId: blockedBatch.batchId, executionId: snapshot.executionId },
      );
      return true;
    }
    if (snapshot.status !== 'SUCCEEDED' || !snapshot.result?.finalText) {
      this.#repository.appendEvent(
        plan.planId,
        'EXTERNAL_PROGRESS_SYNC_FAILED',
        {
          reason: snapshot.error?.code ?? `EXTERNAL_PROGRESS_AUDIT_${snapshot.status}`,
          candidateRevision: candidate.revision,
        },
        { batchId: blockedBatch.batchId, executionId: snapshot.executionId },
      );
      return true;
    }

    let audit;
    try {
      audit = parseExternalProgressAudit(
        snapshot.result.finalText,
        candidate.revision,
        blockedBatch.key,
        targetKeys,
      );
    } catch (error) {
      this.#repository.appendEvent(
        plan.planId,
        'EXTERNAL_PROGRESS_SYNC_FAILED',
        {
          reason: error instanceof Error ? error.message : String(error),
          candidateRevision: candidate.revision,
        },
        { batchId: blockedBatch.batchId, executionId: snapshot.executionId },
      );
      return true;
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
        { batchId: blockedBatch.batchId, executionId: snapshot.executionId },
      );
      return true;
    }
    const currentCandidate = await this.#workspace.discoverExternalProgress({
      repositoryPath: plan.repositoryPath,
      currentRevision: plan.currentRevision,
      workItemKeys: allItems.map((item) => item.key),
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
        { batchId: blockedBatch.batchId, executionId: snapshot.executionId },
      );
      return true;
    }
    const verifiedWorkItems = audit.workItems
      .filter((item) => item.status === 'VERIFIED_COMPLETE')
      .map((item) => ({ key: item.key, evidence: item.evidence }));
    this.#repository.adoptExternalProgress(plan.planId, {
      revision: candidate.revision,
      ref: candidate.ref,
      blockedBatchKey: blockedBatch.key,
      verifiedWorkItems,
      auditExecutionId: snapshot.executionId,
      analysisSummary: audit.analysisSummary,
    });
    return true;
  }
}
