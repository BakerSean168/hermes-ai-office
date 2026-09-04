import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DataResetRequiredError, V4Error } from '../domain/errors.js';

export const SCHEMA_VERSION = 11;

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
  last_provider_observed_at TEXT,
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

const CREATE_PROJECT_PLAN_SCHEDULING_SQL = `
CREATE TABLE IF NOT EXISTS project_plan_leases (
  project_key TEXT PRIMARY KEY,
  repository_path TEXT NOT NULL,
  active_root_plan_id TEXT UNIQUE REFERENCES plans(plan_id),
  version INTEGER NOT NULL,
  acquired_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_plan_queue (
  plan_id TEXT PRIMARY KEY REFERENCES plans(plan_id),
  project_key TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enqueued_at TEXT NOT NULL,
  activated_at TEXT,
  cancelled_at TEXT,
  UNIQUE(project_key, sequence)
);
CREATE INDEX IF NOT EXISTS idx_project_plan_queue_ready
  ON project_plan_queue(project_key, cancelled_at, activated_at, priority DESC, sequence ASC);
`;

const CREATE_PLAN_WORKTREES_SQL = `
CREATE TABLE IF NOT EXISTS plan_worktrees (
  worktree_id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  root_plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  work_item_id TEXT REFERENCES work_items(work_item_id),
  role TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  host_path TEXT NOT NULL UNIQUE,
  execution_path TEXT NOT NULL UNIQUE,
  branch_ref TEXT,
  base_revision TEXT NOT NULL,
  current_revision TEXT NOT NULL,
  state TEXT NOT NULL,
  owner_execution_id TEXT REFERENCES executions(execution_id),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_worktrees_plan ON plan_worktrees(root_plan_id, state, role);
CREATE INDEX IF NOT EXISTS idx_plan_worktrees_work_item ON plan_worktrees(root_plan_id, work_item_id, state);
`;

const CREATE_RESOURCE_ROUTING_SQL = `
CREATE TABLE IF NOT EXISTS execution_resource_selections (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
  capability TEXT NOT NULL,
  model_family TEXT NOT NULL,
  agent_backend TEXT NOT NULL,
  transport TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_tier INTEGER NOT NULL,
  model_rank INTEGER NOT NULL,
  resource_sequence INTEGER NOT NULL,
  resource_state TEXT NOT NULL,
  selection_reason TEXT NOT NULL,
  binding_id TEXT,
  deployment_id TEXT,
  route_model TEXT,
  protocol TEXT,
  selected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_resource_selections_resource
  ON execution_resource_selections(resource_id, selected_at);
CREATE TABLE IF NOT EXISTS resource_state_overrides (
  resource_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  reason_class TEXT,
  sanitized_reason TEXT,
  suspended_until TEXT,
  source TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const CREATE_PROTECTED_REF_SNAPSHOT_SQL = `
CREATE TABLE IF NOT EXISTS plan_protected_refs (
  root_plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  ref_name TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(root_plan_id, ref_name)
);
CREATE INDEX IF NOT EXISTS idx_plan_protected_refs_plan ON plan_protected_refs(root_plan_id, ref_name);
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
  'CREATE TABLE IF NOT EXISTS plan_deliveries (plan_id TEXT PRIMARY KEY REFERENCES plans(plan_id), remote TEXT NOT NULL, branch TEXT NOT NULL, target_branch TEXT NOT NULL, auto_merge INTEGER NOT NULL, merge_method TEXT NOT NULL, required_checks TEXT NOT NULL, status TEXT NOT NULL, head_sha TEXT, pull_request_number INTEGER, pull_request_url TEXT, merge_sha TEXT, error_code TEXT, superseded_by_plan_id TEXT REFERENCES plans(plan_id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS graph_versions (graph_version_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(plan_id), version INTEGER NOT NULL, parent_graph_version_id TEXT, reason TEXT NOT NULL, triggering_observation_cursor INTEGER, status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(plan_id, version));',
  "CREATE TABLE IF NOT EXISTS work_items (work_item_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(plan_id), graph_version_id TEXT NOT NULL REFERENCES graph_versions(graph_version_id), item_key TEXT NOT NULL, title TEXT NOT NULL, objective TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, dependencies TEXT NOT NULL, parallel_safe INTEGER NOT NULL DEFAULT 0, write_scopes TEXT NOT NULL DEFAULT '[]', conflict_keys TEXT NOT NULL DEFAULT '[]', wave INTEGER, integration_base_revision TEXT, status TEXT NOT NULL, exact_accepted_revision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(graph_version_id, item_key));",
  'CREATE TABLE IF NOT EXISTS executions (execution_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL REFERENCES plans(plan_id), work_item_id TEXT REFERENCES work_items(work_item_id), phase TEXT NOT NULL, parent_execution_id TEXT REFERENCES executions(execution_id), attempt INTEGER NOT NULL, route TEXT NOT NULL, source_revision TEXT, objective TEXT NOT NULL, status TEXT NOT NULL, result_revision TEXT, result_summary TEXT, error_code TEXT, retryable INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  CREATE_EXECUTION_SESSIONS_SQL,
  'CREATE TABLE IF NOT EXISTS reviews (review_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL REFERENCES plans(plan_id), work_item_id TEXT REFERENCES work_items(work_item_id), implementation_execution_id TEXT NOT NULL REFERENCES executions(execution_id), reviewer_execution_id TEXT, source_revision TEXT NOT NULL, reviewed_sha TEXT NOT NULL, status TEXT NOT NULL, verdict TEXT, findings TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS supervisors (supervisor_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES plans(plan_id), conversation_id TEXT, status TEXT NOT NULL, observation_cursor INTEGER NOT NULL DEFAULT 0, projection_digest TEXT NOT NULL, policy_id TEXT NOT NULL, budget_id TEXT NOT NULL, last_decision_at TEXT, next_wake_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS supervisor_decisions (decision_id TEXT PRIMARY KEY, supervisor_id TEXT NOT NULL REFERENCES supervisors(supervisor_id), idempotency_key TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL REFERENCES plans(plan_id), version INTEGER NOT NULL, observation_cursor INTEGER NOT NULL, projection_digest TEXT NOT NULL, precondition_snapshot TEXT NOT NULL, action_payload TEXT NOT NULL, validator_result TEXT, created_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS supervisor_actions (action_id TEXT PRIMARY KEY, supervisor_id TEXT NOT NULL REFERENCES supervisors(supervisor_id), plan_id TEXT NOT NULL REFERENCES plans(plan_id), version INTEGER NOT NULL, type TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, observation_cursor INTEGER NOT NULL, projection_digest TEXT NOT NULL, precondition_snapshot TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, validation TEXT, result TEXT, execution_id TEXT, child_plan_id TEXT, pull_request_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS leases (aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, owner_id TEXT NOT NULL, lease_token TEXT NOT NULL, claimed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (aggregate_type, aggregate_id));',
  'CREATE TABLE IF NOT EXISTS resources (resource_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, capabilities TEXT NOT NULL, quota_remaining REAL, observation TEXT NOT NULL, updated_at TEXT NOT NULL, observed_at TEXT NOT NULL);',
  CREATE_RESOURCE_ROUTING_SQL,
  CREATE_PROJECT_PLAN_SCHEDULING_SQL,
  CREATE_PLAN_WORKTREES_SQL,
  CREATE_PROTECTED_REF_SNAPSHOT_SQL,
  'CREATE TABLE IF NOT EXISTS external_changes (external_change_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, source_ref TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS plan_relationships (relationship_id TEXT PRIMARY KEY, parent_plan_id TEXT NOT NULL REFERENCES plans(plan_id), child_plan_id TEXT NOT NULL UNIQUE REFERENCES plans(plan_id), kind TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(parent_plan_id, child_plan_id, kind));',
  'CREATE TABLE IF NOT EXISTS maintenance_programs (program_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, policy TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  "CREATE TABLE IF NOT EXISTS improvement_candidates (candidate_id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES maintenance_programs(program_id), fingerprint TEXT NOT NULL UNIQUE, title TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL, plan_id TEXT REFERENCES plans(plan_id), pull_request_id TEXT, risk TEXT NOT NULL DEFAULT 'LOW', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
  "INSERT OR IGNORE INTO schema_meta(schema_id, schema_version, created_at) VALUES ('pixel-v4', 11, CAST(strftime('%s','now') AS INTEGER));",
].join('\n');

const V1_REQUIRED_COLUMNS = {
  supervisor_wakes: ['wake_key', 'supervisor_id', 'observation_cursor', 'reason', 'requested_at'],
  events: [
    'event_order',
    'event_id',
    'aggregate_id',
    'aggregate_type',
    'sequence',
    'type',
    'payload',
    'occurred_at',
    'correlation_id',
  ],
  plans: [
    'plan_id',
    'idempotency_key',
    'project_key',
    'objective',
    'repository_path',
    'base_revision',
    'current_revision',
    'status',
    'active_graph_version_id',
    'parent_plan_id',
    'created_at',
    'updated_at',
  ],
  graph_versions: [
    'graph_version_id',
    'plan_id',
    'version',
    'parent_graph_version_id',
    'reason',
    'triggering_observation_cursor',
    'status',
    'created_at',
  ],
  work_items: [
    'work_item_id',
    'plan_id',
    'graph_version_id',
    'item_key',
    'title',
    'objective',
    'acceptance_criteria',
    'dependencies',
    'status',
    'exact_accepted_revision',
    'created_at',
    'updated_at',
  ],
  executions: [
    'execution_id',
    'idempotency_key',
    'plan_id',
    'work_item_id',
    'attempt',
    'route',
    'source_revision',
    'objective',
    'status',
    'result_revision',
    'result_summary',
    'error_code',
    'retryable',
    'created_at',
    'updated_at',
  ],
  reviews: [
    'review_id',
    'idempotency_key',
    'plan_id',
    'work_item_id',
    'implementation_execution_id',
    'reviewer_execution_id',
    'source_revision',
    'reviewed_sha',
    'status',
    'verdict',
    'findings',
    'created_at',
    'updated_at',
  ],
  supervisors: [
    'supervisor_id',
    'plan_id',
    'conversation_id',
    'status',
    'observation_cursor',
    'projection_digest',
    'policy_id',
    'budget_id',
    'last_decision_at',
    'next_wake_at',
    'created_at',
    'updated_at',
  ],
  supervisor_decisions: [
    'decision_id',
    'supervisor_id',
    'idempotency_key',
    'plan_id',
    'version',
    'observation_cursor',
    'projection_digest',
    'precondition_snapshot',
    'action_payload',
    'validator_result',
    'created_at',
  ],
  supervisor_actions: [
    'action_id',
    'supervisor_id',
    'plan_id',
    'version',
    'type',
    'idempotency_key',
    'observation_cursor',
    'projection_digest',
    'precondition_snapshot',
    'payload',
    'status',
    'validation',
    'result',
    'execution_id',
    'child_plan_id',
    'pull_request_id',
    'created_at',
    'updated_at',
  ],
  leases: ['aggregate_type', 'aggregate_id', 'owner_id', 'lease_token', 'claimed_at', 'expires_at'],
  resources: [
    'resource_id',
    'kind',
    'status',
    'capabilities',
    'quota_remaining',
    'observation',
    'updated_at',
    'observed_at',
  ],
  external_changes: [
    'external_change_id',
    'fingerprint',
    'repository',
    'base_sha',
    'head_sha',
    'source_ref',
    'status',
    'evidence',
    'created_at',
    'updated_at',
  ],
  plan_relationships: ['relationship_id', 'parent_plan_id', 'child_plan_id', 'kind', 'created_at'],
  maintenance_programs: [
    'program_id',
    'project_key',
    'policy',
    'status',
    'created_at',
    'updated_at',
  ],
  improvement_candidates: [
    'candidate_id',
    'program_id',
    'fingerprint',
    'title',
    'evidence',
    'status',
    'plan_id',
    'pull_request_id',
    'created_at',
    'updated_at',
  ],
} as const satisfies Record<string, readonly string[]>;

const V2_REQUIRED_COLUMNS = {
  ...V1_REQUIRED_COLUMNS,
  v4_jules_sessions: [
    'idempotency_key',
    'session_id',
    'repository',
    'base_revision',
    'result',
    'updated_at',
  ],
  improvement_candidates: [
    'candidate_id',
    'program_id',
    'fingerprint',
    'title',
    'evidence',
    'status',
    'plan_id',
    'pull_request_id',
    'risk',
    'created_at',
    'updated_at',
  ],
  execution_sessions: [
    'execution_id',
    'phase',
    'provider',
    'provider_session_id',
    'workspace_host_path',
    'workspace_execution_path',
    'evidence_host_path',
    'evidence_execution_path',
    'workspace_created_at',
    'source_repository_path',
    'source_revision',
    'provider_status',
    'last_heartbeat_at',
    'started_at',
    'completed_at',
    'final_response',
    'error_code',
    'created_at',
    'updated_at',
  ],
  execution_evidence: [
    'evidence_id',
    'execution_id',
    'kind',
    'name',
    'source_revision',
    'payload',
    'created_at',
  ],
} as const satisfies Record<string, readonly string[]>;

const V3_REQUIRED_COLUMNS = {
  ...V2_REQUIRED_COLUMNS,
  executions: [...V2_REQUIRED_COLUMNS.executions, 'phase', 'parent_execution_id'],
} as const satisfies Record<string, readonly string[]>;

const V4_REQUIRED_COLUMNS = {
  ...V3_REQUIRED_COLUMNS,
  plan_deliveries: [
    'plan_id',
    'remote',
    'branch',
    'target_branch',
    'auto_merge',
    'merge_method',
    'required_checks',
    'status',
    'head_sha',
    'pull_request_number',
    'pull_request_url',
    'merge_sha',
    'error_code',
    'created_at',
    'updated_at',
  ],
} as const satisfies Record<string, readonly string[]>;

const V5_REQUIRED_COLUMNS = {
  ...V4_REQUIRED_COLUMNS,
  plan_deliveries: [...V4_REQUIRED_COLUMNS.plan_deliveries, 'superseded_by_plan_id'],
} as const satisfies Record<string, readonly string[]>;

const V6_REQUIRED_COLUMNS = {
  ...V5_REQUIRED_COLUMNS,
  execution_resource_selections: [
    'execution_id',
    'capability',
    'model_family',
    'agent_backend',
    'transport',
    'resource_id',
    'resource_tier',
    'model_rank',
    'resource_sequence',
    'resource_state',
    'selection_reason',
    'binding_id',
    'deployment_id',
    'route_model',
    'protocol',
    'selected_at',
  ],
  resource_state_overrides: [
    'resource_id',
    'state',
    'reason_class',
    'sanitized_reason',
    'suspended_until',
    'source',
    'version',
    'updated_at',
  ],
} as const satisfies Record<string, readonly string[]>;

const V7_REQUIRED_COLUMNS = {
  ...V6_REQUIRED_COLUMNS,
  project_plan_leases: [
    'project_key',
    'repository_path',
    'active_root_plan_id',
    'version',
    'acquired_at',
    'updated_at',
  ],
  project_plan_queue: [
    'plan_id',
    'project_key',
    'repository_path',
    'sequence',
    'priority',
    'enqueued_at',
    'activated_at',
    'cancelled_at',
  ],
} as const satisfies Record<string, readonly string[]>;

const V8_REQUIRED_COLUMNS = {
  ...V7_REQUIRED_COLUMNS,
  plan_worktrees: [
    'worktree_id',
    'project_key',
    'root_plan_id',
    'work_item_id',
    'role',
    'repository_path',
    'host_path',
    'execution_path',
    'branch_ref',
    'base_revision',
    'current_revision',
    'state',
    'owner_execution_id',
    'version',
    'created_at',
    'updated_at',
  ],
} as const satisfies Record<string, readonly string[]>;

const V9_REQUIRED_COLUMNS = {
  ...V8_REQUIRED_COLUMNS,
  work_items: [
    ...V8_REQUIRED_COLUMNS.work_items,
    'parallel_safe',
    'write_scopes',
    'conflict_keys',
    'wave',
    'integration_base_revision',
  ],
} as const satisfies Record<string, readonly string[]>;

const V10_REQUIRED_COLUMNS = {
  ...V9_REQUIRED_COLUMNS,
  plan_protected_refs: ['root_plan_id', 'ref_name', 'revision', 'created_at'],
} as const satisfies Record<string, readonly string[]>;

const V11_REQUIRED_COLUMNS = {
  ...V10_REQUIRED_COLUMNS,
  execution_sessions: [...V10_REQUIRED_COLUMNS.execution_sessions, 'last_provider_observed_at'],
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
  return new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as Array<{
        name: string;
      }>
    ).map((item) => item.name),
  );
}

function schemaVersion(db: DatabaseSync): unknown {
  const tables = tableNames(db);
  if (!tables.has('schema_meta')) return undefined;
  const row = db
    .prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'")
    .get() as { schema_version?: unknown } | undefined;
  return row?.schema_version;
}

function assertVersion(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > SCHEMA_VERSION) {
    throw new V4Error(
      'V4_SCHEMA_VERSION_INVALID',
      'Unsupported V4 schema version: ' + String(value),
    );
  }
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const escaped = table.replaceAll('\"', '\"\"');
  return new Set(
    (
      db.prepare('PRAGMA table_info(\"' + escaped + '\")').all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
}

function assertSchemaColumns(db: DatabaseSync, required: Record<string, readonly string[]>): void {
  const tables = tableNames(db);
  const missingTables = Object.keys(required).filter((name) => !tables.has(name));
  if (missingTables.length > 0)
    throw new V4Error('V4_SCHEMA_INCOMPLETE', 'Missing tables: ' + missingTables.join(','));
  const missingColumns: string[] = [];
  for (const [table, expected] of Object.entries(required)) {
    const escaped = table.replaceAll('"', '""');
    const actual = new Set(
      (
        db.prepare('PRAGMA table_info("' + escaped + '")').all() as unknown as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    for (const column of expected)
      if (!actual.has(column)) missingColumns.push(table + '.' + column);
  }
  if (missingColumns.length > 0)
    throw new V4Error('V4_SCHEMA_INCOMPLETE', 'Missing columns: ' + missingColumns.join(','));
}

function hasForeignKey(
  db: DatabaseSync,
  table: string,
  from: string,
  target: string,
  to: string,
): boolean {
  const escaped = table.replaceAll('"', '""');
  const rows = db.prepare('PRAGMA foreign_key_list("' + escaped + '")').all() as unknown as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  return rows.some((row) => row.table === target && row.from === from && row.to === to);
}

function assertV2Relationships(db: DatabaseSync): void {
  if (!hasForeignKey(db, 'improvement_candidates', 'plan_id', 'plans', 'plan_id')) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: improvement_candidates.plan_id -> plans.plan_id',
    );
  }
}

function assertV3Relationships(db: DatabaseSync): void {
  assertV2Relationships(db);
  if (!hasForeignKey(db, 'executions', 'parent_execution_id', 'executions', 'execution_id')) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: executions.parent_execution_id -> executions.execution_id',
    );
  }
}

function assertV5Relationships(db: DatabaseSync): void {
  assertV3Relationships(db);
  if (!hasForeignKey(db, 'plan_deliveries', 'superseded_by_plan_id', 'plans', 'plan_id')) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: plan_deliveries.superseded_by_plan_id -> plans.plan_id',
    );
  }
}

function assertV6Relationships(db: DatabaseSync): void {
  assertV5Relationships(db);
  if (
    !hasForeignKey(
      db,
      'execution_resource_selections',
      'execution_id',
      'executions',
      'execution_id',
    )
  ) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: execution_resource_selections.execution_id -> executions.execution_id',
    );
  }
}

function assertV7Relationships(db: DatabaseSync): void {
  assertV6Relationships(db);
  if (!hasForeignKey(db, 'project_plan_leases', 'active_root_plan_id', 'plans', 'plan_id')) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: project_plan_leases.active_root_plan_id -> plans.plan_id',
    );
  }
  if (!hasForeignKey(db, 'project_plan_queue', 'plan_id', 'plans', 'plan_id')) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: project_plan_queue.plan_id -> plans.plan_id',
    );
  }
}

function assertV8Relationships(db: DatabaseSync): void {
  assertV7Relationships(db);
  if (!hasForeignKey(db, 'plan_worktrees', 'root_plan_id', 'plans', 'plan_id')) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: plan_worktrees.root_plan_id -> plans.plan_id',
    );
  }
  if (!hasForeignKey(db, 'plan_worktrees', 'work_item_id', 'work_items', 'work_item_id')) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: plan_worktrees.work_item_id -> work_items.work_item_id',
    );
  }
  if (!hasForeignKey(db, 'plan_worktrees', 'owner_execution_id', 'executions', 'execution_id')) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: plan_worktrees.owner_execution_id -> executions.execution_id',
    );
  }
}

function assertV9Relationships(db: DatabaseSync): void {
  assertV8Relationships(db);
}

function assertV10Relationships(db: DatabaseSync): void {
  assertV9Relationships(db);
  if (!hasForeignKey(db, 'plan_protected_refs', 'root_plan_id', 'plans', 'plan_id')) {
    throw new V4Error(
      'V4_SCHEMA_INCOMPLETE',
      'Missing foreign key: plan_protected_refs.root_plan_id -> plans.plan_id',
    );
  }
}

function assertV11Relationships(db: DatabaseSync): void {
  assertV10Relationships(db);
}

function migrateV10ToV11(db: DatabaseSync): void {
  if (schemaVersion(db) !== 10) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const lockedVersion = schemaVersion(db);
    if (lockedVersion !== 10) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
    assertSchemaColumns(db, V10_REQUIRED_COLUMNS);
    assertV10Relationships(db);
    const columns = tableColumns(db, 'execution_sessions');
    if (!columns.has('last_provider_observed_at'))
      db.exec('ALTER TABLE execution_sessions ADD COLUMN last_provider_observed_at TEXT');
    db.exec(`UPDATE execution_sessions
      SET last_provider_observed_at=COALESCE(completed_at,last_heartbeat_at,started_at)
      WHERE last_provider_observed_at IS NULL`);
    assertSchemaColumns(db, V11_REQUIRED_COLUMNS);
    assertV11Relationships(db);
    const result = db
      .prepare(
        "UPDATE schema_meta SET schema_version=11 WHERE schema_id='pixel-v4' AND schema_version=10",
      )
      .run();
    if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* preserve original migration failure */
    }
    throw error;
  }
}

function migrateImprovementCandidates(db: DatabaseSync): void {
  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(improvement_candidates)').all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  if (
    columns.has('risk') &&
    hasForeignKey(db, 'improvement_candidates', 'plan_id', 'plans', 'plan_id')
  )
    return;
  const orphan = db
    .prepare(
      `SELECT candidate_id FROM improvement_candidates candidate
    WHERE candidate.plan_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM plans WHERE plans.plan_id=candidate.plan_id)
    LIMIT 1`,
    )
    .get() as { candidate_id: string } | undefined;
  if (orphan)
    throw new V4Error(
      'V4_SCHEMA_CANDIDATE_PLAN_ORPHANED',
      'Candidate references a missing plan: ' + orphan.candidate_id,
    );
  if (tableNames(db).has('improvement_candidates_v2'))
    throw new V4Error('V4_SCHEMA_MIGRATION_TEMP_TABLE_EXISTS');
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
      if (lockedVersion !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V1_REQUIRED_COLUMNS);
      db.exec(CREATE_V1_COMPATIBILITY_SQL);
      migrateImprovementCandidates(db);
      db.exec(CREATE_EXECUTION_SESSIONS_SQL);
      assertSchemaColumns(db, V2_REQUIRED_COLUMNS);
      assertV2Relationships(db);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=2 WHERE schema_id='pixel-v4' AND schema_version=1",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  const afterV2 = schemaVersion(db);
  if (afterV2 === 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion !== 2) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V2_REQUIRED_COLUMNS);
      assertV2Relationships(db);
      const executionColumns = new Set(
        (
          db.prepare('PRAGMA table_info(executions)').all() as unknown as Array<{ name: string }>
        ).map((row) => row.name),
      );
      const hasPhase = executionColumns.has('phase');
      const hasParent = executionColumns.has('parent_execution_id');
      if (hasPhase !== hasParent)
        throw new V4Error('V4_SCHEMA_INCOMPLETE', 'Partial V3 execution columns detected.');
      if (!hasPhase) {
        db.exec("ALTER TABLE executions ADD COLUMN phase TEXT NOT NULL DEFAULT 'IMPLEMENT'");
        db.exec(
          'ALTER TABLE executions ADD COLUMN parent_execution_id TEXT REFERENCES executions(execution_id)',
        );
      }
      assertSchemaColumns(db, V3_REQUIRED_COLUMNS);
      assertV3Relationships(db);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=3 WHERE schema_id='pixel-v4' AND schema_version=2",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  const afterV3 = schemaVersion(db);
  if (afterV3 === 3) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion !== 3) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V3_REQUIRED_COLUMNS);
      assertV3Relationships(db);
      db.exec(
        'CREATE TABLE IF NOT EXISTS plan_deliveries (plan_id TEXT PRIMARY KEY REFERENCES plans(plan_id), remote TEXT NOT NULL, branch TEXT NOT NULL, target_branch TEXT NOT NULL, auto_merge INTEGER NOT NULL, merge_method TEXT NOT NULL, required_checks TEXT NOT NULL, status TEXT NOT NULL, head_sha TEXT, pull_request_number INTEGER, pull_request_url TEXT, merge_sha TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
      );
      assertSchemaColumns(db, V4_REQUIRED_COLUMNS);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=4 WHERE schema_id='pixel-v4' AND schema_version=3",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  const afterV4 = schemaVersion(db);
  if (afterV4 === 4) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion !== 4) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V4_REQUIRED_COLUMNS);
      assertV3Relationships(db);
      const deliveryColumns = new Set(
        (
          db.prepare('PRAGMA table_info(plan_deliveries)').all() as unknown as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      if (!deliveryColumns.has('superseded_by_plan_id')) {
        db.exec(
          'ALTER TABLE plan_deliveries ADD COLUMN superseded_by_plan_id TEXT REFERENCES plans(plan_id)',
        );
      }
      assertSchemaColumns(db, V5_REQUIRED_COLUMNS);
      assertV5Relationships(db);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=5 WHERE schema_id='pixel-v4' AND schema_version=4",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  const afterV5 = schemaVersion(db);
  if (afterV5 === 5) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion !== 5) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V5_REQUIRED_COLUMNS);
      assertV5Relationships(db);
      const existingTables = tableNames(db);
      if (existingTables.has('execution_resource_selections')) {
        assertSchemaColumns(db, {
          execution_resource_selections: V6_REQUIRED_COLUMNS.execution_resource_selections,
        });
      }
      if (existingTables.has('resource_state_overrides')) {
        assertSchemaColumns(db, {
          resource_state_overrides: V6_REQUIRED_COLUMNS.resource_state_overrides,
        });
      }
      db.exec(CREATE_RESOURCE_ROUTING_SQL);
      assertSchemaColumns(db, V6_REQUIRED_COLUMNS);
      assertV6Relationships(db);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=6 WHERE schema_id='pixel-v4' AND schema_version=5",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  const afterV6 = schemaVersion(db);
  if (afterV6 === 6) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion !== 6) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V6_REQUIRED_COLUMNS);
      assertV6Relationships(db);
      const existingTables = tableNames(db);
      if (existingTables.has('project_plan_leases')) {
        assertSchemaColumns(db, { project_plan_leases: V7_REQUIRED_COLUMNS.project_plan_leases });
      }
      if (existingTables.has('project_plan_queue')) {
        assertSchemaColumns(db, { project_plan_queue: V7_REQUIRED_COLUMNS.project_plan_queue });
      }
      db.exec(CREATE_PROJECT_PLAN_SCHEDULING_SQL);
      assertSchemaColumns(db, V7_REQUIRED_COLUMNS);
      assertV7Relationships(db);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=7 WHERE schema_id='pixel-v4' AND schema_version=6",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  const afterV7 = schemaVersion(db);
  if (afterV7 === 7) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion !== 7) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V7_REQUIRED_COLUMNS);
      assertV7Relationships(db);
      if (tableNames(db).has('plan_worktrees')) {
        assertSchemaColumns(db, { plan_worktrees: V8_REQUIRED_COLUMNS.plan_worktrees });
      }
      db.exec(CREATE_PLAN_WORKTREES_SQL);
      assertSchemaColumns(db, V8_REQUIRED_COLUMNS);
      assertV8Relationships(db);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=8 WHERE schema_id='pixel-v4' AND schema_version=7",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  const afterV8 = schemaVersion(db);
  if (afterV8 === 8) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion !== 8) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V8_REQUIRED_COLUMNS);
      assertV8Relationships(db);
      const columns = tableColumns(db, 'work_items');
      if (!columns.has('parallel_safe'))
        db.exec('ALTER TABLE work_items ADD COLUMN parallel_safe INTEGER NOT NULL DEFAULT 0');
      if (!columns.has('write_scopes'))
        db.exec("ALTER TABLE work_items ADD COLUMN write_scopes TEXT NOT NULL DEFAULT '[]'");
      if (!columns.has('conflict_keys'))
        db.exec("ALTER TABLE work_items ADD COLUMN conflict_keys TEXT NOT NULL DEFAULT '[]'");
      if (!columns.has('wave')) db.exec('ALTER TABLE work_items ADD COLUMN wave INTEGER');
      if (!columns.has('integration_base_revision'))
        db.exec('ALTER TABLE work_items ADD COLUMN integration_base_revision TEXT');
      assertSchemaColumns(db, V9_REQUIRED_COLUMNS);
      assertV9Relationships(db);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=9 WHERE schema_id='pixel-v4' AND schema_version=8",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  const afterV9 = schemaVersion(db);
  if (afterV9 === 9) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion !== 9) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V9_REQUIRED_COLUMNS);
      assertV9Relationships(db);
      const existingTables = tableNames(db);
      if (existingTables.has('plan_protected_refs')) {
        assertSchemaColumns(db, {
          plan_protected_refs: V10_REQUIRED_COLUMNS.plan_protected_refs,
        });
      }
      db.exec(CREATE_PROTECTED_REF_SNAPSHOT_SQL);
      assertSchemaColumns(db, V10_REQUIRED_COLUMNS);
      assertV10Relationships(db);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=10 WHERE schema_id='pixel-v4' AND schema_version=9",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  migrateV10ToV11(db);
  const current = schemaVersion(db);
  if (current !== SCHEMA_VERSION) throw new V4Error('V4_SCHEMA_VERSION_INVALID');
  assertSchemaColumns(db, V11_REQUIRED_COLUMNS);
  assertV11Relationships(db);
}

function dropAllTables(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ name: string }>;
  for (const row of rows) db.exec('DROP TABLE IF EXISTS "' + row.name.replaceAll('"', '""') + '"');
  db.exec('PRAGMA foreign_keys = ON;');
}

function createSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_V4_SQL);
  migrateKnownV4Schema(db);
}

export function assertCurrentV4Schema(db: DatabaseSync): void {
  const afterV9 = schemaVersion(db);
  if (afterV9 === 9) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = schemaVersion(db);
      if (lockedVersion !== 9) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      assertSchemaColumns(db, V9_REQUIRED_COLUMNS);
      assertV9Relationships(db);
      const existingTables = tableNames(db);
      if (existingTables.has('plan_protected_refs')) {
        assertSchemaColumns(db, {
          plan_protected_refs: V10_REQUIRED_COLUMNS.plan_protected_refs,
        });
      }
      db.exec(CREATE_PROTECTED_REF_SNAPSHOT_SQL);
      assertSchemaColumns(db, V10_REQUIRED_COLUMNS);
      assertV10Relationships(db);
      const result = db
        .prepare(
          "UPDATE schema_meta SET schema_version=10 WHERE schema_id='pixel-v4' AND schema_version=9",
        )
        .run();
      if (Number(result.changes) !== 1) throw new V4Error('V4_SCHEMA_MIGRATION_STALE');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original migration failure */
      }
      throw error;
    }
  }

  migrateV10ToV11(db);
  const current = schemaVersion(db);
  if (current !== SCHEMA_VERSION) throw new V4Error('V4_SCHEMA_VERSION_INVALID');
  assertSchemaColumns(db, V11_REQUIRED_COLUMNS);
  assertV11Relationships(db);
}

export function openV4Database(file: string, options: V4DatabaseOptions = {}): DatabaseSync {
  const env = options.env ?? process.env;
  const environment =
    options.environment ?? (env.NODE_ENV as V4DatabaseOptions['environment']) ?? 'development';
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
      throw new V4Error(
        'PRODUCTION_RESET_FORBIDDEN',
        'Production database reset is disabled by default.',
      );
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
    try {
      db.exec('ROLLBACK');
    } catch {
      /* preserve original failure */
    }
    throw error;
  }
}

export function pragmaValue(db: DatabaseSync, name: string): string | number | undefined {
  const row = db.prepare('PRAGMA ' + name).get() as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const value = row[name] ?? row[Object.keys(row)[0] ?? ''];
  return value as string | number | undefined;
}
