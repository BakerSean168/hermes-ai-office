import { InvalidTransitionError, failClosed } from './errors.js';

export const EXECUTION_PHASES = ['IMPLEMENT', 'IMPLEMENT_FIX', 'REVIEW'] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

export const EXECUTION_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface ExecutionIdentity {
  executionId: string;
  planId: string;
  workItemId?: string;
  phase: ExecutionPhase;
  parentExecutionId?: string;
  attempt: number;
  route: string;
  sourceRevision?: string;
}

export interface Execution {
  identity: ExecutionIdentity;
  idempotencyKey: string;
  objective: string;
  status: ExecutionStatus;
  resultRevision?: string;
  resultSummary?: string;
  errorCode?: string;
  retryable?: boolean;
  createdAt: string;
  updatedAt: string;
}

const TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: ['QUEUED', 'CANCELLED'],
  BLOCKED: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
};

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

export function transitionExecution(execution: Execution, next: ExecutionStatus, now: string): Execution {
  if (execution.status === next) return { ...execution, updatedAt: now };
  if (!TRANSITIONS[execution.status].includes(next)) {
    throw new InvalidTransitionError('Execution', execution.status, next);
  }
  return { ...execution, status: next, updatedAt: now };
}

export function validateExecutionIdentity(identity: ExecutionIdentity): void {
  failClosed(identity.executionId.length > 0, 'EXECUTION_ID_REQUIRED');
  failClosed(identity.planId.length > 0, 'EXECUTION_PLAN_REQUIRED');
  failClosed(EXECUTION_PHASES.includes(identity.phase), 'EXECUTION_PHASE_INVALID');
  failClosed(!identity.parentExecutionId || identity.parentExecutionId !== identity.executionId, 'EXECUTION_PARENT_INVALID');
  failClosed(Number.isInteger(identity.attempt) && identity.attempt > 0, 'EXECUTION_ATTEMPT_INVALID');
  failClosed(identity.route.length > 0, 'EXECUTION_ROUTE_REQUIRED');
}
