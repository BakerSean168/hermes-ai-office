import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type {
  DevelopmentPhase,
  ExecutionLinkRecord,
  ExecutionSelection,
  ExecutionStatus,
  HermesExecutionContext,
} from './types.js';

interface ExecutionLinkRow {
  execution_id: string;
  idempotency_key: string;
  project_key: string;
  phase: string;
  objective_summary: string;
  hermes_profile: string | null;
  hermes_session_id: string | null;
  hermes_turn_id: string | null;
  backend: string;
  transport_mode: string;
  logical_model_class: string;
  workspace_mode: string;
  session_policy: string;
  openhands_conversation_id: string | null;
  langfuse_trace_id: string | null;
  workspace_ref: string | null;
  git_branch: string | null;
  source_revision: string | null;
  previous_execution_id: string | null;
  result_text: string | null;
  selection_reasons_json: string | null;
  status_cache: string;
  created_at: number;
  updated_at: number;
}

export function ensureV3Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v3_execution_links (
      execution_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      project_key TEXT NOT NULL,
      phase TEXT NOT NULL,
      objective_summary TEXT NOT NULL,
      hermes_profile TEXT,
      hermes_session_id TEXT,
      hermes_turn_id TEXT,
      backend TEXT NOT NULL,
      transport_mode TEXT NOT NULL,
      logical_model_class TEXT NOT NULL,
      workspace_mode TEXT NOT NULL,
      session_policy TEXT NOT NULL,
      openhands_conversation_id TEXT,
      langfuse_trace_id TEXT,
      workspace_ref TEXT,
      git_branch TEXT,
      source_revision TEXT,
      previous_execution_id TEXT,
      result_text TEXT,
      selection_reasons_json TEXT,
      status_cache TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v3_execution_links_project_created
      ON v3_execution_links(project_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_v3_execution_links_status_updated
      ON v3_execution_links(status_cache, updated_at DESC);
  `);

  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(v3_execution_links)').all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  if (!columns.has('previous_execution_id')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN previous_execution_id TEXT');
  }
  if (!columns.has('result_text')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN result_text TEXT');
  }
  if (!columns.has('selection_reasons_json')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN selection_reasons_json TEXT');
  }
}

function selectionReasons(value: string | null): string[] {
  if (!value) return ['execution-link:persisted'];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return ['execution-link:persisted'];
    const reasons = parsed
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
    return reasons.length > 0 ? reasons : ['execution-link:persisted'];
  } catch {
    return ['execution-link:persisted'];
  }
}

function rowToRecord(row: ExecutionLinkRow): ExecutionLinkRecord {
  return {
    executionId: row.execution_id,
    idempotencyKey: row.idempotency_key,
    projectKey: row.project_key,
    phase: row.phase as DevelopmentPhase,
    objectiveSummary: row.objective_summary,
    hermesProfile: row.hermes_profile ?? undefined,
    hermesSessionId: row.hermes_session_id ?? undefined,
    hermesTurnId: row.hermes_turn_id ?? undefined,
    backend: row.backend,
    transportMode: row.transport_mode as ExecutionLinkRecord['transportMode'],
    logicalModelClass: row.logical_model_class,
    workspaceMode: row.workspace_mode as ExecutionLinkRecord['workspaceMode'],
    sessionPolicy: row.session_policy as ExecutionLinkRecord['sessionPolicy'],
    openhandsConversationId: row.openhands_conversation_id ?? undefined,
    langfuseTraceId: row.langfuse_trace_id ?? undefined,
    workspaceRef: row.workspace_ref ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    sourceRevision: row.source_revision ?? undefined,
    previousExecutionId: row.previous_execution_id ?? undefined,
    resultText: row.result_text ?? undefined,
    selectionReasons: selectionReasons(row.selection_reasons_json),
    statusCache: row.status_cache as ExecutionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ExecutionLinkRepository {
  readonly #db: DatabaseSync;
  readonly #byExecution: StatementSync;
  readonly #byIdempotency: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    ensureV3Schema(db);
    this.#byExecution = db.prepare('SELECT * FROM v3_execution_links WHERE execution_id=?');
    this.#byIdempotency = db.prepare('SELECT * FROM v3_execution_links WHERE idempotency_key=?');
  }

  get(executionId: string): ExecutionLinkRecord | null {
    const row = this.#byExecution.get(executionId) as ExecutionLinkRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByIdempotencyKey(key: string): ExecutionLinkRecord | null {
    const row = this.#byIdempotency.get(key) as ExecutionLinkRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  reserve(input: {
    idempotencyKey: string;
    projectKey: string;
    phase: DevelopmentPhase;
    objectiveSummary: string;
    selection: ExecutionSelection;
    hermes?: HermesExecutionContext;
    previousExecutionId?: string | null;
  }): { record: ExecutionLinkRecord; created: boolean } {
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return { record: existing, created: false };

    const now = Date.now();
    const executionId = `exec_${randomUUID()}`;
    try {
      this.#db
        .prepare(
          `INSERT INTO v3_execution_links (
             execution_id,idempotency_key,project_key,phase,objective_summary,
             hermes_profile,hermes_session_id,hermes_turn_id,
             backend,transport_mode,logical_model_class,workspace_mode,session_policy,
             previous_execution_id,selection_reasons_json,status_cache,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          executionId,
          input.idempotencyKey,
          input.projectKey,
          input.phase,
          input.objectiveSummary,
          input.hermes?.profile ?? null,
          input.hermes?.sessionId ?? null,
          input.hermes?.turnId ?? null,
          input.selection.backend,
          input.selection.transportMode,
          input.selection.modelClass,
          input.selection.workspaceMode,
          input.selection.sessionPolicy,
          input.previousExecutionId ?? null,
          JSON.stringify(input.selection.reasons),
          'STARTING',
          now,
          now,
        );
    } catch (error) {
      const raced = this.findByIdempotencyKey(input.idempotencyKey);
      if (raced) return { record: raced, created: false };
      throw error;
    }
    return { record: this.get(executionId)!, created: true };
  }

  attachWorkspace(
    executionId: string,
    input: { workspaceRef: string; gitBranch?: string; sourceRevision?: string },
  ): ExecutionLinkRecord {
    this.#db
      .prepare(
        `UPDATE v3_execution_links
           SET workspace_ref=?,git_branch=?,source_revision=?,updated_at=? WHERE execution_id=?`,
      )
      .run(
        input.workspaceRef,
        input.gitBranch ?? null,
        input.sourceRevision ?? null,
        Date.now(),
        executionId,
      );
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  attachOpenHands(executionId: string, conversationId: string): ExecutionLinkRecord {
    const now = Date.now();
    this.#db
      .prepare(
        `UPDATE v3_execution_links
           SET openhands_conversation_id=?, status_cache='RUNNING', updated_at=?
         WHERE execution_id=?`,
      )
      .run(conversationId, now, executionId);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  updateStatus(executionId: string, status: ExecutionStatus): ExecutionLinkRecord {
    this.#db
      .prepare('UPDATE v3_execution_links SET status_cache=?,updated_at=? WHERE execution_id=?')
      .run(status, Date.now(), executionId);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  completeInternal(executionId: string, resultText: string): ExecutionLinkRecord {
    this.#db
      .prepare(
        `UPDATE v3_execution_links
           SET result_text=?,status_cache='SUCCEEDED',updated_at=? WHERE execution_id=?`,
      )
      .run(resultText, Date.now(), executionId);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  attachLangfuse(executionId: string, traceId: string): ExecutionLinkRecord {
    this.#db
      .prepare(
        'UPDATE v3_execution_links SET langfuse_trace_id=?,updated_at=? WHERE execution_id=?',
      )
      .run(traceId, Date.now(), executionId);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  writerCandidates(): ExecutionLinkRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM v3_execution_links
           WHERE phase IN ('IMPLEMENT','IMPLEMENT_FIX')
             AND status_cache IN ('STARTING','RUNNING','PAUSED','WAITING_FOR_CONFIRMATION')
           ORDER BY created_at ASC`,
      )
      .all() as unknown as ExecutionLinkRow[];
    return rows.map(rowToRecord);
  }

  list(input: { projectKey?: string; limit?: number } = {}): ExecutionLinkRecord[] {
    const limit = Math.min(500, Math.max(1, input.limit ?? 50));
    const rows = input.projectKey
      ? (this.#db
          .prepare(
            'SELECT * FROM v3_execution_links WHERE project_key=? ORDER BY created_at DESC LIMIT ?',
          )
          .all(input.projectKey, limit) as unknown as ExecutionLinkRow[])
      : (this.#db
          .prepare('SELECT * FROM v3_execution_links ORDER BY created_at DESC LIMIT ?')
          .all(limit) as unknown as ExecutionLinkRow[]);
    return rows.map(rowToRecord);
  }
}
