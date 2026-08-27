import type { DevelopmentExecutionSnapshot, StartDevelopmentExecutionInput } from '../types.js';

export const PLAN_TERMINAL_EXECUTION_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'STUCK',
  'CANCELLED',
]);

export interface PlanExecutionPort {
  start(
    input: StartDevelopmentExecutionInput,
    idempotencyKey: string,
  ): Promise<DevelopmentExecutionSnapshot>;
  get(executionId: string): Promise<DevelopmentExecutionSnapshot | null>;
  cancel(executionId: string): Promise<DevelopmentExecutionSnapshot | null>;
}
