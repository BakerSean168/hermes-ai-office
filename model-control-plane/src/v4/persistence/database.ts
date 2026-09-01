import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DataResetRequiredError, V4Error } from '../domain/errors.js';

export const SCHEMA_VERSION = 2;

const CREATE_EXECUTION_SESSIONS_SQL = `
CREATE TABLE IF NOT EXISTS execution_sessions (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
  phase TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT UNIQUE,
  workspace_host_path TEXT NOT NULL,
  workspace_execution_path TEXT NOT NULL,
  evidence_host_path TEXT NOT NULL,
  evidence_execution_path TEXT NOT NULL,
  workspace_created_at TEXT NOT NULL,
  source_repository_path TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  last_heartbeat_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  final_response TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_sessions_status ON execution_sessions(provider_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_execution_sessions_provider ON execution_sessions(provider, provider_session_id);
CREATE TABLE IF NOT EXISTS execution_evidence (
  evidence_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  source_revision TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(execution_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_execution_evidence_execution ON execution_evidence(execution_id, created_at);
`;

const CREATE_V1_COMPATIBILITY_SQL = `
CREATE TABLE IF NOT EXISTS v4_jules_sessions (
  idempotency_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  result TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const SCHEMA_V4_SQL = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA busy_timeout = 5000;',
  'CREATE TABLE IF NOT EXISTS schema_meta (schema_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, created_at INTEGER NOT NULL);',
  'CREATE TABLE IF NOT EXISTS events (event_order INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, aggregate_id TEXT NOT NULL, aggregate_type TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, occurred_at TEXT NOT NULL, correlation_id TEXT NOT NULL, UNIQUE (aggregate_id, sequence));',
  'CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_id, sequence);',
  'CREATE INDEX IF NOT EXISTS idx_events_cursor ON events(event_order);',
  'CREATE TABLE IF NOT EXISTS supervisor_wakes (wake_key TEXT PRIMARY KEY, supervisor_id TEXT NOT NULL, observation_cursor INTEGER NOT NULL, reason TEXT NOT NULL, requested_at TEXT NOT NULL);',
  'CREATE INDEX IF NOT EXISTS idx_supervisor_wakes_requested ON supervisor_wakes(requested_at, wake_key);',
  'CREATE TABLE IF NOT EXISTS v4_jules_sessions (idempotency_key TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, base_revision TEXT NOT NULL, result TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS plans (plan_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, project_key TEXT NOT NULL, objective TEXT NOT NULL, repository_path TEXT NOT NULL, base_revision TEXT NOT NULL, current_revision TEXT NOT NULL, status TEXT NOT NULL, active_graph_version_id TEXT, parent_plan_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS graph_versions (graph_version_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(plan_id), version INTEGER NOT NULL, parent_graph_version_id TEXT, reason TEXT NOT NULL, triggering_observation_cursor INTEGER, status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(plan_id, version));',
  'CREATE TABLE IF NOT EXISTS work_items (work_item_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(plan_id), graph_version_id TEXT NOT NULL REFERENCES graph_versions(graph_version_id), item_key TEXT NOT NULL, title TEXT NOT NULL, objective TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, dependencies TEXT NOT NULL, status TEXT NOT NULL, exact_accepted_revision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(graph_version_id, item_key));',
  'CREATE TABLE IF NOT EXISTS executions (execution_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL REFERENCES plans(plan_id), work_item_id TEXT REFERENCES work_items(work_item_id), attempt INTEGER NOT NULL, route TEXT NOT NULL, source_revision TEXT, objective TEXT NOT NULL, status TEXT NOT NULL, result_revision TEXT, result_summary TEXT, error_code TEXT, retryable INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  CREATE_EXECUTION_SESSIONS_SQL,
  'CREATE TABLE IF NOT EXISTS reviews (review_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL REFERENCES plans(plan_id), work_item_id TEXT REFERENCES work_items(work_item_id), implementation_execution_id TEXT NOT NULL REFERENCES executions(execution_id), reviewer_execution_id TEXT, source_revision TEXT NOT NULL, reviewed_sha TEXT NOT NULL, status TEXT NOT NULL, verdict TEXT, findings TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS supervisors (supervisor_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES plans(plan_id), conversation_id TEXT, status TEXT NOT NULL, observation_cursor INTEGER NOT NULL DEFAULT 0, projection_digest TEXT NOT NULL, policy_id TEXT NOT NULL, budget_id TEXT NOT NULL, last_decision_at TEXT, next_wake_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS supervisor_decisions (decision_id TEXT PRIMARY KEY, supervisor_id TEXT NOT NULL REFERENCES supervisors(supervisor_id), idempotency_key TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL REFERENCES plans(plan_id), version INTEGER NOT NULL, observation_cursor INTEGER NOT NULL, projection_digest TEXT NOT NULL, precondition_snapshot TEXT NOT NULL, action_payload TEXT NOT NULL, validator_result TEXT, created_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS supervisor_actions (action_id TEXT PRIMARY KEY, supervisor_id TEXT NOT NULL REFERENCES supervisors(supervisor_id), plan_id TEXT NOT NULL REFERENCES plans(plan_id), version INTEGER NOT NULL, type TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, observation_cursor INTEGER NOT NULL, projection_digest TEXT NOT NULL, precondition_snapshot TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, validation TEXT, result TEXT, execution_id TEXT, child_plan_id TEXT, pull_request_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS leases (aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, owner_id TEXT NOT NULL, lease_token TEXT NOT NULL, claimed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (aggregate_type, aggregate_id));',
  'CREATE TABLE IF NOT EXISTS resources (resource_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, capabilities TEXT NOT NULL, quota_remaining REAL, observation TEXT NOT NULL, updated_at TEXT NOT NULL, observed_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS external_changes (external_change_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, source_ref TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS plan_relationships (relationship_id TEXT PRIMARY KEY, parent_plan_id TEXT NOT NULL REFERENCES plans(plan_id), child_plan_id TEXT NOT NULL UNIQUE REFERENCES plans(plan_id), kind TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(parent_plan_id, child_plan_id, kind));',
  'CREATE TABLE IF NOT EXISTS maintenance_programs (program_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, policy TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  "CREATE TABLE IF NOT EXISTS improvement_candidates (candidate_id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES maintenance_programs(program_id), fingerprint TEXT NOT NULL UNIQUE, title TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL, plan_id TEXT REFERENCES plans(plan_id), pull_request_id TEXT, risk TEXT NOT NULL DEFAULT 'LOW', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
  "INSERT OR IGNORE INTO schema_meta(schema_id, schema_version, created_at) VALUES ('pixel-v4', 2, CAST(strftime('%s','now') AS INTEGER));",
].join('\n');

const V1_REQUIRED_COLUMNS = {
  supervisor_wakes: ['wake_key', 'supervisor_id', 'observation_cursor', 'reason', 'requested_at'],
  events: ['event_order', 'event_id', 'aggregate_id', 'aggregate_type', 'sequence', 'type', 'payload', 'occurred_at', 'correlation_id'],
  plans: ['plan_id', 'idempotency_key', 'project_key', 'objective', 'repository_path', 'base_revision', 'current_revision', 'status', 'active_graph_version_id', 'parent_plan_id', 'created_at', 'updated_at'],
  graph_versions: ['graph_version_id', 'plan_id', 'version', 'parent_graph_version_id', 'reason', 'triggering_observation_cursor', 'status', 'created_at'],
  work_items: ['work_item_id', 'plan_id', 'graph_version_id', 'item_key', 'title', 'objective', 'acceptance_criteria', 'dependencies', 'status', 'exact_accepted_revision', 'created_at', 'updated_at'],
  executions: ['execution_id', 'idempotency_key', 'plan_id', 'work_item_id', 'attempt', 'route', 'source_revision', 'objective', 'status', 'result_revision', 'result_summary', 'error_code', 'retryable', 'created_at', 'updated_at'],
  reviews: ['review_id', 'idempotency_key', 'plan_id', 'work_item_id', 'implementation_execution_id', 'reviewer_execution_id', 'source_revision', 'reviewed_sha', 'status', 'verdict', 'findings', 'created_at', 'updated_at'],
  supervisors: ['supervisor_id', 'plan_id', 'conversation_id', 'status', 'observation_cursor', 'projection_digest', 'policy_id', 'budget_id', 'last_decision_at', 'next_wake_at', 'created_at', 'updated_at'],
  supervisor_decisions: ['decision_id', 'supervisor_id', 'idempotency_key', 'plan_id', 'version', 'observation_cursor', 'projection_digest', 'precondition_snapshot', 'action_payload', 'validator_result', 'created_at'],
  supervisor_actions: ['action_id', 'supervisor_id', 'plan_id', 'version', 'type', 'idempotency_key', 'observation_cursor', 'projection_digest', 'precondition_snapshot', 'payload', 'status', 'validation', 'result', 'execution_id', 'child_plan_id', 'pull_request_id', 'created_at', 'updated_at'],
  leases: ['aggregate_type', 'aggregate_id', 'owner_id', 'lease_token', 'claimed_at', 'expires_at'],
  resources: ['resource_id', 'kind', 'status', 'capabilities', 'quota_remaining', 'observation', 'updated_at', 'observed_at'],
  external_changes: ['external_change_id', 'fingerprint', 'repository', 'base_sha', 'head_sha', 'source_ref', 'status', 'evidence', 'created_at', 'updated_at'],
  plan_relationships: ['relationship_id', 'parent_plan_id', 'child_plan_id', 'kind', 'created_at'],
  maintenance_programs: ['program_id', 'project_key', 'policy', 'status', 'created_at', 'updated_at'],
  improvement_candidates: ['candidate_id', 'program_id', 'fingerprint', 'title', 'evidence', 'status', 'plan_id', 'pull_request_id', 'created_at', 'updated_at'],
} as const satisfies Record<string, readonly string[]>;

const V2_REQUIRED_COLUMNS = {
  ...V1_REQUIRED_COLUMNS,
  v4_jules_sessions: ['idempotency_key', 'session_id', 'repository', 'base_revision', 'result', 'updated_at'],
  improvement_candidates: ['candidate_id', 'program_id', 'fingerprint', 'title', 'evidence', 'status', 'plan_id', 'pull_request_id', 'risk', 'created_at', 'updated_at'],
  execution_sessions: ['execution_id', 'phase', 'provider', 'provider_session_id', 'workspace_host_path', 'workspace_execution_path', 'evidence_host_path', 'evidence_execution_path', 'workspace_created_at', 'source_repository_path', 'source_revision', 'provider_status', 'last_heartbeat_at', 'started_at', 'completed_at', 'final_response', 'error_code', 'created_at', 'updated_at'],
  execution_evidence: ['evidence_id', 'execution_id', 'kind', 'name', 'source_revision', 'payload', 'created_at'],
} as const satisfies Record<string, readonly string[]>;

export interface V4DatabaseOptions {
  env?: NodeJS.ProcessEnv;
  environment?: 'test' | 'development' | 'staging' | 'production';
  allowDataReset?: boolean;
}

function configure(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
}

function tableNames(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as Array<{ name: string }>).map((item) => item.name));
}

function schemaVersion(db: DatabaseSync): unknown {
  const tables = tableNames(db);
  if (!tables.has('schema_meta')) return undefined;
  const row = db.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get() as { schema_version?: unknown } | undefined;
  return row?.schema_version;
}

function assertVersion(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > SCHEMA_VERSION) {
    throw new V4Error('V4_SCHEMA_VERSION_INVALID', 'Unsupported V4 schema version: ' + String(value));
  }
}

function assertSchemaColumns(db: DatabaseSync, required: Record<string, readonly string[]>): void {
  const tables = tableNames(db);
  const missingTables = Object.keys(required).filter((name) => !tables.has(name));
  if (missingTables.length > 0) throw new V4Error('V4_SCHEMA_INCOMPLETE', 'Missing tables: ' + missingTables.join(','));
  const missingColumns: string[] = [];
  for (const [table, expected] of Object.entries(required)) {
    const escaped = table.replaceAll('"', '""');
    const actual = new Set((db.prepare('PRAGMA table_info("' + escaped + '")').all() as unknown as Array<{ name: string }>).map((row) => row.name));
    for (const column of expected) if (!actual.has(column)) missingColumns.push(table + '.' + column);
  }
  if (missingColumns.length > 0) throw new V4Error('V4_SCHEMA_INCOMPLETE', 'Missing columns: ' + missingColumns.join(','));
}

function hasForeignKey(db: DatabaseSync, table: string, from: string, target: string, to: string): boolean {
  const escaped = table.replaceAll('"', '""');
  const rows = db.prepare('PRAGMA foreign_key_list("' + escaped + '")').all() as unknown as Array<{ table: string; from: string; to: string }>;
  return rows.some((row) => row.table === target && row.from === from && row.to === to);
}

function assertV2Relationships(db: DatabaseSync): void {
  if (!hasForeignKey(db, 'improvement_candidates', 'plan_id', 'plans', 'plan_id')) {
    throw new V4Error('V4_SCHEMA_INCOMPLETE', 'Missing foreign key: improvement_candidates.plan_id -> plans.plan_id');
  }
}

function migrateImprovementCandidates(db: DatabaseSync): void {
  const columns = new Set((db.prepare('PRAGMA table_info(improvement_candidates)').all() as unknown as Array<{ name: string }>).map((row) => row.name));
  if (columns.has('risk') && hasForeignKey(db, 'improvement_candidates', 'plan_id', 'plans', 'plan_id')) return;
  const orphan = db.prepare(`SELECT candidate_id FROM improvement_candidates candidate
    WHERE candidate.plan_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM plans WHERE plans.plan_id=candidate.plan_id)
    LIMIT 1`).get() as { candidate_id: string } | undefined;
  if (orphan) throw new V4Error('V4_SCHEMA_CANDIDATE_PLAN_ORPHANED', 'Candidate references a missing plan: ' + orphan.candidate_id);
  if (tableNames(db).has('improvement_candidates_v2')) throw new V4Error('V4_SCHEMA_MIGRATION_TEMP_TABLE_EXISTS');
  db.exec(`CREATE TABLE improvement_candidates_v2 (
    candidate_id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL REFERENCES maintenance_programs(program_id),
    fingerprint TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    evidence TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_id TEXT REFERENCES plans(plan_id),
    pull_request_id TEXT,
    risk TEXT NOT NULL DEFAULT 'LOW',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const riskExpression = columns.has('risk') ? 'risk' : "'LOW'";
  db.exec(`INSERT INTO improvement_candidates_v2(
    candidate_id,program_id,fingerprint,title,evidence,status,plan_id,pull_request_id,risk,created_at,updated_at
  ) SELECT candidate_id,program_id,fingerprint,title,evidence,status,plan_id,pull_request_id,${riskExpression},created_at,updated_at
    FROM improvement_candidates`);
  db.exec('DROP TABLE improvement_candidates');
  db.exec('ALTER TABLE improvement_candidates_v2 RENAME TO improvement_candidates');
}

function migrateKnownV4Schema(db: DatabaseSync): void {
  const initialVersion = schemaVersion(db);
  if (initialVersion === undefined) throw new V4Error('V4_SCHEMA_META_MISSING');
  assertVersion(initialVersion);
  if (initialVersion === 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion === undefined) throw new V4Error('V4_SCHEMA_META_MISSING');
      assertVersion(lockedVersion);
      if (lockedVersion === 1) {
        assertSchemaColumns(db, V1_REQUIRED_COLUMNS);
        db.exec(CREATE_V1_COMPATIBILITY_SQL);
        migrateImprovementCandidates(db);
        db.exec(CREATE_EXECUTION_SESSIONS_SQL);
        assertSchemaColumns(db, V2_REQUIRED_COLUMNS);
        assertV2Relationships(db);
        const result = db.prepare("UPDATE schema_meta SET schema_version=? WHERE schema_id='pixel-v4' AND schema_version=1").run(SCHEMA_VERSION);
        if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      } else {
        assertSchemaColumns(db, V2_REQUIRED_COLUMNS);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original migration failure */ }
      throw error;
    }
  }
  const current = schemaVersion(db);
  if (current !== SCHEMA_VERSION) throw new V4Error('V4_SCHEMA_VERSION_INVALID');
  assertSchemaColumns(db, V2_REQUIRED_COLUMNS);
  assertV2Relationships(db);
}

function dropAllTables(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as unknown as Array<{ name: string }>;
  for (const row of rows) db.exec('DROP TABLE IF EXISTS "' + row.name.replaceAll('"', '""') + '"');
  db.exec('PRAGMA foreign_keys = ON;');
}

function createSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_V4_SQL);
  migrateKnownV4Schema(db);
}

export function assertCurrentV4Schema(db: DatabaseSync): void {
  const current = schemaVersion(db);
  if (current !== SCHEMA_VERSION) throw new V4Error('V4_SCHEMA_VERSION_INVALID');
  assertSchemaColumns(db, V2_REQUIRED_COLUMNS);
  assertV2Relationships(db);
}

export function openV4Database(file: string, options: V4DatabaseOptions = {}): DatabaseSync {
  const env = options.env ?? process.env;
  const environment = options.environment ?? (env.NODE_ENV as V4DatabaseOptions['environment']) ?? 'development';
  const isMemory = file === ':memory:';
  if (!isMemory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = !isMemory && fs.existsSync(file) && fs.statSync(file).size > 0;
  const db = new DatabaseSync(file);
  configure(db);

  if (tableNames(db).has('schema_meta')) {
    try {
      migrateKnownV4Schema(db);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  if (existed) {
    const authorized = options.allowDataReset === true || env.PIXEL_V4_ALLOW_DATA_RESET === 'true';
    if (!authorized) {
      db.close();
      throw new DataResetRequiredError(file);
    }
    if (environment === 'production') {
      db.close();
      throw new V4Error('PRODUCTION_RESET_FORBIDDEN', 'Production database reset is disabled by default.');
    }
    dropAllTables(db);
  }

  try {
    createSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  }
}

export function pragmaValue(db: DatabaseSync, name: string): string | number | undefined {
  const row = db.prepare('PRAGMA ' + name).get() as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const value = row[name] ?? row[Object.keys(row)[0] ?? ''];
  return value as string | number | undefined;
}
