import { useEffect, useState } from 'react';

type OfficeProjection = {
  summary: {
    workScopes?: number;
    activePositions?: number;
    staffedPositions?: number;
    runtimeActiveUnattributedPositions?: number;
    unfilledPositions?: number;
    activeRuns?: number;
    activeDuties?: number;
    activeRuntimeSessions?: number;
    employees?: number;
  };
};

type SupplyProjection = {
  summary: {
    suppliers?: number;
    employees?: number;
    activeAgreements?: number;
    currentEmployments?: number;
    capacityPools?: number;
    unmappedChannels?: number;
  };
};

type IncidentResponse = { items?: Array<{ lifecycle?: string; severity?: string }> };

type OverviewState = {
  office: OfficeProjection;
  supply: SupplyProjection;
  incidents: IncidentResponse;
};

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="pixel-panel p-5">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-sm">{label}</div>
      <div className="mt-2 text-xs text-text-muted">{detail}</div>
    </div>
  );
}

export function CompanyOverviewPanel() {
  const [state, setState] = useState<OverviewState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const [officeResponse, supplyResponse, incidentResponse] = await Promise.all([
          fetch('/api/model/v2/projections/office'),
          fetch('/api/model/v2/projections/supply'),
          fetch('/api/model/v2/incidents?limit=200'),
        ]);
        if (!officeResponse.ok || !supplyResponse.ok || !incidentResponse.ok) {
          throw new Error(
            `HTTP ${officeResponse.status}/${supplyResponse.status}/${incidentResponse.status}`,
          );
        }
        const next: OverviewState = {
          office: (await officeResponse.json()) as OfficeProjection,
          supply: (await supplyResponse.json()) as SupplyProjection,
          incidents: (await incidentResponse.json()) as IncidentResponse,
        };
        if (!cancelled) {
          setState(next);
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

  if (!state) {
    return (
      <div className="pixel-panel p-5 text-sm text-text-muted">
        Company overview: {error ?? 'Loading…'}
      </div>
    );
  }

  const activeIncidents = (state.incidents.items ?? []).filter(
    (item) => item.lifecycle === 'OPEN' || item.lifecycle === 'ACKNOWLEDGED',
  );
  const attention = [
    {
      label: 'Unfilled positions',
      value: state.office.summary.unfilledPositions ?? 0,
      detail: 'organizational seats with no current appointment',
    },
    {
      label: 'Runtime attribution gaps',
      value: state.office.summary.runtimeActiveUnattributedPositions ?? 0,
      detail: 'runtime evidence exists but Employee identity is unknown',
    },
    {
      label: 'Unmapped gateway routes',
      value: state.supply.summary.unmappedChannels ?? 0,
      detail: 'technical routes without a commercial SupplyAgreement mapping',
    },
    {
      label: 'Active incidents',
      value: activeIncidents.length,
      detail: 'open or acknowledged operational incidents',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="mb-3">
          <div className="text-lg">Company overview</div>
          <div className="text-xs text-text-muted">
            Business identities first; runtime and gateway evidence stay secondary.
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Workspaces"
            value={state.office.summary.workScopes ?? 0}
            detail={`${state.office.summary.activeRuns ?? 0} active runs`}
          />
          <Metric
            label="Positions"
            value={state.office.summary.activePositions ?? 0}
            detail={`${state.office.summary.staffedPositions ?? 0} staffed`}
          />
          <Metric
            label="Employees"
            value={state.supply.summary.employees ?? state.office.summary.employees ?? 0}
            detail={`${state.supply.summary.currentEmployments ?? 0} current employments`}
          />
          <Metric
            label="HR Suppliers"
            value={state.supply.summary.suppliers ?? 0}
            detail={`${state.supply.summary.activeAgreements ?? 0} active agreements`}
          />
        </div>
      </section>

      <section className="pixel-panel p-5">
        <div className="text-sm font-semibold">Needs attention</div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {attention.map((item) => (
            <div className="border border-border p-3" key={item.label}>
              <div className="text-xl font-semibold">{item.value}</div>
              <div className="mt-1 text-sm">{item.label}</div>
              <div className="mt-1 text-xs text-text-muted">{item.detail}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
