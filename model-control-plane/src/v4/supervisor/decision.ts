import { parseSupervisorDecision } from './protocol.js';
import type { SupervisorDecision } from '../domain/supervisor.js';

export interface SupervisorDecisionSource { output: string; receivedAt?: string; }

export function decodeDecision(source: SupervisorDecisionSource): SupervisorDecision {
  return parseSupervisorDecision(source.output, source.receivedAt ?? new Date().toISOString());
}
