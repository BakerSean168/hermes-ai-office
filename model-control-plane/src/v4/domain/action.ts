import { InvalidTransitionError, failClosed } from './errors.js';

export const ACTION_STATUSES = [
  'PROPOSED', 'VALIDATING', 'ACCEPTED', 'REJECTED', 'EXECUTING',
  'SUCCEEDED', 'FAILED', 'STALE', 'CANCELLED',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export type SupervisorActionType =
  | 'NO_ACTION' | 'CONTINUE_EXECUTION' | 'RETRY_EXECUTION' | 'SWITCH_ROUTE'
  | 'REQUEST_REVIEW' | 'CREATE_REPAIR' | 'REPLAN_REMAINDER' | 'CREATE_CHILD_PLAN'
  | 'PAUSE_FOR_RESOURCE' | 'PARK_EXTERNAL_GATE' | 'ESCALATE';

export interface NoActionPayload { type: 'NO_ACTION'; reason: string; }
export interface ContinueExecutionPayload { type: 'CONTINUE_EXECUTION'; executionId: string; }
export interface RetryExecutionPayload { type: 'RETRY_EXECUTION'; executionId: string; reason: string; }
export interface SwitchRoutePayload { type: 'SWITCH_ROUTE'; executionId: string; route: string; }
export interface RequestReviewPayload { type: 'REQUEST_REVIEW'; executionId: string; reviewerRoute: string; }
export interface CreateRepairPayload { type: 'CREATE_REPAIR'; workItemId: string; baseExecutionId: string; findingRefs: string[]; }
export interface ReplanRemainderPayload {
  type: 'REPLAN_REMAINDER';
  reason: string;
  workItems: Array<{ itemKey: string; title: string; objective: string; dependencies: string[]; acceptanceCriteria: string[] }>;
}
export interface CreateChildPlanPayload {
  type: 'CREATE_CHILD_PLAN';
  childPlanId: string;
  repositoryPath: string;
  objective: string;
  relation: 'SYSTEM_REPAIR' | 'INFRASTRUCTURE_REPAIR' | 'FOLLOW_UP';
}
export interface PauseForResourcePayload { type: 'PAUSE_FOR_RESOURCE'; resourceId: string; reason: string; }
export interface ParkExternalGatePayload { type: 'PARK_EXTERNAL_GATE'; gate: 'NATIVE_MACHINE' | 'SECRET' | 'HUMAN' | 'POLICY'; reason: string; }
export interface EscalatePayload { type: 'ESCALATE'; reason: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; }

export type SupervisorActionPayload =
  | NoActionPayload | ContinueExecutionPayload | RetryExecutionPayload | SwitchRoutePayload
  | RequestReviewPayload | CreateRepairPayload | ReplanRemainderPayload | CreateChildPlanPayload
  | PauseForResourcePayload | ParkExternalGatePayload | EscalatePayload;

export interface SupervisorAction {
  actionId: string;
  version: 1;
  type: SupervisorActionType;
  planId: string;
  supervisorId: string;
  observationCursor: number;
  projectionDigest: string;
  idempotencyKey: string;
  preconditionSnapshot: Record<string, unknown>;
  payload: SupervisorActionPayload;
  status: ActionStatus;
  validation?: { accepted: boolean; code: string; message?: string; checkedAt: string };
  result?: { code: string; message?: string; linkedExecutionId?: string; linkedPlanId?: string; pullRequestId?: string; completedAt: string };
  createdAt: string;
  updatedAt: string;
}

const TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  PROPOSED: ['VALIDATING', 'CANCELLED'],
  VALIDATING: ['ACCEPTED', 'REJECTED', 'STALE', 'CANCELLED'],
  ACCEPTED: ['EXECUTING', 'CANCELLED', 'STALE'],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  REJECTED: [],
  SUCCEEDED: [],
  FAILED: ['EXECUTING', 'CANCELLED'],
  STALE: [],
  CANCELLED: [],
};

export function transitionAction(action: SupervisorAction, next: ActionStatus, now: string): SupervisorAction {
  if (action.status === next) return { ...action, updatedAt: now };
  if (!TRANSITIONS[action.status].includes(next)) {
    throw new InvalidTransitionError('SupervisorAction', action.status, next);
  }
  return { ...action, status: next, updatedAt: now };
}

export function validateActionShape(action: Pick<SupervisorAction, 'version' | 'type' | 'planId' | 'supervisorId' | 'observationCursor' | 'projectionDigest' | 'idempotencyKey' | 'payload'>): void {
  failClosed(action.version === 1, 'ACTION_VERSION_UNSUPPORTED');
  failClosed(action.planId.length > 0, 'ACTION_PLAN_REQUIRED');
  failClosed(action.supervisorId.length > 0, 'ACTION_SUPERVISOR_REQUIRED');
  failClosed(Number.isInteger(action.observationCursor) && action.observationCursor >= 0, 'ACTION_CURSOR_INVALID');
  failClosed(action.projectionDigest.length > 0, 'ACTION_DIGEST_REQUIRED');
  failClosed(action.idempotencyKey.length > 0, 'ACTION_IDEMPOTENCY_REQUIRED');
  failClosed(action.payload.type === action.type, 'ACTION_PAYLOAD_TYPE_MISMATCH');
}
