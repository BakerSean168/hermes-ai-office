import { createHash } from 'node:crypto';

import type { V2Event, V2Repository, V2Row } from './repository.js';

type JsonRecord = Record<string, unknown>;

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
function incidentId(fingerprint: string): string {
  return `inc_${createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;
}

interface IncidentTrigger {
  fingerprint: string;
  kind: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  title: string;
  entityType?: string;
  entityId?: string;
  runId?: string;
  dutySessionId?: string;
  positionId?: string;
  employeeId?: string;
  detail?: JsonRecord;
}

interface EventContext {
  seq: number;
  type: string;
  timestamp: number;
  entityType?: string;
  entityId?: string;
  runId?: string;
  dutySessionId?: string;
  positionId?: string;
  employeeId?: string;
  payload: JsonRecord;
}

export class IncidentProjectionService {
  static readonly projectionName = 'incidents';
  static readonly projectionVersion = 1;
  readonly #domain: V2Repository;

  constructor(domain: V2Repository) {
    this.#domain = domain;
  }

  #context(event: V2Event): EventContext {
    const value = event as unknown as Record<string, unknown>;
    const payload =
      value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
        ? (value.payload as JsonRecord)
        : {};
    const entity =
      value.entity && typeof value.entity === 'object' && !Array.isArray(value.entity)
        ? (value.entity as JsonRecord)
        : {};
    const correlation =
      value.correlation &&
      typeof value.correlation === 'object' &&
      !Array.isArray(value.correlation)
        ? (value.correlation as JsonRecord)
        : {};
    const dutySessionId = value.dutySessionId
      ? String(value.dutySessionId)
      : correlation.dutySessionId
        ? String(correlation.dutySessionId)
        : undefined;
    let runId = value.runId
      ? String(value.runId)
      : correlation.runId
        ? String(correlation.runId)
        : undefined;
    let positionId = value.positionId
      ? String(value.positionId)
      : payload.positionId
        ? String(payload.positionId)
        : undefined;
    if (dutySessionId && (!runId || !positionId)) {
      const duty = row(
        this.#domain.db
          .prepare('SELECT run_id,position_id FROM v2_duty_sessions WHERE id=?')
          .get(dutySessionId),
      );
      if (duty) {
        runId ??= String(duty.run_id);
        positionId ??= String(duty.position_id);
      }
    }
    const entityType = value.entityType
      ? String(value.entityType)
      : entity.type
        ? String(entity.type)
        : undefined;
    const entityId = value.entityId
      ? String(value.entityId)
      : entity.id
        ? String(entity.id)
        : undefined;
    if (!positionId && entityType === 'RuntimeSession' && entityId) {
      const runtime = row(
        this.#domain.db
          .prepare('SELECT position_id,run_id,duty_session_id FROM v2_runtime_sessions WHERE id=?')
          .get(entityId),
      );
      if (runtime) {
        positionId = String(runtime.position_id);
        runId ??= String(runtime.run_id);
      }
    }
    return {
      seq: Number(value.seq),
      type: String(value.type),
      timestamp: Number(value.occurredAt ?? value.createdAt ?? value.timestamp ?? now()),
      entityType,
      entityId,
      runId,
      dutySessionId,
      positionId,
      employeeId: value.employeeId
        ? String(value.employeeId)
        : payload.employeeId
          ? String(payload.employeeId)
          : undefined,
      payload,
    };
  }

  #triggerFor(context: EventContext): IncidentTrigger | null {
    if (context.type === 'dispatch.failed') {
      const scope = context.dutySessionId ?? context.entityId ?? 'unknown';
      return {
        fingerprint: `dispatch:${scope}`,
        kind: 'DISPATCH_FAILURE',
        severity: 'ERROR',
        title: 'No eligible and routable employee could be dispatched',
        ...context,
        detail: context.payload,
      };
    }
    if (context.type === 'invocation.failed') {
      const scope = context.dutySessionId ?? context.entityId ?? 'unknown';
      return {
        fingerprint: `invocation:${scope}`,
        kind: 'INVOCATION_FAILURE',
        severity: 'ERROR',
        title: 'Model invocation failed',
        ...context,
        detail: context.payload,
      };
    }
    if (context.type === 'execution_sync.failed') {
      return {
        fingerprint: 'execution-sync:HERMES_ORG',
        kind: 'EXECUTION_SYNC_FAILURE',
        severity: 'ERROR',
        title: 'Hermes execution projection failed',
        ...context,
        detail: context.payload,
      };
    }
    if (
      context.type === 'duty.cancelled' &&
      String(context.payload.reason ?? context.payload.outcome ?? '') === 'SNAPSHOT_MISSING'
    ) {
      return {
        fingerprint: `runtime-missing:${context.runId ?? 'unknown'}:${context.positionId ?? context.dutySessionId ?? 'unknown'}`,
        kind: 'RUNTIME_DISAPPEARED',
        severity: 'WARNING',
        title: 'Runtime disappeared from the current Hermes snapshot',
        ...context,
        detail: context.payload,
      };
    }
    if (
      context.type.includes('reconciliation') &&
      Number(context.payload.mismatches ?? context.payload.mismatchCount ?? 0) > 0
    ) {
      return {
        fingerprint: `usage-reconciliation:${String(context.payload.gatewayId ?? context.entityId ?? 'unknown')}`,
        kind: 'USAGE_RECONCILIATION_MISMATCH',
        severity: 'WARNING',
        title: 'Gateway usage evidence does not match the internal ledger',
        ...context,
        detail: context.payload,
      };
    }
    return null;
  }

  #recoveryFingerprint(context: EventContext): string | null {
    if (context.type === 'staffing_segment.started' && context.dutySessionId) {
      return `dispatch:${context.dutySessionId}`;
    }
    if (context.type === 'execution_sync.completed') return 'execution-sync:HERMES_ORG';
    if (context.type === 'runtime_session.opened') {
      return `runtime-missing:${context.runId ?? 'unknown'}:${context.positionId ?? context.dutySessionId ?? 'unknown'}`;
    }
    if (
      context.type.includes('reconciliation') &&
      Number(context.payload.mismatches ?? context.payload.mismatchCount ?? 0) === 0 &&
      (context.payload.gatewayId || context.entityId)
    ) {
      return `usage-reconciliation:${String(context.payload.gatewayId ?? context.entityId)}`;
    }
    return null;
  }

  #link(incidentIdValue: string, eventSeq: number, linkType: string, timestamp: number): void {
    this.#domain.db
      .prepare(
        `INSERT OR IGNORE INTO v2_incident_event_links(incident_id,event_seq,link_type,created_at)
         VALUES(?,?,?,?)`,
      )
      .run(incidentIdValue, eventSeq, linkType, timestamp);
  }

  #openOrUpdate(trigger: IncidentTrigger, context: EventContext): void {
    const id = incidentId(trigger.fingerprint);
    const existing = row(
      this.#domain.db
        .prepare('SELECT * FROM v2_incidents WHERE fingerprint=?')
        .get(trigger.fingerprint),
    );
    if (!existing) {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_incidents(
             id,fingerprint,kind,severity,lifecycle,title,entity_type,entity_id,run_id,duty_session_id,
             position_id,employee_id,first_event_seq,last_event_seq,occurrence_count,first_seen_at,last_seen_at,
             detail_json,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          trigger.fingerprint,
          trigger.kind,
          trigger.severity,
          'OPEN',
          trigger.title,
          trigger.entityType ?? null,
          trigger.entityId ?? null,
          trigger.runId ?? null,
          trigger.dutySessionId ?? null,
          trigger.positionId ?? null,
          trigger.employeeId ?? null,
          context.seq,
          context.seq,
          1,
          context.timestamp,
          context.timestamp,
          encode(trigger.detail),
          context.timestamp,
        );
      this.#link(id, context.seq, 'TRIGGER', context.timestamp);
      return;
    }
    const lifecycle = existing.lifecycle === 'RESOLVED' ? 'OPEN' : String(existing.lifecycle);
    this.#domain.db
      .prepare(
        `UPDATE v2_incidents SET lifecycle=?,severity=?,title=?,entity_type=?,entity_id=?,run_id=?,
           duty_session_id=?,position_id=?,employee_id=?,last_event_seq=?,occurrence_count=occurrence_count+1,
           last_seen_at=?,resolved_at=CASE WHEN ?='OPEN' THEN NULL ELSE resolved_at END,
           resolution_note=CASE WHEN ?='OPEN' THEN NULL ELSE resolution_note END,detail_json=?,updated_at=?
         WHERE id=?`,
      )
      .run(
        lifecycle,
        trigger.severity,
        trigger.title,
        trigger.entityType ?? (existing.entity_type == null ? null : String(existing.entity_type)),
        trigger.entityId ?? (existing.entity_id == null ? null : String(existing.entity_id)),
        trigger.runId ?? (existing.run_id == null ? null : String(existing.run_id)),
        trigger.dutySessionId ??
          (existing.duty_session_id == null ? null : String(existing.duty_session_id)),
        trigger.positionId ?? (existing.position_id == null ? null : String(existing.position_id)),
        trigger.employeeId ?? (existing.employee_id == null ? null : String(existing.employee_id)),
        context.seq,
        context.timestamp,
        lifecycle,
        lifecycle,
        encode(trigger.detail),
        context.timestamp,
        id,
      );
    this.#link(id, context.seq, 'UPDATE', context.timestamp);
  }

  #recover(fingerprint: string, context: EventContext): void {
    const existing = row(
      this.#domain.db.prepare('SELECT * FROM v2_incidents WHERE fingerprint=?').get(fingerprint),
    );
    if (!existing || existing.lifecycle === 'RESOLVED') return;
    this.#domain.db
      .prepare(
        `UPDATE v2_incidents SET lifecycle='RESOLVED',last_event_seq=?,last_seen_at=?,resolved_at=?,
           resolution_note='AUTO_RECOVERED',updated_at=? WHERE id=?`,
      )
      .run(
        context.seq,
        context.timestamp,
        context.timestamp,
        context.timestamp,
        String(existing.id),
      );
    this.#link(String(existing.id), context.seq, 'RECOVERY', context.timestamp);
  }

  #recoverRunIncidents(context: EventContext): void {
    if (!context.runId) return;
    const active = rows(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_incidents
           WHERE run_id=? AND lifecycle IN ('OPEN','ACKNOWLEDGED')
             AND kind IN ('DISPATCH_FAILURE','INVOCATION_FAILURE','RUNTIME_DISAPPEARED')`,
        )
        .all(context.runId),
    );
    for (const incident of active) {
      this.#domain.db
        .prepare(
          `UPDATE v2_incidents SET lifecycle='RESOLVED',last_event_seq=?,last_seen_at=?,resolved_at=?,
             resolution_note='AUTO_RUN_TERMINAL',updated_at=? WHERE id=?`,
        )
        .run(
          context.seq,
          context.timestamp,
          context.timestamp,
          context.timestamp,
          String(incident.id),
        );
      this.#link(String(incident.id), context.seq, 'RECOVERY', context.timestamp);
    }
  }

  #applyOperatorEvent(context: EventContext): boolean {
    if (!['incident.acknowledged', 'incident.resolved'].includes(context.type)) return false;
    const fingerprint = context.payload.fingerprint ? String(context.payload.fingerprint) : '';
    if (!fingerprint) return true;
    const existing = row(
      this.#domain.db.prepare('SELECT * FROM v2_incidents WHERE fingerprint=?').get(fingerprint),
    );
    if (!existing) return true;
    if (context.type === 'incident.acknowledged') {
      this.#domain.db
        .prepare(
          `UPDATE v2_incidents SET lifecycle=CASE WHEN lifecycle='RESOLVED' THEN lifecycle ELSE 'ACKNOWLEDGED' END,
             acknowledged_at=CASE WHEN lifecycle='RESOLVED' THEN acknowledged_at ELSE ? END,
             last_event_seq=?,updated_at=? WHERE id=?`,
        )
        .run(context.timestamp, context.seq, context.timestamp, String(existing.id));
      this.#link(String(existing.id), context.seq, 'ACKNOWLEDGE', context.timestamp);
    } else {
      this.#domain.db
        .prepare(
          `UPDATE v2_incidents SET lifecycle='RESOLVED',resolved_at=?,resolution_note=?,last_event_seq=?,updated_at=?
           WHERE id=?`,
        )
        .run(
          context.timestamp,
          context.payload.note ? String(context.payload.note) : 'OPERATOR_RESOLVED',
          context.seq,
          context.timestamp,
          String(existing.id),
        );
      this.#link(String(existing.id), context.seq, 'RESOLVE', context.timestamp);
    }
    return true;
  }

  #apply(event: V2Event): void {
    const context = this.#context(event);
    if (this.#applyOperatorEvent(context)) return;
    const trigger = this.#triggerFor(context);
    if (trigger) this.#openOrUpdate(trigger, context);
    const recovery = this.#recoveryFingerprint(context);
    if (recovery) this.#recover(recovery, context);
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(context.type)) {
      this.#recoverRunIncidents(context);
    }
  }

  projectIncremental(batchSize = 500): V2Row {
    const size = Math.min(2_000, Math.max(1, batchSize));
    const checkpoint = row(
      this.#domain.db
        .prepare('SELECT * FROM v2_projection_checkpoints WHERE projection_name=?')
        .get(IncidentProjectionService.projectionName),
    );
    let lastSeq = Number(checkpoint?.last_event_seq ?? 0);
    let processed = 0;
    let batches = 0;
    while (true) {
      const events = this.#domain.eventsAfter(lastSeq, size) as V2Event[];
      if (events.length === 0) break;
      this.#domain.transaction(() => {
        for (const event of events) {
          this.#apply(event);
          lastSeq = Math.max(lastSeq, Number((event as unknown as Record<string, unknown>).seq));
          processed += 1;
        }
        const timestamp = now();
        this.#domain.db
          .prepare(
            `INSERT INTO v2_projection_checkpoints(
               projection_name,projection_version,last_event_seq,updated_at,state_json)
             VALUES(?,?,?,?,?)
             ON CONFLICT(projection_name) DO UPDATE SET
               projection_version=excluded.projection_version,
               last_event_seq=excluded.last_event_seq,
               updated_at=excluded.updated_at`,
          )
          .run(
            IncidentProjectionService.projectionName,
            IncidentProjectionService.projectionVersion,
            lastSeq,
            timestamp,
            '{}',
          );
      });
      batches += 1;
      if (events.length < size) break;
    }
    return {
      projectionName: IncidentProjectionService.projectionName,
      lastEventSeq: lastSeq,
      processed,
      batches,
    };
  }

  rebuild(): V2Row {
    this.#domain.transaction(() => {
      this.#domain.db.prepare('DELETE FROM v2_incident_event_links').run();
      this.#domain.db.prepare('DELETE FROM v2_incidents').run();
      this.#domain.db
        .prepare('DELETE FROM v2_projection_checkpoints WHERE projection_name=?')
        .run(IncidentProjectionService.projectionName);
    });
    const result = this.projectIncremental();
    this.#domain.db
      .prepare(
        'UPDATE v2_projection_checkpoints SET rebuilt_at=?,updated_at=? WHERE projection_name=?',
      )
      .run(now(), now(), IncidentProjectionService.projectionName);
    return { ...result, rebuilt: true };
  }

  acknowledge(incidentIdValue: string, note?: string): V2Row {
    const incident = row(
      this.#domain.db.prepare('SELECT * FROM v2_incidents WHERE id=?').get(incidentIdValue),
    );
    if (!incident) throw new Error('INCIDENT_NOT_FOUND');
    this.#domain.transaction(() => {
      this.#domain.emit({
        type: 'incident.acknowledged',
        entityType: 'Incident',
        entityId: incidentIdValue,
        runId: incident.run_id ? String(incident.run_id) : undefined,
        dutySessionId: incident.duty_session_id ? String(incident.duty_session_id) : undefined,
        payload: {
          fingerprint: incident.fingerprint,
          employeeId: incident.employee_id ? String(incident.employee_id) : null,
          note: note ?? null,
        },
      });
    });
    this.projectIncremental();
    return this.getIncident(incidentIdValue)!;
  }

  resolve(incidentIdValue: string, note?: string): V2Row {
    const incident = row(
      this.#domain.db.prepare('SELECT * FROM v2_incidents WHERE id=?').get(incidentIdValue),
    );
    if (!incident) throw new Error('INCIDENT_NOT_FOUND');
    this.#domain.transaction(() => {
      this.#domain.emit({
        type: 'incident.resolved',
        entityType: 'Incident',
        entityId: incidentIdValue,
        runId: incident.run_id ? String(incident.run_id) : undefined,
        dutySessionId: incident.duty_session_id ? String(incident.duty_session_id) : undefined,
        payload: {
          fingerprint: incident.fingerprint,
          employeeId: incident.employee_id ? String(incident.employee_id) : null,
          note: note ?? null,
        },
      });
    });
    this.projectIncremental();
    return this.getIncident(incidentIdValue)!;
  }

  getIncident(incidentIdValue: string): V2Row | null {
    return (
      this.listIncidents({ limit: 10_000 }).find((item) => item.id === incidentIdValue) ?? null
    );
  }

  listIncidents(
    filters: { lifecycle?: string; runId?: string; positionId?: string; limit?: number } = {},
  ): V2Row[] {
    const limit = Math.min(5_000, Math.max(1, filters.limit ?? 200));
    return rows(
      this.#domain.db
        .prepare(
          `SELECT i.*,
                  (SELECT COUNT(*) FROM v2_incident_event_links l WHERE l.incident_id=i.id) linked_event_count
           FROM v2_incidents i
           WHERE (? IS NULL OR i.lifecycle=?)
             AND (? IS NULL OR i.run_id=?)
             AND (? IS NULL OR i.position_id=?)
           ORDER BY CASE i.lifecycle WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END,
                    CASE i.severity WHEN 'CRITICAL' THEN 0 WHEN 'ERROR' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END,
                    i.last_seen_at DESC
           LIMIT ?`,
        )
        .all(
          filters.lifecycle ?? null,
          filters.lifecycle ?? null,
          filters.runId ?? null,
          filters.runId ?? null,
          filters.positionId ?? null,
          filters.positionId ?? null,
          limit,
        ),
    ).map((value) => ({
      id: value.id,
      fingerprint: value.fingerprint,
      kind: value.kind,
      severity: value.severity,
      lifecycle: value.lifecycle,
      title: value.title,
      entityType: value.entity_type,
      entityId: value.entity_id,
      runId: value.run_id,
      dutySessionId: value.duty_session_id,
      positionId: value.position_id,
      employeeId: value.employee_id,
      firstEventSeq: Number(value.first_event_seq),
      lastEventSeq: Number(value.last_event_seq),
      occurrenceCount: Number(value.occurrence_count),
      firstSeenAt: Number(value.first_seen_at),
      lastSeenAt: Number(value.last_seen_at),
      acknowledgedAt: value.acknowledged_at,
      resolvedAt: value.resolved_at,
      resolutionNote: value.resolution_note,
      detail: decode<JsonRecord>(value.detail_json, {}),
      linkedEventCount: Number(value.linked_event_count ?? 0),
    }));
  }

  checkpoint(): V2Row | null {
    const value = row(
      this.#domain.db
        .prepare('SELECT * FROM v2_projection_checkpoints WHERE projection_name=?')
        .get(IncidentProjectionService.projectionName),
    );
    if (!value) return null;
    return {
      projectionName: value.projection_name,
      projectionVersion: Number(value.projection_version),
      lastEventSeq: Number(value.last_event_seq),
      rebuiltAt: value.rebuilt_at,
      updatedAt: value.updated_at,
      state: decode<JsonRecord>(value.state_json, {}),
    };
  }
}
