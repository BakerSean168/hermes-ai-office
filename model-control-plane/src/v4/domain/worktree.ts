import { failClosed } from './errors.js';

export const PLAN_WORKTREE_ROLES = [
  'INTEGRATION',
  'WORK_ITEM',
  'REVIEW',
  'DELIVERY_REPAIR',
] as const;
export type PlanWorktreeRole = (typeof PLAN_WORKTREE_ROLES)[number];

export const PLAN_WORKTREE_STATES = [
  'PROVISIONING',
  'READY',
  'WRITER_ATTACHED',
  'QUIESCENT',
  'REVIEWING',
  'INTEGRATED',
  'RETIRED',
  'FAILED',
] as const;
export type PlanWorktreeState = (typeof PLAN_WORKTREE_STATES)[number];

export interface PlanWorktree {
  worktreeId: string;
  projectKey: string;
  rootPlanId: string;
  workItemId?: string;
  role: PlanWorktreeRole;
  repositoryPath: string;
  hostPath: string;
  executionPath: string;
  branchRef?: string;
  baseRevision: string;
  currentRevision: string;
  state: PlanWorktreeState;
  ownerExecutionId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlanWorktreeRecordInput extends Omit<
  PlanWorktree,
  'state' | 'currentRevision' | 'ownerExecutionId' | 'version' | 'createdAt' | 'updatedAt'
> {
  state?: Extract<PlanWorktreeState, 'PROVISIONING' | 'REVIEWING'>;
}

const STATE_TRANSITIONS: Record<PlanWorktreeState, readonly PlanWorktreeState[]> = {
  PROVISIONING: ['READY', 'REVIEWING', 'FAILED'],
  READY: ['WRITER_ATTACHED', 'REVIEWING', 'INTEGRATED', 'RETIRED', 'FAILED'],
  WRITER_ATTACHED: ['QUIESCENT', 'FAILED'],
  QUIESCENT: ['WRITER_ATTACHED', 'INTEGRATED', 'RETIRED', 'FAILED'],
  REVIEWING: ['QUIESCENT', 'RETIRED', 'FAILED'],
  INTEGRATED: ['RETIRED', 'FAILED'],
  RETIRED: [],
  FAILED: ['RETIRED'],
};

export function validatePlanWorktree(worktree: PlanWorktree): void {
  failClosed(worktree.worktreeId.trim().length > 0, 'WORKTREE_ID_REQUIRED');
  failClosed(worktree.projectKey.trim().length > 0, 'WORKTREE_PROJECT_REQUIRED');
  failClosed(worktree.rootPlanId.trim().length > 0, 'WORKTREE_ROOT_PLAN_REQUIRED');
  failClosed(PLAN_WORKTREE_ROLES.includes(worktree.role), 'WORKTREE_ROLE_INVALID');
  failClosed(PLAN_WORKTREE_STATES.includes(worktree.state), 'WORKTREE_STATE_INVALID');
  failClosed(worktree.repositoryPath.startsWith('/'), 'WORKTREE_REPOSITORY_PATH_INVALID');
  failClosed(worktree.hostPath.startsWith('/'), 'WORKTREE_HOST_PATH_INVALID');
  failClosed(worktree.executionPath.startsWith('/'), 'WORKTREE_EXECUTION_PATH_INVALID');
  failClosed(worktree.baseRevision.trim().length > 0, 'WORKTREE_BASE_REVISION_REQUIRED');
  failClosed(worktree.currentRevision.trim().length > 0, 'WORKTREE_CURRENT_REVISION_REQUIRED');
  failClosed(
    Number.isInteger(worktree.version) && worktree.version >= 1,
    'WORKTREE_VERSION_INVALID',
  );
  if (worktree.role === 'WORK_ITEM')
    failClosed(Boolean(worktree.workItemId), 'WORKTREE_WORK_ITEM_REQUIRED');
  if (worktree.role === 'REVIEW')
    failClosed(!worktree.branchRef, 'WORKTREE_REVIEW_DETACHED_REQUIRED');
  if (worktree.ownerExecutionId)
    failClosed(
      worktree.state === 'WRITER_ATTACHED' || worktree.state === 'REVIEWING',
      'WORKTREE_OWNER_STATE_INVALID',
    );
}

export function transitionPlanWorktree(
  worktree: PlanWorktree,
  next: PlanWorktreeState,
): PlanWorktree {
  if (worktree.state === next) return worktree;
  failClosed(STATE_TRANSITIONS[worktree.state].includes(next), 'WORKTREE_STATE_TRANSITION_INVALID');
  return { ...worktree, state: next };
}
