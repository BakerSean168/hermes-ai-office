ALTER TABLE v2_suppliers ADD COLUMN supply_origin TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (supply_origin IN ('OFFICIAL','COMMERCIAL_RELAY','COMMUNITY_RELAY','EVENT_GRANT','PERSONAL_HOSTED','INTERNAL_POOL','UNKNOWN'));
ALTER TABLE v2_suppliers ADD COLUMN routing_policy TEXT NOT NULL DEFAULT 'AUTO'
  CHECK (routing_policy IN ('AUTO','MANUAL_ONLY','BRAIN_ONLY','DISABLED'));
CREATE INDEX IF NOT EXISTS v2_suppliers_economics
  ON v2_suppliers(lifecycle,routing_policy,supply_origin,name);
