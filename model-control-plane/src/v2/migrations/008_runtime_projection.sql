ALTER TABLE v2_positions ADD COLUMN external_position_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS v2_position_external_run_ref
  ON v2_positions(origin_run_id, external_position_ref)
  WHERE origin_run_id IS NOT NULL AND external_position_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS v2_runs_external_ref_unique
  ON v2_runs(external_run_ref)
  WHERE external_run_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS v2_runtime_sessions (
  id TEXT PRIMARY KEY,
  duty_session_id TEXT NOT NULL REFERENCES v2_duty_sessions(id),
  position_id TEXT NOT NULL REFERENCES v2_positions(id),
  run_id TEXT NOT NULL REFERENCES v2_runs(id),
  runtime_kind TEXT NOT NULL,
  external_session_ref TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ACTIVE','COMPLETED','FAILED','CANCELLED')),
  state TEXT NOT NULL,
  model_hint TEXT,
  process_ref TEXT,
  cwd TEXT,
  worktree TEXT,
  parent_runtime_session_id TEXT REFERENCES v2_runtime_sessions(id),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  CHECK (closed_at IS NULL OR closed_at >= opened_at),
  UNIQUE (run_id, external_session_ref)
);
CREATE INDEX IF NOT EXISTS v2_runtime_sessions_duty_active
  ON v2_runtime_sessions(duty_session_id, lifecycle, opened_at DESC);
CREATE INDEX IF NOT EXISTS v2_runtime_sessions_position
  ON v2_runtime_sessions(position_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS v2_runtime_session_edges (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES v2_runs(id),
  from_runtime_session_id TEXT NOT NULL REFERENCES v2_runtime_sessions(id),
  to_runtime_session_id TEXT NOT NULL REFERENCES v2_runtime_sessions(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('SPAWNED','DELEGATED','SUPERVISES','REVIEWS','DEPENDS_ON')),
  source TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  CHECK (from_runtime_session_id <> to_runtime_session_id),
  UNIQUE (run_id, from_runtime_session_id, to_runtime_session_id, relation_type)
);

CREATE TABLE IF NOT EXISTS v2_activity_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES v2_runs(id),
  duty_session_id TEXT REFERENCES v2_duty_sessions(id),
  position_id TEXT REFERENCES v2_positions(id),
  runtime_session_id TEXT REFERENCES v2_runtime_sessions(id),
  activity TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS v2_activity_run_time
  ON v2_activity_events(run_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS v2_activity_position_time
  ON v2_activity_events(position_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS v2_execution_sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_revision TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  profiles_seen INTEGER NOT NULL DEFAULT 0,
  runs_seen INTEGER NOT NULL DEFAULT 0,
  nodes_seen INTEGER NOT NULL DEFAULT 0,
  runtime_sessions_seen INTEGER NOT NULL DEFAULT 0,
  edges_seen INTEGER NOT NULL DEFAULT 0,
  issues_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
