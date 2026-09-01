import type { DatabaseSync } from 'node:sqlite';

import { DuplicateKeyError, V4Error, failClosed } from '../domain/errors.js';
import { assertCurrentV4Schema, openV4Database, withTransaction } from '../persistence/database.js';

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

interface JulesRow {
  idempotency_key: string;
  session_id: string;
  repository: string;
  base_revision: string;
  result: string;
  updated_at: string;
}

const JULES_STATUSES = new Set<JulesTaskResult['status']>(['RUNNING', 'SUCCEEDED', 'FAILED']);
const MAX_JULES_FIELD_LENGTH = 2_000;

function validateRequest(input: JulesTaskRequest): void {
  failClosed(input.idempotencyKey.trim().length > 0 && input.idempotencyKey.length <= MAX_JULES_FIELD_LENGTH, 'JULES_IDEMPOTENCY_REQUIRED');
  failClosed(input.repository.trim().length > 0 && input.repository.length <= MAX_JULES_FIELD_LENGTH, 'JULES_REPOSITORY_REQUIRED');
  failClosed(input.baseRevision.trim().length > 0 && input.baseRevision.length <= MAX_JULES_FIELD_LENGTH, 'JULES_BASE_REQUIRED');
  failClosed(input.objective.trim().length > 0, 'JULES_OBJECTIVE_REQUIRED');
}

function validateResult(result: JulesTaskResult): void {
  failClosed(result.sessionId.trim().length > 0 && result.sessionId.length <= MAX_JULES_FIELD_LENGTH, 'JULES_SESSION_REQUIRED');
  failClosed(result.repository.trim().length > 0 && result.repository.length <= MAX_JULES_FIELD_LENGTH, 'JULES_RESULT_REPOSITORY_REQUIRED');
  failClosed(result.baseRevision.trim().length > 0 && result.baseRevision.length <= MAX_JULES_FIELD_LENGTH, 'JULES_RESULT_BASE_REQUIRED');
  failClosed(JULES_STATUSES.has(result.status), 'JULES_RESULT_STATUS_INVALID');
  if (result.headRevision !== undefined) failClosed(result.headRevision.trim().length > 0 && result.headRevision.length <= MAX_JULES_FIELD_LENGTH, 'JULES_HEAD_REVISION_INVALID');
  if (result.pullRequestId !== undefined) failClosed(result.pullRequestId.trim().length > 0 && result.pullRequestId.length <= MAX_JULES_FIELD_LENGTH, 'JULES_PULL_REQUEST_INVALID');
  if (result.status === 'SUCCEEDED') failClosed(Boolean(result.headRevision || result.pullRequestId), 'JULES_RESULT_IDENTITY_REQUIRED');
}

function decodeResult(row: JulesRow): JulesTaskResult {
  try {
    const decoded = JSON.parse(row.result) as Partial<JulesTaskResult>;
    const result: JulesTaskResult = {
      sessionId: String(decoded.sessionId ?? ''),
      repository: String(decoded.repository ?? ''),
      baseRevision: String(decoded.baseRevision ?? ''),
      status: decoded.status as JulesTaskResult['status'],
      ...(decoded.headRevision === undefined ? {} : { headRevision: String(decoded.headRevision) }),
      ...(decoded.pullRequestId === undefined ? {} : { pullRequestId: String(decoded.pullRequestId) }),
    };
    validateResult(result);
    if (result.sessionId !== row.session_id || result.repository !== row.repository || result.baseRevision !== row.base_revision) {
      throw new V4Error('CORRUPTED_JULES_PROVENANCE');
    }
    return result;
  } catch (error) {
    if (error instanceof V4Error) throw error;
    throw new V4Error('CORRUPTED_JULES_RESULT', 'Stored Jules result is invalid.', error);
  }
}

function sameResult(left: JulesTaskResult, right: JulesTaskResult): boolean {
  return left.sessionId === right.sessionId
    && left.repository === right.repository
    && left.baseRevision === right.baseRevision
    && left.headRevision === right.headRevision
    && left.pullRequestId === right.pullRequestId
    && left.status === right.status;
}

function assertMonotonicUpdate(current: JulesTaskResult, next: JulesTaskResult): void {
  if (current.sessionId !== next.sessionId) throw new V4Error('JULES_SESSION_IMMUTABLE');
  if (current.repository !== next.repository || current.baseRevision !== next.baseRevision) throw new V4Error('JULES_PROVENANCE_MISMATCH');
  if (current.status !== 'RUNNING') throw new V4Error('JULES_RESULT_IMMUTABLE');
  if (current.headRevision && current.headRevision !== next.headRevision) throw new V4Error('JULES_HEAD_REVISION_IMMUTABLE');
  if (current.pullRequestId && current.pullRequestId !== next.pullRequestId) throw new V4Error('JULES_PULL_REQUEST_IMMUTABLE');
}

function encodedResult(result: JulesTaskResult): string {
  return JSON.stringify({
    sessionId: result.sessionId,
    repository: result.repository,
    baseRevision: result.baseRevision,
    ...(result.headRevision === undefined ? {} : { headRevision: result.headRevision }),
    ...(result.pullRequestId === undefined ? {} : { pullRequestId: result.pullRequestId }),
    status: result.status,
  });
}

export class JulesAdapter {
  constructor(
    readonly client?: JulesClient,
    readonly db: DatabaseSync = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } }),
  ) {
    assertCurrentV4Schema(this.db);
  }

  submit(input: JulesTaskRequest): JulesTaskResult {
    validateRequest(input);
    const durable = this.findByIdempotencyKey(input.idempotencyKey);
    if (durable) {
      const existing = decodeResult(durable);
      if (existing.repository !== input.repository || existing.baseRevision !== input.baseRevision) throw new V4Error('JULES_PROVENANCE_MISMATCH');
      return existing;
    }
    if (!this.client) throw new V4Error('JULES_CLIENT_UNAVAILABLE');
    return this.persist(input, this.client.submit(input));
  }

  correlate(request: JulesTaskRequest, result: JulesTaskResult): JulesTaskResult {
    validateRequest(request);
    return this.persist(request, result);
  }

  getResult(sessionId: string): JulesTaskResult {
    failClosed(sessionId.trim().length > 0 && sessionId.length <= MAX_JULES_FIELD_LENGTH, 'JULES_SESSION_REQUIRED');
    const durable = this.findBySessionId(sessionId);
    if (!durable) throw new V4Error('JULES_SESSION_NOT_FOUND');
    const current = decodeResult(durable);
    if (current.status !== 'RUNNING' || !this.client) return current;
    const remote = this.client.getResult(sessionId);
    return this.persist({
      idempotencyKey: durable.idempotency_key,
      repository: durable.repository,
      baseRevision: durable.base_revision,
      objective: 'durable-jules-session-refresh',
    }, remote);
  }

  private findByIdempotencyKey(key: string): JulesRow | undefined {
    return this.db.prepare('SELECT * FROM v4_jules_sessions WHERE idempotency_key=?').get(key) as JulesRow | undefined;
  }

  private findBySessionId(sessionId: string): JulesRow | undefined {
    return this.db.prepare('SELECT * FROM v4_jules_sessions WHERE session_id=?').get(sessionId) as JulesRow | undefined;
  }

  private persist(request: JulesTaskRequest, result: JulesTaskResult): JulesTaskResult {
    validateResult(result);
    if (result.repository !== request.repository || result.baseRevision !== request.baseRevision) throw new V4Error('JULES_PROVENANCE_MISMATCH');
    return withTransaction(this.db, () => {
      const byKey = this.findByIdempotencyKey(request.idempotencyKey);
      const bySession = this.findBySessionId(result.sessionId);
      if (byKey) {
        const current = decodeResult(byKey);
        if (bySession && bySession.idempotency_key !== request.idempotencyKey) throw new DuplicateKeyError(result.sessionId);
        if (sameResult(current, result)) return current;
        assertMonotonicUpdate(current, result);
        const encoded = encodedResult(result);
        const updatedAt = new Date().toISOString();
        const update = this.db.prepare('UPDATE v4_jules_sessions SET result=?,updated_at=? WHERE idempotency_key=? AND session_id=? AND result=?').run(
          encoded, updatedAt, request.idempotencyKey, current.sessionId, byKey.result,
        );
        if (Number(update.changes) !== 1) throw new V4Error('JULES_RESULT_STALE');
        return decodeResult(this.findByIdempotencyKey(request.idempotencyKey)!);
      }
      if (bySession) throw new DuplicateKeyError(result.sessionId);
      const encoded = encodedResult(result);
      this.db.prepare('INSERT INTO v4_jules_sessions(idempotency_key,session_id,repository,base_revision,result,updated_at) VALUES(?,?,?,?,?,?)').run(
        request.idempotencyKey, result.sessionId, result.repository, result.baseRevision, encoded, new Date().toISOString(),
      );
      return decodeResult(this.findByIdempotencyKey(request.idempotencyKey)!);
    });
  }
}
