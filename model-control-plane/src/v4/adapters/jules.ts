import { createHash } from 'node:crypto';
import { V4Error, failClosed } from '../domain/errors.js';

export interface JulesTaskRequest {
  idempotencyKey: string;
  repository: string;
  baseRevision: string;
  objective: string;
}

export interface JulesTaskResult {
  sessionId: string;
  repository: string;
  baseRevision: string;
  headRevision?: string;
  pullRequestId?: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
}

export interface JulesClient {
  submit(input: JulesTaskRequest): JulesTaskResult;
  getResult(sessionId: string): JulesTaskResult;
}

export class JulesAdapter {
  readonly requests = new Map<string, JulesTaskResult>();

  constructor(readonly client?: JulesClient) {}

  submit(input: JulesTaskRequest): JulesTaskResult {
    failClosed(input.idempotencyKey.length > 0, 'JULES_IDEMPOTENCY_REQUIRED');
    failClosed(input.repository.length > 0, 'JULES_REPOSITORY_REQUIRED');
    failClosed(input.baseRevision.length > 0, 'JULES_BASE_REQUIRED');
    const existing = this.requests.get(input.idempotencyKey);
    if (existing) return existing;
    const result = this.client?.submit(input) ?? {
      sessionId: 'jules-' + createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16),
      repository: input.repository,
      baseRevision: input.baseRevision,
      status: 'RUNNING' as const,
    };
    this.requests.set(input.idempotencyKey, result);
    return result;
  }

  correlate(request: JulesTaskRequest, result: JulesTaskResult): JulesTaskResult {
    if (result.repository !== request.repository || result.baseRevision !== request.baseRevision) throw new V4Error('JULES_PROVENANCE_MISMATCH');
    return result;
  }

  getResult(sessionId: string): JulesTaskResult {
    const result = this.client?.getResult(sessionId) ?? Array.from(this.requests.values()).find((item) => item.sessionId === sessionId);
    if (!result) throw new V4Error('JULES_SESSION_NOT_FOUND');
    return result;
  }
}
