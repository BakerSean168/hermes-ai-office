import { InvalidTransitionError, failClosed } from './errors.js';

export const PLAN_STATUSES = [
  'DRAFT', 'READY', 'RUNNING', 'WAITING_FOR_RESOURCE', 'WAITING_FOR_SYSTEM_REPAIR',
  'WAITING_FOR_EXTERNAL_EVIDENCE', 'SAFETY_HOLD', 'SUCCEEDED', 'FAILED', 'CANCELLED',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface Plan {
  planId: string;
  idempotencyKey: string;
  projectKey: string;
  objective: string;
  repositoryPath: string;
  baseRevision: string;
  currentRevision: string;
  status: PlanStatus;
  activeGraphVersionId?: string;
  parentPlanId?: string;
  childPlanIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlanInput {
  planId?: string;
  idempotencyKey: string;
  projectKey: string;
  objective: string;
  repositoryPath: string;
  baseRevision: string;
  parentPlanId?: string;
}

const PLAN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['RUNNING', 'WAITING_FOR_RESOURCE', 'WAITING_FOR_EXTERNAL_EVIDENCE', 'SAFETY_HOLD', 'CANCELLED'],
  RUNNING: ['WAITING_FOR_RESOURCE', 'WAITING_FOR_SYSTEM_REPAIR', 'WAITING_FOR_EXTERNAL_EVIDENCE', 'SAFETY_HOLD', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_RESOURCE: ['READY', 'RUNNING', 'CANCELLED', 'SAFETY_HOLD'],
  WAITING_FOR_SYSTEM_REPAIR: ['READY', 'RUNNING', 'FAILED', 'CANCELLED', 'SAFETY_HOLD'],
  WAITING_FOR_EXTERNAL_EVIDENCE: ['READY', 'RUNNING', 'FAILED', 'CANCELLED', 'SAFETY_HOLD'],
  SAFETY_HOLD: ['READY', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isTerminalPlanStatus(status: PlanStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

export function transitionPlan(plan: Plan, next: PlanStatus, now: string): Plan {
  if (plan.status === next) return { ...plan, updatedAt: now };
  if (!PLAN_TRANSITIONS[plan.status].includes(next)) {
    throw new InvalidTransitionError('Plan', plan.status, next);
  }
  return { ...plan, status: next, updatedAt: now };
}

export function validatePlanInput(input: CreatePlanInput): void {
  failClosed(input.idempotencyKey.trim().length > 0, 'PLAN_IDEMPOTENCY_REQUIRED');
  failClosed(input.projectKey.trim().length > 0, 'PLAN_PROJECT_REQUIRED');
  failClosed(input.objective.trim().length > 0, 'PLAN_OBJECTIVE_REQUIRED');
  failClosed(input.repositoryPath.trim().length > 0, 'PLAN_REPOSITORY_REQUIRED');
  failClosed(input.baseRevision.trim().length > 0, 'PLAN_BASE_REVISION_REQUIRED');
}
