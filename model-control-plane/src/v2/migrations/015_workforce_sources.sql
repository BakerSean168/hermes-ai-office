ALTER TABLE v2_suppliers ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'EXTERNAL';
CREATE INDEX IF NOT EXISTS v2_suppliers_source_kind ON v2_suppliers(source_kind,lifecycle,name);
