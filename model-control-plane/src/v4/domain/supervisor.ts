import { InvalidTransitionError, failClosed } from './errors.js';
import type { SupervisorAction } from './action.js';

export const SUPERVISOR_STATUSES = [
  'CREATED', 'ACTIVE', 'SLEEPING', 'OBSERVING', 'DIAGNOSING', 'ACTION_PENDING', 'RECOVERING',
  'WAITING_FOR_RESOURCE', 'WAITING_FOR_SYSTEM_REPAIR', 'WAITING_FOR_EXTERNAL_EVIDENCE',
  'SAFETY_HOLD', 'COMPLETED', 'CANCELLED',
] as const;
export type SupervisorStatus = (typeof SUPERVISOR_STATUSES)[number];

export interface Supervisor {
  supervisorId: string;
  planId: string;
  conversationId?: string;
  status: SupervisorStatus;
  observationCursor: number;
  projectionDigest: string;
  policyId: string;
  budgetId: string;
  lease?: import('./resource.js').Lease;
  lastDecisionAt?: string;
  nextWakeAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionValidationResult {
  accepted: boolean;
  code: string;
  message?: string;
  checkedAt: string;
}

export interface SupervisorDecision {
  decisionId: string;
  version: 1;
  planId: string;
  supervisorId: string;
  observationCursor: number;
  projectionDigest: string;
  idempotencyKey: string;
  preconditionSnapshot: Record<string, unknown>;
  action: SupervisorAction;
  validatorResult?: ActionValidationResult;
  createdAt: string;
}

export type SupervisorWakeReason =
  | 'NEW_PLAN' | 'TERMINAL_RESULT' | 'UNKNOWN_FAILURE' | 'REPEATED_FAILURE'
  | 'STALL' | 'LIMIT' | 'RESOURCE_TRANSITION' | 'EXTERNAL_RESULT'
  | 'CHILD_PLAN' | 'OPERATOR_REQUEST';

export function transitionSupervisor(supervisor: Supervisor, next: SupervisorStatus, now: string): Supervisor {
  if (supervisor.status === next) return { ...supervisor, updatedAt: now };
  const allowed: Record<SupervisorStatus, readonly SupervisorStatus[]> = {
    CREATED: ['ACTIVE', 'CANCELLED'],
    ACTIVE: ['SLEEPING', 'OBSERVING', 'CANCELLED', 'COMPLETED'],
    SLEEPING: ['OBSERVING', 'CANCELLED', 'COMPLETED'],
    OBSERVING: ['DIAGNOSING', 'SLEEPING', 'ACTION_PENDING', 'CANCELLED'],
    DIAGNOSING: ['ACTION_PENDING', 'SLEEPING', 'WAITING_FOR_RESOURCE', 'WAITING_FOR_SYSTEM_REPAIR', 'WAITING_FOR_EXTERNAL_EVIDENCE', 'SAFETY_HOLD', 'CANCELLED'],
    ACTION_PENDING: ['RECOVERING', 'SLEEPING', 'SAFETY_HOLD', 'CANCELLED'],
    RECOVERING: ['SLEEPING', 'OBSERVING', 'WAITING_FOR_RESOURCE', 'WAITING_FOR_SYSTEM_REPAIR', 'WAITING_FOR_EXTERNAL_EVIDENCE', 'SAFETY_HOLD', 'COMPLETED', 'CANCELLED'],
    WAITING_FOR_RESOURCE: ['OBSERVING', 'ACTIVE', 'CANCELLED', 'SAFETY_HOLD'],
    WAITING_FOR_SYSTEM_REPAIR: ['OBSERVING', 'ACTIVE', 'CANCELLED', 'SAFETY_HOLD'],
    WAITING_FOR_EXTERNAL_EVIDENCE: ['OBSERVING', 'ACTIVE', 'CANCELLED', 'SAFETY_HOLD'],
    SAFETY_HOLD: ['ACTIVE', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  };
  if (!allowed[supervisor.status].includes(next)) {
    throw new InvalidTransitionError('Supervisor', supervisor.status, next);
  }
  return { ...supervisor, status: next, updatedAt: now };
}

export function validateSupervisor(supervisor: Supervisor): void {
  failClosed(supervisor.supervisorId.length > 0, 'SUPERVISOR_ID_REQUIRED');
  failClosed(supervisor.planId.length > 0, 'SUPERVISOR_PLAN_REQUIRED');
  failClosed(Number.isInteger(supervisor.observationCursor) && supervisor.observationCursor >= 0, 'SUPERVISOR_CURSOR_INVALID');
  failClosed(supervisor.policyId.length > 0, 'SUPERVISOR_POLICY_REQUIRED');
  failClosed(supervisor.budgetId.length > 0, 'SUPERVISOR_BUDGET_REQUIRED');
}
