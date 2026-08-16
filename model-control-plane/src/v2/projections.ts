import type { HermesExecutionSyncService } from './execution.js';
import type { FinanceRepository } from './finance.js';
import type { OrganizationRepository } from './organization.js';
import type { V2Repository, V2Row } from './repository.js';
import type { StaffingRepository } from './staffing.js';

type JsonRecord = Record<string, unknown>;

function row(value: unknown): V2Row | null {
  return value && typeof value === 'object' ? (value as V2Row) : null;
}
function rows(value: unknown): V2Row[] {
  return Array.isArray(value) ? (value as V2Row[]) : [];
}
function decode<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class OfficeProjectionService {
  readonly #domain: V2Repository;
  readonly #organization: OrganizationRepository;
  readonly #execution: HermesExecutionSyncService;
  readonly #staffing: StaffingRepository;
  readonly #finance: FinanceRepository;

  constructor(input: {
    domain: V2Repository;
    organization: OrganizationRepository;
    execution: HermesExecutionSyncService;
    staffing: StaffingRepository;
    finance: FinanceRepository;
  }) {
    this.#domain = input.domain;
    this.#organization = input.organization;
    this.#execution = input.execution;
    this.#staffing = input.staffing;
    this.#finance = input.finance;
  }

  office(): V2Row {
    const topology = this.#organization.topology();
    const workforce = this.#domain.workforceProjection();
    const activeRuns = this.#domain
      .listRuns(500)
      .filter((run) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(run.status)));
    const activeDuties = this.#domain.listDuties({ activeOnly: true });
    const activeRuntimes = this.#execution.listRuntimeSessions({ activeOnly: true, limit: 2_000 });
    const appointments = this.#domain
      .listAppointments()
      .filter((appointment) =>
        ['SCHEDULED', 'CURRENT', 'SUSPENDED'].includes(String(appointment.status)),
      );
    const appointmentsByPosition = new Map<string, V2Row[]>();
    for (const appointment of appointments) {
      const key = String(appointment.positionId);
      const list = appointmentsByPosition.get(key) ?? [];
      list.push(appointment);
      appointmentsByPosition.set(key, list);
    }
    const dutiesByPosition = new Map<string, V2Row[]>();
    for (const duty of activeDuties) {
      const key = String(duty.positionId);
      const list = dutiesByPosition.get(key) ?? [];
      list.push(duty);
      dutiesByPosition.set(key, list);
    }
    const runtimesByPosition = new Map<string, V2Row[]>();
    for (const runtime of activeRuntimes) {
      const key = String(runtime.positionId);
      const list = runtimesByPosition.get(key) ?? [];
      list.push(runtime);
      runtimesByPosition.set(key, list);
    }
    const positions = (topology.positions as V2Row[]).map((position) => {
      const positionId = String(position.id);
      const currentAppointments = appointmentsByPosition.get(positionId) ?? [];
      const currentDuties = dutiesByPosition.get(positionId) ?? [];
      const runtimeSessions = runtimesByPosition.get(positionId) ?? [];
      const lifecycle = String(position.lifecycle);
      const hasCurrentStaffing = currentDuties.some((duty) => Boolean(duty.currentStaffing));
      const status =
        lifecycle === 'RETIRED' || lifecycle === 'ARCHIVED'
          ? 'RETIRED'
          : hasCurrentStaffing
            ? 'WORKING'
            : runtimeSessions.length > 0 || currentDuties.length > 0
              ? 'RUNTIME_ACTIVE_UNATTRIBUTED'
              : currentAppointments.some((item) => item.status === 'CURRENT')
                ? 'STAFFED'
                : currentAppointments.length > 0
                  ? 'SCHEDULED'
                  : 'UNFILLED';
      return {
        ...position,
        lifecyclePolicy: position.lifecyclePolicy,
        status,
        currentAppointments,
        currentDuties,
        runtimeSessions,
      };
    });
    const activePositions = positions.filter((position) => position.status !== 'RETIRED');
    const summary = {
      workScopes: Number(
        row(this.#domain.db.prepare('SELECT COUNT(*) count FROM v2_work_scopes').get())?.count ?? 0,
      ),
      positions: positions.length,
      activePositions: activePositions.length,
      standingPositions: activePositions.filter(
        (position) => position.lifecyclePolicy === 'STANDING',
      ).length,
      runScopedPositions: activePositions.filter(
        (position) => position.lifecyclePolicy === 'RUN_SCOPED',
      ).length,
      staffedPositions: activePositions.filter((position) =>
        ['STAFFED', 'WORKING'].includes(String(position.status)),
      ).length,
      unfilledPositions: activePositions.filter((position) => position.status === 'UNFILLED')
        .length,
      runtimeActiveUnattributedPositions: activePositions.filter(
        (position) => position.status === 'RUNTIME_ACTIVE_UNATTRIBUTED',
      ).length,
      activeRuns: activeRuns.length,
      activeDuties: activeDuties.length,
      activeRuntimeSessions: activeRuntimes.length,
      employees: Number((workforce.summary as V2Row).employees ?? 0),
      employed: Number((workforce.summary as V2Row).employed ?? 0),
    };
    return {
      projectionVersion: 2,
      generatedAt: Date.now(),
      summary,
      positions,
      relations: topology.relations,
      activeRuns,
      activeDuties,
      activeRuntimeSessions: activeRuntimes,
      workforce,
    };
  }

  positionDossier(positionId: string): V2Row | null {
    const position = this.#domain.listPositions().find((item) => item.id === positionId);
    if (!position) return null;
    const relations = this.#organization.listPositionRelations();
    const appointments = this.#domain.listAppointments({ positionId });
    const duties = this.#domain.listDuties().filter((duty) => duty.positionId === positionId);
    const runtimeSessions = this.#execution
      .listRuntimeSessions({ limit: 2_000 })
      .filter((runtime) => runtime.positionId === positionId);
    const qualifications = this.#staffing.listQualificationAssessments({ positionId, limit: 500 });
    const evaluations = this.#finance.listEvaluations({ positionId, limit: 500 });
    const usageByEmployee = rows(
      this.#domain.db
        .prepare(
          `SELECT u.employee_id,e.display_name employee_name,COUNT(*) requests,
                  COALESCE(SUM(u.input_tokens),0) input_tokens,
                  COALESCE(SUM(u.output_tokens),0) output_tokens,
                  COALESCE(SUM(u.actual_cost),0) actual_cost,
                  COALESCE(SUM(v.amount),0) market_value,
                  COALESCE(SUM(a.amount),0) allocated_cost
           FROM v2_usage_entries u
           JOIN v2_employees e ON e.id=u.employee_id
           LEFT JOIN v2_usage_market_valuations v
             ON v.usage_entry_id=u.id AND v.superseded_at IS NULL
           LEFT JOIN (
             SELECT ce.usage_entry_id,ce.amount
             FROM v2_cost_allocation_entries ce
             JOIN v2_cost_allocation_runs cr ON cr.id=ce.allocation_run_id
             WHERE cr.status='COMPLETED' AND cr.superseded_at IS NULL
           ) a ON a.usage_entry_id=u.id
           WHERE u.position_id=?
           GROUP BY u.employee_id,e.display_name
           ORDER BY requests DESC,e.display_name`,
        )
        .all(positionId),
    ).map((value) => ({
      employeeId: value.employee_id,
      employeeName: value.employee_name,
      requests: Number(value.requests ?? 0),
      inputTokens: Number(value.input_tokens ?? 0),
      outputTokens: Number(value.output_tokens ?? 0),
      actualCost: Number(value.actual_cost ?? 0),
      marketValue: Number(value.market_value ?? 0),
      allocatedCost: Number(value.allocated_cost ?? 0),
    }));
    return {
      position,
      relations: {
        outgoing: relations.filter((relation) => relation.fromPositionId === positionId),
        incoming: relations.filter((relation) => relation.toPositionId === positionId),
      },
      appointments,
      duties,
      runtimeSessions,
      qualifications,
      evaluations,
      usageByEmployee,
    };
  }

  runDossier(runId: string): V2Row | null {
    const run = this.#domain.listRuns(1_000).find((item) => item.id === runId);
    if (!run) return null;
    const duties = this.#domain.listDuties({ runId });
    const runtimeSessions = this.#execution.listRuntimeSessions({ runId, limit: 2_000 });
    const runtimeEdges = this.#execution.listRuntimeEdges(runId, 5_000);
    const activities = this.#execution.listActivityEvents(runId, 2_000);
    const usage = this.#domain.listUsage({ runId });
    const positionIds = new Set(duties.map((duty) => String(duty.positionId)));
    const positions = this.#domain
      .listPositions()
      .filter((position) => positionIds.has(String(position.id)));
    const staffing = rows(
      this.#domain.db
        .prepare(
          `SELECT ss.*,e.display_name employee_name,p.name position_name
           FROM v2_staffing_segments ss
           JOIN v2_employees e ON e.id=ss.employee_id
           JOIN v2_duty_sessions d ON d.id=ss.duty_session_id
           JOIN v2_positions p ON p.id=d.position_id
           WHERE d.run_id=? ORDER BY ss.started_at`,
        )
        .all(runId),
    ).map((value) => ({
      id: value.id,
      dutySessionId: value.duty_session_id,
      employeeId: value.employee_id,
      employeeName: value.employee_name,
      positionName: value.position_name,
      startedAt: value.started_at,
      endedAt: value.ended_at,
      endedReason: value.ended_reason,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
    return {
      run,
      positions,
      duties,
      staffing,
      runtimeSessions,
      runtimeEdges,
      activities,
      usage,
    };
  }
}
