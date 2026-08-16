CREATE TABLE IF NOT EXISTS v2_capability_definitions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('NUMERIC','BOOLEAN','TEXT')),
  unit TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_capability_claims (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('SUPPLIER','SUPPLIER_MODEL','EMPLOYEE','MODEL_OFFERING','EMPLOYMENT')),
  subject_id TEXT NOT NULL,
  capability_id TEXT NOT NULL REFERENCES v2_capability_definitions(id),
  value_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('DECLARED','MEASURED','MANUAL','INFERRED','IMPORTED')),
  confidence REAL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (expires_at IS NULL OR expires_at > observed_at)
);
CREATE INDEX IF NOT EXISTS v2_capability_claim_subject
  ON v2_capability_claims(subject_type, subject_id, capability_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS v2_requirement_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  requirements_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

ALTER TABLE v2_positions ADD COLUMN requirement_set_id TEXT REFERENCES v2_requirement_sets(id);

CREATE TABLE IF NOT EXISTS v2_qualification_assessments (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES v2_employees(id),
  position_id TEXT NOT NULL REFERENCES v2_positions(id),
  requirement_set_id TEXT REFERENCES v2_requirement_sets(id),
  qualified INTEGER NOT NULL CHECK (qualified IN (0,1)),
  reasons_json TEXT NOT NULL,
  effective_capabilities_json TEXT NOT NULL,
  input_version_refs_json TEXT NOT NULL DEFAULT '{}',
  evaluated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_qualification_employee_position
  ON v2_qualification_assessments(employee_id, position_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS v2_staffing_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  employee_selector_json TEXT NOT NULL,
  position_selector_json TEXT NOT NULL,
  appointment_class TEXT NOT NULL CHECK (appointment_class IN ('PRIMARY','BACKUP','RESERVE')),
  priority INTEGER NOT NULL DEFAULT 0,
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ACTIVE','PAUSED','RETIRED')),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

ALTER TABLE v2_appointments ADD COLUMN source_rule_id TEXT REFERENCES v2_staffing_rules(id);
CREATE INDEX IF NOT EXISTS v2_appointments_source_rule ON v2_appointments(source_rule_id);

CREATE TABLE IF NOT EXISTS v2_staffing_constraints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('GLOBAL','WORK_SCOPE','POSITION')),
  scope_id TEXT,
  constraint_type TEXT NOT NULL CHECK (constraint_type IN ('MAX_CONCURRENT_DUTIES','SEPARATION_OF_DUTIES')),
  strength TEXT NOT NULL CHECK (strength IN ('HARD','SOFT')),
  expression_json TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ACTIVE','PAUSED','RETIRED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_staffing_constraints_scope
  ON v2_staffing_constraints(scope_type, scope_id, lifecycle);
