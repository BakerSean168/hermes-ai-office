PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_meta (schema_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  event_order INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  UNIQUE (aggregate_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_cursor ON events(event_order);

CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  project_key TEXT NOT NULL,
  objective TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  current_revision TEXT NOT NULL,
  status TEXT NOT NULL,
  active_graph_version_id TEXT,
  parent_plan_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_versions (
  graph_version_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  version INTEGER NOT NULL,
  parent_graph_version_id TEXT,
  reason TEXT NOT NULL,
  triggering_observation_cursor INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(plan_id, version)
);
CREATE TABLE IF NOT EXISTS work_items (
  work_item_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  graph_version_id TEXT NOT NULL REFERENCES graph_versions(graph_version_id),
  item_key TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  status TEXT NOT NULL,
  exact_accepted_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(graph_version_id, item_key)
);
CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  work_item_id TEXT REFERENCES work_items(work_item_id),
  attempt INTEGER NOT NULL,
  route TEXT NOT NULL,
  source_revision TEXT,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  result_revision TEXT,
  result_summary TEXT,
  error_code TEXT,
  retryable INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  work_item_id TEXT REFERENCES work_items(work_item_id),
  implementation_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  reviewer_execution_id TEXT,
  source_revision TEXT NOT NULL,
  reviewed_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  findings TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supervisors (
  supervisor_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE REFERENCES plans(plan_id),
  conversation_id TEXT,
  status TEXT NOT NULL,
  observation_cursor INTEGER NOT NULL DEFAULT 0,
  projection_digest TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  last_decision_at TEXT,
  next_wake_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supervisor_decisions (
  decision_id TEXT PRIMARY KEY,
  supervisor_id TEXT NOT NULL REFERENCES supervisors(supervisor_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  version INTEGER NOT NULL,
  observation_cursor INTEGER NOT NULL,
  projection_digest TEXT NOT NULL,
  precondition_snapshot TEXT NOT NULL,
  action_payload TEXT NOT NULL,
  validator_result TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supervisor_actions (
  action_id TEXT PRIMARY KEY,
  supervisor_id TEXT NOT NULL REFERENCES supervisors(supervisor_id),
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  observation_cursor INTEGER NOT NULL,
  projection_digest TEXT NOT NULL,
  precondition_snapshot TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  validation TEXT,
  result TEXT,
  execution_id TEXT,
  child_plan_id TEXT,
  pull_request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (aggregate_type, aggregate_id)
);
CREATE TABLE IF NOT EXISTS resources (
  resource_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  quota_remaining REAL,
  observation TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS external_changes (
  external_change_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_relationships (
  relationship_id TEXT PRIMARY KEY,
  parent_plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  child_plan_id TEXT NOT NULL UNIQUE REFERENCES plans(plan_id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(parent_plan_id, child_plan_id, kind)
);
CREATE TABLE IF NOT EXISTS maintenance_programs (
  program_id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  policy TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS improvement_candidates (
  candidate_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES maintenance_programs(program_id),
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_id TEXT,
  pull_request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_meta(schema_id, schema_version, created_at)
VALUES ('pixel-v4', 1, CAST(strftime('%s','now') AS INTEGER));
