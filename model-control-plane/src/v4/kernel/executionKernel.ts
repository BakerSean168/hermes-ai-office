import type { Execution, ExecutionIdentity, ExecutionStatus } from '../domain/execution.js';
import type { V4Repositories, MutationResult } from '../persistence/repositories.js';

export class ExecutionKernel {
  constructor(readonly repositories: V4Repositories) {}

  queue(input: { executionId?: string; idempotencyKey: string; identity: ExecutionIdentity; objective: string }): MutationResult<Execution> {
    return this.repositories.executions.create(input);
  }

  transition(executionId: string, next: ExecutionStatus): MutationResult<Execution> {
    return this.repositories.executions.updateStatus(executionId, next);
  }

  succeed(executionId: string, resultRevision: string, resultSummary?: string): MutationResult<Execution> {
    return this.repositories.executions.recordResult(executionId, { status: 'SUCCEEDED', resultRevision, resultSummary });
  }

  fail(executionId: string, errorCode: string, retryable: boolean, resultSummary?: string): MutationResult<Execution> {
    return this.repositories.executions.recordResult(executionId, { status: 'FAILED', errorCode, retryable, resultSummary });
  }

  block(executionId: string, errorCode: string, resultSummary?: string): MutationResult<Execution> {
    return this.repositories.executions.recordResult(executionId, { status: 'BLOCKED', errorCode, retryable: false, resultSummary });
  }
}
