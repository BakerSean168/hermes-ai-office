import { newId } from './ids.js';
import type { V2Repository, V2Row } from './repository.js';

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

export interface MaintenanceOptions {
  dryRun?: boolean;
  at?: number;
  staleSyncAfterMs?: number;
}

export class MaintenanceService {
  readonly #domain: V2Repository;

  constructor(domain: V2Repository) {
    this.#domain = domain;
  }

  retentionPolicy(): V2Row {
    return {
      version: 1,
      principle:
        'Core business evidence is retained until an explicit future archival policy says otherwise.',
      keepForever: [
        'Supplier',
        'SupplierModel',
        'Employee',
        'Plan',
        'SupplyAgreement',
        'Employment',
        'Appointment',
        'Run',
        'DutySession',
        'StaffingSegment',
        'ModelInvocation',
        'InvocationAttempt',
        'UsageEntry',
        'Evaluation',
        'CapabilityClaim',
        'QualificationAssessment',
        'V2Event',
      ],
      rebuildableProjections: ['Incident', 'ProjectionCheckpoint', 'OfficeProjection'],
      ephemeral: [
        {
          artifact: 'IdempotencyKey',
          policy: 'DELETE_AFTER_EXPIRES_AT',
          rationale: 'Request replay cache, not business evidence.',
        },
      ],
      repairableOperationalRecords: [
        {
          artifact: 'ExecutionSyncRun',
          policy: 'MARK_STALE_RUNNING_AS_FAILED',
          rationale: 'A process crash must not leave a sync run permanently RUNNING.',
        },
      ],
    };
  }

  run(options: MaintenanceOptions = {}): V2Row {
    const timestamp = options.at ?? now();
    const staleSyncAfterMs = Math.max(60_000, options.staleSyncAfterMs ?? 15 * 60_000);
    const staleBefore = timestamp - staleSyncAfterMs;
    const dryRun = options.dryRun === true;
    const id = newId('maint', timestamp);
    this.#domain.db
      .prepare(
        `INSERT INTO v2_maintenance_runs(id,started_at,status,dry_run,created_at)
         VALUES(?,?,'RUNNING',?,?)`,
      )
      .run(id, timestamp, dryRun ? 1 : 0, timestamp);
    try {
      const expiredIdempotency = Number(
        row(
          this.#domain.db
            .prepare('SELECT COUNT(*) count FROM v2_idempotency_keys WHERE expires_at<=?')
            .get(timestamp),
        )?.count ?? 0,
      );
      const staleSyncRuns = Number(
        row(
          this.#domain.db
            .prepare(
              `SELECT COUNT(*) count FROM v2_execution_sync_runs
               WHERE status='RUNNING' AND started_at<=?`,
            )
            .get(staleBefore),
        )?.count ?? 0,
      );
      const changes: JsonRecord = {
        expiredIdempotencyKeys: expiredIdempotency,
        staleExecutionSyncRuns: staleSyncRuns,
      };
      if (!dryRun) {
        this.#domain.transaction(() => {
          if (expiredIdempotency > 0) {
            this.#domain.db
              .prepare('DELETE FROM v2_idempotency_keys WHERE expires_at<=?')
              .run(timestamp);
          }
          if (staleSyncRuns > 0) {
            this.#domain.db
              .prepare(
                `UPDATE v2_execution_sync_runs
                 SET status='FAILED',completed_at=?,error_code=COALESCE(error_code,'STALE_SYNC_RUN')
                 WHERE status='RUNNING' AND started_at<=?`,
              )
              .run(timestamp, staleBefore);
          }
          this.#domain.emit({
            type: 'maintenance.completed',
            entityType: 'MaintenanceRun',
            entityId: id,
            payload: { ...changes, dryRun: false },
          });
        });
      }
      this.#domain.db
        .prepare(
          `UPDATE v2_maintenance_runs SET completed_at=?,status='COMPLETED',
             expired_idempotency_keys=?,stale_execution_sync_runs=?,changes_json=? WHERE id=?`,
        )
        .run(timestamp, expiredIdempotency, staleSyncRuns, encode(changes), id);
      return this.getRun(id)!;
    } catch (error) {
      const code = error instanceof Error ? error.message : 'MAINTENANCE_FAILED';
      this.#domain.db
        .prepare(
          `UPDATE v2_maintenance_runs SET completed_at=?,status='FAILED',error_code=? WHERE id=?`,
        )
        .run(now(), code, id);
      throw error;
    }
  }

  getRun(id: string): V2Row | null {
    const value = row(
      this.#domain.db.prepare('SELECT * FROM v2_maintenance_runs WHERE id=?').get(id),
    );
    if (!value) return null;
    return {
      id: value.id,
      startedAt: value.started_at,
      completedAt: value.completed_at,
      status: value.status,
      dryRun: Number(value.dry_run) === 1,
      expiredIdempotencyKeys: Number(value.expired_idempotency_keys ?? 0),
      staleExecutionSyncRuns: Number(value.stale_execution_sync_runs ?? 0),
      changes: decode<JsonRecord>(value.changes_json, {}),
      errorCode: value.error_code,
    };
  }

  listRuns(limit = 100): V2Row[] {
    return rows(
      this.#domain.db
        .prepare('SELECT * FROM v2_maintenance_runs ORDER BY started_at DESC LIMIT ?')
        .all(Math.min(1_000, Math.max(1, limit))),
    ).map((value) => ({
      id: value.id,
      startedAt: value.started_at,
      completedAt: value.completed_at,
      status: value.status,
      dryRun: Number(value.dry_run) === 1,
      expiredIdempotencyKeys: Number(value.expired_idempotency_keys ?? 0),
      staleExecutionSyncRuns: Number(value.stale_execution_sync_runs ?? 0),
      changes: decode<JsonRecord>(value.changes_json, {}),
      errorCode: value.error_code,
    }));
  }
}
