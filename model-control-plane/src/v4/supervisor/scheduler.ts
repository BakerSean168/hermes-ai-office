import { DatabaseSync } from 'node:sqlite';
import type { SupervisorRepository } from '../persistence/repositories.js';
import type { SupervisorWakeReason } from '../domain/supervisor.js';
import { withTransaction } from '../persistence/database.js';

export interface WakeRequest {
  supervisorId: string;
  observationCursor: number;
  reason: SupervisorWakeReason;
  requestedAt: string;
}

export class SupervisorWakeScheduler {
  constructor(readonly supervisors?: SupervisorRepository, readonly db: DatabaseSync = new DatabaseSync(':memory:')) {
    this.db.exec('CREATE TABLE IF NOT EXISTS supervisor_wakes (wake_key TEXT PRIMARY KEY, supervisor_id TEXT NOT NULL, observation_cursor INTEGER NOT NULL, reason TEXT NOT NULL, requested_at TEXT NOT NULL)');
  }

  schedule(input: WakeRequest): { status: 'created' | 'existing'; request: WakeRequest } {
    const key = input.supervisorId + ':' + input.observationCursor + ':' + input.reason;
    const result = this.db.prepare('INSERT OR IGNORE INTO supervisor_wakes(wake_key,supervisor_id,observation_cursor,reason,requested_at) VALUES(?,?,?,?,?)').run(key, input.supervisorId, input.observationCursor, input.reason, input.requestedAt);
    return { status: Number(result.changes) === 1 ? 'created' : 'existing', request: input };
  }

  drain(): WakeRequest[] {
    return withTransaction(this.db, () => { const rows = this.db.prepare('SELECT supervisor_id,observation_cursor,reason,requested_at FROM supervisor_wakes ORDER BY requested_at,wake_key').all() as unknown as Array<{ supervisor_id: string; observation_cursor: number; reason: SupervisorWakeReason; requested_at: string }>; this.db.exec('DELETE FROM supervisor_wakes'); return rows.map((row) => ({ supervisorId: row.supervisor_id, observationCursor: row.observation_cursor, reason: row.reason, requestedAt: row.requested_at })); });
  }

  recoverDue(now = new Date().toISOString()): WakeRequest[] {
    return (this.supervisors?.listDue(now) ?? []).map((supervisor) => ({
      supervisorId: supervisor.supervisorId, observationCursor: supervisor.observationCursor, reason: 'STALL' as const, requestedAt: now,
    }));
  }
}
