import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { openV4Database } from './database.js';

export interface BootstrapV4Options {
  dbFile?: string;
  env?: NodeJS.ProcessEnv;
  environment?: 'test' | 'development' | 'staging' | 'production';
  allowDataReset?: boolean;
}

export function bootstrapV4(options: BootstrapV4Options = {}): { db: DatabaseSync; dbFile: string } {
  const env = options.env ?? process.env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dbFile = options.dbFile ?? env.MODEL_CP_DB ?? path.resolve(here, '../../../data/control-plane-v4.sqlite');
  return { db: openV4Database(dbFile, options), dbFile };
}
