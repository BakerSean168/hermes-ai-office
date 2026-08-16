import { useEffect, useMemo, useState } from 'react';

type Appointment = {
  id: string;
  employeeId?: string;
  employeeName?: string;
  status?: string;
  appointmentClass?: string;
  class?: string;
};

type Duty = {
  id: string;
  currentActivity?: string;
  currentStaffing?: { employeeId?: string; employeeName?: string } | null;
};

type RuntimeSession = {
  id: string;
  runtimeKind?: string;
  state?: string;
  modelHint?: string | null;
};

type Position = {
  id: string;
  name: string;
  slug: string;
  kind?: string;
  lifecycle?: string;
  lifecyclePolicy?: string;
  runtimeKind?: string | null;
  status?: string;
  workScope?: { id?: string; slug?: string; name?: string } | null;
  role?: { id?: string; slug?: string; name?: string } | null;
  template?: { id?: string; slug?: string; name?: string } | null;
  currentAppointments?: Appointment[];
  currentDuties?: Duty[];
  runtimeSessions?: RuntimeSession[];
};

type OfficeProjection = {
  projectionVersion: number;
  generatedAt: number;
  summary: {
    workScopes?: number;
    positions?: number;
    activePositions?: number;
    standingPositions?: number;
    runScopedPositions?: number;
    staffedPositions?: number;
    runtimeActiveUnattributedPositions?: number;
    unfilledPositions?: number;
    activeRuns?: number;
    activeDuties?: number;
    activeRuntimeSessions?: number;
    employees?: number;
    employed?: number;
  };
  positions: Position[];
};

type WorkScopeGroup = {
  id: string;
  name: string;
  slug: string;
  positions: Position[];
};

function statusLabel(status?: string): string {
  if (status === 'RUNTIME_ACTIVE_UNATTRIBUTED') return 'runtime active · employee unknown';
  if (status === 'WORKING') return 'working';
  if (status === 'STAFFED') return 'staffed';
  if (status === 'SCHEDULED') return 'scheduled';
  if (status === 'UNFILLED') return 'unfilled';
  if (status === 'RETIRED') return 'retired';
  return status?.toLowerCase() || 'unknown';
}

function rank(position: Position): number {
  if (position.status === 'WORKING') return 0;
  if (position.status === 'RUNTIME_ACTIVE_UNATTRIBUTED') return 1;
  if (position.status === 'STAFFED') return 2;
  if (position.status === 'SCHEDULED') return 3;
  if (position.status === 'UNFILLED') return 4;
  return 5;
}

function PositionCard({ position }: { position: Position }) {
  const staffing = position.currentDuties?.find((duty) => duty.currentStaffing)?.currentStaffing;
  const appointment = position.currentAppointments?.find(
    (item) => item.status === 'CURRENT' || !item.status,
  );
  const runtime = position.runtimeSessions?.[0];
  return (
    <article className="border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{position.name}</div>
          <div className="mt-1 text-xs text-text-muted">
            {position.role?.name ?? position.kind ?? 'Position'} ·{' '}
            {position.lifecyclePolicy?.toLowerCase() ??
              position.lifecycle?.toLowerCase() ??
              'active'}
          </div>
        </div>
        <span className="text-xs text-text-muted">{statusLabel(position.status)}</span>
      </div>

      {staffing ? (
        <div className="mt-3 text-xs">
          On duty: <strong>{staffing.employeeName ?? staffing.employeeId ?? 'Employee'}</strong>
        </div>
      ) : appointment ? (
        <div className="mt-3 text-xs">
          Appointed:{' '}
          <strong>{appointment.employeeName ?? appointment.employeeId ?? 'Employee'}</strong>
          <span className="text-text-muted">
            {' '}
            · {appointment.class ?? appointment.appointmentClass}
          </span>
        </div>
      ) : (
        <div className="mt-3 text-xs text-text-muted">No current appointment.</div>
      )}

      {runtime ? (
        <div className="mt-2 border-l-2 border-border pl-3 text-xs text-text-muted">
          Runtime {runtime.runtimeKind ?? position.runtimeKind ?? 'unknown'} ·{' '}
          {runtime.state ?? 'unknown'}
          {runtime.modelHint ? ` · model hint ${runtime.modelHint}` : ''}
        </div>
      ) : null}
      {position.status === 'RUNTIME_ACTIVE_UNATTRIBUTED' ? (
        <div className="mt-2 text-xs text-warning">
          Runtime evidence exists, but no Employee attribution is asserted.
        </div>
      ) : null}
    </article>
  );
}

export function OfficePositionPanel() {
  const [projection, setProjection] = useState<OfficeProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch('/api/model/v2/projections/office');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = (await response.json()) as OfficeProjection;
        if (!cancelled) {
          setProjection(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) timer = setTimeout(load, 5_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const groups = useMemo<WorkScopeGroup[]>(() => {
    const byScope = new Map<string, WorkScopeGroup>();
    for (const position of projection?.positions ?? []) {
      const id = position.workScope?.id ?? 'global';
      const group = byScope.get(id) ?? {
        id,
        name: position.workScope?.name ?? 'Global',
        slug: position.workScope?.slug ?? 'global',
        positions: [],
      };
      group.positions.push(position);
      byScope.set(id, group);
    }
    return [...byScope.values()]
      .map((group) => ({
        ...group,
        positions: [...group.positions].sort(
          (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
        ),
      }))
      .sort((a, b) => {
        const aRank = Math.min(...a.positions.map(rank));
        const bRank = Math.min(...b.positions.map(rank));
        return aRank - bRank || a.name.localeCompare(b.name);
      });
  }, [projection]);

  if (!projection && !error) {
    return (
      <section className="pixel-panel p-5 text-sm text-text-muted">Loading organization…</section>
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Organization positions">
      <div className="pixel-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-lg">Organization</div>
            <div className="mt-1 text-xs text-text-muted">
              WorkScopes contain durable Positions. Runtime sessions and Employee assignments are
              shown as evidence on each seat.
            </div>
          </div>
          {projection ? (
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs text-text-muted sm:grid-cols-4">
              <span>{projection.summary.workScopes ?? 0} workspaces</span>
              <span>{projection.summary.activePositions ?? 0} active positions</span>
              <span>{projection.summary.staffedPositions ?? 0} staffed</span>
              <span>{projection.summary.unfilledPositions ?? 0} unfilled</span>
            </div>
          ) : null}
        </div>
        {error ? (
          <div className="mt-3 text-xs text-warning">Position projection unavailable: {error}</div>
        ) : null}
      </div>

      {groups.map((group) => {
        const staffed = group.positions.filter((position) =>
          ['WORKING', 'STAFFED'].includes(position.status ?? ''),
        ).length;
        const unattributed = group.positions.filter(
          (position) => position.status === 'RUNTIME_ACTIVE_UNATTRIBUTED',
        ).length;
        return (
          <section className="pixel-panel p-5" key={group.id}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
              <div>
                <div className="text-base font-semibold">{group.name}</div>
                <div className="text-xs text-text-muted">WorkScope · {group.slug}</div>
              </div>
              <div className="text-xs text-text-muted">
                {group.positions.length} position{group.positions.length === 1 ? '' : 's'} ·{' '}
                {staffed} staffed
                {unattributed > 0 ? ` · ${unattributed} runtime unattributed` : ''}
              </div>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {group.positions.map((position) => (
                <PositionCard key={position.id} position={position} />
              ))}
            </div>
          </section>
        );
      })}

      {projection && groups.length === 0 ? (
        <div className="pixel-panel p-5 text-sm text-text-muted">
          No organizational positions yet.
        </div>
      ) : null}
    </section>
  );
}
