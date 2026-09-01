import { V4Error } from '../domain/errors.js';
import { validateActionShape, type SupervisorActionType } from '../domain/action.js';
import type { SupervisorDecision, ActionValidationResult } from '../domain/supervisor.js';
import type { SupervisorProjection } from './projection.js';
import type { ActionRepository, SupervisorRepository } from '../persistence/repositories.js';

export class SupervisorActionValidator {
  constructor(readonly actions?: ActionRepository, readonly supervisors?: SupervisorRepository) {}

  validate(decision: SupervisorDecision, projection: SupervisorProjection, now = new Date().toISOString()): ActionValidationResult {
    try {
      if (decision.planId !== projection.plan.planId) throw new V4Error('ACTION_PLAN_MISMATCH');
      if (decision.supervisorId !== projection.supervisor.supervisorId) throw new V4Error('ACTION_SUPERVISOR_MISMATCH');
      if (decision.observationCursor !== projection.cursor) throw new V4Error('STALE_OBSERVATION_CURSOR');
      if (decision.projectionDigest !== projection.digest) throw new V4Error('STALE_PROJECTION_DIGEST');
      const durable = this.supervisors?.getById(decision.supervisorId);
      if (durable?.projectionDigest && decision.observationCursor <= durable.observationCursor) {
        throw new V4Error('STALE_OBSERVATION_CURSOR');
      }
      validateActionShape(decision.action);
      if (!projection.supervisor.allowedActions.includes(decision.action.type)) throw new V4Error('ACTION_NOT_ALLOWED');
      if (this.actions?.findByIdempotencyKey(decision.idempotencyKey)) throw new V4Error('DUPLICATE_ACTION');
      this.validatePayload(decision.action.type, decision.action.payload, projection);
      return { accepted: true, code: 'ACCEPTED', checkedAt: now };
    } catch (error) {
      return { accepted: false, code: error instanceof V4Error ? error.code : 'ACTION_VALIDATION_FAILED', message: error instanceof Error ? error.message : String(error), checkedAt: now };
    }
  }

  private validatePayload(type: SupervisorActionType, payload: SupervisorDecision['action']['payload'], projection: SupervisorProjection): void {
    if (type === 'NO_ACTION' || type === 'ESCALATE' || type === 'PARK_EXTERNAL_GATE' || type === 'CREATE_CHILD_PLAN') return;
    if (type === 'CREATE_EXECUTION') {
      if (payload.type !== type) throw new V4Error('ACTION_PAYLOAD_TYPE_MISMATCH');
      const item = projection.graph.items.find((candidate) => candidate.workItemId === payload.workItemId);
      if (!item) throw new V4Error('WORK_ITEM_NOT_FOUND');
      if (item.status !== 'PENDING' && item.status !== 'READY' && item.status !== 'RUNNING') throw new V4Error('WORK_ITEM_NOT_RUNNABLE');
      const byKey = new Map(projection.graph.items.map((candidate) => [candidate.itemKey, candidate]));
      if (!item.dependencies.every((dependency) => byKey.get(dependency)?.status === 'SUCCEEDED')) throw new V4Error('WORK_ITEM_DEPENDENCIES_INCOMPLETE');
      if (projection.executions.some((execution) => execution.workItemId === item.workItemId && (execution.status === 'QUEUED' || execution.status === 'RUNNING'))) {
        throw new V4Error('WORK_ITEM_EXECUTION_ACTIVE');
      }
      return;
    }
    if (type === 'PAUSE_FOR_RESOURCE') return;
    if (type === 'REPLAN_REMAINDER') {
      if (payload.type !== type) throw new V4Error('ACTION_PAYLOAD_TYPE_MISMATCH');
      const completed = new Set(projection.graph.items.filter((item) => item.status === 'SUCCEEDED').map((item) => item.itemKey));
      if (Array.from(completed).some((key) => !payload.workItems.some((item) => item.itemKey === key))) throw new V4Error('COMPLETED_WORK_REMOVAL_REJECTED');
      return;
    }
    if (payload.type === 'CONTINUE_EXECUTION' || payload.type === 'RETRY_EXECUTION' || payload.type === 'SWITCH_ROUTE' || payload.type === 'REQUEST_REVIEW') {
      const execution = projection.executions.find((item) => item.executionId === payload.executionId);
      if (!execution) throw new V4Error('EXECUTION_NOT_FOUND');
      if (type === 'CONTINUE_EXECUTION' && execution.status !== 'RUNNING') throw new V4Error('EXECUTION_NOT_RESUMABLE');
      if (type === 'RETRY_EXECUTION' && execution.status !== 'FAILED' && execution.status !== 'BLOCKED') throw new V4Error('EXECUTION_NOT_RETRYABLE');
      if (type === 'SWITCH_ROUTE' && execution.status !== 'FAILED' && execution.status !== 'BLOCKED') throw new V4Error('EXECUTION_NOT_SWITCHABLE');
      if (type === 'REQUEST_REVIEW' && !execution.resultRevision) throw new V4Error('REVIEW_EXACT_RESULT_REQUIRED');
      return;
    }
    if (type === 'CREATE_REPAIR' && payload.type === type) {
      const execution = projection.executions.find((item) => item.executionId === payload.baseExecutionId);
      if (!execution?.resultRevision) throw new V4Error('REPAIR_EXACT_RESULT_REQUIRED');
      if (!execution.workItemId || execution.workItemId !== payload.workItemId) throw new V4Error('REPAIR_WORK_ITEM_MISMATCH');
      return;
    }
    throw new V4Error('ACTION_PAYLOAD_INVALID');
  }
}
