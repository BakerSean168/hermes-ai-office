CREATE TABLE IF NOT EXISTS v2_suppliers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','RETIRED','ARCHIVED')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_supplier_models (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES v2_suppliers(id),
  supplier_model_key TEXT NOT NULL,
  model_definition_ref TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  display_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','RETIRED')),
  first_seen_at INTEGER NOT NULL,
  retired_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (supplier_id, supplier_model_key)
);

CREATE TABLE IF NOT EXISTS v2_employees (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES v2_suppliers(id),
  supplier_model_id TEXT NOT NULL REFERENCES v2_supplier_models(id),
  display_name TEXT NOT NULL,
  record_lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (record_lifecycle IN ('ACTIVE','RETIRED','ARCHIVED')),
  first_seen_at INTEGER NOT NULL,
  retired_at INTEGER,
  archived_at INTEGER,
  archive_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (supplier_id, supplier_model_id)
);

CREATE TABLE IF NOT EXISTS v2_supply_agreements (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES v2_suppliers(id),
  plan_ref TEXT,
  name TEXT NOT NULL,
  external_account_ref TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('PENDING','ACTIVE','SUSPENDED','EXPIRED','TERMINATED','ARCHIVED')),
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  fixed_cost REAL,
  currency TEXT,
  billing_period TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  archived_at INTEGER,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE IF NOT EXISTS v2_employments (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES v2_employees(id),
  supply_agreement_id TEXT NOT NULL REFERENCES v2_supply_agreements(id),
  status TEXT NOT NULL CHECK (status IN ('SCHEDULED','CURRENT','SUSPENDED','ENDED')),
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  ended_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS v2_one_open_employment_per_agreement
  ON v2_employments(employee_id, supply_agreement_id)
  WHERE status IN ('SCHEDULED','CURRENT','SUSPENDED') AND effective_to IS NULL;

CREATE TABLE IF NOT EXISTS v2_gateways (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('LITELLM','CPA','DIRECT','OTHER')),
  display_name TEXT NOT NULL,
  base_url_hint TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','DEGRADED','DISABLED','RETIRED')),
  last_seen_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_gateway_bindings (
  id TEXT PRIMARY KEY,
  employment_id TEXT NOT NULL REFERENCES v2_employments(id),
  gateway_id TEXT NOT NULL REFERENCES v2_gateways(id),
  external_route_ref TEXT NOT NULL,
  protocol TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','DISABLED','RETIRED')),
  priority INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (employment_id, gateway_id, external_route_ref)
);
CREATE INDEX IF NOT EXISTS v2_gateway_bindings_employment
  ON v2_gateway_bindings(employment_id, lifecycle, priority DESC);

CREATE TABLE IF NOT EXISTS v2_work_scopes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','PAUSED','ARCHIVED')),
  external_profile_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS v2_positions (
  id TEXT PRIMARY KEY,
  work_scope_id TEXT REFERENCES v2_work_scopes(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'GENERIC',
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('PLANNED','ACTIVE','PAUSED','RETIRED','ARCHIVED')),
  runtime_kind TEXT,
  requirements_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retired_at INTEGER,
  archived_at INTEGER,
  UNIQUE (work_scope_id, slug)
);

CREATE TABLE IF NOT EXISTS v2_appointments (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES v2_employees(id),
  position_id TEXT NOT NULL REFERENCES v2_positions(id),
  appointment_class TEXT NOT NULL CHECK (appointment_class IN ('PRIMARY','BACKUP','RESERVE')),
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('SCHEDULED','CURRENT','SUSPENDED','ENDED','REVOKED')),
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  source TEXT NOT NULL DEFAULT 'MANUAL',
  ended_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS v2_one_open_appointment_per_employee_position
  ON v2_appointments(employee_id, position_id)
  WHERE status IN ('SCHEDULED','CURRENT','SUSPENDED') AND effective_to IS NULL;
CREATE INDEX IF NOT EXISTS v2_appointments_position_current
  ON v2_appointments(position_id, status, priority DESC);

CREATE TABLE IF NOT EXISTS v2_runs (
  id TEXT PRIMARY KEY,
  work_scope_id TEXT REFERENCES v2_work_scopes(id),
  external_run_ref TEXT,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','PLANNING','RUNNING','BLOCKED','FINALIZING','COMPLETED','FAILED','CANCELLED')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_duty_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES v2_runs(id),
  position_id TEXT NOT NULL REFERENCES v2_positions(id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('PLANNED','ACTIVE','COMPLETED','FAILED','CANCELLED')),
  current_activity TEXT NOT NULL DEFAULT 'IDLE',
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS v2_duties_run ON v2_duty_sessions(run_id, lifecycle);
CREATE INDEX IF NOT EXISTS v2_duties_position ON v2_duty_sessions(position_id, lifecycle);

CREATE TABLE IF NOT EXISTS v2_dispatch_decisions (
  id TEXT PRIMARY KEY,
  duty_session_id TEXT NOT NULL REFERENCES v2_duty_sessions(id),
  selected_employee_id TEXT REFERENCES v2_employees(id),
  selected_appointment_id TEXT REFERENCES v2_appointments(id),
  selected_employment_id TEXT REFERENCES v2_employments(id),
  candidate_results_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  policy_version TEXT NOT NULL,
  trigger TEXT NOT NULL,
  correlation_id TEXT,
  decided_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_dispatch_duty ON v2_dispatch_decisions(duty_session_id, decided_at);

CREATE TABLE IF NOT EXISTS v2_staffing_segments (
  id TEXT PRIMARY KEY,
  duty_session_id TEXT NOT NULL REFERENCES v2_duty_sessions(id),
  employee_id TEXT NOT NULL REFERENCES v2_employees(id),
  appointment_id TEXT REFERENCES v2_appointments(id),
  dispatch_decision_id TEXT NOT NULL REFERENCES v2_dispatch_decisions(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS v2_one_open_staffing_segment_per_duty
  ON v2_staffing_segments(duty_session_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS v2_staffing_employee_time
  ON v2_staffing_segments(employee_id, started_at DESC);

CREATE TABLE IF NOT EXISTS v2_model_invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES v2_runs(id),
  duty_session_id TEXT NOT NULL REFERENCES v2_duty_sessions(id),
  runtime_session_ref TEXT,
  logical_position_id TEXT NOT NULL REFERENCES v2_positions(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING','STREAMING','SUCCEEDED','FAILED','CANCELLED')),
  requested_at INTEGER NOT NULL,
  completed_at INTEGER,
  correlation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS v2_invocation_attempts (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES v2_model_invocations(id),
  attempt_number INTEGER NOT NULL,
  employee_id TEXT NOT NULL REFERENCES v2_employees(id),
  employment_id TEXT NOT NULL REFERENCES v2_employments(id),
  supply_agreement_id TEXT NOT NULL REFERENCES v2_supply_agreements(id),
  gateway_id TEXT NOT NULL REFERENCES v2_gateways(id),
  gateway_binding_id TEXT REFERENCES v2_gateway_bindings(id),
  external_route_ref TEXT NOT NULL,
  external_deployment_ref TEXT,
  gateway_request_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('STARTED','SUCCEEDED','FAILED','CANCELLED','UNKNOWN')),
  error_class TEXT,
  latency_ms INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (invocation_id, attempt_number),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS v2_attempts_gateway_request
  ON v2_invocation_attempts(gateway_id, gateway_request_id);

CREATE TABLE IF NOT EXISTS v2_usage_entries (
  id TEXT PRIMARY KEY,
  invocation_attempt_id TEXT NOT NULL REFERENCES v2_invocation_attempts(id),
  run_id TEXT NOT NULL REFERENCES v2_runs(id),
  duty_session_id TEXT NOT NULL REFERENCES v2_duty_sessions(id),
  position_id TEXT NOT NULL REFERENCES v2_positions(id),
  employee_id TEXT NOT NULL REFERENCES v2_employees(id),
  supplier_id TEXT NOT NULL REFERENCES v2_suppliers(id),
  employment_id TEXT NOT NULL REFERENCES v2_employments(id),
  supply_agreement_id TEXT NOT NULL REFERENCES v2_supply_agreements(id),
  supplier_model_id TEXT NOT NULL REFERENCES v2_supplier_models(id),
  gateway_id TEXT NOT NULL REFERENCES v2_gateways(id),
  external_route_ref TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  actual_cost REAL NOT NULL DEFAULT 0,
  allocated_cost REAL NOT NULL DEFAULT 0,
  market_value REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS v2_usage_attempt_once
  ON v2_usage_entries(invocation_attempt_id);
CREATE INDEX IF NOT EXISTS v2_usage_employee_time ON v2_usage_entries(employee_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS v2_usage_employment_time ON v2_usage_entries(employment_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS v2_usage_position_time ON v2_usage_entries(position_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS v2_usage_run_time ON v2_usage_entries(run_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS v2_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  entity_type TEXT,
  entity_id TEXT,
  aggregate_version INTEGER,
  correlation_id TEXT,
  causation_id TEXT,
  task_id TEXT,
  run_id TEXT,
  duty_session_id TEXT,
  invocation_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_ref TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_events_type_seq ON v2_events(type, seq);
CREATE INDEX IF NOT EXISTS v2_events_correlation ON v2_events(correlation_id, seq);

CREATE TABLE IF NOT EXISTS v2_idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_idempotency_expiry ON v2_idempotency_keys(expires_at);
