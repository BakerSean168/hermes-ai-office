import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { DeliveryStage } from './delivery.js';
import { PLAN_LIMITS } from './planConstants.js';
import {
  type BatchRecord,
  type CreatePlanInput,
  type DelegatePlanInput,
  type PlanNodeStatus,
  type PlanRecord,
  type PlanStatus,
  validatePlanEnvelope,
  validatePlanGraph,
  type WorkItemRecord,
} from './plan/model.js';
import { normalizePlanSource, type PlanSource } from './plan/source.js';
import {
  batchFromRow,
  ensurePlanSchema,
  itemFromRow,
  planFromRow,
  type BatchRow,
  type PlanRow,
  type WorkItemRow,
} from './plan/sqlite.js';

export type {
  BatchRecord,
  CreatePlanInput,
  DelegatePlanInput,
  PlanNodeStatus,
  PlanRecord,
  PlanStatus,
  WorkItemRecord,
} from './plan/model.js';
export type { PlanSource } from './plan/source.js';
export { ensurePlanSchema } from './plan/sqlite.js';

export class PlanRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    ensurePlanSchema(db);
  }

  create(input: CreatePlanInput, commandKey: string): { plan: PlanRecord; created: boolean } {
    const existing = this.findByCommandKey(commandKey);
    if (existing) return { plan: existing, created: false };
    validatePlanGraph(input);
    const now = Date.now();
    const planId = `plan_${randomUUID()}`;
    const baseRevision = input.repository.baseRevision?.trim() || 'HEAD';
    const source = normalizePlanSource(input.source);
    const delivery = input.delivery
      ? {
          remote: input.delivery.remote?.trim() || 'origin',
          branch: input.delivery.branch.trim(),
          targetBranch: input.delivery.targetBranch?.trim() || 'main',
          autoMerge: true,
          mergeMethod: input.delivery.mergeMethod ?? 'merge',
        }
      : undefined;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db
        .prepare(
          `INSERT INTO v3_plans
           (plan_id,command_key,project_key,objective,repository_path,base_revision,current_revision,
            source_json,external_head_revision,governance_status_required,governance_status_revision,
            governance_status_plan_status,delivery_json,delivery_stage,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          planId,
          commandKey,
          input.projectKey,
          input.objective,
          input.repository.path,
          baseRevision,
          baseRevision,
          JSON.stringify(source),
          source.kind === 'EXTERNAL_CHANGE' ? source.revision : null,
          source.kind === 'EXTERNAL_CHANGE' && source.origin?.kind === 'GITHUB_PULL_REQUEST' ? 1 : 0,
          null,
          null,
          delivery ? JSON.stringify(delivery) : null,
          delivery ? 'PENDING' : null,
          'PENDING',
          now,
          now,
        );
      input.batches.forEach((batch, batchIndex) => {
        const batchId = `batch_${randomUUID()}`;
        this.#db
          .prepare(
            `INSERT INTO v3_plan_batches
             (batch_id,plan_id,batch_key,title,ordinal,depends_on_json,status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            batchId,
            planId,
            batch.key,
            batch.title,
            batchIndex,
            JSON.stringify(batch.dependsOn ?? []),
            'PENDING',
            now,
            now,
          );
        batch.workItems.forEach((item, itemIndex) => {
          this.#db
            .prepare(
              `INSERT INTO v3_plan_work_items
               (work_item_id,plan_id,batch_id,item_key,title,objective,acceptance_criteria_json,ordinal,status,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              `work_${randomUUID()}`,
              planId,
              batchId,
              item.key,
              item.title,
              item.objective,
              JSON.stringify(item.acceptanceCriteria ?? []),
              itemIndex,
              'PENDING',
              now,
              now,
            );
        });
      });
      this.appendEvent(planId, 'PLAN_CREATED', {
        batches: input.batches.length,
        source,
        analysisSummary: input.analysisSummary.slice(0, PLAN_LIMITS.repairEvidenceCharacters),
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      const raced = this.findByCommandKey(commandKey);
      if (raced) return { plan: raced, created: false };
      throw error;
    }
    return { plan: this.get(planId)!, created: true };
  }

  createDelegatedDraft(
    input: DelegatePlanInput,
    commandKey: string,
  ): { plan: PlanRecord; created: boolean } {
    const existing = this.findByCommandKey(commandKey);
    if (existing) return { plan: existing, created: false };
    validatePlanEnvelope(input);
    const now = Date.now();
    const planId = `plan_${randomUUID()}`;
    const baseRevision = input.repository.baseRevision?.trim() || 'HEAD';
    const delivery = input.delivery
      ? {
          remote: input.delivery.remote?.trim() || 'origin',
          branch: input.delivery.branch.trim(),
          targetBranch: input.delivery.targetBranch?.trim() || 'main',
          autoMerge: true,
          mergeMethod: input.delivery.mergeMethod ?? 'merge',
        }
      : undefined;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db
        .prepare(
          `INSERT INTO v3_plans
           (plan_id,command_key,project_key,objective,repository_path,base_revision,current_revision,
            delivery_json,delivery_stage,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          planId,
          commandKey,
          input.projectKey,
          input.objective,
          input.repository.path,
          baseRevision,
          baseRevision,
          delivery ? JSON.stringify(delivery) : null,
          delivery ? 'PENDING' : null,
          'ORCHESTRATING',
          now,
          now,
        );
      this.appendEvent(planId, 'PLAN_DELEGATED', { mode: 'OPENHANDS_SUPERVISOR' });
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      const raced = this.findByCommandKey(commandKey);
      if (raced) return { plan: raced, created: false };
      throw error;
    }
    return { plan: this.get(planId)!, created: true };
  }

  materializeDelegatedPlan(
    planId: string,
    proposal: Pick<CreatePlanInput, 'analysisSummary' | 'batches'>,
  ): PlanRecord {
    const plan = this.get(planId);
    if (!plan) throw new Error('PLAN_NOT_FOUND');
    if (plan.status !== 'ORCHESTRATING') return plan;
    const input: CreatePlanInput = {
      projectKey: plan.projectKey,
      objective: plan.objective,
      analysisSummary: proposal.analysisSummary,
      repository: { path: plan.repositoryPath, baseRevision: plan.baseRevision },
      delivery: plan.delivery,
      batches: proposal.batches,
    };
    validatePlanGraph(input);
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      input.batches.forEach((batch, batchIndex) => {
        const batchId = `batch_${randomUUID()}`;
        this.#db
          .prepare(
            `INSERT INTO v3_plan_batches
             (batch_id,plan_id,batch_key,title,ordinal,depends_on_json,status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            batchId,
            planId,
            batch.key,
            batch.title,
            batchIndex,
            JSON.stringify(batch.dependsOn ?? []),
            'PENDING',
            now,
            now,
          );
        batch.workItems.forEach((item, itemIndex) => {
          this.#db
            .prepare(
              `INSERT INTO v3_plan_work_items
               (work_item_id,plan_id,batch_id,item_key,title,objective,acceptance_criteria_json,ordinal,status,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              `work_${randomUUID()}`,
              planId,
              batchId,
              item.key,
              item.title,
              item.objective,
              JSON.stringify(item.acceptanceCriteria ?? []),
              itemIndex,
              'PENDING',
              now,
              now,
            );
        });
      });
      this.#db
        .prepare(
          "UPDATE v3_plans SET status='PENDING',blocked_reason=NULL,updated_at=? WHERE plan_id=?",
        )
        .run(now, planId);
      this.appendEvent(planId, 'PLAN_ORCHESTRATED', {
        batches: input.batches.length,
        analysisSummary: input.analysisSummary.slice(0, PLAN_LIMITS.repairEvidenceCharacters),
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return this.get(planId)!;
  }

  get(planId: string): PlanRecord | null {
    const row = this.#db.prepare('SELECT * FROM v3_plans WHERE plan_id=?').get(planId) as
      PlanRow | undefined;
    return row ? planFromRow(row) : null;
  }

  findByCommandKey(commandKey: string): PlanRecord | null {
    const row = this.#db.prepare('SELECT * FROM v3_plans WHERE command_key=?').get(commandKey) as
      PlanRow | undefined;
    return row ? planFromRow(row) : null;
  }

  active(planId?: string): PlanRecord[] {
    const pendingGovernanceStatus = `(
      governance_status_required=1 AND (
        governance_status_revision IS NULL OR
        governance_status_revision IS NOT external_head_revision OR
        governance_status_plan_status IS NOT status
      )
    )`;
    const rows = planId
      ? (this.#db
          .prepare(
            `SELECT * FROM v3_plans WHERE plan_id=? AND (status IN ('ORCHESTRATING','PENDING','RUNNING') OR ${pendingGovernanceStatus})`,
          )
          .all(planId) as unknown as PlanRow[])
      : (this.#db
          .prepare(
            `SELECT * FROM v3_plans WHERE status IN ('ORCHESTRATING','PENDING','RUNNING') OR ${pendingGovernanceStatus} ORDER BY created_at`,
          )
          .all() as unknown as PlanRow[]);
    return rows.map(planFromRow);
  }

  list(limit = 100): PlanRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM v3_plans ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, limit))) as unknown as PlanRow[];
    return rows.map(planFromRow);
  }

  batches(planId: string): BatchRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM v3_plan_batches WHERE plan_id=? ORDER BY ordinal')
      .all(planId) as unknown as BatchRow[];
    return rows.map(batchFromRow);
  }

  workItems(batchId: string): WorkItemRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM v3_plan_work_items WHERE batch_id=? ORDER BY ordinal')
      .all(batchId) as unknown as WorkItemRow[];
    return rows.map(itemFromRow);
  }

  executionIds(workItemId: string): string[] {
    return (
      this.#db
        .prepare(
          'SELECT execution_id FROM v3_execution_links WHERE work_item_id=? ORDER BY created_at,rowid',
        )
        .all(workItemId) as unknown as Array<{ execution_id: string }>
    ).map((row) => row.execution_id);
  }

  adoptExternalProgress(
    planId: string,
    input: {
      revision: string;
      ref: string;
      blockedBatchKey: string;
      verifiedWorkItems: Array<{ key: string; evidence: string }>;
      auditExecutionId: string;
      analysisSummary: string;
    },
  ): { adoptedWorkItems: string[]; adoptedBatches: string[] } {
    const plan = this.get(planId);
    if (!plan) throw new Error('PLAN_NOT_FOUND');
    if (plan.status !== 'BLOCKED') throw new Error('EXTERNAL_PROGRESS_PLAN_NOT_BLOCKED');
    const batchesBefore = this.batches(planId);
    const blockedBatch = batchesBefore.find(
      (batch) => batch.key === input.blockedBatchKey && batch.status === 'BLOCKED',
    );
    if (!blockedBatch) throw new Error('EXTERNAL_PROGRESS_BLOCKED_BATCH_MISSING');
    const itemByKey = new Map<string, WorkItemRecord>();
    for (const batch of batchesBefore) {
      for (const item of this.workItems(batch.batchId)) itemByKey.set(item.key, item);
    }
    const verified = input.verifiedWorkItems.filter((item) => itemByKey.has(item.key));
    const verifiedKeys = new Set(verified.map((item) => item.key));
    const blockedItems = this.workItems(blockedBatch.batchId);
    if (
      !blockedItems.every(
        (item) => item.status === 'SUCCEEDED' || verifiedKeys.has(item.key),
      )
    ) {
      throw new Error('EXTERNAL_PROGRESS_BLOCKED_BATCH_UNVERIFIED');
    }

    const adoptedWorkItems: string[] = [];
    const adoptedBatches: string[] = [];
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of verified) {
        const current = itemByKey.get(item.key)!;
        if (current.status === 'SUCCEEDED') continue;
        if (current.status === 'CANCELLED') throw new Error('EXTERNAL_PROGRESS_ITEM_CANCELLED');
        this.#db
          .prepare(
            "UPDATE v3_plan_work_items SET status='SUCCEEDED',blocked_reason=NULL,updated_at=? WHERE work_item_id=?",
          )
          .run(now, current.workItemId);
        adoptedWorkItems.push(item.key);
        this.appendEvent(
          planId,
          'EXTERNAL_WORK_ITEM_ADOPTED',
          {
            key: item.key,
            revision: input.revision,
            ref: input.ref,
            evidence: item.evidence.slice(0, 2_000),
          },
          { batchId: current.batchId, workItemId: current.workItemId, executionId: input.auditExecutionId },
        );
      }

      let changed = true;
      while (changed) {
        changed = false;
        const batches = this.batches(planId).sort((left, right) => left.ordinal - right.ordinal);
        const statusByKey = new Map(batches.map((batch) => [batch.key, batch.status]));
        for (const batch of batches) {
          if (batch.status === 'SUCCEEDED' || batch.status === 'CANCELLED') continue;
          const items = this.workItems(batch.batchId);
          const itemsComplete = items.length > 0 && items.every((item) => item.status === 'SUCCEEDED');
          const dependenciesComplete = batch.dependsOn.every(
            (dependency) => statusByKey.get(dependency) === 'SUCCEEDED',
          );
          if (!itemsComplete || !dependenciesComplete) continue;
          this.#db
            .prepare(
              `UPDATE v3_plan_batches
               SET status='SUCCEEDED',base_revision=COALESCE(base_revision,?),integrated_revision=?,integration_ref=?,blocked_reason=NULL,updated_at=?
               WHERE batch_id=?`,
            )
            .run(plan.currentRevision, input.revision, input.ref, now, batch.batchId);
          adoptedBatches.push(batch.key);
          statusByKey.set(batch.key, 'SUCCEEDED');
          this.appendEvent(
            planId,
            'EXTERNAL_BATCH_ADOPTED',
            { key: batch.key, revision: input.revision, ref: input.ref },
            { batchId: batch.batchId, executionId: input.auditExecutionId },
          );
          changed = true;
        }
      }
      if (!adoptedBatches.includes(blockedBatch.key)) {
        throw new Error('EXTERNAL_PROGRESS_BLOCKED_BATCH_UNVERIFIED');
      }
      this.#db
        .prepare(
          "UPDATE v3_plans SET current_revision=?,status='RUNNING',blocked_reason=NULL,updated_at=? WHERE plan_id=?",
        )
        .run(input.revision, now, planId);
      this.appendEvent(
        planId,
        'EXTERNAL_PROGRESS_ADOPTED',
        {
          revision: input.revision,
          ref: input.ref,
          previousRevision: plan.currentRevision,
          blockedBatchKey: input.blockedBatchKey,
          adoptedWorkItems,
          adoptedBatches,
          analysisSummary: input.analysisSummary.slice(0, 4_000),
        },
        { executionId: input.auditExecutionId },
      );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return { adoptedWorkItems, adoptedBatches };
  }

  setExternalHeadRevision(planId: string, revision: string): void {
    if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error('EXTERNAL_HEAD_REVISION_INVALID');
    const now = Date.now();
    this.#db
      .prepare(
        `UPDATE v3_plans
            SET external_head_published_at=CASE
                  WHEN external_head_revision=? AND external_head_published_at IS NOT NULL
                    THEN external_head_published_at
                  ELSE ?
                END,
                external_head_revision=?,updated_at=?
          WHERE plan_id=?`,
      )
      .run(revision, now, revision, now, planId);
  }

  setGovernanceStatusPublished(planId: string, revision: string, planStatus: PlanStatus): void {
    if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error('GOVERNANCE_STATUS_REVISION_INVALID');
    this.#db
      .prepare(
        `UPDATE v3_plans
            SET governance_status_revision=?,governance_status_plan_status=?,updated_at=?
          WHERE plan_id=?`,
      )
      .run(revision, planStatus, Date.now(), planId);
  }

  setPlanStatus(planId: string, status: PlanStatus, blockedReason?: string): void {
    this.#db
      .prepare('UPDATE v3_plans SET status=?,blocked_reason=?,updated_at=? WHERE plan_id=?')
      .run(status, blockedReason ?? null, Date.now(), planId);
  }

  cancel(planId: string): void {
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db
        .prepare(
          "UPDATE v3_plan_work_items SET status='CANCELLED',blocked_reason=NULL,updated_at=? WHERE plan_id=? AND status!='SUCCEEDED'",
        )
        .run(now, planId);
      this.#db
        .prepare(
          "UPDATE v3_plan_batches SET status='CANCELLED',blocked_reason=NULL,updated_at=? WHERE plan_id=? AND status!='SUCCEEDED'",
        )
        .run(now, planId);
      this.#db
        .prepare(
          "UPDATE v3_plans SET status='CANCELLED',blocked_reason=NULL,updated_at=? WHERE plan_id=?",
        )
        .run(now, planId);
      this.appendEvent(planId, 'PLAN_CANCELLED');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  setDeliveryState(
    planId: string,
    input: {
      stage: DeliveryStage;
      evidence?: Record<string, unknown>;
      pullRequestUrl?: string;
      mergeRevision?: string;
    },
  ): void {
    this.#db
      .prepare(
        `UPDATE v3_plans SET delivery_stage=?,delivery_evidence_json=?,
         pull_request_url=COALESCE(?,pull_request_url),merge_revision=COALESCE(?,merge_revision),updated_at=?
         WHERE plan_id=?`,
      )
      .run(
        input.stage,
        input.evidence ? JSON.stringify(input.evidence) : null,
        input.pullRequestUrl ?? null,
        input.mergeRevision ?? null,
        Date.now(),
        planId,
      );
  }

  addDeliveryRepairBatch(planId: string, evidence: Record<string, unknown>): BatchRecord | null {
    const batches = this.batches(planId);
    const repairAttempt =
      batches.filter((batch) => batch.key.startsWith('delivery-fix-')).length + 1;
    const authorizedExtraAttempts = Number(
      (
        this.#db
          .prepare(
            "SELECT COUNT(*) AS count FROM v3_plan_events WHERE plan_id=? AND event_type='PLAN_DELIVERY_REPAIR_RETRY_AUTHORIZED'",
          )
          .get(planId) as { count: number }
      ).count,
    );
    if (repairAttempt > PLAN_LIMITS.deliveryRepairAttempts + authorizedExtraAttempts) return null;
    const existing = batches.find((batch) => batch.key === `delivery-fix-${repairAttempt}`);
    if (existing) return existing;
    const predecessor = batches.at(-1);
    if (!predecessor) throw new Error('PLAN_BATCHES_REQUIRED');
    const now = Date.now();
    const batchId = `batch_${randomUUID()}`;
    const itemId = `work_${randomUUID()}`;
    const reason =
      typeof evidence.reason === 'string' ? evidence.reason : 'DELIVERY_REPAIR_REQUIRED';
    const mergeConflict = reason === 'DELIVERY_MERGE_CONFLICT';
    const postMergeFailure = reason === 'DELIVERY_POST_MERGE_CHECKS_FAILED';
    const mergeRevision =
      typeof evidence.mergeRevision === 'string' ? evidence.mergeRevision.trim() : '';
    if (postMergeFailure && !mergeRevision) {
      throw new Error('DELIVERY_POST_MERGE_REVISION_REQUIRED');
    }
    const batchTitle = mergeConflict
      ? `Resolve delivery merge conflict (attempt ${repairAttempt})`
      : postMergeFailure
        ? `Repair post-merge checks (attempt ${repairAttempt})`
        : `Repair remote checks (attempt ${repairAttempt})`;
    const itemTitle = mergeConflict
      ? `Resolve delivery merge conflict (attempt ${repairAttempt})`
      : postMergeFailure
        ? `Repair failed post-merge checks (attempt ${repairAttempt})`
        : `Repair failed remote checks (attempt ${repairAttempt})`;
    const objective = mergeConflict
      ? `Resolve only the merge conflict preventing this verified delivery. Fetch the current target branch, reconcile it into the repair workspace without discarding previously reviewed plan behavior, resolve conflicts according to repository contracts, and run focused regression checks. Conflict evidence: ${JSON.stringify(evidence).slice(0, PLAN_LIMITS.repairEvidenceCharacters)}`
      : postMergeFailure
        ? `Diagnose and repair the post-merge CI failure on target branch revision ${mergeRevision}. This is a follow-up repair after the previous pull request already merged, so do not rewrite or pretend to amend the merged history. Fetch the current target branch, reconcile it into this repair workspace, verify that failed merge revision ${mergeRevision} remains an ancestor of the final repair HEAD, inspect the failing checks and repository evidence, implement the smallest safe follow-up fix, run focused regression checks, commit the repair, and leave the workspace clean. Failure evidence: ${JSON.stringify(evidence).slice(0, PLAN_LIMITS.repairEvidenceCharacters)}`
        : `Diagnose and repair only the failed remote checks for this delivery. Use repository and GitHub evidence to identify the root cause. Failure evidence: ${JSON.stringify(evidence).slice(0, PLAN_LIMITS.repairEvidenceCharacters)}`;
    const acceptanceCriteria = mergeConflict
      ? [
          'The repair commit incorporates the current target branch without unresolved conflicts.',
          'Previously reviewed plan behavior is preserved and focused regression tests pass.',
          'The repair is committed and independently reviewed.',
        ]
      : postMergeFailure
        ? [
            `The failed merge revision ${mergeRevision} is an ancestor of the final repair HEAD and the current target branch has been reconciled before the fix is finalized.`,
            'The post-merge CI root cause is addressed by a new follow-up commit without rewriting already-merged history.',
            'Focused regression tests pass locally and the previously failing post-merge checks are expected to pass on the follow-up pull request.',
            'The repair is committed and independently reviewed before delivery resumes.',
          ]
        : [
            'The previously failing remote checks pass.',
            'Focused regression tests pass locally.',
            'The repair is committed and independently reviewed.',
          ];
    const itemKey = postMergeFailure
      ? `post-merge-fix-${repairAttempt}`
      : `delivery-fix-${repairAttempt}`;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db
        .prepare(
          `INSERT INTO v3_plan_batches
           (batch_id,plan_id,batch_key,title,ordinal,depends_on_json,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          batchId,
          planId,
          `delivery-fix-${repairAttempt}`,
          batchTitle,
          batches.length,
          JSON.stringify([predecessor.key]),
          'PENDING',
          now,
          now,
        );
      this.#db
        .prepare(
          `INSERT INTO v3_plan_work_items
           (work_item_id,plan_id,batch_id,item_key,title,objective,acceptance_criteria_json,ordinal,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          itemId,
          planId,
          batchId,
          itemKey,
          itemTitle,
          objective,
          JSON.stringify(acceptanceCriteria),
          0,
          'PENDING',
          now,
          now,
        );
      this.appendEvent(
        planId,
        'DELIVERY_REPAIR_BATCH_CREATED',
        { attempt: repairAttempt, evidence },
        {
          batchId,
          workItemId: itemId,
        },
      );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      const raced = this.batches(planId).find(
        (batch) => batch.key === `delivery-fix-${repairAttempt}`,
      );
      if (raced) return raced;
      throw error;
    }
    return this.batches(planId).find((batch) => batch.batchId === batchId) ?? null;
  }

  addBatchIntegrationRepairWorkItem(
    planId: string,
    batchId: string,
    input: {
      objective: string;
      acceptanceCriteria: string[];
      evidence: Record<string, unknown>;
    },
  ): WorkItemRecord | null {
    const batch = this.batches(planId).find((candidate) => candidate.batchId === batchId);
    if (!batch) throw new Error('PLAN_BATCH_NOT_FOUND');
    const keyPrefix = `integration-repair-b${batch.ordinal + 1}-`;
    const items = this.workItems(batchId);
    const repairAttempt = items.filter((item) => item.key.startsWith(keyPrefix)).length + 1;
    if (repairAttempt > PLAN_LIMITS.batchIntegrationRepairAttempts) return null;
    const itemKey = `${keyPrefix}${repairAttempt}`;
    const existing = items.find((item) => item.key === itemKey);
    if (existing) return existing;
    const itemId = `work_${randomUUID()}`;
    const ordinal = items.reduce((max, item) => Math.max(max, item.ordinal), -1) + 1;
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db
        .prepare(
          `INSERT INTO v3_plan_work_items
           (work_item_id,plan_id,batch_id,item_key,title,objective,acceptance_criteria_json,ordinal,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          itemId,
          planId,
          batchId,
          itemKey,
          `Resolve ${batch.key} integration conflict (attempt ${repairAttempt})`,
          input.objective,
          JSON.stringify(input.acceptanceCriteria),
          ordinal,
          'PENDING',
          now,
          now,
        );
      this.appendEvent(
        planId,
        'BATCH_INTEGRATION_REPAIR_CREATED',
        { attempt: repairAttempt, evidence: input.evidence },
        { batchId, workItemId: itemId },
      );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      const raced = this.workItems(batchId).find((item) => item.key === itemKey);
      if (raced) return raced;
      throw error;
    }
    return this.workItems(batchId).find((item) => item.workItemId === itemId) ?? null;
  }

  addBatchAggregateReviewWorkItem(
    planId: string,
    batchId: string,
    input: {
      objective: string;
      acceptanceCriteria: string[];
      candidateRevision: string;
    },
  ): WorkItemRecord {
    const batch = this.batches(planId).find((candidate) => candidate.batchId === batchId);
    if (!batch) throw new Error('PLAN_BATCH_NOT_FOUND');
    const keyPrefix = `batch-verify-b${batch.ordinal + 1}-`;
    const items = this.workItems(batchId);
    const existing = [...items]
      .reverse()
      .find(
        (item) =>
          item.key.startsWith(keyPrefix) && item.objective.includes(input.candidateRevision),
      );
    if (existing) return existing;
    const attempt = items.filter((item) => item.key.startsWith(keyPrefix)).length + 1;
    const itemId = `work_${randomUUID()}`;
    const itemKey = `${keyPrefix}${attempt}`;
    const ordinal = items.reduce((max, item) => Math.max(max, item.ordinal), -1) + 1;
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db
        .prepare(
          `INSERT INTO v3_plan_work_items
           (work_item_id,plan_id,batch_id,item_key,title,objective,acceptance_criteria_json,ordinal,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          itemId,
          planId,
          batchId,
          itemKey,
          `Verify ${batch.key} integrated batch (attempt ${attempt})`,
          input.objective,
          JSON.stringify(input.acceptanceCriteria),
          ordinal,
          'PENDING',
          now,
          now,
        );
      this.appendEvent(
        planId,
        'BATCH_AGGREGATE_REVIEW_CREATED',
        { attempt, candidateRevision: input.candidateRevision },
        { batchId, workItemId: itemId },
      );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      const raced = this.workItems(batchId).find((item) => item.key === itemKey);
      if (raced) return raced;
      throw error;
    }
    return this.workItems(batchId).find((item) => item.workItemId === itemId)!;
  }

  setBatchIntegrationCandidate(batchId: string, revision: string, ref: string): void {
    this.#db
      .prepare(
        `UPDATE v3_plan_batches
         SET status='RUNNING',integrated_revision=?,integration_ref=?,blocked_reason=NULL,updated_at=?
         WHERE batch_id=?`,
      )
      .run(revision, ref, Date.now(), batchId);
  }

  clearBatchIntegrationCandidate(batchId: string): void {
    this.#db
      .prepare(
        `UPDATE v3_plan_batches
         SET integrated_revision=NULL,integration_ref=NULL,blocked_reason=NULL,updated_at=?
         WHERE batch_id=?`,
      )
      .run(Date.now(), batchId);
  }

  promoteBatchIntegration(batchId: string): void {
    const batch = this.#db
      .prepare('SELECT plan_id,integrated_revision FROM v3_plan_batches WHERE batch_id=?')
      .get(batchId) as { plan_id: string; integrated_revision: string | null } | undefined;
    if (!batch) throw new Error('PLAN_BATCH_NOT_FOUND');
    if (!batch.integrated_revision) throw new Error('BATCH_INTEGRATION_CANDIDATE_MISSING');
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db
        .prepare(
          `UPDATE v3_plan_batches SET status='SUCCEEDED',blocked_reason=NULL,updated_at=? WHERE batch_id=?`,
        )
        .run(now, batchId);
      this.#db
        .prepare(
          'UPDATE v3_plans SET current_revision=?,blocked_reason=NULL,updated_at=? WHERE plan_id=?',
        )
        .run(batch.integrated_revision, now, batch.plan_id);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  setBatchStatus(
    batchId: string,
    status: PlanNodeStatus,
    input: {
      baseRevision?: string;
      integratedRevision?: string;
      integrationRef?: string;
      blockedReason?: string;
    } = {},
  ): void {
    this.#db
      .prepare(
        `UPDATE v3_plan_batches SET status=?,base_revision=COALESCE(?,base_revision),
         integrated_revision=COALESCE(?,integrated_revision),integration_ref=COALESCE(?,integration_ref),
         blocked_reason=?,updated_at=? WHERE batch_id=?`,
      )
      .run(
        status,
        input.baseRevision ?? null,
        input.integratedRevision ?? null,
        input.integrationRef ?? null,
        input.blockedReason ?? null,
        Date.now(),
        batchId,
      );
    if (input.integratedRevision) {
      this.#db
        .prepare(
          'UPDATE v3_plans SET current_revision=?,updated_at=? WHERE plan_id=(SELECT plan_id FROM v3_plan_batches WHERE batch_id=?)',
        )
        .run(input.integratedRevision, Date.now(), batchId);
    }
  }

  setWorkItemStatus(workItemId: string, status: PlanNodeStatus, blockedReason?: string): void {
    this.#db
      .prepare(
        'UPDATE v3_plan_work_items SET status=?,blocked_reason=?,updated_at=? WHERE work_item_id=?',
      )
      .run(status, blockedReason ?? null, Date.now(), workItemId);
  }

  appendEvent(
    planId: string,
    eventType: string,
    detail: Record<string, unknown> = {},
    refs: { batchId?: string; workItemId?: string; executionId?: string } = {},
  ): void {
    this.#db
      .prepare(
        `INSERT INTO v3_plan_events
         (plan_id,event_type,batch_id,work_item_id,execution_id,detail_json,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        planId,
        eventType,
        refs.batchId ?? null,
        refs.workItemId ?? null,
        refs.executionId ?? null,
        JSON.stringify(detail),
        Date.now(),
      );
  }

  events(planId: string): Array<Record<string, unknown>> {
    const rows = this.#db
      .prepare('SELECT * FROM v3_plan_events WHERE plan_id=? ORDER BY event_id')
      .all(planId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      eventId: row.event_id,
      type: row.event_type,
      batchId: row.batch_id,
      workItemId: row.work_item_id,
      executionId: row.execution_id,
      detail: JSON.parse(String(row.detail_json)) as unknown,
      createdAt: new Date(Number(row.created_at)).toISOString(),
    }));
  }
}
