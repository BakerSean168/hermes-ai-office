import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { DuplicateKeyError, V4Error, failClosed } from '../domain/errors.js';
import { assertSafeEventPayload } from '../domain/events.js';
import {
  EXECUTION_EVIDENCE_KINDS,
  EXECUTION_PHASES,
  PROVIDER_SESSION_STATUSES,
  type ExecutionEvidence,
  type ExecutionEvidenceKind,
  type ExecutionPhase,
  type ExecutionSession,
  type ProviderSessionStatus,
  type WorkspaceDescriptor,
} from '../orchestration/contracts.js';
import { withTransaction } from './database.js';
import { EventStore } from './eventStore.js';
import type { MutationResult } from './repositories.js';

const MAX_EVIDENCE_PAYLOAD_BYTES = 256_000;
const MAX_FINAL_RESPONSE_BYTES = 64_000;
const MAX_IDENTIFIER_LENGTH = 500;
const MAX_REASON_LENGTH = 2_000;
const iso = (): string => new Date().toISOString();

function assertCanonicalTimestamp(value: string, code: string): void {
  const parsed = Date.parse(value);
  failClosed(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, code);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

const encode = (value: unknown): string => JSON.stringify(canonicalize(value));

function decodeRecord(value: string, code: string): Record<string, unknown> {
  try {
    const decoded = JSON.parse(value) as unknown;
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('not an object');
    assertSafeEventPayload(decoded);
    return decoded as Record<string, unknown>;
  } catch (error) {
    throw new V4Error(code, code, error);
  }
}

function isExecutionPhase(value: unknown): value is ExecutionPhase {
  return typeof value === 'string' && (EXECUTION_PHASES as readonly string[]).includes(value);
}

function isProviderStatus(value: unknown): value is ProviderSessionStatus {
  return typeof value === 'string' && (PROVIDER_SESSION_STATUSES as readonly string[]).includes(value);
}

function isEvidenceKind(value: unknown): value is ExecutionEvidenceKind {
  return typeof value === 'string' && (EXECUTION_EVIDENCE_KINDS as readonly string[]).includes(value);
}

interface SessionRow {
  execution_id: string;
  phase: string;
  provider: string;
  provider_session_id: string | null;
  workspace_host_path: string;
  workspace_execution_path: string;
  evidence_host_path: string;
  evidence_execution_path: string;
  workspace_created_at: string;
  source_repository_path: string;
  source_revision: string;
  provider_status: string;
  last_heartbeat_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  final_response: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface EvidenceRow {
  evidence_id: string;
  execution_id: string;
  kind: string;
  name: string;
  source_revision: string | null;
  payload: string;
  created_at: string;
}

function workspaceFrom(row: SessionRow): WorkspaceDescriptor {
  return {
    executionId: row.execution_id,
    hostPath: row.workspace_host_path,
    executionPath: row.workspace_execution_path,
    evidenceHostPath: row.evidence_host_path,
    evidenceExecutionPath: row.evidence_execution_path,
    sourceRepositoryPath: row.source_repository_path,
    sourceRevision: row.source_revision,
    createdAt: row.workspace_created_at,
  };
}

function sessionFrom(row: SessionRow): ExecutionSession {
  if (!isExecutionPhase(row.phase)) throw new V4Error('CORRUPTED_EXECUTION_PHASE');
  if (!isProviderStatus(row.provider_status)) throw new V4Error('CORRUPTED_PROVIDER_SESSION_STATUS');
  if (!row.execution_id.trim() || !row.provider.trim() || row.provider.length > MAX_IDENTIFIER_LENGTH || !row.source_revision.trim() || row.source_revision.length > MAX_IDENTIFIER_LENGTH) {
    throw new V4Error('CORRUPTED_EXECUTION_SESSION_IDENTITY');
  }
  if (row.provider_session_id !== null && (!row.provider_session_id.trim() || row.provider_session_id.length > MAX_IDENTIFIER_LENGTH)) {
    throw new V4Error('CORRUPTED_EXECUTION_SESSION_IDENTITY');
  }
  for (const value of [row.workspace_host_path, row.workspace_execution_path, row.evidence_host_path, row.evidence_execution_path, row.source_repository_path]) {
    if (!value.trim()) throw new V4Error('CORRUPTED_EXECUTION_SESSION_WORKSPACE');
  }
  if (row.final_response && Buffer.byteLength(row.final_response, 'utf8') > MAX_FINAL_RESPONSE_BYTES) throw new V4Error('CORRUPTED_EXECUTION_SESSION_RESULT');
  if (row.error_code && row.error_code.length > MAX_IDENTIFIER_LENGTH) throw new V4Error('CORRUPTED_EXECUTION_SESSION_RESULT');
  for (const timestamp of [row.workspace_created_at, row.created_at, row.updated_at]) {
    assertCanonicalTimestamp(timestamp, 'CORRUPTED_EXECUTION_SESSION_TIME');
  }
  for (const timestamp of [row.last_heartbeat_at, row.started_at, row.completed_at]) {
    if (timestamp) assertCanonicalTimestamp(timestamp, 'CORRUPTED_EXECUTION_SESSION_TIME');
  }
  if (row.updated_at < row.created_at) throw new V4Error('CORRUPTED_EXECUTION_SESSION_TIME');
  if (row.last_heartbeat_at && row.last_heartbeat_at > row.updated_at) throw new V4Error('CORRUPTED_EXECUTION_SESSION_TIME');
  if (row.started_at && row.started_at > row.updated_at) throw new V4Error('CORRUPTED_EXECUTION_SESSION_TIME');
  if (row.completed_at && row.completed_at > row.updated_at) throw new V4Error('CORRUPTED_EXECUTION_SESSION_TIME');
  if (TERMINAL_PROVIDER_STATUSES.has(row.provider_status) !== Boolean(row.completed_at)) {
    throw new V4Error('CORRUPTED_EXECUTION_SESSION_TERMINAL_TIME');
  }
  return {
    executionId: row.execution_id,
    phase: row.phase,
    provider: row.provider,
    providerSessionId: row.provider_session_id ?? undefined,
    workspace: workspaceFrom(row),
    sourceRevision: row.source_revision,
    providerStatus: row.provider_status,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    finalResponse: row.final_response ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function evidenceFrom(row: EvidenceRow): ExecutionEvidence {
  if (!isEvidenceKind(row.kind)) throw new V4Error('CORRUPTED_EXECUTION_EVIDENCE_KIND');
  assertCanonicalTimestamp(row.created_at, 'CORRUPTED_EXECUTION_EVIDENCE_TIME');
  return {
    evidenceId: row.evidence_id,
    executionId: row.execution_id,
    kind: row.kind,
    name: row.name,
    sourceRevision: row.source_revision ?? undefined,
    payload: decodeRecord(row.payload, 'CORRUPTED_EXECUTION_EVIDENCE'),
    createdAt: row.created_at,
  };
}

const TERMINAL_PROVIDER_STATUSES = new Set<ProviderSessionStatus>(['SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED']);
const PROVIDER_TRANSITIONS: Record<ProviderSessionStatus, readonly ProviderSessionStatus[]> = {
  CREATED: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED', 'UNKNOWN'],
  QUEUED: ['RUNNING', 'PAUSED', 'WAITING_FOR_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED', 'UNKNOWN'],
  RUNNING: ['PAUSED', 'WAITING_FOR_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED', 'UNKNOWN'],
  PAUSED: ['RUNNING', 'WAITING_FOR_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED', 'UNKNOWN'],
  WAITING_FOR_CONFIRMATION: ['RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED', 'UNKNOWN'],
  SUCCEEDED: [],
  FAILED: [],
  STUCK: [],
  CANCELLED: [],
  UNKNOWN: ['QUEUED', 'RUNNING', 'PAUSED', 'WAITING_FOR_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED'],
};

function event(events: EventStore, executionId: string, type: string, payload: Record<string, unknown>): void {
  events.appendInTransaction({
    eventId: randomUUID(),
    aggregateId: executionId,
    aggregateType: 'EXECUTION',
    type,
    payload,
    occurredAt: iso(),
    correlationId: executionId,
  });
}

function assertWorkspace(input: WorkspaceDescriptor, executionId: string, sourceRevision: string): void {
  failClosed(input.executionId === executionId, 'SESSION_WORKSPACE_EXECUTION_MISMATCH');
  failClosed(input.sourceRevision === sourceRevision, 'SESSION_WORKSPACE_REVISION_MISMATCH');
  for (const value of [input.hostPath, input.executionPath, input.evidenceHostPath, input.evidenceExecutionPath, input.sourceRepositoryPath, input.createdAt]) {
    failClosed(value.trim().length > 0, 'SESSION_WORKSPACE_INVALID');
  }
  assertCanonicalTimestamp(input.createdAt, 'SESSION_WORKSPACE_TIME_INVALID');
}

export class ExecutionSessionRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}

  create(input: {
    executionId: string;
    phase: ExecutionPhase;
    provider: string;
    workspace: WorkspaceDescriptor;
    sourceRevision: string;
  }): MutationResult<ExecutionSession> {
    failClosed(isExecutionPhase(input.phase), 'EXECUTION_PHASE_INVALID');
    failClosed(input.provider.trim().length > 0 && input.provider.length <= MAX_IDENTIFIER_LENGTH, 'SESSION_PROVIDER_REQUIRED');
    failClosed(input.sourceRevision.trim().length > 0 && input.sourceRevision.length <= MAX_IDENTIFIER_LENGTH, 'SESSION_SOURCE_REVISION_REQUIRED');
    assertWorkspace(input.workspace, input.executionId, input.sourceRevision);
    return withTransaction(this.db, () => {
      const execution = this.db.prepare(`SELECT executions.source_revision,plans.repository_path
        FROM executions JOIN plans ON plans.plan_id=executions.plan_id
        WHERE executions.execution_id=?`).get(input.executionId) as { source_revision: string | null; repository_path: string } | undefined;
      if (!execution) throw new V4Error('EXECUTION_NOT_FOUND');
      if (!execution.source_revision) throw new V4Error('EXECUTION_SOURCE_REVISION_REQUIRED');
      if (execution.source_revision !== input.sourceRevision) throw new V4Error('SESSION_SOURCE_REVISION_MISMATCH');
      if (execution.repository_path !== input.workspace.sourceRepositoryPath) throw new V4Error('SESSION_REPOSITORY_MISMATCH');
      const existing = this.getOptional(input.executionId);
      if (existing) {
        const same = existing.phase === input.phase
          && existing.provider === input.provider
          && existing.sourceRevision === input.sourceRevision
          && existing.workspace.hostPath === input.workspace.hostPath
          && existing.workspace.executionPath === input.workspace.executionPath
          && existing.workspace.evidenceHostPath === input.workspace.evidenceHostPath
          && existing.workspace.evidenceExecutionPath === input.workspace.evidenceExecutionPath
          && existing.workspace.createdAt === input.workspace.createdAt
          && existing.workspace.sourceRepositoryPath === input.workspace.sourceRepositoryPath;
        if (!same) throw new V4Error('EXECUTION_SESSION_IMMUTABLE');
        return { status: 'existing', value: existing };
      }
      const createdAt = iso();
      this.db.prepare(`INSERT INTO execution_sessions(
        execution_id,phase,provider,workspace_host_path,workspace_execution_path,evidence_host_path,evidence_execution_path,workspace_created_at,source_repository_path,
        source_revision,provider_status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.executionId, input.phase, input.provider, input.workspace.hostPath, input.workspace.executionPath,
        input.workspace.evidenceHostPath, input.workspace.evidenceExecutionPath, input.workspace.createdAt, input.workspace.sourceRepositoryPath, input.sourceRevision, 'CREATED', createdAt, createdAt,
      );
      event(this.events, input.executionId, 'EXECUTION_SESSION_CREATED', { phase: input.phase, provider: input.provider, sourceRevision: input.sourceRevision });
      return { status: 'created', value: this.get(input.executionId) };
    });
  }

  get(executionId: string): ExecutionSession {
    const value = this.getOptional(executionId);
    if (!value) throw new V4Error('EXECUTION_SESSION_NOT_FOUND');
    return value;
  }

  getOptional(executionId: string): ExecutionSession | undefined {
    const row = this.db.prepare('SELECT * FROM execution_sessions WHERE execution_id=?').get(executionId) as SessionRow | undefined;
    return row ? sessionFrom(row) : undefined;
  }

  findByProviderSessionId(providerSessionId: string): ExecutionSession | undefined {
    const row = this.db.prepare('SELECT * FROM execution_sessions WHERE provider_session_id=?').get(providerSessionId) as SessionRow | undefined;
    return row ? sessionFrom(row) : undefined;
  }

  listActive(limit = 100): ExecutionSession[] {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const rows = this.db.prepare("SELECT * FROM execution_sessions WHERE provider_status NOT IN ('SUCCEEDED','FAILED','STUCK','CANCELLED') ORDER BY updated_at LIMIT ?").all(safeLimit) as unknown as SessionRow[];
    return rows.map(sessionFrom);
  }

  listByPlan(planId: string): ExecutionSession[] {
    const rows = this.db.prepare('SELECT sessions.* FROM execution_sessions sessions JOIN executions ON executions.execution_id=sessions.execution_id WHERE executions.plan_id=? ORDER BY sessions.created_at').all(planId) as unknown as SessionRow[];
    return rows.map(sessionFrom);
  }

  attachProviderSession(executionId: string, providerSessionId: string): MutationResult<ExecutionSession> {
    failClosed(providerSessionId.trim().length > 0 && providerSessionId.length <= MAX_IDENTIFIER_LENGTH, 'PROVIDER_SESSION_ID_REQUIRED');
    return withTransaction(this.db, () => {
      const current = this.get(executionId);
      if (current.providerSessionId === providerSessionId) return { status: 'existing', value: current };
      if (TERMINAL_PROVIDER_STATUSES.has(current.providerStatus)) throw new V4Error('EXECUTION_SESSION_TERMINAL');
      if (current.providerSessionId) throw new V4Error('PROVIDER_SESSION_IMMUTABLE');
      const conflict = this.findByProviderSessionId(providerSessionId);
      if (conflict) throw new V4Error('PROVIDER_SESSION_DUPLICATE');
      const updatedAt = iso();
      const result = this.db.prepare('UPDATE execution_sessions SET provider_session_id=?,updated_at=? WHERE execution_id=? AND provider_session_id IS NULL').run(providerSessionId, updatedAt, executionId);
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.get(executionId), reason: 'STALE_PROVIDER_SESSION' };
      event(this.events, executionId, 'EXECUTION_PROVIDER_SESSION_ATTACHED', { provider: current.provider, providerSessionId });
      return { status: 'updated', value: this.get(executionId) };
    });
  }

  replaceProviderSession(executionId: string, expectedProviderSessionId: string, providerSessionId: string, reason: string): MutationResult<ExecutionSession> {
    failClosed(expectedProviderSessionId.trim().length > 0 && expectedProviderSessionId.length <= MAX_IDENTIFIER_LENGTH, 'EXPECTED_PROVIDER_SESSION_ID_REQUIRED');
    failClosed(providerSessionId.trim().length > 0 && providerSessionId.length <= MAX_IDENTIFIER_LENGTH && reason.trim().length > 0 && reason.length <= MAX_REASON_LENGTH, 'PROVIDER_SESSION_REPLACEMENT_INVALID');
    return withTransaction(this.db, () => {
      const current = this.get(executionId);
      if (current.providerSessionId === providerSessionId) return { status: 'existing', value: current };
      if (current.providerSessionId !== expectedProviderSessionId) return { status: 'rejected', value: current, reason: 'STALE_PROVIDER_SESSION' };
      if (TERMINAL_PROVIDER_STATUSES.has(current.providerStatus)) throw new V4Error('EXECUTION_SESSION_TERMINAL');
      const conflict = this.findByProviderSessionId(providerSessionId);
      if (conflict) throw new V4Error('PROVIDER_SESSION_DUPLICATE');
      const updatedAt = iso();
      const result = this.db.prepare(`UPDATE execution_sessions
        SET provider_session_id=?,provider_status='CREATED',last_heartbeat_at=NULL,started_at=NULL,completed_at=NULL,final_response=NULL,error_code=NULL,updated_at=?
        WHERE execution_id=? AND provider_session_id=?`).run(providerSessionId, updatedAt, executionId, expectedProviderSessionId);
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.get(executionId), reason: 'STALE_PROVIDER_SESSION' };
      event(this.events, executionId, 'EXECUTION_PROVIDER_SESSION_REPLACED', { expectedProviderSessionId, providerSessionId, previousStatus: current.providerStatus, resetStatus: 'CREATED', reason });
      return { status: 'updated', value: this.get(executionId) };
    });
  }

  updateProviderStatus(executionId: string, next: ProviderSessionStatus, observedAt = iso()): MutationResult<ExecutionSession> {
    failClosed(isProviderStatus(next), 'PROVIDER_SESSION_STATUS_INVALID');
    assertCanonicalTimestamp(observedAt, 'PROVIDER_OBSERVATION_TIME_INVALID');
    return withTransaction(this.db, () => {
      const current = this.get(executionId);
      if (current.providerStatus === next) return { status: 'existing', value: current };
      if (observedAt < current.updatedAt) return { status: 'rejected', value: current, reason: 'STALE_PROVIDER_OBSERVATION' };
      if (TERMINAL_PROVIDER_STATUSES.has(current.providerStatus) || !PROVIDER_TRANSITIONS[current.providerStatus].includes(next)) {
        throw new V4Error('INVALID_PROVIDER_SESSION_TRANSITION', current.providerStatus + ' -> ' + next);
      }
      const startedAt = current.startedAt ?? (next === 'RUNNING' ? observedAt : undefined);
      const result = this.db.prepare('UPDATE execution_sessions SET provider_status=?,last_heartbeat_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE execution_id=? AND provider_status=?').run(
        next, observedAt, startedAt ?? null, observedAt, executionId, current.providerStatus,
      );
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.get(executionId), reason: 'STALE_PROVIDER_STATUS' };
      event(this.events, executionId, 'EXECUTION_PROVIDER_STATUS_CHANGED', { from: current.providerStatus, to: next, observedAt });
      return { status: 'updated', value: this.get(executionId) };
    });
  }

  heartbeat(executionId: string, expectedStatus: ProviderSessionStatus, observedAt = iso()): MutationResult<ExecutionSession> {
    failClosed(isProviderStatus(expectedStatus), 'PROVIDER_SESSION_STATUS_INVALID');
    assertCanonicalTimestamp(observedAt, 'PROVIDER_OBSERVATION_TIME_INVALID');
    return withTransaction(this.db, () => {
      const current = this.get(executionId);
      if (current.providerStatus !== expectedStatus) return { status: 'rejected', value: current, reason: 'STALE_PROVIDER_STATUS' };
      if (TERMINAL_PROVIDER_STATUSES.has(current.providerStatus)) return { status: 'existing', value: current };
      if (observedAt < current.updatedAt || (current.lastHeartbeatAt && observedAt <= current.lastHeartbeatAt)) {
        return { status: 'rejected', value: current, reason: 'STALE_PROVIDER_HEARTBEAT' };
      }
      const result = this.db.prepare('UPDATE execution_sessions SET last_heartbeat_at=?,updated_at=? WHERE execution_id=? AND provider_status=? AND (last_heartbeat_at IS NULL OR last_heartbeat_at<?)').run(
        observedAt, observedAt, executionId, expectedStatus, observedAt,
      );
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.get(executionId), reason: 'STALE_PROVIDER_HEARTBEAT' };
      return { status: 'updated', value: this.get(executionId) };
    });
  }

  complete(executionId: string, input: {
    status: Extract<ProviderSessionStatus, 'SUCCEEDED' | 'FAILED' | 'STUCK' | 'CANCELLED'>;
    finalResponse?: string;
    errorCode?: string;
    completedAt?: string;
  }): MutationResult<ExecutionSession> {
    failClosed(TERMINAL_PROVIDER_STATUSES.has(input.status), 'PROVIDER_TERMINAL_STATUS_REQUIRED');
    failClosed(!input.finalResponse || Buffer.byteLength(input.finalResponse, 'utf8') <= MAX_FINAL_RESPONSE_BYTES, 'PROVIDER_FINAL_RESPONSE_TOO_LARGE');
    failClosed(!input.errorCode || input.errorCode.length <= MAX_IDENTIFIER_LENGTH, 'PROVIDER_ERROR_CODE_TOO_LARGE');
    const completedAt = input.completedAt ?? iso();
    assertCanonicalTimestamp(completedAt, 'PROVIDER_COMPLETION_TIME_INVALID');
    return withTransaction(this.db, () => {
      const current = this.get(executionId);
      if (TERMINAL_PROVIDER_STATUSES.has(current.providerStatus)) {
        const same = current.providerStatus === input.status
          && current.finalResponse === input.finalResponse
          && current.errorCode === input.errorCode;
        if (same) return { status: 'existing', value: current };
        throw new V4Error('EXECUTION_SESSION_RESULT_IMMUTABLE');
      }
      if (!PROVIDER_TRANSITIONS[current.providerStatus].includes(input.status)) throw new V4Error('INVALID_PROVIDER_SESSION_TRANSITION');
      if (completedAt < current.updatedAt) return { status: 'rejected', value: current, reason: 'STALE_PROVIDER_COMPLETION' };
      const result = this.db.prepare('UPDATE execution_sessions SET provider_status=?,last_heartbeat_at=?,completed_at=?,final_response=?,error_code=?,updated_at=? WHERE execution_id=? AND provider_status=?').run(
        input.status, completedAt, completedAt, input.finalResponse ?? null, input.errorCode ?? null, completedAt, executionId, current.providerStatus,
      );
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.get(executionId), reason: 'STALE_PROVIDER_STATUS' };
      event(this.events, executionId, 'EXECUTION_PROVIDER_SESSION_COMPLETED', { status: input.status, errorCode: input.errorCode ?? null });
      return { status: 'updated', value: this.get(executionId) };
    });
  }
}

export class ExecutionEvidenceRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}

  append(input: {
    evidenceId?: string;
    executionId: string;
    kind: ExecutionEvidenceKind;
    name: string;
    sourceRevision?: string;
    payload: Record<string, unknown>;
  }): MutationResult<ExecutionEvidence> {
    failClosed(isEvidenceKind(input.kind), 'EXECUTION_EVIDENCE_KIND_INVALID');
    failClosed(input.name.trim().length > 0 && input.name.length <= MAX_IDENTIFIER_LENGTH, 'EVIDENCE_NAME_REQUIRED');
    failClosed(!input.sourceRevision || input.sourceRevision.length <= MAX_IDENTIFIER_LENGTH, 'EVIDENCE_SOURCE_REVISION_INVALID');
    assertSafeEventPayload(input.payload);
    const encoded = encode(input.payload);
    failClosed(Buffer.byteLength(encoded, 'utf8') <= MAX_EVIDENCE_PAYLOAD_BYTES, 'EXECUTION_EVIDENCE_TOO_LARGE');
    return withTransaction(this.db, () => {
      if (!this.db.prepare('SELECT execution_id FROM executions WHERE execution_id=?').get(input.executionId)) throw new V4Error('EXECUTION_NOT_FOUND');
      const existing = this.find(input.executionId, input.kind, input.name);
      if (existing) {
        const same = existing.sourceRevision === input.sourceRevision && encode(existing.payload) === encoded;
        if (!same) throw new V4Error('DURABLE_EVIDENCE_IMMUTABLE');
        return { status: 'existing', value: existing };
      }
      const evidenceId = input.evidenceId ?? 'evidence_' + randomUUID();
      const idConflict = this.getOptional(evidenceId);
      if (idConflict) throw new DuplicateKeyError(evidenceId);
      const createdAt = iso();
      this.db.prepare('INSERT INTO execution_evidence(evidence_id,execution_id,kind,name,source_revision,payload,created_at) VALUES(?,?,?,?,?,?,?)').run(
        evidenceId, input.executionId, input.kind, input.name, input.sourceRevision ?? null, encoded, createdAt,
      );
      event(this.events, input.executionId, 'EXECUTION_EVIDENCE_APPENDED', { evidenceId, kind: input.kind, name: input.name, sourceRevision: input.sourceRevision ?? null });
      return { status: 'created', value: this.get(evidenceId) };
    });
  }

  get(evidenceId: string): ExecutionEvidence {
    const value = this.getOptional(evidenceId);
    if (!value) throw new V4Error('EXECUTION_EVIDENCE_NOT_FOUND');
    return value;
  }

  getOptional(evidenceId: string): ExecutionEvidence | undefined {
    const row = this.db.prepare('SELECT * FROM execution_evidence WHERE evidence_id=?').get(evidenceId) as EvidenceRow | undefined;
    return row ? evidenceFrom(row) : undefined;
  }

  find(executionId: string, kind: ExecutionEvidenceKind, name: string): ExecutionEvidence | undefined {
    const row = this.db.prepare('SELECT * FROM execution_evidence WHERE execution_id=? AND kind=? AND name=?').get(executionId, kind, name) as EvidenceRow | undefined;
    return row ? evidenceFrom(row) : undefined;
  }

  listByExecution(executionId: string): ExecutionEvidence[] {
    const rows = this.db.prepare('SELECT * FROM execution_evidence WHERE execution_id=? ORDER BY created_at,evidence_id').all(executionId) as unknown as EvidenceRow[];
    return rows.map(evidenceFrom);
  }
}
