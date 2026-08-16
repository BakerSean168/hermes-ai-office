import { useCallback, useEffect, useState } from 'react';

interface V2Appointment {
  id: string;
  positionId: string;
  positionName: string;
  positionSlug: string;
  positionKind?: string;
  workScopeName?: string;
  workScopeSlug?: string;
  class: string;
  priority: number;
}

interface V2CurrentWork {
  staffingSegmentId: string;
  dutySessionId: string;
  positionId: string;
  positionName: string;
  positionSlug: string;
  runId: string;
  runTitle?: string;
  activity: string;
  startedAt: number;
}

interface V2EmployeeUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  actualCost: number;
  allocatedCost: number;
  marketValue: number;
}

interface V2Employee {
  id: string;
  displayName: string;
  recordLifecycle: string;
  cooperationState: string;
  supplier: { id: string; slug: string; name: string };
  supplierModel: { id: string; key: string; name: string };
  currentEmploymentCount: number;
  currentAppointmentCount: number;
  currentDutyCount: number;
  firstSeenAt: number;
  currentAppointments: V2Appointment[];
  currentWork: V2CurrentWork[];
  career: {
    staffingSegments: number;
    usage: V2EmployeeUsage;
  };
}

interface V2WorkforceProjection {
  projectionVersion: number;
  generatedAt: number;
  employees: V2Employee[];
  summary: {
    employees: number;
    employed: number;
    dormant: number;
    currentDuties: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    actualCost: number;
    marketValue: number;
  };
}

const money = (value: number | undefined) => `$${Number(value ?? 0).toFixed(2)}`;
const compact = (value: number | undefined) =>
  Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    Number(value ?? 0),
  );

function elapsedLabel(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - Number(timestamp ?? 0));
  if (elapsed < 60_000) return '<1m';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

function EmployeeCard({ employee }: { employee: V2Employee }) {
  const usage = employee.career.usage;
  const working = employee.currentWork.length > 0;
  return (
    <div className="border-2 border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{employee.displayName}</div>
          <div className="text-xs text-text-muted">
            {employee.supplier.name} · {employee.supplierModel.name}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs">
          <div>
            {working
              ? '● working'
              : employee.cooperationState === 'EMPLOYED'
                ? '○ rostered'
                : '○ dormant'}
          </div>
          <div className="text-text-muted">
            {employee.currentEmploymentCount} employment route
            {employee.currentEmploymentCount === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="text-xs font-semibold">Current work</div>
        {employee.currentWork.length === 0 ? (
          <div className="mt-1 text-xs text-text-muted">
            No active duty. The employee remains available through current appointments.
          </div>
        ) : (
          <div className="mt-1 flex flex-col gap-2">
            {employee.currentWork.map((work) => (
              <div className="border-l-2 border-border pl-2 text-xs" key={work.staffingSegmentId}>
                <div className="font-semibold">
                  {work.positionName} · {work.activity}
                </div>
                <div className="text-text-muted">
                  {work.runTitle ?? work.runId} · active {elapsedLabel(work.startedAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3">
        <div className="text-xs font-semibold">Current appointments</div>
        {employee.currentAppointments.length === 0 ? (
          <div className="mt-1 text-xs text-text-muted">No current appointment.</div>
        ) : (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
            {employee.currentAppointments.map((appointment) => (
              <span key={appointment.id}>
                {appointment.workScopeName ? `${appointment.workScopeName} / ` : ''}
                {appointment.positionName} · {appointment.class}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-border pt-2 text-xs text-text-muted">
        {compact(employee.career.staffingSegments)} duties · {compact(usage.requests)} requests ·{' '}
        {compact(usage.inputTokens)} in · {compact(usage.outputTokens)} out ·{' '}
        {compact(usage.reasoningTokens)} reasoning
      </div>
      <div className="text-xs text-text-muted">
        {money(usage.actualCost)} actual · {money(usage.allocatedCost)} allocated ·{' '}
        {money(usage.marketValue)} market value
      </div>
    </div>
  );
}

export function ModelWorkforcePanel() {
  const [snapshot, setSnapshot] = useState<V2WorkforceProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/model/v2/workforce');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSnapshot((await response.json()) as V2WorkforceProjection);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const source = new EventSource('/api/model/v2/events');
    source.onmessage = () => void load();
    source.onerror = () => setError((value) => value ?? 'Employee event stream reconnecting');
    return () => source.close();
  }, [load]);

  if (!snapshot) {
    return (
      <div className="pixel-panel p-4 text-sm text-text-muted">
        AI Workforce: {error ?? 'Loading control plane…'}
      </div>
    );
  }

  return (
    <div className="pixel-panel p-5" style={{ backgroundColor: 'var(--color-bg)' }}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-lg">AI Workforce</div>
          <div className="text-xs text-text-muted">
            {snapshot.summary.employees} employee{snapshot.summary.employees === 1 ? '' : 's'} ·{' '}
            {snapshot.summary.employed} employed · {snapshot.summary.currentDuties} working now ·{' '}
            {compact(snapshot.summary.requests)} requests
          </div>
        </div>
        <div className="text-right text-xs text-text-muted">
          <div>V2 business authority</div>
          {error && <div>{error}</div>}
        </div>
      </div>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}
      >
        {snapshot.employees.map((employee) => (
          <EmployeeCard employee={employee} key={employee.id} />
        ))}
      </div>

      {snapshot.employees.length === 0 && (
        <div className="border-2 border-border p-4 text-sm text-text-muted">
          No durable Employee identity has been reconciled yet.
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>
          Career usage: {compact(snapshot.summary.inputTokens)} input ·{' '}
          {compact(snapshot.summary.outputTokens)} output
        </span>
        <span>
          {money(snapshot.summary.actualCost)} actual · {money(snapshot.summary.marketValue)} market
          value
        </span>
      </div>
    </div>
  );
}
