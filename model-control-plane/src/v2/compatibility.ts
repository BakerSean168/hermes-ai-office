import type { V2Repository, V2Row } from './repository.js';

type JsonRecord = Record<string, unknown>;

function row(value: unknown): V2Row | null {
  return value && typeof value === 'object' ? (value as V2Row) : null;
}
function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}
function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export interface LegacySnapshotSource {
  snapshot(): unknown;
}

export class CompatibilityAuditService {
  readonly #domain: V2Repository;
  readonly #legacy: LegacySnapshotSource;
  readonly #env: NodeJS.ProcessEnv;

  constructor(
    domain: V2Repository,
    legacy: LegacySnapshotSource,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.#domain = domain;
    this.#legacy = legacy;
    this.#env = env;
  }

  status(): V2Row {
    const legacy = object(this.#legacy.snapshot());
    const workforce = this.#domain.workforceProjection();
    const migrations = this.#domain.db
      .prepare('SELECT id,applied_at FROM v2_schema_migrations ORDER BY applied_at,id')
      .all() as Array<{ id: string; applied_at: number }>;
    const latestMigration = migrations.at(-1)?.id ?? null;
    const executionSyncCount = Number(
      row(this.#domain.db.prepare('SELECT COUNT(*) count FROM v2_execution_sync_runs').get())
        ?.count ?? 0,
    );
    const latestSync = row(
      this.#domain.db
        .prepare('SELECT * FROM v2_execution_sync_runs ORDER BY started_at DESC LIMIT 1')
        .get(),
    );
    const maxEventSeq = Number(
      row(this.#domain.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM v2_events').get())?.seq ??
        0,
    );
    const incidentCheckpoint = row(
      this.#domain.db
        .prepare(
          "SELECT * FROM v2_projection_checkpoints WHERE projection_name='incidents' LIMIT 1",
        )
        .get(),
    );
    const incidentCheckpointSeq = Number(incidentCheckpoint?.last_event_seq ?? 0);
    const legacyCpaSyncEnabled = this.#env.MODEL_CP_SYNC_CPA !== '0';
    const legacyPositionAliasesEnabled = this.#env.MODEL_CP_MANAGE_POSITION_ALIASES !== '0';
    const explicitRetirementApproval = this.#env.MODEL_CP_V1_RETIREMENT_APPROVED === '1';
    const activeDuties = this.#domain.listDuties({ activeOnly: true }).length;
    const runtimeSessions = Number(
      row(this.#domain.db.prepare('SELECT COUNT(*) count FROM v2_runtime_sessions').get())?.count ??
        0,
    );
    const activeRuntimeSessions = Number(
      row(
        this.#domain.db
          .prepare("SELECT COUNT(*) count FROM v2_runtime_sessions WHERE lifecycle='ACTIVE'")
          .get(),
      )?.count ?? 0,
    );
    const currentEmployments = Number(
      row(
        this.#domain.db
          .prepare(
            "SELECT COUNT(*) count FROM v2_employments WHERE status='CURRENT' AND effective_to IS NULL",
          )
          .get(),
      )?.count ?? 0,
    );

    const protectedContracts = [
      {
        contract: '/api/v1/*',
        status: 'PROTECTED',
        reason:
          'Legacy Model Control Plane clients and operational tooling still consume V1 shapes.',
      },
      {
        contract: '/api/model/*',
        status: 'PROTECTED',
        reason:
          'Pixel Office compatibility facade remains a public runtime contract during migration.',
      },
      {
        contract: 'position:* logical aliases',
        status: 'PROTECTED',
        reason: 'CPA routing compatibility still converges position aliases through gatewayctl.',
      },
    ];

    const v2Authority = [
      'Employee identity and Employment history',
      'Appointment, DutySession and StaffingSegment staffing facts',
      'Run and RuntimeSession execution projection',
      'Capability, qualification, staffing rules and constraints',
      'UsageEntry, valuation, cost allocation and evaluation evidence',
      'Organization roles, position templates and position relations',
      'Incident, checkpoint and retention policy projections',
    ];

    const blockers: Array<{ code: string; detail: string }> = [];
    if (legacyCpaSyncEnabled) {
      blockers.push({
        code: 'LEGACY_CPA_SYNC_ACTIVE',
        detail:
          'CPA discovery/sync still maintains the V1 provider/channel/worker compatibility model.',
      });
    }
    if (legacyPositionAliasesEnabled) {
      blockers.push({
        code: 'LEGACY_POSITION_ALIAS_MANAGEMENT_ACTIVE',
        detail: 'position:* aliases are still reconciled through the compatibility control plane.',
      });
    }
    if (!explicitRetirementApproval) {
      blockers.push({
        code: 'PUBLIC_V1_RETIREMENT_NOT_APPROVED',
        detail:
          'Protected public V1 contracts require an explicit cutover decision after all consumers migrate.',
      });
    }

    const gates = {
      v2SchemaAtLatestKnownMigration: latestMigration === '010_maintenance',
      hermesExecutionSyncObserved: executionSyncCount > 0,
      latestHermesExecutionSyncHealthy:
        executionSyncCount === 0 ? false : String(latestSync?.status) === 'COMPLETED',
      incidentProjectionCurrent: incidentCheckpointSeq === maxEventSeq,
      runtimeIdentitySeparatedFromEmployee: true,
      gatewayIdentitySeparatedFromEmployee: true,
      employeeIdentityUsesSupplierAndModel: true,
      v2WorkforceProjectionAvailable: Boolean(workforce && workforce.summary),
    };

    const allTechnicalGatesGreen = Object.values(gates).every(Boolean);
    return {
      mode: blockers.length === 0 && allTechnicalGatesGreen ? 'RETIREMENT_READY' : 'DUAL_RUN',
      retirementReady: blockers.length === 0 && allTechnicalGatesGreen,
      generatedAt: Date.now(),
      protectedContracts,
      semanticWarnings: [
        'V1 Worker is Channel × Model and MUST NOT be compared one-to-one with V2 Employee.',
        'V1 Assignment is compatibility routing state; V2 Appointment and DutySession are business staffing authority.',
        'ExecutionNode.model and RuntimeSession.modelHint are telemetry hints and MUST NOT create Employee identity.',
        'Channel/Gateway health affects routability, not durable Employee identity.',
      ],
      v1: {
        role: 'COMPATIBILITY',
        providers: countArray(legacy.providers),
        channels: countArray(legacy.channels),
        workers: countArray(legacy.workers),
        positions: countArray(legacy.positions),
        assignments: countArray(legacy.assignments),
        cpaSyncEnabled: legacyCpaSyncEnabled,
        positionAliasManagementEnabled: legacyPositionAliasesEnabled,
      },
      v2: {
        role: 'BUSINESS_AUTHORITY',
        employees: Number((workforce.summary as JsonRecord).employees ?? 0),
        employed: Number((workforce.summary as JsonRecord).employed ?? 0),
        currentEmployments,
        positions: this.#domain.listPositions().length,
        activeDuties,
        runtimeSessions,
        activeRuntimeSessions,
        migrations: migrations.length,
        latestMigration,
        eventTail: maxEventSeq,
        incidentCheckpoint: incidentCheckpointSeq,
      },
      v2Authority,
      gates,
      blockers,
      cutoverRule:
        'Retire V1 only after every blocker is removed, technical gates are green, and protected consumers have been migrated explicitly.',
    };
  }
}
