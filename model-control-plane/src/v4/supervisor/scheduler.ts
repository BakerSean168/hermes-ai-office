import type { SupervisorRepository } from '../persistence/repositories.js';
import type { SupervisorWakeReason } from '../domain/supervisor.js';

export interface WakeRequest {
  supervisorId: string;
  observationCursor: number;
  reason: SupervisorWakeReason;
  requestedAt: string;
}

export class SupervisorWakeScheduler {
  readonly pending = new Map<string, WakeRequest>();

  constructor(readonly supervisors?: SupervisorRepository) {}

  schedule(input: WakeRequest): { status: 'created' | 'existing'; request: WakeRequest } {
    const key = input.supervisorId + ':' + input.observationCursor + ':' + input.reason;
    const existing = this.pending.get(key);
    if (existing) return { status: 'existing', request: existing };
    this.pending.set(key, input);
    return { status: 'created', request: input };
  }

  drain(): WakeRequest[] {
    const requests = Array.from(this.pending.values()).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    this.pending.clear();
    return requests;
  }

  recoverDue(now = new Date().toISOString()): WakeRequest[] {
    return (this.supervisors?.listDue(now) ?? []).map((supervisor) => ({
      supervisorId: supervisor.supervisorId, observationCursor: supervisor.observationCursor, reason: 'STALL' as const, requestedAt: now,
    }));
  }
}
