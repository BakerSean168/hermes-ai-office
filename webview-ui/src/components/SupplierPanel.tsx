import { useCallback, useEffect, useState } from 'react';

type GatewayBinding = {
  id: string;
  gatewayName: string;
  gatewayKind: string;
  externalRouteRef: string;
  protocol: string;
  lifecycle: string;
};

type SupplyEmployee = {
  id: string;
  displayName: string;
  cooperationState: string;
  currentAppointmentCount: number;
  currentDutyCount: number;
  supplierModel: { name: string; key: string };
};

type Employment = {
  id: string;
  employeeId: string;
  employeeName: string;
  status: string;
  effectiveFrom: number;
  effectiveTo?: number | null;
  bindings: GatewayBinding[];
  employee?: SupplyEmployee | null;
};

type CapacityPool = {
  id: string;
  name: string;
  dimension: string;
  limit: number | null;
  remaining: number | null;
  unit: string | null;
  lifecycle: string;
};

type Agreement = {
  id: string;
  name: string;
  planName?: string | null;
  lifecycle: string;
  fixedCost?: number | null;
  currency?: string | null;
  billingPeriod?: string | null;
  employments: Employment[];
  capacityPools: CapacityPool[];
  channels: Array<{ id: string; name: string; health: string; gatewayName: string }>;
};

type Supplier = {
  id: string;
  slug: string;
  name: string;
  lifecycle: string;
  plans: Array<{ id: string; name: string; commercialType: string; lifecycle: string }>;
  employees: SupplyEmployee[];
  agreements: Agreement[];
  summary: {
    supplierModels: number;
    employees: number;
    employed: number;
    plans: number;
    agreements: number;
    activeAgreements: number;
    currentEmployments: number;
    capacityPools: number;
    activeBindings: number;
  };
};

type SupplyProjection = {
  projectionVersion: number;
  generatedAt: number;
  suppliers: Supplier[];
  gateways: Array<{
    id: string;
    displayName: string;
    kind: string;
    lifecycle: string;
    activeBindings: number;
    routeCount: number;
  }>;
  unmappedInfrastructure: {
    count: number;
    groups: Array<{
      gatewaySlug: string;
      gatewayName: string;
      channelName: string;
      health: string[];
      supplierHints: string[];
      modelHints: string[];
      routes: Array<{ id: string; externalRouteRef: string; protocol: string; health: string }>;
    }>;
    channels: Array<{
      id: string;
      name: string;
      gatewayName: string;
      health: string;
      externalRouteRef: string;
    }>;
  };
  summary: {
    suppliers: number;
    activeSuppliers: number;
    supplierModels: number;
    employees: number;
    plans: number;
    agreements: number;
    activeAgreements: number;
    currentEmployments: number;
    capacityPools: number;
    activeBindings: number;
    gateways: number;
    unmappedChannels: number;
  };
};

const money = (amount?: number | null, currency?: string | null) => {
  if (amount == null) return null;
  return `${currency ?? 'USD'} ${Number(amount).toFixed(2)}`;
};

function capacityLabel(pool: CapacityPool): string {
  if (pool.limit == null) return `${pool.dimension}: limit unknown`;
  if (pool.remaining == null) return `${pool.dimension}: remaining unknown`;
  const percentage = pool.limit === 0 ? 0 : Math.max(0, (pool.remaining / pool.limit) * 100);
  return `${pool.dimension}: ${percentage.toFixed(0)}% remaining`;
}

function SupplierCard({ supplier }: { supplier: Supplier }) {
  return (
    <article className="pixel-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <div className="text-lg font-semibold">{supplier.name}</div>
          <div className="mt-1 text-xs text-text-muted">HR supplier · {supplier.lifecycle}</div>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs text-text-muted sm:grid-cols-4">
          <span>{supplier.summary.employees} employees</span>
          <span>{supplier.summary.currentEmployments} employed routes</span>
          <span>{supplier.summary.activeAgreements} active agreements</span>
          <span>{supplier.summary.activeBindings} gateway bindings</span>
        </div>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(260px,0.8fr)_minmax(420px,1.4fr)]">
        <section>
          <div className="text-sm font-semibold">Workforce</div>
          <div className="mt-2 flex flex-col gap-2">
            {supplier.employees.map((employee) => (
              <div className="border border-border p-3" key={employee.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">{employee.displayName}</div>
                    <div className="text-xs text-text-muted">{employee.supplierModel.name}</div>
                  </div>
                  <span className="text-xs text-text-muted">{employee.cooperationState}</span>
                </div>
                <div className="mt-2 text-xs text-text-muted">
                  {employee.currentAppointmentCount} appointments · {employee.currentDutyCount}{' '}
                  working now
                </div>
              </div>
            ))}
            {supplier.employees.length === 0 ? (
              <div className="border border-border p-3 text-xs text-text-muted">
                No durable employees registered for this supplier.
              </div>
            ) : null}
          </div>
        </section>

        <section>
          <div className="text-sm font-semibold">Commercial access</div>
          <div className="mt-2 flex flex-col gap-3">
            {supplier.agreements.map((agreement) => (
              <div className="border border-border p-3" key={agreement.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">{agreement.name}</div>
                    <div className="text-xs text-text-muted">
                      {agreement.planName ?? 'Plan not classified'} · {agreement.lifecycle}
                    </div>
                  </div>
                  {money(agreement.fixedCost, agreement.currency) ? (
                    <div className="text-xs text-text-muted">
                      {money(agreement.fixedCost, agreement.currency)}
                      {agreement.billingPeriod ? ` / ${agreement.billingPeriod}` : ''}
                    </div>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-col gap-2">
                  {agreement.employments.map((employment) => (
                    <div className="border-l-2 border-border pl-3" key={employment.id}>
                      <div className="text-xs">
                        <strong>{employment.employeeName}</strong> · {employment.status}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-text-muted">
                        {employment.bindings.map((binding) => (
                          <span className="border border-border px-2 py-1" key={binding.id}>
                            {binding.gatewayName} · {binding.protocol}
                          </span>
                        ))}
                        {employment.bindings.length === 0 ? (
                          <span>No active gateway binding</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                {agreement.capacityPools.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-text-muted">
                    {agreement.capacityPools.map((pool) => (
                      <span className="border border-border px-2 py-1" key={pool.id}>
                        {capacityLabel(pool)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 text-xs text-text-muted">Capacity evidence: unknown</div>
                )}
              </div>
            ))}
            {supplier.agreements.length === 0 ? (
              <div className="border border-border p-3 text-xs text-text-muted">
                No supply agreement registered.
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </article>
  );
}

export function SupplierPanel() {
  const [projection, setProjection] = useState<SupplyProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/model/v2/projections/supply');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setProjection((await response.json()) as SupplyProjection);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const source = new EventSource('/api/model/v2/events');
    source.onmessage = () => void load();
    source.onerror = () => setError((value) => value ?? 'Supply event stream reconnecting');
    return () => source.close();
  }, [load]);

  if (!projection) {
    return (
      <div className="pixel-panel p-5 text-sm text-text-muted">
        Suppliers: {error ?? 'Loading…'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="pixel-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-lg">Workforce Suppliers</div>
            <div className="mt-1 text-xs text-text-muted">
              Who supplies the AI workforce, under which commercial agreements, and through which
              routes.
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs text-text-muted sm:grid-cols-4">
            <span>{projection.summary.suppliers} suppliers</span>
            <span>{projection.summary.employees} employees</span>
            <span>{projection.summary.activeAgreements} active agreements</span>
            <span>{projection.summary.currentEmployments} current employments</span>
          </div>
        </div>
        {error ? <div className="mt-3 text-xs text-warning">{error}</div> : null}
      </div>

      {projection.suppliers.map((supplier) => (
        <SupplierCard key={supplier.id} supplier={supplier} />
      ))}

      {projection.suppliers.length === 0 ? (
        <div className="pixel-panel p-5 text-sm text-text-muted">
          No HR supplier has been registered. Gateway routes alone are not enough to create Supplier
          identity.
        </div>
      ) : null}

      <div className="pixel-panel p-5">
        <div className="text-sm font-semibold">Infrastructure evidence</div>
        <div className="mt-1 text-xs text-text-muted">
          {projection.summary.gateways} gateways · {projection.summary.activeBindings} active
          business bindings · {projection.summary.unmappedChannels} unmapped technical routes
        </div>
        {projection.unmappedInfrastructure.count > 0 ? (
          <div className="mt-3">
            <div className="border-l-2 border-warning pl-3 text-xs text-text-muted">
              {projection.unmappedInfrastructure.count} gateway route
              {projection.unmappedInfrastructure.count === 1 ? '' : 's'} currently have no
              SupplyAgreement mapping. They remain technical evidence and are intentionally not
              shown as employees or suppliers.
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {projection.unmappedInfrastructure.groups.map((group) => (
                <div
                  className="border border-border p-3"
                  key={`${group.gatewaySlug}:${group.channelName}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{group.channelName}</div>
                      <div className="text-xs text-text-muted">{group.gatewayName}</div>
                    </div>
                    <div className="text-xs text-text-muted">{group.health.join(' / ')}</div>
                  </div>
                  <div className="mt-2 text-xs text-text-muted">
                    Models: {group.modelHints.length > 0 ? group.modelHints.join(', ') : 'unknown'}
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    Commercial identity:{' '}
                    {group.supplierHints.length > 0
                      ? group.supplierHints.join(', ')
                      : 'unclassified'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
