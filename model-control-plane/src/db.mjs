import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'api', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL, protocol TEXT, enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0, weight INTEGER NOT NULL DEFAULT 100, health TEXT NOT NULL DEFAULT 'unknown', last_test TEXT, base_url_hint TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(provider_id) REFERENCES providers(id));
    CREATE TABLE IF NOT EXISTS model_definitions (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, capabilities TEXT NOT NULL DEFAULT '[]', context_window INTEGER, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0, capabilities TEXT NOT NULL DEFAULT '[]', context_window INTEGER, quality_score REAL, reliability_score REAL, latency_score REAL, cost_score REAL, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(channel_id, model_id), FOREIGN KEY(channel_id) REFERENCES channels(id), FOREIGN KEY(model_id) REFERENCES model_definitions(id));
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, profile_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'generic', required_capabilities TEXT NOT NULL DEFAULT '[]', min_context INTEGER, weights TEXT NOT NULL DEFAULT '{}', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id));
    CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, position_id TEXT NOT NULL, worker_id TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, weight INTEGER NOT NULL DEFAULT 100, status TEXT NOT NULL DEFAULT 'standby', reason TEXT, effective_from INTEGER NOT NULL, effective_to INTEGER, metadata TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(position_id) REFERENCES positions(id), FOREIGN KEY(worker_id) REFERENCES workers(id));
    CREATE TABLE IF NOT EXISTS quotas (id TEXT PRIMARY KEY, channel_id TEXT, worker_id TEXT, kind TEXT NOT NULL DEFAULT 'credits', limit_value REAL, remaining_value REAL, unit TEXT NOT NULL DEFAULT 'usd', reset_at INTEGER, source TEXT, metadata TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL, FOREIGN KEY(channel_id) REFERENCES channels(id), FOREIGN KEY(worker_id) REFERENCES workers(id));
    CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, billing_kind TEXT NOT NULL DEFAULT 'metered', fixed_cost REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', billing_period TEXT NOT NULL DEFAULT 'month', starts_at INTEGER, resets_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(channel_id) REFERENCES channels(id));
    CREATE TABLE IF NOT EXISTS prices (id TEXT PRIMARY KEY, model_id TEXT NOT NULL, worker_id TEXT, input_per_million REAL NOT NULL DEFAULT 0, output_per_million REAL NOT NULL DEFAULT 0, cached_per_million REAL NOT NULL DEFAULT 0, reasoning_per_million REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', source TEXT, metadata TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL, FOREIGN KEY(model_id) REFERENCES model_definitions(id), FOREIGN KEY(worker_id) REFERENCES workers(id));
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, position_id TEXT, worker_id TEXT, external_run_id TEXT, task_id TEXT, agent_instance_id TEXT, status TEXT NOT NULL DEFAULT 'running', started_at INTEGER NOT NULL, completed_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(position_id) REFERENCES positions(id), FOREIGN KEY(worker_id) REFERENCES workers(id));
    CREATE TABLE IF NOT EXISTS usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, position_id TEXT, worker_id TEXT NOT NULL, channel_id TEXT NOT NULL, provider_id TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, actual_cost REAL NOT NULL DEFAULT 0, allocated_cost REAL NOT NULL DEFAULT 0, market_value REAL NOT NULL DEFAULT 0, occurred_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, entity_type TEXT, entity_id TEXT, payload TEXT NOT NULL DEFAULT '{}', occurred_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS external_usage_snapshots (source TEXT NOT NULL, range_key TEXT NOT NULL, provider_key TEXT NOT NULL, model_id TEXT NOT NULL, worker_id TEXT, channel_id TEXT, requests INTEGER NOT NULL DEFAULT 0, failed_requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, actual_cost REAL NOT NULL DEFAULT 0, allocated_cost REAL NOT NULL DEFAULT 0, market_value REAL NOT NULL DEFAULT 0, generated_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(source, range_key, provider_key, model_id));
    CREATE INDEX IF NOT EXISTS idx_usage_worker ON usage_ledger(worker_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_position ON usage_ledger(position_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
  `);
  for (const migration of [
    'ALTER TABLE external_usage_snapshots ADD COLUMN allocated_cost REAL NOT NULL DEFAULT 0',
    'ALTER TABLE external_usage_snapshots ADD COLUMN market_value REAL NOT NULL DEFAULT 0',
  ]) {
    try {
      db.exec(migration);
    } catch {}
  }
  return db;
}

export function json(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
