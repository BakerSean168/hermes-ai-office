import { newId } from './ids.js';
import { OrganizationRepository } from './organization.js';
import type { V2Repository, V2Row } from './repository.js';

type JsonRecord = Record<string, unknown>;

type RunStatus =
  'PLANNING' | 'RUNNING' | 'BLOCKED' | 'FINALIZING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type NodeState =
  | 'STARTING'
  | 'THINKING'
  | 'CODING'
  | 'TERMINAL'
  | 'BROWSING'
  | 'TESTING'
  | 'REVIEWING'
  | 'WAITING_IO'
  | 'NEEDS_INPUT'
  | 'BLOCKED'
  | 'DONE'
  | 'FAILED';
type NodeType = 'HERMES_SUBAGENT' | 'OPENCODE' | 'CODEX' | 'TERMINAL' | 'BROWSER' | 'OTHER';
type NodeRole =
  'SUPERVISOR' | 'ORCHESTRATOR' | 'EXECUTOR' | 'REVIEWER' | 'RESEARCHER' | 'TESTER' | 'INTEGRATOR';
type EdgeRelation = 'SPAWNED' | 'DELEGATED' | 'SUPERVISES' | 'REVIEWS' | 'DEPENDS_ON';

export interface HermesProfileControllerInput {
  profileId: string;
  displayName?: string;
  availability: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  workload: 'READY' | 'PLANNING' | 'SUPERVISING' | 'EXECUTING' | 'BLOCKED';
  sessionId?: string;
  controllerState?: NodeState;
  controllerStatus?: string;
  controllerModel?: string;
  controllerAction?: string;
  controllerActive?: boolean;
  mission?: string;
  lastSeenAt?: number;
  lastResponseAt?: number;
}

export interface HermesRunInput {
  id: string;
  profileId: string;
  title: string;
  status: RunStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface HermesExecutionNodeInput {
  id: string;
  profileId: string;
  runId: string;
  parentId?: string;
  type: NodeType;
  role: NodeRole;
  runtime?: string;
  model?: string;
  taskId?: string;
  taskTitle?: string;
  num?: number;
  state: NodeState;
  sessionId?: string;
  processId?: string;
  cwd?: string;
  workspace?: string;
  worktree?: string;
  branch?: string;
  currentTool?: string;
  currentAction?: string;
  tokensIn?: number;
  tokensOut?: number;
  cachedTokens?: number;
  cost?: number;
  elapsedSec?: number;
  startedAt: number;
  updatedAt: number;
  lastHeartbeatAt?: number;
  metadata?: JsonRecord;
}

export interface HermesExecutionEdgeInput {
  id: string;
  runId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: EdgeRelation;
}

export interface HermesOrgSnapshotInput {
  profiles: HermesProfileControllerInput[];
  runs: HermesRunInput[];
  nodes: HermesExecutionNodeInput[];
  edges: HermesExecutionEdgeInput[];
  sourceRevision?: string;
}

export interface ExecutionSyncResult {
  syncRunId: string;
  profilesSeen: number;
  runsSeen: number;
  nodesSeen: number;
  runtimeSessionsSeen: number;
  edgesSeen: number;
  workScopesCreated: number;
  runsCreated: number;
  positionsCreated: number;
  runtimeSessionsCreated: number;
  runtimeSessionsUpdated: number;
  runtimeSessionsClosed: number;
  dutiesCreated: number;
  relationsCreated: number;
  issues: Array<Record<string, unknown>>;
}

function now(): number {
  return Date.now();
}
function encode(value: unknown): string {
  return JSON.stringify(value ?? {});
}
function decode<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function row(value: unknown): V2Row | null {
  return value && typeof value === 'object' ? (value as V2Row) : null;
}
function rows(value: unknown): V2Row[] {
  return Array.isArray(value) ? (value as V2Row[]) : [];
}
function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return normalized || 'profile';
}
function title(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
function terminalRun(status: RunStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}
function terminalNode(state: NodeState): boolean {
  return state === 'DONE' || state === 'FAILED';
}
function runtimeLifecycle(state: NodeState): 'ACTIVE' | 'COMPLETED' | 'FAILED' {
  if (state === 'DONE') return 'COMPLETED';
  if (state === 'FAILED') return 'FAILED';
  return 'ACTIVE';
}
function dutyOutcome(state: NodeState): 'COMPLETED' | 'FAILED' | null {
  if (state === 'DONE') return 'COMPLETED';
  if (state === 'FAILED') return 'FAILED';
  return null;
}
function positionRelation(
  relation: EdgeRelation,
): 'DELEGATES_TO' | 'SUPERVISES' | 'REVIEWS' | 'DEPENDS_ON' | null {
  if (relation === 'DELEGATED') return 'DELEGATES_TO';
  if (relation === 'SUPERVISES') return 'SUPERVISES';
  if (relation === 'REVIEWS') return 'REVIEWS';
  if (relation === 'DEPENDS_ON') return 'DEPENDS_ON';
  return null;
}

export class HermesExecutionSyncService {
  readonly #domain: V2Repository;
  readonly #organization: OrganizationRepository;

  constructor(domain: V2Repository, organization = new OrganizationRepository(domain)) {
    this.#domain = domain;
    this.#organization = organization;
  }

  #startSync(sourceRevision?: string): V2Row {
    const timestamp = now();
    const id = newId('xsync', timestamp);
    this.#domain.db
      .prepare(
        `INSERT INTO v2_execution_sync_runs(id,source,source_revision,started_at,status,metadata_json)
         VALUES(?,?,?,?,'RUNNING','{}')`,
      )
      .run(id, 'HERMES_ORG', sourceRevision ?? null, timestamp);
    return row(this.#domain.db.prepare('SELECT * FROM v2_execution_sync_runs WHERE id=?').get(id))!;
  }

  #finishSync(syncRunId: string, result: ExecutionSyncResult): void {
    this.#domain.db
      .prepare(
        `UPDATE v2_execution_sync_runs SET completed_at=?,status='COMPLETED',profiles_seen=?,runs_seen=?,
           nodes_seen=?,runtime_sessions_seen=?,edges_seen=?,issues_json=? WHERE id=?`,
      )
      .run(
        now(),
        result.profilesSeen,
        result.runsSeen,
        result.nodesSeen,
        result.runtimeSessionsSeen,
        result.edgesSeen,
        encode(result.issues),
        syncRunId,
      );
    this.#domain.emit({
      type: 'execution_sync.completed',
      entityType: 'ExecutionSyncRun',
      entityId: syncRunId,
      payload: {
        profilesSeen: result.profilesSeen,
        runsSeen: result.runsSeen,
        nodesSeen: result.nodesSeen,
        runtimeSessionsSeen: result.runtimeSessionsSeen,
        edgesSeen: result.edgesSeen,
        issues: result.issues.length,
      },
    });
  }

  #failSync(syncRunId: string, errorCode: string): void {
    this.#domain.db
      .prepare(
        `UPDATE v2_execution_sync_runs SET completed_at=?,status='FAILED',error_code=? WHERE id=?`,
      )
      .run(now(), errorCode, syncRunId);
    this.#domain.emit({
      type: 'execution_sync.failed',
      entityType: 'ExecutionSyncRun',
      entityId: syncRunId,
      payload: { errorCode },
    });
  }

  #ensureProfileLead(workScopeId: string): V2Row {
    const role = this.#organization.createRole({
      slug: 'profile-lead',
      name: 'Profile Lead',
      purpose: 'Own the work scope, coordinate execution, and supervise delegated positions.',
    });
    const template = this.#organization.createPositionTemplate({
      slug: 'hermes-profile-lead',
      name: 'Hermes Profile Lead',
      roleId: String(role.id),
      runtimePolicy: { kind: 'HERMES_PROFILE' },
      lifecyclePolicy: 'STANDING',
      metadata: { source: 'HERMES_ORG' },
    });
    return this.#organization.instantiatePosition({
      templateId: String(template.id),
      workScopeId,
      slug: 'profile-lead',
      name: 'Profile Lead',
      metadata: { source: 'HERMES_ORG' },
    });
  }

  #ensureNodePosition(
    node: HermesExecutionNodeInput,
    runId: string,
    workScopeId: string,
  ): { position: V2Row; created: boolean } {
    const existing = row(
      this.#domain.db
        .prepare(`SELECT * FROM v2_positions WHERE origin_run_id=? AND external_position_ref=?`)
        .get(runId, node.id),
    );
    if (existing) return { position: existing, created: false };
    const roleSlug = slug(node.role);
    const role = this.#organization.createRole({
      slug: roleSlug,
      name: title(node.role),
      purpose: `Hermes ${node.role.toLowerCase()} execution responsibility.`,
      metadata: { source: 'HERMES_ORG' },
    });
    const templateSlug = `hermes-${roleSlug}-${slug(node.type)}`;
    const template = this.#organization.createPositionTemplate({
      slug: templateSlug,
      name: `${title(node.role)} · ${title(node.type)}`,
      roleId: String(role.id),
      runtimePolicy: { kind: node.type },
      lifecyclePolicy: 'RUN_SCOPED',
      metadata: { source: 'HERMES_ORG' },
    });
    const position = this.#organization.instantiatePosition({
      templateId: String(template.id),
      workScopeId,
      originRunId: runId,
      externalPositionRef: node.id,
      allowTerminalRun: true,
      name: node.taskTitle?.trim() || `${title(node.role)} ${node.num ?? ''}`.trim(),
      metadata: {
        source: 'HERMES_ORG',
        externalNodeId: node.id,
        taskId: node.taskId ?? null,
      },
    });
    return { position, created: true };
  }

  #upsertRun(sourceRun: HermesRunInput, workScopeId: string): { run: V2Row; created: boolean } {
    const externalRunRef = `hermes:${sourceRun.id}`;
    const existing = row(
      this.#domain.db.prepare('SELECT * FROM v2_runs WHERE external_run_ref=?').get(externalRunRef),
    );
    const timestamp = now();
    if (!existing) {
      const id = newId('run', sourceRun.createdAt || timestamp);
      const startedAt = sourceRun.startedAt ?? sourceRun.createdAt ?? timestamp;
      this.#domain.db
        .prepare(
          `INSERT INTO v2_runs(
             id,work_scope_id,external_run_ref,title,status,started_at,completed_at,metadata_json,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          workScopeId,
          externalRunRef,
          sourceRun.title,
          sourceRun.status,
          startedAt,
          sourceRun.completedAt ?? (terminalRun(sourceRun.status) ? timestamp : null),
          encode({
            source: 'HERMES_ORG',
            hermesRunId: sourceRun.id,
            profileId: sourceRun.profileId,
          }),
          sourceRun.createdAt ?? timestamp,
          timestamp,
        );
      this.#domain.emit({
        type: 'run.started',
        entityType: 'Run',
        entityId: id,
        runId: id,
        payload: { workScopeId, title: sourceRun.title, source: 'HERMES_ORG' },
      });
      return {
        run: row(this.#domain.db.prepare('SELECT * FROM v2_runs WHERE id=?').get(id))!,
        created: true,
      };
    }
    this.#domain.db
      .prepare(
        `UPDATE v2_runs SET work_scope_id=?,title=?,status=?,completed_at=?,updated_at=? WHERE id=?`,
      )
      .run(
        workScopeId,
        sourceRun.title,
        sourceRun.status,
        sourceRun.completedAt ?? (terminalRun(sourceRun.status) ? timestamp : null),
        timestamp,
        String(existing.id),
      );
    return {
      run: row(
        this.#domain.db.prepare('SELECT * FROM v2_runs WHERE id=?').get(String(existing.id)),
      )!,
      created: false,
    };
  }

  #ensureDuty(
    runId: string,
    positionId: string,
    activity: string,
    metadata: JsonRecord,
    allowNewAfterClosed = true,
  ): { duty: V2Row; created: boolean } {
    const existing = row(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_duty_sessions WHERE run_id=? AND position_id=?
           ORDER BY opened_at DESC LIMIT 1`,
        )
        .get(runId, positionId),
    );
    if (existing && ['PLANNED', 'ACTIVE'].includes(String(existing.lifecycle))) {
      this.#domain.db
        .prepare(`UPDATE v2_duty_sessions SET lifecycle='ACTIVE',current_activity=? WHERE id=?`)
        .run(activity, String(existing.id));
      return {
        duty: row(
          this.#domain.db
            .prepare('SELECT * FROM v2_duty_sessions WHERE id=?')
            .get(String(existing.id)),
        )!,
        created: false,
      };
    }
    if (existing && !allowNewAfterClosed) {
      return { duty: existing, created: false };
    }
    const timestamp = now();
    const id = newId('duty', timestamp);
    this.#domain.db
      .prepare(
        `INSERT INTO v2_duty_sessions(
           id,run_id,position_id,lifecycle,current_activity,opened_at,metadata_json)
         VALUES(?,?,?,'ACTIVE',?,?,?)`,
      )
      .run(id, runId, positionId, activity, timestamp, encode(metadata));
    this.#domain.emit({
      type: 'duty.opened',
      entityType: 'DutySession',
      entityId: id,
      runId,
      dutySessionId: id,
      payload: { positionId, source: 'HERMES_ORG' },
    });
    return {
      duty: row(this.#domain.db.prepare('SELECT * FROM v2_duty_sessions WHERE id=?').get(id))!,
      created: true,
    };
  }

  #upsertRuntime(input: {
    dutyId: string;
    positionId: string;
    runId: string;
    runtimeKind: string;
    externalSessionRef: string;
    state: string;
    modelHint?: string;
    processRef?: string;
    cwd?: string;
    worktree?: string;
    parentRuntimeSessionId?: string;
    openedAt?: number;
    observedAt?: number;
    metadata?: JsonRecord;
    lifecycle?: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  }): { runtime: V2Row; created: boolean; stateChanged: boolean } {
    const observedAt = input.observedAt ?? now();
    const existing = row(
      this.#domain.db
        .prepare(`SELECT * FROM v2_runtime_sessions WHERE run_id=? AND external_session_ref=?`)
        .get(input.runId, input.externalSessionRef),
    );
    const lifecycle = input.lifecycle ?? 'ACTIVE';
    if (!existing) {
      const id = newId('rt', input.openedAt ?? observedAt);
      this.#domain.db
        .prepare(
          `INSERT INTO v2_runtime_sessions(
             id,duty_session_id,position_id,run_id,runtime_kind,external_session_ref,lifecycle,state,
             model_hint,process_ref,cwd,worktree,parent_runtime_session_id,opened_at,closed_at,last_seen_at,
             metadata_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.dutyId,
          input.positionId,
          input.runId,
          input.runtimeKind,
          input.externalSessionRef,
          lifecycle,
          input.state,
          input.modelHint ?? null,
          input.processRef ?? null,
          input.cwd ?? null,
          input.worktree ?? null,
          input.parentRuntimeSessionId ?? null,
          input.openedAt ?? observedAt,
          lifecycle === 'ACTIVE' ? null : observedAt,
          observedAt,
          encode(input.metadata),
        );
      this.#recordActivity({
        runId: input.runId,
        dutyId: input.dutyId,
        positionId: input.positionId,
        runtimeSessionId: id,
        activity: input.state,
        eventType: 'RUNTIME_OPENED',
        occurredAt: observedAt,
        metadata: input.metadata,
      });
      this.#domain.emit({
        type: 'runtime_session.opened',
        entityType: 'RuntimeSession',
        entityId: id,
        runId: input.runId,
        dutySessionId: input.dutyId,
        payload: { positionId: input.positionId, runtimeKind: input.runtimeKind },
      });
      return {
        runtime: row(
          this.#domain.db.prepare('SELECT * FROM v2_runtime_sessions WHERE id=?').get(id),
        )!,
        created: true,
        stateChanged: true,
      };
    }
    const stateChanged = String(existing.state) !== input.state;
    const wasActive = String(existing.lifecycle) === 'ACTIVE';
    this.#domain.db
      .prepare(
        `UPDATE v2_runtime_sessions SET duty_session_id=?,position_id=?,runtime_kind=?,lifecycle=?,state=?,
           model_hint=?,process_ref=?,cwd=?,worktree=?,parent_runtime_session_id=COALESCE(?,parent_runtime_session_id),
           closed_at=CASE WHEN ?='ACTIVE' THEN NULL ELSE COALESCE(closed_at,?) END,
           last_seen_at=?,metadata_json=? WHERE id=?`,
      )
      .run(
        input.dutyId,
        input.positionId,
        input.runtimeKind,
        lifecycle,
        input.state,
        input.modelHint ?? null,
        input.processRef ?? null,
        input.cwd ?? null,
        input.worktree ?? null,
        input.parentRuntimeSessionId ?? null,
        lifecycle,
        observedAt,
        observedAt,
        encode(input.metadata),
        String(existing.id),
      );
    if (stateChanged) {
      this.#recordActivity({
        runId: input.runId,
        dutyId: input.dutyId,
        positionId: input.positionId,
        runtimeSessionId: String(existing.id),
        activity: input.state,
        eventType: 'STATE_CHANGED',
        occurredAt: observedAt,
        metadata: input.metadata,
      });
    }
    if (!wasActive && lifecycle === 'ACTIVE') {
      this.#recordActivity({
        runId: input.runId,
        dutyId: input.dutyId,
        positionId: input.positionId,
        runtimeSessionId: String(existing.id),
        activity: input.state,
        eventType: 'RUNTIME_REOPENED',
        occurredAt: observedAt,
        metadata: input.metadata,
      });
      this.#domain.emit({
        type: 'runtime_session.opened',
        entityType: 'RuntimeSession',
        entityId: String(existing.id),
        runId: input.runId,
        dutySessionId: input.dutyId,
        payload: { positionId: input.positionId, runtimeKind: input.runtimeKind, reopened: true },
      });
    }
    if (wasActive && lifecycle !== 'ACTIVE') {
      this.#domain.emit({
        type: 'runtime_session.closed',
        entityType: 'RuntimeSession',
        entityId: String(existing.id),
        runId: input.runId,
        dutySessionId: input.dutyId,
        payload: { lifecycle, state: input.state },
      });
    }
    return {
      runtime: row(
        this.#domain.db
          .prepare('SELECT * FROM v2_runtime_sessions WHERE id=?')
          .get(String(existing.id)),
      )!,
      created: false,
      stateChanged,
    };
  }

  #recordActivity(input: {
    runId: string;
    dutyId?: string;
    positionId?: string;
    runtimeSessionId?: string;
    activity: string;
    eventType: string;
    occurredAt?: number;
    metadata?: JsonRecord;
  }): void {
    const timestamp = input.occurredAt ?? now();
    this.#domain.db
      .prepare(
        `INSERT INTO v2_activity_events(
           id,run_id,duty_session_id,position_id,runtime_session_id,activity,event_type,occurred_at,source,metadata_json)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        newId('act', timestamp),
        input.runId,
        input.dutyId ?? null,
        input.positionId ?? null,
        input.runtimeSessionId ?? null,
        input.activity,
        input.eventType,
        timestamp,
        'HERMES_ORG',
        encode(input.metadata),
      );
  }

  #closeDutyWithoutFinalizingRun(
    dutyId: string,
    outcome: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    reason: string,
    timestamp = now(),
  ): void {
    const duty = row(
      this.#domain.db.prepare('SELECT * FROM v2_duty_sessions WHERE id=?').get(dutyId),
    );
    if (!duty || !['PLANNED', 'ACTIVE'].includes(String(duty.lifecycle))) return;
    const segments = rows(
      this.#domain.db
        .prepare('SELECT * FROM v2_staffing_segments WHERE duty_session_id=? AND ended_at IS NULL')
        .all(dutyId),
    );
    for (const segment of segments) {
      const endedAt = Math.max(timestamp, Number(segment.started_at) + 1);
      this.#domain.db
        .prepare('UPDATE v2_staffing_segments SET ended_at=?,ended_reason=? WHERE id=?')
        .run(endedAt, outcome, String(segment.id));
      this.#domain.emit({
        type: 'staffing_segment.ended',
        entityType: 'StaffingSegment',
        entityId: String(segment.id),
        runId: String(duty.run_id),
        dutySessionId: dutyId,
        payload: { employeeId: segment.employee_id, reason: outcome },
      });
    }
    this.#domain.db
      .prepare(
        `UPDATE v2_duty_sessions SET lifecycle=?,current_activity='IDLE',closed_at=?,close_reason=? WHERE id=?`,
      )
      .run(outcome, timestamp, reason, dutyId);
    this.#domain.emit({
      type:
        outcome === 'COMPLETED'
          ? 'duty.completed'
          : outcome === 'FAILED'
            ? 'duty.failed'
            : 'duty.cancelled',
      entityType: 'DutySession',
      entityId: dutyId,
      runId: String(duty.run_id),
      dutySessionId: dutyId,
      payload: { outcome, reason },
    });
  }

  #finalizeRun(
    runId: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    completedAt?: number,
  ): void {
    const timestamp = completedAt ?? now();
    const duties = rows(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_duty_sessions WHERE run_id=? AND lifecycle IN ('PLANNED','ACTIVE')`,
        )
        .all(runId),
    );
    for (const duty of duties) {
      this.#closeDutyWithoutFinalizingRun(
        String(duty.id),
        status === 'FAILED' ? 'FAILED' : status === 'CANCELLED' ? 'CANCELLED' : 'COMPLETED',
        `RUN_${status}`,
        timestamp,
      );
    }
    const runtimes = rows(
      this.#domain.db
        .prepare(`SELECT * FROM v2_runtime_sessions WHERE run_id=? AND lifecycle='ACTIVE'`)
        .all(runId),
    );
    for (const runtime of runtimes) {
      const lifecycle =
        status === 'FAILED' ? 'FAILED' : status === 'CANCELLED' ? 'CANCELLED' : 'COMPLETED';
      this.#domain.db
        .prepare(
          `UPDATE v2_runtime_sessions SET lifecycle=?,state=?,closed_at=?,last_seen_at=? WHERE id=?`,
        )
        .run(lifecycle, status, timestamp, timestamp, String(runtime.id));
      this.#domain.emit({
        type: 'runtime_session.closed',
        entityType: 'RuntimeSession',
        entityId: String(runtime.id),
        runId,
        dutySessionId: String(runtime.duty_session_id),
        payload: { lifecycle, reason: `RUN_${status}` },
      });
    }
    this.#domain.db
      .prepare('UPDATE v2_runs SET status=?,completed_at=?,updated_at=? WHERE id=?')
      .run(status, timestamp, timestamp, runId);
    const runScoped = rows(
      this.#domain.db
        .prepare(
          `SELECT id FROM v2_positions
           WHERE origin_run_id=? AND lifecycle_policy='RUN_SCOPED'
             AND lifecycle IN ('PLANNED','ACTIVE','PAUSED')`,
        )
        .all(runId),
    );
    for (const position of runScoped) {
      this.#domain.db
        .prepare(
          `UPDATE v2_appointments
           SET status='ENDED',effective_to=CASE WHEN effective_from>=? THEN effective_from+1 ELSE ? END,
               ended_reason=?,updated_at=?
           WHERE position_id=? AND status IN ('SCHEDULED','CURRENT','SUSPENDED') AND effective_to IS NULL`,
        )
        .run(timestamp, timestamp, `RUN_${status}`, timestamp, String(position.id));
      this.#domain.db
        .prepare(`UPDATE v2_positions SET lifecycle='RETIRED',retired_at=?,updated_at=? WHERE id=?`)
        .run(timestamp, timestamp, String(position.id));
      this.#domain.db
        .prepare(
          `UPDATE v2_position_relations
           SET effective_to=CASE WHEN effective_from>=? THEN effective_from+1 ELSE ? END
           WHERE effective_to IS NULL AND (from_position_id=? OR to_position_id=?)`,
        )
        .run(timestamp, timestamp, String(position.id), String(position.id));
      this.#domain.emit({
        type: 'position.retired',
        entityType: 'Position',
        entityId: String(position.id),
        runId,
        payload: { reason: `RUN_${status}` },
      });
    }
    this.#domain.emit({
      type:
        status === 'COMPLETED'
          ? 'run.completed'
          : status === 'FAILED'
            ? 'run.failed'
            : 'run.cancelled',
      entityType: 'Run',
      entityId: runId,
      runId,
      payload: { status, source: 'HERMES_ORG' },
    });
  }

  #upsertRuntimeEdge(input: {
    runId: string;
    fromRuntimeSessionId: string;
    toRuntimeSessionId: string;
    relation: EdgeRelation;
    metadata?: JsonRecord;
  }): { edge: V2Row; created: boolean } {
    const timestamp = now();
    const existing = row(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_runtime_session_edges
           WHERE run_id=? AND from_runtime_session_id=? AND to_runtime_session_id=? AND relation_type=?`,
        )
        .get(input.runId, input.fromRuntimeSessionId, input.toRuntimeSessionId, input.relation),
    );
    if (existing) {
      this.#domain.db
        .prepare('UPDATE v2_runtime_session_edges SET last_seen_at=?,metadata_json=? WHERE id=?')
        .run(timestamp, encode(input.metadata), String(existing.id));
      return {
        edge: row(
          this.#domain.db
            .prepare('SELECT * FROM v2_runtime_session_edges WHERE id=?')
            .get(String(existing.id)),
        )!,
        created: false,
      };
    }
    const id = newId('redge', timestamp);
    this.#domain.db
      .prepare(
        `INSERT INTO v2_runtime_session_edges(
           id,run_id,from_runtime_session_id,to_runtime_session_id,relation_type,source,
           first_seen_at,last_seen_at,metadata_json)
         VALUES(?,?,?,?,?,'HERMES_ORG',?,?,?)`,
      )
      .run(
        id,
        input.runId,
        input.fromRuntimeSessionId,
        input.toRuntimeSessionId,
        input.relation,
        timestamp,
        timestamp,
        encode(input.metadata),
      );
    return {
      edge: row(
        this.#domain.db.prepare('SELECT * FROM v2_runtime_session_edges WHERE id=?').get(id),
      )!,
      created: true,
    };
  }

  async sync(snapshot: HermesOrgSnapshotInput): Promise<ExecutionSyncResult> {
    const syncRun = this.#startSync(snapshot.sourceRevision);
    const result: ExecutionSyncResult = {
      syncRunId: String(syncRun.id),
      profilesSeen: snapshot.profiles.length,
      runsSeen: snapshot.runs.length,
      nodesSeen: snapshot.nodes.length,
      runtimeSessionsSeen: 0,
      edgesSeen: snapshot.edges.length,
      workScopesCreated: 0,
      runsCreated: 0,
      positionsCreated: 0,
      runtimeSessionsCreated: 0,
      runtimeSessionsUpdated: 0,
      runtimeSessionsClosed: 0,
      dutiesCreated: 0,
      relationsCreated: 0,
      issues: [],
    };
    try {
      this.#domain.transaction(() => {
        const profileById = new Map(
          snapshot.profiles.map((profile) => [profile.profileId, profile]),
        );
        const scopeByProfile = new Map<string, V2Row>();
        const leadByProfile = new Map<string, V2Row>();
        for (const profile of snapshot.profiles) {
          const before = row(
            this.#domain.db
              .prepare('SELECT * FROM v2_work_scopes WHERE external_profile_ref=?')
              .get(profile.profileId),
          );
          const scope = this.#domain.getOrCreateWorkScope({
            slug: slug(profile.profileId),
            name: profile.displayName?.trim() || profile.profileId,
            externalProfileRef: profile.profileId,
          });
          if (!before) result.workScopesCreated += 1;
          this.#domain.db
            .prepare('UPDATE v2_work_scopes SET name=?,lifecycle=?,updated_at=? WHERE id=?')
            .run(
              profile.displayName?.trim() || profile.profileId,
              profile.availability === 'OFFLINE' ? 'PAUSED' : 'ACTIVE',
              now(),
              String(scope.id),
            );
          scopeByProfile.set(profile.profileId, scope);
          leadByProfile.set(profile.profileId, this.#ensureProfileLead(String(scope.id)));
        }

        const runByExternal = new Map<string, V2Row>();
        for (const sourceRun of snapshot.runs) {
          const scope = scopeByProfile.get(sourceRun.profileId);
          if (!scope) {
            result.issues.push({
              code: 'RUN_PROFILE_MISSING',
              runId: sourceRun.id,
              profileId: sourceRun.profileId,
            });
            continue;
          }
          const upserted = this.#upsertRun(sourceRun, String(scope.id));
          if (upserted.created) result.runsCreated += 1;
          runByExternal.set(sourceRun.id, upserted.run);
        }

        const runtimeByNode = new Map<string, V2Row>();
        const positionByNode = new Map<string, V2Row>();
        const seenRuntimeIdsByRun = new Map<string, Set<string>>();

        for (const sourceRun of snapshot.runs) {
          const profile = profileById.get(sourceRun.profileId);
          const run = runByExternal.get(sourceRun.id);
          const lead = leadByProfile.get(sourceRun.profileId);
          if (!profile || !run || !lead || !profile.sessionId) continue;
          if (sourceRun.id !== `interactive:${profile.profileId}:${profile.sessionId}`) continue;
          const dutyResult = this.#ensureDuty(
            String(run.id),
            String(lead.id),
            profile.controllerState ?? profile.workload,
            { source: 'HERMES_ORG', profileController: true, profileId: profile.profileId },
            !terminalRun(sourceRun.status),
          );
          if (dutyResult.created) result.dutiesCreated += 1;
          const lifecycle = terminalRun(sourceRun.status)
            ? sourceRun.status === 'FAILED'
              ? 'FAILED'
              : sourceRun.status === 'CANCELLED'
                ? 'CANCELLED'
                : 'COMPLETED'
            : 'ACTIVE';
          const runtimeResult = this.#upsertRuntime({
            dutyId: String(dutyResult.duty.id),
            positionId: String(lead.id),
            runId: String(run.id),
            runtimeKind: 'HERMES_PROFILE',
            externalSessionRef: `profile:${profile.profileId}:${profile.sessionId}`,
            state: profile.controllerState ?? profile.workload,
            modelHint: profile.controllerModel,
            openedAt: sourceRun.startedAt ?? sourceRun.createdAt,
            observedAt: profile.lastSeenAt ?? now(),
            lifecycle,
            metadata: {
              source: 'HERMES_ORG',
              profileController: true,
              profileId: profile.profileId,
              controllerStatus: profile.controllerStatus ?? null,
              controllerAction: profile.controllerAction ?? null,
              mission: profile.mission ?? null,
            },
          });
          result.runtimeSessionsSeen += 1;
          if (runtimeResult.created) result.runtimeSessionsCreated += 1;
          else result.runtimeSessionsUpdated += 1;
          const seen = seenRuntimeIdsByRun.get(String(run.id)) ?? new Set<string>();
          seen.add(String(runtimeResult.runtime.id));
          seenRuntimeIdsByRun.set(String(run.id), seen);
        }

        for (const node of snapshot.nodes) {
          if (!node.runId) {
            result.issues.push({
              code: 'NODE_RUN_MISSING',
              nodeId: node.id,
              profileId: node.profileId,
            });
            continue;
          }
          const run = runByExternal.get(node.runId);
          const scope = scopeByProfile.get(node.profileId);
          const sourceRun = snapshot.runs.find((item) => item.id === node.runId);
          if (!run || !scope || !sourceRun) {
            result.issues.push({
              code: 'NODE_RUN_UNRESOLVED',
              nodeId: node.id,
              runId: node.runId,
              profileId: node.profileId,
            });
            continue;
          }
          const ensured = this.#ensureNodePosition(node, String(run.id), String(scope.id));
          if (ensured.created) result.positionsCreated += 1;
          positionByNode.set(node.id, ensured.position);
          const dutyResult = this.#ensureDuty(
            String(run.id),
            String(ensured.position.id),
            node.state,
            { source: 'HERMES_ORG', externalNodeId: node.id, taskId: node.taskId ?? null },
            !terminalRun(sourceRun.status),
          );
          if (dutyResult.created) result.dutiesCreated += 1;
          const runtimeResult = this.#upsertRuntime({
            dutyId: String(dutyResult.duty.id),
            positionId: String(ensured.position.id),
            runId: String(run.id),
            runtimeKind: node.type,
            externalSessionRef: node.sessionId ?? `node:${node.id}`,
            state: node.state,
            modelHint: node.model,
            processRef: node.processId,
            cwd: node.cwd ?? node.workspace,
            worktree: node.worktree,
            openedAt: node.startedAt,
            observedAt: node.updatedAt || now(),
            lifecycle: runtimeLifecycle(node.state),
            metadata: {
              source: 'HERMES_ORG',
              externalNodeId: node.id,
              sessionId: node.sessionId ?? null,
              runtime: node.runtime ?? null,
              modelHintOnly: node.model ?? null,
              taskId: node.taskId ?? null,
              taskTitle: node.taskTitle ?? null,
              branch: node.branch ?? null,
              currentTool: node.currentTool ?? null,
              currentAction: node.currentAction ?? null,
              tokensIn: node.tokensIn ?? null,
              tokensOut: node.tokensOut ?? null,
              cachedTokens: node.cachedTokens ?? null,
              cost: node.cost ?? null,
              elapsedSec: node.elapsedSec ?? null,
              lastHeartbeatAt: node.lastHeartbeatAt ?? null,
              ...(node.metadata ?? {}),
            },
          });
          runtimeByNode.set(node.id, runtimeResult.runtime);
          result.runtimeSessionsSeen += 1;
          if (runtimeResult.created) result.runtimeSessionsCreated += 1;
          else result.runtimeSessionsUpdated += 1;
          const seen = seenRuntimeIdsByRun.get(String(run.id)) ?? new Set<string>();
          seen.add(String(runtimeResult.runtime.id));
          seenRuntimeIdsByRun.set(String(run.id), seen);

          const outcome = dutyOutcome(node.state);
          if (outcome && !terminalRun(sourceRun.status)) {
            this.#closeDutyWithoutFinalizingRun(
              String(dutyResult.duty.id),
              outcome,
              `RUNTIME_${node.state}`,
              node.updatedAt || now(),
            );
          }
        }

        for (const node of snapshot.nodes) {
          if (!node.parentId) continue;
          const child = runtimeByNode.get(node.id);
          const parent = runtimeByNode.get(node.parentId);
          if (!child || !parent) continue;
          this.#domain.db
            .prepare('UPDATE v2_runtime_sessions SET parent_runtime_session_id=? WHERE id=?')
            .run(String(parent.id), String(child.id));
        }

        for (const edge of snapshot.edges) {
          const run = runByExternal.get(edge.runId);
          const fromRuntime = runtimeByNode.get(edge.fromNodeId);
          const toRuntime = runtimeByNode.get(edge.toNodeId);
          if (!run || !fromRuntime || !toRuntime) {
            result.issues.push({
              code: 'EDGE_NODE_UNRESOLVED',
              edgeId: edge.id,
              runId: edge.runId,
            });
            continue;
          }
          this.#upsertRuntimeEdge({
            runId: String(run.id),
            fromRuntimeSessionId: String(fromRuntime.id),
            toRuntimeSessionId: String(toRuntime.id),
            relation: edge.relation,
            metadata: { sourceEdgeId: edge.id },
          });
          const semantic = positionRelation(edge.relation);
          if (semantic) {
            const fromPosition = positionByNode.get(edge.fromNodeId);
            const toPosition = positionByNode.get(edge.toNodeId);
            if (fromPosition && toPosition) {
              const existing = row(
                this.#domain.db
                  .prepare(
                    `SELECT id FROM v2_position_relations
                     WHERE from_position_id=? AND to_position_id=? AND relation_type=? AND effective_to IS NULL`,
                  )
                  .get(String(fromPosition.id), String(toPosition.id), semantic),
              );
              this.#organization.createPositionRelation({
                fromPositionId: String(fromPosition.id),
                toPositionId: String(toPosition.id),
                relationType: semantic,
                source: 'POLICY',
                metadata: { source: 'HERMES_ORG', sourceEdgeId: edge.id },
              });
              if (!existing) result.relationsCreated += 1;
            }
          }
        }

        for (const node of snapshot.nodes.filter((item) => item.runId && !item.parentId)) {
          const lead = leadByProfile.get(node.profileId);
          const position = positionByNode.get(node.id);
          if (!lead || !position) continue;
          const existing = row(
            this.#domain.db
              .prepare(
                `SELECT id FROM v2_position_relations
                 WHERE from_position_id=? AND to_position_id=? AND relation_type='SUPERVISES' AND effective_to IS NULL`,
              )
              .get(String(lead.id), String(position.id)),
          );
          this.#organization.createPositionRelation({
            fromPositionId: String(lead.id),
            toPositionId: String(position.id),
            relationType: 'SUPERVISES',
            source: 'POLICY',
            metadata: { source: 'HERMES_ORG', rootExecutionNode: true },
          });
          if (!existing) result.relationsCreated += 1;
        }

        for (const sourceRun of snapshot.runs) {
          const run = runByExternal.get(sourceRun.id);
          if (!run || terminalRun(sourceRun.status)) continue;
          const seen = seenRuntimeIdsByRun.get(String(run.id)) ?? new Set<string>();
          const active = rows(
            this.#domain.db
              .prepare(`SELECT * FROM v2_runtime_sessions WHERE run_id=? AND lifecycle='ACTIVE'`)
              .all(String(run.id)),
          );
          for (const runtime of active) {
            if (seen.has(String(runtime.id))) continue;
            const metadata = decode<JsonRecord>(runtime.metadata_json, {});
            if (metadata.source !== 'HERMES_ORG') continue;
            const timestamp = now();
            this.#domain.db
              .prepare(
                `UPDATE v2_runtime_sessions
                 SET lifecycle='CANCELLED',state='SNAPSHOT_MISSING',closed_at=?,last_seen_at=? WHERE id=?`,
              )
              .run(timestamp, timestamp, String(runtime.id));
            this.#closeDutyWithoutFinalizingRun(
              String(runtime.duty_session_id),
              'CANCELLED',
              'SNAPSHOT_MISSING',
              timestamp,
            );
            result.runtimeSessionsClosed += 1;
          }
        }

        for (const sourceRun of snapshot.runs.filter((item) => terminalRun(item.status))) {
          const run = runByExternal.get(sourceRun.id);
          if (!run) continue;
          this.#finalizeRun(
            String(run.id),
            sourceRun.status as 'COMPLETED' | 'FAILED' | 'CANCELLED',
            sourceRun.completedAt,
          );
        }
      });
      this.#finishSync(String(syncRun.id), result);
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : 'HERMES_EXECUTION_SYNC_FAILED';
      this.#failSync(String(syncRun.id), code);
      throw error;
    }
  }

  listRuntimeSessions(
    filters: { runId?: string; activeOnly?: boolean; limit?: number } = {},
  ): V2Row[] {
    const limit = Math.min(2_000, Math.max(1, filters.limit ?? 500));
    return rows(
      this.#domain.db
        .prepare(
          `SELECT r.*,p.name position_name,p.slug position_slug,d.current_activity,vr.title run_title
           FROM v2_runtime_sessions r
           JOIN v2_positions p ON p.id=r.position_id
           JOIN v2_duty_sessions d ON d.id=r.duty_session_id
           JOIN v2_runs vr ON vr.id=r.run_id
           WHERE (? IS NULL OR r.run_id=?) AND (?=0 OR r.lifecycle='ACTIVE')
           ORDER BY r.last_seen_at DESC LIMIT ?`,
        )
        .all(filters.runId ?? null, filters.runId ?? null, filters.activeOnly ? 1 : 0, limit),
    ).map((value) => ({
      id: value.id,
      dutySessionId: value.duty_session_id,
      positionId: value.position_id,
      positionName: value.position_name,
      positionSlug: value.position_slug,
      runId: value.run_id,
      runTitle: value.run_title,
      runtimeKind: value.runtime_kind,
      externalSessionRef: value.external_session_ref,
      lifecycle: value.lifecycle,
      state: value.state,
      currentActivity: value.current_activity,
      modelHint: value.model_hint,
      processRef: value.process_ref,
      cwd: value.cwd,
      worktree: value.worktree,
      parentRuntimeSessionId: value.parent_runtime_session_id,
      openedAt: value.opened_at,
      closedAt: value.closed_at,
      lastSeenAt: value.last_seen_at,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  listRuntimeEdges(runId?: string, limit = 1_000): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_runtime_session_edges
           WHERE (? IS NULL OR run_id=?) ORDER BY last_seen_at DESC LIMIT ?`,
        )
        .all(runId ?? null, runId ?? null, Math.min(5_000, Math.max(1, limit))),
    ).map((value) => ({
      id: value.id,
      runId: value.run_id,
      fromRuntimeSessionId: value.from_runtime_session_id,
      toRuntimeSessionId: value.to_runtime_session_id,
      relationType: value.relation_type,
      source: value.source,
      firstSeenAt: value.first_seen_at,
      lastSeenAt: value.last_seen_at,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  listActivityEvents(runId?: string, limit = 500): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_activity_events
           WHERE (? IS NULL OR run_id=?) ORDER BY occurred_at DESC LIMIT ?`,
        )
        .all(runId ?? null, runId ?? null, Math.min(5_000, Math.max(1, limit))),
    ).map((value) => ({
      id: value.id,
      runId: value.run_id,
      dutySessionId: value.duty_session_id,
      positionId: value.position_id,
      runtimeSessionId: value.runtime_session_id,
      activity: value.activity,
      eventType: value.event_type,
      occurredAt: value.occurred_at,
      source: value.source,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  listSyncRuns(limit = 100): V2Row[] {
    return rows(
      this.#domain.db
        .prepare('SELECT * FROM v2_execution_sync_runs ORDER BY started_at DESC LIMIT ?')
        .all(Math.min(1_000, Math.max(1, limit))),
    ).map((value) => ({
      id: value.id,
      source: value.source,
      sourceRevision: value.source_revision,
      startedAt: value.started_at,
      completedAt: value.completed_at,
      status: value.status,
      profilesSeen: Number(value.profiles_seen ?? 0),
      runsSeen: Number(value.runs_seen ?? 0),
      nodesSeen: Number(value.nodes_seen ?? 0),
      runtimeSessionsSeen: Number(value.runtime_sessions_seen ?? 0),
      edgesSeen: Number(value.edges_seen ?? 0),
      issues: decode<unknown[]>(value.issues_json, []),
      errorCode: value.error_code,
    }));
  }
}
