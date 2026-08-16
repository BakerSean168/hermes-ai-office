CREATE TABLE IF NOT EXISTS v2_gateway_usage_evidence (
  id TEXT PRIMARY KEY,
  gateway_id TEXT NOT NULL REFERENCES v2_gateways(id),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('REQUEST','AGGREGATE')),
  evidence_key TEXT NOT NULL,
  external_route_ref TEXT NOT NULL,
  gateway_request_id TEXT,
  external_deployment_ref TEXT,
  model TEXT,
  provider TEXT,
  window TEXT,
  generated_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  request_status TEXT,
  error_class TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  failed_requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  actual_cost REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (gateway_id, evidence_kind, evidence_key)
);
CREATE INDEX IF NOT EXISTS v2_gateway_usage_evidence_route
  ON v2_gateway_usage_evidence(gateway_id, external_route_ref, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS v2_gateway_usage_evidence_request
  ON v2_gateway_usage_evidence(gateway_id, gateway_request_id)
  WHERE gateway_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS v2_usage_reconciliation_runs (
  id TEXT PRIMARY KEY,
  gateway_id TEXT NOT NULL REFERENCES v2_gateways(id),
  cursor TEXT,
  next_cursor TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  evidence_count INTEGER NOT NULL DEFAULT 0,
  request_matched INTEGER NOT NULL DEFAULT 0,
  request_unmatched INTEGER NOT NULL DEFAULT 0,
  request_usage_created INTEGER NOT NULL DEFAULT 0,
  request_mismatched INTEGER NOT NULL DEFAULT 0,
  aggregate_count INTEGER NOT NULL DEFAULT 0,
  issues_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS v2_usage_reconciliation_gateway_time
  ON v2_usage_reconciliation_runs(gateway_id, started_at DESC);
