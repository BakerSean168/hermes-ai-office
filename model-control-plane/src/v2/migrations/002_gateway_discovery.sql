CREATE TABLE IF NOT EXISTS v2_channels (
  id TEXT PRIMARY KEY,
  gateway_id TEXT NOT NULL REFERENCES v2_gateways(id),
  supply_agreement_id TEXT REFERENCES v2_supply_agreements(id),
  external_route_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'ENABLED'
    CHECK (lifecycle IN ('ENABLED','DISABLED','QUARANTINED','ARCHIVED')),
  health TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (health IN ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN')),
  supplier_hint TEXT,
  supplier_model_hint TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (gateway_id, external_route_ref)
);
CREATE INDEX IF NOT EXISTS v2_channels_gateway_health
  ON v2_channels(gateway_id, health, lifecycle);
CREATE INDEX IF NOT EXISTS v2_channels_agreement
  ON v2_channels(supply_agreement_id, lifecycle);

CREATE TABLE IF NOT EXISTS v2_discovery_runs (
  id TEXT PRIMARY KEY,
  gateway_id TEXT NOT NULL REFERENCES v2_gateways(id),
  observed_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  route_count INTEGER NOT NULL DEFAULT 0,
  created_suppliers INTEGER NOT NULL DEFAULT 0,
  created_supplier_models INTEGER NOT NULL DEFAULT 0,
  created_employees INTEGER NOT NULL DEFAULT 0,
  created_agreements INTEGER NOT NULL DEFAULT 0,
  created_employments INTEGER NOT NULL DEFAULT 0,
  created_bindings INTEGER NOT NULL DEFAULT 0,
  issues_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS v2_discovery_runs_gateway_time
  ON v2_discovery_runs(gateway_id, started_at DESC);
