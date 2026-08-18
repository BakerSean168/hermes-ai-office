ALTER TABLE v2_provider_connections ADD COLUMN admin_state TEXT NOT NULL DEFAULT 'ENABLED' CHECK (admin_state IN ('ENABLED','DISABLED'));
ALTER TABLE v2_provider_connections ADD COLUMN availability_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (availability_state IN ('UNKNOWN','AVAILABLE','DEGRADED','CONGESTED','TEMP_UNAVAILABLE','UNAVAILABLE'));
ALTER TABLE v2_provider_connections ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE v2_provider_connections ADD COLUMN total_successes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE v2_provider_connections ADD COLUMN total_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE v2_provider_connections ADD COLUMN last_success_at INTEGER;
ALTER TABLE v2_provider_connections ADD COLUMN last_failure_at INTEGER;
ALTER TABLE v2_provider_connections ADD COLUMN last_error_kind TEXT;
ALTER TABLE v2_provider_connections ADD COLUMN last_error_status INTEGER;
ALTER TABLE v2_provider_connections ADD COLUMN last_error_message TEXT;
ALTER TABLE v2_provider_connections ADD COLUMN retry_after_at INTEGER;
ALTER TABLE v2_provider_connections ADD COLUMN state_changed_at INTEGER;
ALTER TABLE v2_provider_connections ADD COLUMN operator_note TEXT;
ALTER TABLE v2_provider_connections ADD COLUMN operator_updated_at INTEGER;

CREATE TABLE IF NOT EXISTS v2_provider_connection_attempts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES v2_provider_connections(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE','THROTTLED')),
  error_kind TEXT CHECK (error_kind IS NULL OR error_kind IN ('RATE_LIMIT','AUTH','QUOTA','NETWORK','TIMEOUT','SERVER','CLIENT','UNKNOWN')),
  http_status INTEGER,
  error_message TEXT,
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  retry_after_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS v2_provider_connection_attempts_conn_time
  ON v2_provider_connection_attempts(connection_id, observed_at DESC);
