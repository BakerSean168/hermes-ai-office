import { V4Error } from '../domain/errors.js';
import type { SupervisorAction } from '../domain/action.js';
import type { SupervisorDecision } from '../domain/supervisor.js';
import type { ActionRepository, DecisionRepository, SupervisorRepository } from '../persistence/repositories.js';
import type { SupervisorProjection } from './projection.js';
import { SupervisorActionValidator } from './validator.js';

export interface SupervisorKernelPort {
  continueExecution?(payload: Extract<SupervisorAction['payload'], { type: 'CONTINUE_EXECUTION' }>): { code: string; linkedExecutionId?: string };
  retryExecution?(payload: Extract<SupervisorAction['payload'], { type: 'RETRY_EXECUTION' }>): { code: string; linkedExecutionId?: string };
  switchRoute?(payload: Extract<SupervisorAction['payload'], { type: 'SWITCH_ROUTE' }>): { code: string; linkedExecutionId?: string };
  requestReview?(payload: Extract<SupervisorAction['payload'], { type: 'REQUEST_REVIEW' }>): { code: string; linkedExecutionId?: string };
  createRepair?(payload: Extract<SupervisorAction['payload'], { type: 'CREATE_REPAIR' }>): { code: string; linkedExecutionId?: string };
  replanRemainder?(payload: Extract<SupervisorAction['payload'], { type: 'REPLAN_REMAINDER' }>, planId: string): { code: string; linkedPlanId?: string };
  createChildPlan?(payload: Extract<SupervisorAction['payload'], { type: 'CREATE_CHILD_PLAN' }>, parentPlanId: string): { code: string; linkedPlanId?: string };
  pauseForResource?(payload: Extract<SupervisorAction['payload'], { type: 'PAUSE_FOR_RESOURCE' }>, planId: string): { code: string };
  parkExternalGate?(payload: Extract<SupervisorAction['payload'], { type: 'PARK_EXTERNAL_GATE' }>, planId: string): { code: string };
  escalate?(payload: Extract<SupervisorAction['payload'], { type: 'ESCALATE' }>, planId: string): { code: string };
}

export interface ActionExecutionResult {
  actionId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'DUPLICATE';
  code: string;
  action?: SupervisorAction;
}

export class SupervisorActionExecutor {
  readonly validator: SupervisorActionValidator;

  constructor(readonly actions: ActionRepository, readonly decisions: DecisionRepository, readonly kernel: SupervisorKernelPort, readonly supervisors?: SupervisorRepository) {
    this.validator = new SupervisorActionValidator(actions, supervisors);
  }

  execute(decision: SupervisorDecision, projection: SupervisorProjection): ActionExecutionResult {
    const existing = this.actions.findByIdempotencyKey(decision.idempotencyKey);
    if (existing) return { actionId: existing.actionId, status: 'DUPLICATE', code: 'DUPLICATE_ACTION', action: existing };
    const validation = this.validator.validate(decision, projection);
    const persistedDecision = { ...decision, validatorResult: validation };
    this.decisions.append(persistedDecision);
    const created = this.actions.create(decision.action);
    const action = created.value ?? decision.action;
    if (created.status === 'existing') return { actionId: action.actionId, status: 'DUPLICATE', code: 'DUPLICATE_ACTION', action };
    this.actions.recordValidation(action.actionId, validation);
    if (!validation.accepted) return { actionId: action.actionId, status: 'REJECTED', code: validation.code, action: this.actions.getById(action.actionId) };
    const advanced = this.supervisors?.advanceObservation(decision.supervisorId, projection.cursor, projection.digest, new Date().toISOString());
    if (advanced?.status === 'rejected') {
      const stale = this.actions.compareAndSetStatus(action.actionId, 'ACCEPTED', 'STALE');
      return { actionId: action.actionId, status: 'REJECTED', code: advanced.reason ?? 'STALE_OBSERVATION_CURSOR', action: stale.value };
    }
    try {
      const result = this.dispatch(action);
      if (result.code === 'KERNEL_PORT_UNAVAILABLE') throw new V4Error(result.code);
      const final = this.actions.recordSuccess(action.actionId, { ...result, completedAt: new Date().toISOString() });
      if (result.linkedExecutionId) this.actions.attachExecution(action.actionId, result.linkedExecutionId);
      if (result.linkedPlanId) this.actions.attachPlan(action.actionId, result.linkedPlanId);
      if (result.pullRequestId) this.actions.attachPullRequest(action.actionId, result.pullRequestId);
      return { actionId: action.actionId, status: 'SUCCEEDED', code: result.code, action: final.value };
    } catch (error) {
      const code = error instanceof V4Error ? error.code : 'ACTION_EXECUTION_FAILED';
      const final = this.actions.recordFailure(action.actionId, { code, message: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
      return { actionId: action.actionId, status: 'FAILED', code, action: final.value };
    }
  }

  private dispatch(action: SupervisorAction): { code: string; linkedExecutionId?: string; linkedPlanId?: string; pullRequestId?: string } {
    switch (action.type) {
      case 'NO_ACTION': return { code: 'NO_ACTION' };
      case 'CONTINUE_EXECUTION': return this.kernel.continueExecution?.(action.payload as Extract<SupervisorAction['payload'], { type: 'CONTINUE_EXECUTION' }>) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
      case 'RETRY_EXECUTION': return this.kernel.retryExecution?.(action.payload as Extract<SupervisorAction['payload'], { type: 'RETRY_EXECUTION' }>) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
      case 'SWITCH_ROUTE': return this.kernel.switchRoute?.(action.payload as Extract<SupervisorAction['payload'], { type: 'SWITCH_ROUTE' }>) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
      case 'REQUEST_REVIEW': return this.kernel.requestReview?.(action.payload as Extract<SupervisorAction['payload'], { type: 'REQUEST_REVIEW' }>) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
      case 'CREATE_REPAIR': return this.kernel.createRepair?.(action.payload as Extract<SupervisorAction['payload'], { type: 'CREATE_REPAIR' }>) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
      case 'REPLAN_REMAINDER': return this.kernel.replanRemainder?.(action.payload as Extract<SupervisorAction['payload'], { type: 'REPLAN_REMAINDER' }>, action.planId) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
      case 'CREATE_CHILD_PLAN': return this.kernel.createChildPlan?.(action.payload as Extract<SupervisorAction['payload'], { type: 'CREATE_CHILD_PLAN' }>, action.planId) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
      case 'PAUSE_FOR_RESOURCE': return this.kernel.pauseForResource?.(action.payload as Extract<SupervisorAction['payload'], { type: 'PAUSE_FOR_RESOURCE' }>, action.planId) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
      case 'PARK_EXTERNAL_GATE': return this.kernel.parkExternalGate?.(action.payload as Extract<SupervisorAction['payload'], { type: 'PARK_EXTERNAL_GATE' }>, action.planId) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
      case 'ESCALATE': return this.kernel.escalate?.(action.payload as Extract<SupervisorAction['payload'], { type: 'ESCALATE' }>, action.planId) ?? { code: 'KERNEL_PORT_UNAVAILABLE' };
    }
  }
}
