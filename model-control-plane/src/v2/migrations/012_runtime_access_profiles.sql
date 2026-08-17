CREATE TABLE IF NOT EXISTS v2_runtime_access_profiles (
  id TEXT PRIMARY KEY,
  employment_id TEXT NOT NULL REFERENCES v2_employments(id),
  runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('OPENCODE','CODEX','CLAUDE_CODE')),
  adapter_kind TEXT NOT NULL CHECK (adapter_kind IN ('NATIVE_CONFIG','GATEWAY')),
  provider_ref TEXT,
  model_ref TEXT NOT NULL,
  profile_ref TEXT,
  base_url TEXT,
  credential_ref TEXT,
  protocol TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 100,
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','SUSPENDED','RETIRED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS v2_runtime_access_identity
  ON v2_runtime_access_profiles(
    employment_id,
    runtime_kind,
    adapter_kind,
    COALESCE(provider_ref,''),
    model_ref,
    COALESCE(profile_ref,''),
    COALESCE(base_url,'')
  );

CREATE INDEX IF NOT EXISTS v2_runtime_access_resolve
  ON v2_runtime_access_profiles(employment_id,runtime_kind,lifecycle,priority DESC,created_at ASC);

ALTER TABLE v2_runtime_launch_decisions ADD COLUMN selected_access_profile_id TEXT REFERENCES v2_runtime_access_profiles(id);
ALTER TABLE v2_runtime_launch_decisions ADD COLUMN selected_provider TEXT;
ALTER TABLE v2_runtime_launch_decisions ADD COLUMN selected_adapter_kind TEXT;
ALTER TABLE v2_runtime_launch_decisions ADD COLUMN selected_base_url TEXT;
ALTER TABLE v2_runtime_launch_decisions ADD COLUMN selected_credential_ref TEXT;
ALTER TABLE v2_runtime_launch_decisions ADD COLUMN selected_protocol TEXT;
ALTER TABLE v2_runtime_launch_decisions ADD COLUMN selected_access_config_json TEXT NOT NULL DEFAULT '{}';
