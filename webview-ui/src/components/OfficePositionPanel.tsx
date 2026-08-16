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
  currentStaffing?: {
    employeeId?: string;
    employeeName?: string;
  } | null;
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

const panelStyle = {
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: 8,
  marginBottom: 10,
} as const;

const cardStyle = {
  border: '1px solid var(--color-border)',
  borderRadius: 3,
  padding: 7,
  marginTop: 6,
} as const;

function statusLabel(status?: string): string {
  if (status === 'RUNTIME_ACTIVE_UNATTRIBUTED') return 'runtime active · employee unknown';
  if (status === 'WORKING') return 'working';
  if (status === 'STAFFED') return 'staffed';
  if (status === 'SCHEDULED') return 'scheduled';
  if (status === 'UNFILLED') return 'unfilled';
  if (status === 'RETIRED') return 'retired';
  return status?.toLowerCase() || 'unknown';
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

  const positions = useMemo(() => {
    const values = projection?.positions ?? [];
    const rank = (position: Position) => {
      if (position.status === 'WORKING') return 0;
      if (position.status === 'RUNTIME_ACTIVE_UNATTRIBUTED') return 1;
      if (position.status === 'STAFFED') return 2;
      if (position.status === 'SCHEDULED') return 3;
      if (position.status === 'UNFILLED') return 4;
      return 5;
    };
    return [...values].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [projection]);

  if (!projection && !error) {
    return <section style={panelStyle}>Loading organization positions…</section>;
  }

  return (
    <section style={panelStyle} aria-label="Organization positions">
      <div
        style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}
      >
        <strong>Positions</strong>
        <span style={{ opacity: 0.72, fontSize: 12 }}>V2 organization projection</span>
      </div>
      {error ? (
        <div style={{ marginTop: 6, opacity: 0.8 }}>Position projection unavailable: {error}</div>
      ) : null}
      {projection ? (
        <>
          <div style={{ marginTop: 4, opacity: 0.8, lineHeight: 1.45 }}>
            {projection.summary.activePositions ?? 0} active ·{' '}
            {projection.summary.staffedPositions ?? 0} staffed ·{' '}
            {projection.summary.runtimeActiveUnattributedPositions ?? 0} runtime active with
            employee unknown · {projection.summary.unfilledPositions ?? 0} unfilled
          </div>
          <div style={{ marginTop: 2, opacity: 0.68, lineHeight: 1.45 }}>
            {projection.summary.activeRuns ?? 0} active runs ·{' '}
            {projection.summary.activeDuties ?? 0} active duties ·{' '}
            {projection.summary.activeRuntimeSessions ?? 0} runtime sessions
          </div>
          {positions.length === 0 ? (
            <div style={{ marginTop: 8, opacity: 0.72 }}>No organizational positions yet.</div>
          ) : (
            positions.map((position) => {
              const staffing = position.currentDuties?.find(
                (duty) => duty.currentStaffing,
              )?.currentStaffing;
              const appointment = position.currentAppointments?.find(
                (item) => item.status === 'CURRENT' || !item.status,
              );
              const runtime = position.runtimeSessions?.[0];
              return (
                <article key={position.id} style={cardStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{position.name}</strong>
                    <span style={{ opacity: 0.78 }}>{statusLabel(position.status)}</span>
                  </div>
                  <div style={{ marginTop: 2, opacity: 0.78 }}>
                    {position.workScope?.name ?? position.workScope?.slug ?? 'Global'} ·{' '}
                    {position.role?.name ?? position.kind ?? 'Position'}
                    {position.lifecyclePolicy ? ` · ${position.lifecyclePolicy.toLowerCase()}` : ''}
                  </div>
                  {staffing ? (
                    <div style={{ marginTop: 4 }}>
                      On duty:{' '}
                      <strong>{staffing.employeeName ?? staffing.employeeId ?? 'Employee'}</strong>
                    </div>
                  ) : appointment ? (
                    <div style={{ marginTop: 4 }}>
                      Appointed:{' '}
                      <strong>
                        {appointment.employeeName ?? appointment.employeeId ?? 'Employee'}
                      </strong>
                    </div>
                  ) : null}
                  {runtime ? (
                    <div style={{ marginTop: 4, opacity: 0.78 }}>
                      Runtime: {runtime.runtimeKind ?? position.runtimeKind ?? 'unknown'} ·{' '}
                      {runtime.state ?? 'unknown'}
                      {runtime.modelHint ? ` · model hint ${runtime.modelHint}` : ''}
                    </div>
                  ) : null}
                  {position.status === 'RUNTIME_ACTIVE_UNATTRIBUTED' ? (
                    <div style={{ marginTop: 4, opacity: 0.78 }}>
                      Runtime evidence exists, but no Employee attribution is asserted.
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </>
      ) : null}
    </section>
  );
}
