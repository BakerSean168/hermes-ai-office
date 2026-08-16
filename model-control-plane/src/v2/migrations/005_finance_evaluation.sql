CREATE TABLE IF NOT EXISTS v2_reference_prices (
  id TEXT PRIMARY KEY,
  supplier_model_id TEXT NOT NULL REFERENCES v2_supplier_models(id),
  name TEXT NOT NULL,
  input_per_million REAL NOT NULL DEFAULT 0,
  output_per_million REAL NOT NULL DEFAULT 0,
  cache_read_per_million REAL NOT NULL DEFAULT 0,
  cache_write_per_million REAL NOT NULL DEFAULT 0,
  reasoning_per_million REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS v2_reference_prices_model_time
  ON v2_reference_prices(supplier_model_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS v2_usage_market_valuations (
  id TEXT PRIMARY KEY,
  usage_entry_id TEXT NOT NULL REFERENCES v2_usage_entries(id),
  reference_price_id TEXT NOT NULL REFERENCES v2_reference_prices(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  calculated_at INTEGER NOT NULL,
  superseded_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (usage_entry_id, reference_price_id)
);
CREATE INDEX IF NOT EXISTS v2_market_valuation_current
  ON v2_usage_market_valuations(usage_entry_id, superseded_at);

CREATE TABLE IF NOT EXISTS v2_cost_allocation_runs (
  id TEXT PRIMARY KEY,
  supply_agreement_id TEXT NOT NULL REFERENCES v2_supply_agreements(id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  fixed_cost REAL NOT NULL,
  currency TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('TOKENS','REQUESTS')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  total_basis REAL NOT NULL DEFAULT 0,
  allocated_total REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  superseded_at INTEGER,
  policy_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  CHECK (period_end > period_start)
);
CREATE INDEX IF NOT EXISTS v2_cost_allocation_current
  ON v2_cost_allocation_runs(supply_agreement_id, period_start, period_end, superseded_at);

CREATE TABLE IF NOT EXISTS v2_cost_allocation_entries (
  id TEXT PRIMARY KEY,
  allocation_run_id TEXT NOT NULL REFERENCES v2_cost_allocation_runs(id),
  usage_entry_id TEXT NOT NULL REFERENCES v2_usage_entries(id),
  basis_value REAL NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (allocation_run_id, usage_entry_id)
);

CREATE TABLE IF NOT EXISTS v2_evaluations (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  role_id TEXT,
  position_id TEXT REFERENCES v2_positions(id),
  employee_id TEXT REFERENCES v2_employees(id),
  dimensions_json TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS v2_evaluations_employee_position
  ON v2_evaluations(employee_id, position_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS v2_evaluations_subject
  ON v2_evaluations(subject_type, subject_id, recorded_at DESC);
