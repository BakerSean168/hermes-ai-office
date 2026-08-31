import { V4Error } from '../domain/errors.js';
import type { Execution } from '../domain/execution.js';
import type { V4Repositories, MutationResult } from '../persistence/repositories.js';

export class RecoveryKernel {
  constructor(readonly repositories: V4Repositories) {}

  retry(input: { executionId: string; idempotencyKey: string; route: string; maxAttempts: number }): MutationResult<Execution> {
    const current = this.repositories.executions.get(input.executionId);
    if (current.status !== 'FAILED' && current.status !== 'BLOCKED') throw new V4Error('EXECUTION_NOT_RETRYABLE_STATE');
    if (current.identity.attempt >= input.maxAttempts) {
      if (current.status === 'FAILED') {
        this.repositories.executions.recordResult(input.executionId, { status: 'BLOCKED', errorCode: 'RETRY_LIMIT_EXCEEDED', retryable: false });
      }
      return { status: 'rejected', value: this.repositories.executions.get(input.executionId), reason: 'RETRY_LIMIT_EXCEEDED' };
    }
    return this.repositories.executions.create({
      idempotencyKey: input.idempotencyKey,
      identity: { ...current.identity, executionId: 'execution_' + input.idempotencyKey, attempt: current.identity.attempt + 1, route: input.route },
      objective: current.objective,
    });
  }

  waitForResource(planId: string, resourceId: string): void {
    const plan = this.repositories.plans.getPlan(planId);
    const resource = this.repositories.resources.get(resourceId);
    if (!resource) throw new V4Error('RESOURCE_NOT_FOUND');
    if (resource.status === 'AVAILABLE') throw new V4Error('RESOURCE_GATE_NOT_REQUIRED');
    if (plan.status === 'RUNNING' || plan.status === 'READY') this.repositories.plans.updateStatus(planId, 'WAITING_FOR_RESOURCE');
  }
}
