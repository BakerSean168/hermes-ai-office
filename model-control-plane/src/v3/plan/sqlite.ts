import type { DatabaseSync } from 'node:sqlite';

import type { DeliveryStage, PlanDeliveryConfig } from '../delivery.js';
import type { BatchRecord, PlanNodeStatus, PlanRecord, PlanStatus, WorkItemRecord } from './model.js';

export interface PlanRow {
  plan_id: string;
  command_key: string;
  project_key: string;
  objective: string;
  repository_path: string;
  base_revision: string;
  current_revision: string;
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

export interface BatchRow {
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

export interface WorkItemRow {
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

export function planFromRow(row: PlanRow): PlanRecord {
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

export function batchFromRow(row: BatchRow): BatchRecord {
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

export function itemFromRow(row: WorkItemRow): WorkItemRecord {
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
    ['delivery_json', 'TEXT'],
    ['delivery_stage', 'TEXT'],
    ['delivery_evidence_json', 'TEXT'],
    ['pull_request_url', 'TEXT'],
    ['merge_revision', 'TEXT'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE v3_plans ADD COLUMN ${name} ${type}`);
  }
}
