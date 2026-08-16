CREATE TABLE IF NOT EXISTS v2_plans (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES v2_suppliers(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  commercial_type TEXT NOT NULL DEFAULT 'METERED'
    CHECK (commercial_type IN ('FREE','SUBSCRIPTION','PREPAID','METERED','SPONSORED','OTHER')),
  terms_json TEXT NOT NULL DEFAULT '{}',
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','RETIRED','ARCHIVED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (supplier_id, slug)
);

ALTER TABLE v2_supply_agreements ADD COLUMN plan_id TEXT REFERENCES v2_plans(id);

CREATE TABLE IF NOT EXISTS v2_model_offerings (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES v2_suppliers(id),
  supplier_model_id TEXT NOT NULL REFERENCES v2_supplier_models(id),
  plan_id TEXT REFERENCES v2_plans(id),
  supply_agreement_id TEXT REFERENCES v2_supply_agreements(id),
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','SUSPENDED','RETIRED')),
  advertised_capabilities_json TEXT NOT NULL DEFAULT '[]',
  protocol_options_json TEXT NOT NULL DEFAULT '[]',
  commercial_metadata_json TEXT NOT NULL DEFAULT '{}',
  valid_from INTEGER,
  valid_to INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS v2_model_offering_identity
  ON v2_model_offerings(supplier_model_id, COALESCE(plan_id,''), COALESCE(supply_agreement_id,''));

ALTER TABLE v2_employments ADD COLUMN model_offering_id TEXT REFERENCES v2_model_offerings(id);

CREATE TABLE IF NOT EXISTS v2_capacity_pools (
  id TEXT PRIMARY KEY,
  supply_agreement_id TEXT NOT NULL REFERENCES v2_supply_agreements(id),
  name TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('TOKENS','REQUESTS','COST','CONCURRENCY','CUSTOM')),
  limit_value REAL,
  remaining_value REAL,
  unit TEXT,
  reset_policy_json TEXT NOT NULL DEFAULT '{}',
  reset_at INTEGER,
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','SUSPENDED','RETIRED')),
  source TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  observed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (supply_agreement_id, name, dimension)
);
CREATE INDEX IF NOT EXISTS v2_capacity_agreement_active
  ON v2_capacity_pools(supply_agreement_id, lifecycle, dimension);
