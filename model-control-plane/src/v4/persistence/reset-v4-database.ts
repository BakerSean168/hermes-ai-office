import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { DataResetRequiredError, V4Error } from '../domain/errors.js';
import { SCHEMA_V4_SQL } from './database.js';

export interface ResetOptions {
  env?: NodeJS.ProcessEnv;
  environment?: 'test' | 'development' | 'staging' | 'production';
  log?: (message: string) => void;
}

export interface ResetResult {
  databaseFile: string;
  scope: 'ALL_V4_DATA';
  authorized: true;
}

export function resetV4Database(file: string, options: ResetOptions = {}): ResetResult {
  const env = options.env ?? process.env;
  const environment = options.environment ?? (env.NODE_ENV as ResetOptions['environment']) ?? 'development';
  if (env.PIXEL_V4_ALLOW_DATA_RESET !== 'true') throw new DataResetRequiredError(file);
  if (environment === 'production') throw new V4Error('PRODUCTION_RESET_FORBIDDEN');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as unknown as Array<{ name: string }>;
    for (const row of rows) db.exec('DROP TABLE IF EXISTS "' + row.name.replaceAll('"', '""') + '"');
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA_V4_SQL);
  } finally {
    db.close();
  }
  const result: ResetResult = { databaseFile: file, scope: 'ALL_V4_DATA', authorized: true };
  options.log?.('Pixel V4 database reset scope: ' + result.scope + ' at ' + file);
  return result;
}
