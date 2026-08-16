CREATE TABLE IF NOT EXISTS v2_maintenance_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),
  expired_idempotency_keys INTEGER NOT NULL DEFAULT 0,
  stale_execution_sync_runs INTEGER NOT NULL DEFAULT 0,
  changes_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_maintenance_runs_started ON v2_maintenance_runs(started_at DESC);
