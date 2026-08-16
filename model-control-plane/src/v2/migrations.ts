import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface StatementLike {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): unknown;
}

export interface MigrationDatabase {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
}

export interface SqlMigration {
  id: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function defaultMigrationDirectory(): string {
  const candidates = [
    path.join(moduleDir, 'migrations'),
    path.resolve(moduleDir, '../../src/v2/migrations'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`V2 migration directory not found: ${candidates.join(', ')}`);
  return found;
}

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

export function loadV2Migrations(directory = defaultMigrationDirectory()): SqlMigration[] {
  return fs
    .readdirSync(directory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(directory, name), 'utf8');
      return { id: name.replace(/\.sql$/, ''), sql, checksum: checksum(sql) };
    });
}

function migrationRow(value: unknown): { checksum?: string } | null {
  return value && typeof value === 'object' ? (value as { checksum?: string }) : null;
}

export function runV2Migrations(
  db: MigrationDatabase,
  migrations = loadV2Migrations(),
  appliedAt = Date.now(),
): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied: string[] = [];
  const skipped: string[] = [];
  const lookup = db.prepare('SELECT checksum FROM v2_schema_migrations WHERE id=?');
  const insert = db.prepare(
    'INSERT INTO v2_schema_migrations(id,checksum,applied_at) VALUES(?,?,?)',
  );

  for (const migration of migrations) {
    const existing = migrationRow(lookup.get(migration.id));
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `V2 migration checksum mismatch for ${migration.id}: expected ${existing.checksum}, got ${migration.checksum}`,
        );
      }
      skipped.push(migration.id);
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      insert.run(migration.id, migration.checksum, appliedAt);
      db.exec('COMMIT');
      applied.push(migration.id);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The original migration error remains authoritative.
      }
      throw error;
    }
  }

  return { applied, skipped };
}
