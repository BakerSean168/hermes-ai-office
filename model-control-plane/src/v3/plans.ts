import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { DeliveryStage, PlanDeliveryConfig } from './delivery.js';
import { PLAN_LIMITS } from './planConstants.js';

export type PlanStatus = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'SUCCEEDED' | 'CANCELLED';
export type PlanNodeStatus = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'SUCCEEDED' | 'CANCELLED';

export type PlanSource =
  | { kind: 'TASK' }
  | {
      kind: 'EXTERNAL_CHANGE';
      revision: string;
      reviewBackend?: string;
      repairBackend?: string;
    };

export interface CreatePlanInput {
  projectKey: string;
  objective: string;
  analysisSummary: string;
  repository: { path: string; baseRevision?: string };
  source?: PlanSource;
  delivery?: Partial<PlanDeliveryConfig> & Pick<PlanDeliveryConfig, 'branch'>;
  batches: Array<{
    key: string;
    title: string;
    dependsOn?: string[];
    workItems: Array<{
      key: string;
      title: string;
      objective: string;
      acceptanceCriteria?: string[];
    }>;
  }>;
}

export interface PlanRecord {
  planId: string;
  commandKey: string;
  projectKey: string;
  objective: string;
  repositoryPath: string;
  baseRevision: string;
  currentRevision: string;
  source: PlanSource;
  delivery?: PlanDeliveryConfig;
  deliveryStage?: DeliveryStage;
  deliveryEvidence?: Record<string, unknown>;
  pullRequestUrl?: string;
  mergeRevision?: string;
  status: PlanStatus;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BatchRecord {
  batchId: string;
  planId: string;
  key: string;
  title: string;
  ordinal: number;
  dependsOn: string[];
  status: PlanNodeStatus;
  baseRevision?: string;
  integratedRevision?: string;
  integrationRef?: string;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkItemRecord {
  workItemId: string;
  planId: string;
  batchId: string;
  key: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  ordinal: number;
  status: PlanNodeStatus;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

interface PlanRow {
  plan_id: string;
  command_key: string;
  project_key: string;
  objective: string;
  repository_path: string;
  base_revision: string;
  current_revision: string;
  source_json: string | null;
  delivery_json: string | null;
  delivery_stage: string | null;
  delivery_evidence_json: string | null;
  pull_request_url: string | null;
  merge_revision: string | null;
  status: string;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface BatchRow {
  batch_id: string;
  plan_id: string;
  batch_key: string;
  title: string;
  ordinal: number;
  depends_on_json: string;
  status: string;
  base_revision: string | null;
  integrated_revision: string | null;
  integration_ref: string | null;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface WorkItemRow {
  work_item_id: string;
  plan_id: string;
  batch_id: string;
  item_key: string;
  title: string;
  objective: string;
  acceptance_criteria_json: string;
  ordinal: number;
  status: string;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

function jsonStrings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function planFromRow(row: PlanRow): PlanRecord {
  const delivery = row.delivery_json
    ? (JSON.parse(row.delivery_json) as PlanDeliveryConfig)
    : undefined;
  return {
    planId: row.plan_id,
    commandKey: row.command_key,
    projectKey: row.project_key,
    objective: row.objective,
    repositoryPath: row.repository_path,
    baseRevision: row.base_revision,
    currentRevision: row.current_revision,
    source: row.source_json
      ? (JSON.parse(row.source_json) as PlanSource)
      : { kind: 'TASK' },
    delivery,
    deliveryStage: row.delivery_stage ? (row.delivery_stage as DeliveryStage) : undefined,
    deliveryEvidence: row.delivery_evidence_json
      ? (JSON.parse(row.delivery_evidence_json) as Record<string, unknown>)
      : undefined,
    pullRequestUrl: row.pull_request_url ?? undefined,
    mergeRevision: row.merge_revision ?? undefined,
    status: row.status as PlanStatus,
    blockedReason: row.blocked_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function batchFromRow(row: BatchRow): BatchRecord {
  return {
    batchId: row.batch_id,
    planId: row.plan_id,
    key: row.batch_key,
    title: row.title,
    ordinal: row.ordinal,
    dependsOn: jsonStrings(row.depends_on_json),
    status: row.status as PlanNodeStatus,
    baseRevision: row.base_revision ?? undefined,
    integratedRevision: row.integrated_revision ?? undefined,
    integrationRef: row.integration_ref ?? undefined,
    blockedReason: row.blocked_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemFromRow(row: WorkItemRow): WorkItemRecord {
  return {
    workItemId: row.work_item_id,
    planId: row.plan_id,
    batchId: row.batch_id,
    key: row.item_key,
    title: row.title,
    objective: row.objective,
    acceptanceCriteria: jsonStrings(row.acceptance_criteria_json),
    ordinal: row.ordinal,
    status: row.status as PlanNodeStatus,
    blockedReason: row.blocked_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensurePlanSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v3_plans (
      plan_id TEXT PRIMARY KEY,
      command_key TEXT NOT NULL UNIQUE,
      project_key TEXT NOT NULL,
      objective TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      base_revision TEXT NOT NULL,
      current_revision TEXT NOT NULL,
      source_json TEXT,
      delivery_json TEXT,
      delivery_stage TEXT,
      delivery_evidence_json TEXT,
      pull_request_url TEXT,
      merge_revision TEXT,
      status TEXT NOT NULL,
      blocked_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v3_plan_batches (
      batch_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES v3_plans(plan_id) ON DELETE CASCADE,
      batch_key TEXT NOT NULL,
      title TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      depends_on_json TEXT NOT NULL,
      status TEXT NOT NULL,
      base_revision TEXT,
      integrated_revision TEXT,
      integration_ref TEXT,
      blocked_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(plan_id, batch_key)
    );
    CREATE TABLE IF NOT EXISTS v3_plan_work_items (
      work_item_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES v3_plans(plan_id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL REFERENCES v3_plan_batches(batch_id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      blocked_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(plan_id, item_key)
    );
    CREATE TABLE IF NOT EXISTS v3_plan_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL REFERENCES v3_plans(plan_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      batch_id TEXT,
      work_item_id TEXT,
      execution_id TEXT,
      detail_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v3_plans_status_updated ON v3_plans(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_v3_plan_events_plan ON v3_plan_events(plan_id, event_id);
  `);
  const columns = new Set(
    (db.prepare('PRAGMA table_info(v3_plans)').all() as unknown as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  for (const [name, type] of [
    ['source_json', 'TEXT'],
    ['delivery_json', 'TEXT'],
    ['delivery_stage', 'TEXT'],
    ['delivery_evidence_json', 'TEXT'],
    ['pull_request_url', 'TEXT'],
    ['merge_revision', 'TEXT'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE v3_plans ADD COLUMN ${name} ${type}`);
  }
}

function validateGraph(input: CreatePlanInput): void {
  if (!input.projectKey.trim()) throw new Error('PROJECT_KEY_REQUIRED');
  if (!input.objective.trim()) throw new Error('OBJECTIVE_REQUIRED');
  if (!input.analysisSummary.trim()) throw new Error('PLAN_ANALYSIS_REQUIRED');
  if (!input.repository.path.trim()) throw new Error('REPOSITORY_PATH_REQUIRED');
  if (input.source && !['TASK', 'EXTERNAL_CHANGE'].includes(input.source.kind)) {
    throw new Error('PLAN_SOURCE_KIND_INVALID');
  }
  if (input.source?.kind === 'EXTERNAL_CHANGE' && !input.source.revision.trim()) {
    throw new Error('EXTERNAL_CHANGE_REVISION_REQUIRED');
  }
  if (input.delivery) {
    if (!input.delivery.branch.trim()) throw new Error('DELIVERY_BRANCH_REQUIRED');
    if (input.delivery.autoMerge !== true)
      throw new Error('DELIVERY_AUTO_MERGE_AUTHORIZATION_REQUIRED');
    if (
      input.delivery.mergeMethod &&
      !['merge', 'squash', 'rebase'].includes(input.delivery.mergeMethod)
    ) {
      throw new Error('DELIVERY_MERGE_METHOD_INVALID');
    }
  }
  if (input.batches.length === 0) throw new Error('PLAN_BATCHES_REQUIRED');

  const batchKeys = new Set<string>();
  const itemKeys = new Set<string>();
  for (const batch of input.batches) {
    if (!batch.key.trim() || batchKeys.has(batch.key)) throw new Error('PLAN_BATCH_KEY_INVALID');
    batchKeys.add(batch.key);
    if (batch.workItems.length === 0) throw new Error('PLAN_WORK_ITEMS_REQUIRED');
    for (const item of batch.workItems) {
      if (!item.key.trim() || itemKeys.has(item.key)) throw new Error('PLAN_WORK_ITEM_KEY_INVALID');
      itemKeys.add(item.key);
      if (!item.objective.trim()) throw new Error('PLAN_WORK_ITEM_OBJECTIVE_REQUIRED');
    }
  }
  for (const batch of input.batches) {
    if ((batch.dependsOn ?? []).some((dependency) => !batchKeys.has(dependency))) {
      throw new Error('PLAN_DEPENDENCY_NOT_FOUND');
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(input.batches.map((batch) => [batch.key, batch]));
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error('PLAN_DEPENDENCY_CYCLE');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of batchKeys) visit(key);
}

export class PlanRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    ensurePlanSchema(db);
  }

  create(input: CreatePlanInput, commandKey: string): { plan: PlanRecord; created: boolean } {
    const existing = this.findByCommandKey(commandKey);
    if (existing) return { plan: existing, created: false };
    validateGraph(input);
    const now = Date.now();
    const planId = `plan_${randomUUID()}`;
    const baseRevision = input.repository.baseRevision?.trim() || 'HEAD';
    const source: PlanSource = input.source ?? { kind: 'TASK' };
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
            source_json,delivery_json,delivery_stage,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    const rows = planId
      ? (this.#db
          .prepare("SELECT * FROM v3_plans WHERE plan_id=? AND status IN ('PENDING','RUNNING')")
          .all(planId) as unknown as PlanRow[])
      : (this.#db
          .prepare(
            "SELECT * FROM v3_plans WHERE status IN ('PENDING','RUNNING') ORDER BY created_at",
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
    const batchTitle = mergeConflict
      ? `Resolve delivery merge conflict (attempt ${repairAttempt})`
      : `Repair remote checks (attempt ${repairAttempt})`;
    const itemTitle = mergeConflict
      ? `Resolve delivery merge conflict (attempt ${repairAttempt})`
      : `Repair failed remote checks (attempt ${repairAttempt})`;
    const objective = mergeConflict
      ? `Resolve only the merge conflict preventing this verified delivery. Fetch the current target branch, reconcile it into the repair workspace without discarding previously reviewed plan behavior, resolve conflicts according to repository contracts, and run focused regression checks. Conflict evidence: ${JSON.stringify(evidence).slice(0, PLAN_LIMITS.repairEvidenceCharacters)}`
      : `Diagnose and repair only the failed remote checks for this delivery. Use repository and GitHub evidence to identify the root cause. Failure evidence: ${JSON.stringify(evidence).slice(0, PLAN_LIMITS.repairEvidenceCharacters)}`;
    const acceptanceCriteria = mergeConflict
      ? [
          'The repair commit incorporates the current target branch without unresolved conflicts.',
          'Previously reviewed plan behavior is preserved and focused regression tests pass.',
          'The repair is committed and independently reviewed.',
        ]
      : [
          'The previously failing remote checks pass.',
          'Focused regression tests pass locally.',
          'The repair is committed and independently reviewed.',
        ];
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
          `delivery-fix-${repairAttempt}`,
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
