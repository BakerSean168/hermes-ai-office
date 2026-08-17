CREATE TABLE IF NOT EXISTS v2_provider_connections (
  id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  supplier_id TEXT REFERENCES v2_suppliers(id),
  base_url TEXT,
  protocol TEXT,
  auth_kind TEXT NOT NULL DEFAULT 'API_KEY' CHECK (auth_kind IN ('API_KEY','OAUTH','SUBSCRIPTION','ACCOUNT_POOL','NONE')),
  credential_ref TEXT,
  credential_scope TEXT NOT NULL DEFAULT 'GLOBAL' CHECK (credential_scope IN ('GLOBAL','PROFILE_LOCAL','OAUTH_PROFILE','EXTERNAL')),
  source_profile_id TEXT,
  source_kind TEXT NOT NULL,
  share_scope TEXT NOT NULL DEFAULT 'GLOBAL' CHECK (share_scope IN ('GLOBAL','PROFILE_ONLY')),
  health TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (health IN ('UNKNOWN','READY','DEGRADED','UNAVAILABLE')),
  models_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','SUSPENDED','RETIRED')),
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS v2_provider_connection_global_identity
  ON v2_provider_connections(provider_key,COALESCE(base_url,''),COALESCE(credential_ref,''))
  WHERE credential_scope='GLOBAL';

CREATE UNIQUE INDEX IF NOT EXISTS v2_provider_connection_profile_identity
  ON v2_provider_connections(provider_key,COALESCE(base_url,''),COALESCE(credential_ref,''),COALESCE(source_profile_id,''))
  WHERE credential_scope!='GLOBAL';

CREATE INDEX IF NOT EXISTS v2_provider_connections_active
  ON v2_provider_connections(lifecycle,health,provider_key);

CREATE TABLE IF NOT EXISTS v2_profile_provider_links (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES v2_provider_connections(id),
  profile_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('HERMES','OPENCODE','CODEX','CLAUDE_CODE')),
  provider_ref TEXT,
  model_ref TEXT,
  profile_ref TEXT,
  source_kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','INACTIVE')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS v2_profile_provider_link_identity
  ON v2_profile_provider_links(
    connection_id,
    profile_id,
    runtime_kind,
    COALESCE(provider_ref,''),
    COALESCE(model_ref,''),
    COALESCE(profile_ref,'')
  );

CREATE INDEX IF NOT EXISTS v2_profile_provider_links_profile
  ON v2_profile_provider_links(profile_id,state,runtime_kind);
