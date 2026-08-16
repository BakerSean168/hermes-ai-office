CREATE TABLE IF NOT EXISTS v2_role_definitions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  purpose TEXT,
  default_requirement_set_id TEXT REFERENCES v2_requirement_sets(id),
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','RETIRED','ARCHIVED')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_position_templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES v2_role_definitions(id),
  runtime_policy_json TEXT NOT NULL DEFAULT '{}',
  default_requirement_set_id TEXT REFERENCES v2_requirement_sets(id),
  lifecycle_policy TEXT NOT NULL CHECK (lifecycle_policy IN ('STANDING','RUN_SCOPED')),
  default_relations_json TEXT NOT NULL DEFAULT '[]',
  default_constraints_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE v2_positions ADD COLUMN role_id TEXT REFERENCES v2_role_definitions(id);
ALTER TABLE v2_positions ADD COLUMN template_id TEXT REFERENCES v2_position_templates(id);
ALTER TABLE v2_positions ADD COLUMN lifecycle_policy TEXT NOT NULL DEFAULT 'STANDING'
  CHECK (lifecycle_policy IN ('STANDING','RUN_SCOPED'));
ALTER TABLE v2_positions ADD COLUMN origin_run_id TEXT REFERENCES v2_runs(id);
ALTER TABLE v2_positions ADD COLUMN runtime_policy_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS v2_positions_origin_run ON v2_positions(origin_run_id, lifecycle_policy, lifecycle);
CREATE INDEX IF NOT EXISTS v2_positions_role ON v2_positions(role_id, lifecycle);

CREATE TABLE IF NOT EXISTS v2_position_relations (
  id TEXT PRIMARY KEY,
  from_position_id TEXT NOT NULL REFERENCES v2_positions(id),
  to_position_id TEXT NOT NULL REFERENCES v2_positions(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('SUPERVISES','DELEGATES_TO','REVIEWS','DEPENDS_ON','ESCALATES_TO')),
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  source TEXT NOT NULL CHECK (source IN ('MANUAL','TEMPLATE','POLICY','MIGRATION')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK (from_position_id <> to_position_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS v2_position_relation_open_unique
  ON v2_position_relations(from_position_id,to_position_id,relation_type)
  WHERE effective_to IS NULL;
