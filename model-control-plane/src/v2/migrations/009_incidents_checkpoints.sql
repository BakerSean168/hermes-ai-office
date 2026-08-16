CREATE TABLE IF NOT EXISTS v2_projection_checkpoints (
  projection_name TEXT PRIMARY KEY,
  projection_version INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  rebuilt_at INTEGER,
  updated_at INTEGER NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS v2_incidents (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','ERROR','CRITICAL')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  title TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  run_id TEXT REFERENCES v2_runs(id),
  duty_session_id TEXT REFERENCES v2_duty_sessions(id),
  position_id TEXT REFERENCES v2_positions(id),
  employee_id TEXT REFERENCES v2_employees(id),
  first_event_seq INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  resolution_note TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_incidents_lifecycle_severity
  ON v2_incidents(lifecycle,severity,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS v2_incidents_run
  ON v2_incidents(run_id,lifecycle,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS v2_incidents_position
  ON v2_incidents(position_id,lifecycle,last_seen_at DESC);

CREATE TABLE IF NOT EXISTS v2_incident_event_links (
  incident_id TEXT NOT NULL REFERENCES v2_incidents(id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL REFERENCES v2_events(seq),
  link_type TEXT NOT NULL CHECK (link_type IN ('TRIGGER','UPDATE','ACKNOWLEDGE','RESOLVE','RECOVERY')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (incident_id,event_seq,link_type)
);
CREATE INDEX IF NOT EXISTS v2_incident_event_seq ON v2_incident_event_links(event_seq);
