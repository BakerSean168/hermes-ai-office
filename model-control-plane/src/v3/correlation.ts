import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type {
  DevelopmentPhase,
  ExecutionLinkRecord,
  ExecutionSelection,
  ExecutionStatus,
  HermesExecutionContext,
  RouteUsageSummary,
  UsageSummary,
} from './types.js';

const TERMINAL_STATUSES = new Set<ExecutionStatus>(['SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED']);

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
  repository_root: string | null;
  git_branch: string | null;
  source_revision: string | null;
  writer_start_revision: string | null;
  host_launch_token: string | null;
  host_launch_claimed_at: number | null;
  previous_execution_id: string | null;
  plan_id: string | null;
  batch_id: string | null;
  work_item_id: string | null;
  attempt: number | null;
  command_key: string | null;
  result_text: string | null;
  error_code: string | null;
  error_detail: string | null;
  error_retryable: number | null;
  usage_json: string | null;
  observed_routes_json: string | null;
  selection_reasons_json: string | null;
  status_cache: string;
  created_at: number;
  updated_at: number;
  host_updated_at: number | null;
  started_at: number | null;
  ended_at: number | null;
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
      repository_root TEXT,
      git_branch TEXT,
      source_revision TEXT,
      writer_start_revision TEXT,
      host_launch_token TEXT,
      host_launch_claimed_at INTEGER,
      previous_execution_id TEXT,
      plan_id TEXT,
      batch_id TEXT,
      work_item_id TEXT,
      attempt INTEGER,
      command_key TEXT,
      result_text TEXT,
      error_code TEXT,
      error_detail TEXT,
      error_retryable INTEGER,
      usage_json TEXT,
      observed_routes_json TEXT,
      selection_reasons_json TEXT,
      status_cache TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      host_updated_at INTEGER,
      started_at INTEGER,
      ended_at INTEGER
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
  if (!columns.has('repository_root')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN repository_root TEXT');
  }
  if (!columns.has('writer_start_revision')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN writer_start_revision TEXT');
  }
  if (!columns.has('host_launch_token')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN host_launch_token TEXT');
  }
  if (!columns.has('host_launch_claimed_at')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN host_launch_claimed_at INTEGER');
  }
  if (!columns.has('previous_execution_id')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN previous_execution_id TEXT');
  }
  if (!columns.has('result_text')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN result_text TEXT');
  }
  if (!columns.has('error_code')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN error_code TEXT');
  }
  if (!columns.has('error_detail')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN error_detail TEXT');
  }
  if (!columns.has('error_retryable')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN error_retryable INTEGER');
  }
  if (!columns.has('selection_reasons_json')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN selection_reasons_json TEXT');
  }
  if (!columns.has('usage_json')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN usage_json TEXT');
  }
  if (!columns.has('observed_routes_json')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN observed_routes_json TEXT');
  }
  if (!columns.has('host_updated_at')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN host_updated_at INTEGER');
  }
  if (!columns.has('started_at')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN started_at INTEGER');
  }
  if (!columns.has('ended_at')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN ended_at INTEGER');
  }
  if (!columns.has('plan_id')) db.exec('ALTER TABLE v3_execution_links ADD COLUMN plan_id TEXT');
  if (!columns.has('batch_id')) db.exec('ALTER TABLE v3_execution_links ADD COLUMN batch_id TEXT');
  if (!columns.has('work_item_id')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN work_item_id TEXT');
  }
  if (!columns.has('attempt')) db.exec('ALTER TABLE v3_execution_links ADD COLUMN attempt INTEGER');
  if (!columns.has('command_key')) {
    db.exec('ALTER TABLE v3_execution_links ADD COLUMN command_key TEXT');
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_v3_execution_links_command_key ON v3_execution_links(command_key) WHERE command_key IS NOT NULL',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_v3_execution_links_work_item ON v3_execution_links(work_item_id, created_at)',
  );
  db.exec('UPDATE v3_execution_links SET started_at=created_at WHERE started_at IS NULL');
  db.exec(`UPDATE v3_execution_links
             SET ended_at=updated_at
           WHERE ended_at IS NULL
             AND status_cache IN ('SUCCEEDED','FAILED','STUCK','CANCELLED')`);
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

function parsedJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
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
    repositoryRoot: row.repository_root ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    sourceRevision: row.source_revision ?? undefined,
    writerStartRevision: row.writer_start_revision ?? undefined,
    hostLaunchToken: row.host_launch_token ?? undefined,
    hostLaunchClaimedAt: row.host_launch_claimed_at ?? undefined,
    previousExecutionId: row.previous_execution_id ?? undefined,
    planId: row.plan_id ?? undefined,
    batchId: row.batch_id ?? undefined,
    workItemId: row.work_item_id ?? undefined,
    attempt: row.attempt ?? undefined,
    commandKey: row.command_key ?? undefined,
    resultText: row.result_text ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorDetail: row.error_detail ?? undefined,
    errorRetryable: row.error_retryable == null ? undefined : Boolean(row.error_retryable),
    observedUsage: parsedJson<UsageSummary>(row.usage_json),
    observedRoutes: parsedJson<RouteUsageSummary[]>(row.observed_routes_json),
    selectionReasons: selectionReasons(row.selection_reasons_json),
    statusCache: row.status_cache as ExecutionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hostUpdatedAt: row.host_updated_at ?? undefined,
    startedAt: row.started_at ?? row.created_at,
    endedAt: row.ended_at ?? undefined,
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

  findByCommandKey(key: string): ExecutionLinkRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM v3_execution_links WHERE command_key=?')
      .get(key) as ExecutionLinkRow | undefined;
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
    plan?: {
      planId: string;
      batchId: string;
      workItemId: string;
      attempt: number;
      commandKey: string;
    };
  }): { record: ExecutionLinkRecord; created: boolean } {
    const existing = input.plan
      ? this.findByCommandKey(input.plan.commandKey)
      : this.findByIdempotencyKey(input.idempotencyKey);
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
             previous_execution_id,plan_id,batch_id,work_item_id,attempt,command_key,
             selection_reasons_json,status_cache,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          input.plan?.planId ?? null,
          input.plan?.batchId ?? null,
          input.plan?.workItemId ?? null,
          input.plan?.attempt ?? null,
          input.plan?.commandKey ?? null,
          JSON.stringify(input.selection.reasons),
          'STARTING',
          now,
          now,
        );
    } catch (error) {
      const raced = input.plan
        ? this.findByCommandKey(input.plan.commandKey)
        : this.findByIdempotencyKey(input.idempotencyKey);
      if (raced) return { record: raced, created: false };
      throw error;
    }
    return { record: this.get(executionId)!, created: true };
  }

  attachWorkspace(
    executionId: string,
    input: {
      workspaceRef: string;
      repositoryRoot?: string;
      gitBranch?: string;
      sourceRevision?: string;
    },
  ): ExecutionLinkRecord {
    this.#db
      .prepare(
        `UPDATE v3_execution_links
           SET workspace_ref=?,repository_root=?,git_branch=?,source_revision=?,updated_at=? WHERE execution_id=?`,
      )
      .run(
        input.workspaceRef,
        input.repositoryRoot ?? null,
        input.gitBranch ?? null,
        input.sourceRevision ?? null,
        Date.now(),
        executionId,
      );
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  attachWriterStartRevision(executionId: string, startRevision: string): ExecutionLinkRecord {
    this.#db
      .prepare(
        `UPDATE v3_execution_links
            SET writer_start_revision=COALESCE(writer_start_revision,?),updated_at=?
          WHERE execution_id=?`,
      )
      .run(startRevision, Date.now(), executionId);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    if (record.writerStartRevision !== startRevision) {
      throw new Error('WRITER_COMPLETION_BASELINE_MISMATCH');
    }
    return record;
  }

  claimHostLaunch(
    executionId: string,
    token: string,
    claimedAt: number,
    staleBefore: number,
  ): { record: ExecutionLinkRecord; acquired: boolean } {
    const result = this.#db
      .prepare(
        `UPDATE v3_execution_links
            SET host_launch_token=?,host_launch_claimed_at=?,updated_at=?
          WHERE execution_id=?
            AND openhands_conversation_id IS NULL
            AND status_cache='STARTING'
            AND (
              host_launch_token IS NULL OR host_launch_claimed_at IS NULL OR host_launch_claimed_at < ?
            )`,
      )
      .run(token, claimedAt, claimedAt, executionId, staleBefore);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return { record, acquired: Number(result.changes) === 1 };
  }

  expireHostLaunchClaim(
    executionId: string,
    token: string,
  ): { record: ExecutionLinkRecord; expired: boolean } {
    const now = Date.now();
    const result = this.#db
      .prepare(
        `UPDATE v3_execution_links
            SET status_cache='FAILED',ended_at=?,host_launch_token=NULL,
                host_launch_claimed_at=NULL,updated_at=?
          WHERE execution_id=? AND status_cache='STARTING'
            AND openhands_conversation_id IS NULL AND host_launch_token=?`,
      )
      .run(now, now, executionId, token);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return { record, expired: Number(result.changes) === 1 };
  }

  attachOpenHands(
    executionId: string,
    conversationId: string,
    startedAt?: number,
    launchToken?: string,
  ): ExecutionLinkRecord {
    const now = Date.now();
    const statement = launchToken
      ? this.#db.prepare(
          `UPDATE v3_execution_links
             SET openhands_conversation_id=?, status_cache='RUNNING',
                 host_launch_token=NULL,host_launch_claimed_at=NULL,
                 started_at=COALESCE(?,started_at,created_at), updated_at=?
           WHERE execution_id=? AND status_cache='STARTING'
             AND (openhands_conversation_id IS NULL OR openhands_conversation_id=?)
             AND host_launch_token=?`,
        )
      : this.#db.prepare(
          `UPDATE v3_execution_links
             SET openhands_conversation_id=?, status_cache='RUNNING',
                 host_launch_token=NULL,host_launch_claimed_at=NULL,
                 started_at=COALESCE(?,started_at,created_at), updated_at=?
           WHERE execution_id=? AND status_cache='STARTING'
             AND (openhands_conversation_id IS NULL OR openhands_conversation_id=?)`,
        );
    if (launchToken) {
      statement.run(
        conversationId,
        startedAt ?? null,
        now,
        executionId,
        conversationId,
        launchToken,
      );
    } else {
      statement.run(conversationId, startedAt ?? null, now, executionId, conversationId);
    }
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    if (record.openhandsConversationId !== conversationId) {
      throw new Error('HOST_EXECUTION_ASSOCIATION_CONFLICT');
    }
    return record;
  }

  observeHostUpdatedAt(executionId: string, observedAt: number): ExecutionLinkRecord {
    if (!Number.isFinite(observedAt)) {
      const record = this.get(executionId);
      if (!record) throw new Error('EXECUTION_NOT_FOUND');
      return record;
    }
    this.#db
      .prepare(
        `UPDATE v3_execution_links
            SET host_updated_at=CASE
              WHEN host_updated_at IS NULL OR host_updated_at < ? THEN ?
              ELSE host_updated_at
            END
          WHERE execution_id=?`,
      )
      .run(observedAt, observedAt, executionId);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  updateStatus(
    executionId: string,
    status: ExecutionStatus,
    observedAt?: number,
  ): ExecutionLinkRecord {
    const now = Date.now();
    const endedAt = TERMINAL_STATUSES.has(status) ? (observedAt ?? now) : null;
    this.#db
      .prepare(
        `UPDATE v3_execution_links
            SET status_cache=?,
                ended_at=CASE WHEN ? IS NOT NULL AND ended_at IS NULL THEN ? ELSE ended_at END,
                updated_at=?
          WHERE execution_id=?
            AND (status_cache NOT IN ('SUCCEEDED','FAILED','STUCK','CANCELLED')
                 OR status_cache=?)`,
      )
      .run(status, endedAt, endedAt, now, executionId, status);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  attachResultText(executionId: string, resultText: string): ExecutionLinkRecord {
    this.#db
      .prepare(
        `UPDATE v3_execution_links
           SET result_text=?,updated_at=?
         WHERE execution_id=? AND result_text IS NULL`,
      )
      .run(resultText, Date.now(), executionId);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  attachFailure(
    executionId: string,
    failure: { code: string; detail?: string; retryable: boolean },
  ): ExecutionLinkRecord {
    this.#db
      .prepare(
        `UPDATE v3_execution_links
           SET error_code=?,error_detail=?,error_retryable=?,updated_at=?
         WHERE execution_id=? AND error_code IS NULL`,
      )
      .run(
        failure.code,
        failure.detail ?? null,
        failure.retryable ? 1 : 0,
        Date.now(),
        executionId,
      );
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  completeInternal(executionId: string, resultText: string): ExecutionLinkRecord {
    const now = Date.now();
    this.#db
      .prepare(
        `UPDATE v3_execution_links
           SET result_text=?,status_cache='SUCCEEDED',
               started_at=COALESCE(started_at,created_at),
               ended_at=COALESCE(ended_at,?),updated_at=?
         WHERE execution_id=?`,
      )
      .run(resultText, now, now, executionId);
    const record = this.get(executionId);
    if (!record) throw new Error('EXECUTION_NOT_FOUND');
    return record;
  }

  attachObservation(
    executionId: string,
    usage: UsageSummary | null | undefined,
    routes: RouteUsageSummary[] | null | undefined,
  ): ExecutionLinkRecord {
    this.#db
      .prepare(
        `UPDATE v3_execution_links
            SET usage_json=COALESCE(?,usage_json),
                observed_routes_json=COALESCE(?,observed_routes_json),
                updated_at=?
          WHERE execution_id=?`,
      )
      .run(
        usage ? JSON.stringify(usage) : null,
        routes ? JSON.stringify(routes) : null,
        Date.now(),
        executionId,
      );
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

  list(
    input: { projectKey?: string; limit?: number; offset?: number } = {},
  ): ExecutionLinkRecord[] {
    const limit = Math.min(5000, Math.max(1, input.limit ?? 100));
    const offset = Math.max(0, input.offset ?? 0);
    const rows = input.projectKey
      ? (this.#db
          .prepare(
            'SELECT * FROM v3_execution_links WHERE project_key=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
          )
          .all(input.projectKey, limit, offset) as unknown as ExecutionLinkRow[])
      : (this.#db
          .prepare(
            'SELECT * FROM v3_execution_links ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
          )
          .all(limit, offset) as unknown as ExecutionLinkRow[]);
    return rows.map(rowToRecord);
  }
}
