import { useCallback, useEffect, useMemo, useState } from 'react';

interface Channel {
  id: string;
  providerId: string;
  name: string;
  enabled: number | boolean;
  priority: number;
  weight: number;
  health: string;
  lastTest?: string;
  metadata?: Record<string, unknown>;
}
interface Worker {
  id: string;
  channelId: string;
  modelId: string;
  displayName: string;
  enabled: number | boolean;
  capabilities: string[];
}
interface Position {
  id: string;
  profileId?: string;
  name: string;
  kind: string;
}
interface Assignment {
  id: string;
  positionId: string;
  workerId: string;
  priority: number;
  weight: number;
  status: string;
  reason?: string;
}
interface Quota {
  id: string;
  channelId?: string;
  workerId?: string;
  remaining?: number;
  limit?: number;
  unit: string;
  resetAt?: number;
}
interface Contract {
  id: string;
  channelId: string;
  billingKind: string;
  fixedCost: number;
  currency: string;
  billingPeriod: string;
  resetsAt?: number;
}
interface Price {
  id: string;
  modelId: string;
  workerId?: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedPerMillion: number;
  reasoningPerMillion: number;
  currency: string;
}
interface Stat {
  id: string | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  actualCost: number;
  allocatedCost: number;
  marketValue: number;
}
interface WorkforceSnapshot {
  channels: Channel[];
  workers: Worker[];
  positions: Position[];
  assignments: Assignment[];
  quotas: Quota[];
  contracts: Contract[];
  prices: Price[];
  stats: { workers: Stat[]; positions: Stat[]; providers: Stat[]; channels: Stat[] };
}

const money = (value: number | undefined) => `$${Number(value ?? 0).toFixed(2)}`;
const compact = (value: number | undefined) =>
  Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    Number(value ?? 0),
  );
const numberOrUndefined = (value: string) => (value.trim() === '' ? undefined : Number(value));

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function WorkerRow({
  worker,
  stat,
  assignments,
  positions,
  price,
  adminEnabled,
  onChanged,
}: {
  worker: Worker;
  stat?: Stat;
  assignments: Assignment[];
  positions: Map<string, Position>;
  price?: Price;
  adminEnabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [inputPrice, setInputPrice] = useState(String(price?.inputPerMillion ?? ''));
  const [outputPrice, setOutputPrice] = useState(String(price?.outputPerMillion ?? ''));
  const [cachedPrice, setCachedPrice] = useState(String(price?.cachedPerMillion ?? ''));
  const [reasoningPrice, setReasoningPrice] = useState(String(price?.reasoningPerMillion ?? ''));
  const [busy, setBusy] = useState(false);

  const savePrice = async () => {
    setBusy(true);
    try {
      await api('/api/model/admin/prices', {
        method: 'POST',
        body: JSON.stringify({
          id: `price:${worker.id}`,
          workerId: worker.id,
          modelId: worker.modelId,
          inputPerMillion: numberOrUndefined(inputPrice) ?? 0,
          outputPerMillion: numberOrUndefined(outputPrice) ?? 0,
          cachedPerMillion: numberOrUndefined(cachedPrice) ?? 0,
          reasoningPerMillion: numberOrUndefined(reasoningPrice) ?? 0,
          currency: 'USD',
          source: 'pixel-agents-admin',
        }),
      });
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-l-2 border-border pl-2 py-1">
      <div className="flex items-center gap-2 text-sm">
        <span>{assignments.some((item) => item.status === 'active') ? '🧑‍💻' : '👤'}</span>
        <span
          className={assignments.some((item) => item.status === 'active') ? 'font-semibold' : ''}
        >
          {worker.modelId}
        </span>
      </div>
      <div className="text-xs text-text-muted">
        {assignments.length === 0
          ? 'Unassigned'
          : assignments.map((assignment) => (
              <span className="mr-2 inline-flex items-center gap-1" key={assignment.id}>
                {positions.get(assignment.positionId)?.name ?? assignment.positionId}
                <span>· P{assignment.priority}</span>
                <span>· {assignment.status}</span>
                {adminEnabled && (
                  <button
                    className="underline"
                    type="button"
                    onClick={() => {
                      const value = window.prompt(
                        'Position-specific priority',
                        String(assignment.priority),
                      );
                      if (value === null || !Number.isFinite(Number(value))) return;
                      void api(
                        `/api/model/admin/assignments/${encodeURIComponent(assignment.id)}/policy`,
                        {
                          method: 'PATCH',
                          body: JSON.stringify({ priority: Number(value) }),
                        },
                      ).then(onChanged);
                    }}
                  >
                    edit
                  </button>
                )}
              </span>
            ))}
      </div>
      <div className="text-xs text-text-muted">
        {compact(stat?.runs)} runs · {compact(stat?.inputTokens)} in · {compact(stat?.outputTokens)}{' '}
        out · {compact(stat?.cachedTokens)} cached
      </div>
      <div className="text-xs text-text-muted">
        {money(stat?.actualCost)} actual · {money(stat?.allocatedCost)} allocated ·{' '}
        {money(stat?.marketValue)} market value
      </div>
      {adminEnabled && (
        <details className="mt-1 text-xs text-text-muted">
          <summary className="cursor-pointer">Market pricing</summary>
          <div className="mt-1 grid grid-cols-2 gap-1">
            <label>
              Input / 1M
              <input
                className="ml-1 w-20 border border-border bg-transparent px-1"
                value={inputPrice}
                onChange={(event) => setInputPrice(event.target.value)}
              />
            </label>
            <label>
              Output / 1M
              <input
                className="ml-1 w-20 border border-border bg-transparent px-1"
                value={outputPrice}
                onChange={(event) => setOutputPrice(event.target.value)}
              />
            </label>
            <label>
              Cache / 1M
              <input
                className="ml-1 w-20 border border-border bg-transparent px-1"
                value={cachedPrice}
                onChange={(event) => setCachedPrice(event.target.value)}
              />
            </label>
            <label>
              Reason / 1M
              <input
                className="ml-1 w-20 border border-border bg-transparent px-1"
                value={reasoningPrice}
                onChange={(event) => setReasoningPrice(event.target.value)}
              />
            </label>
          </div>
          <button
            className="mt-1 underline"
            disabled={busy}
            type="button"
            onClick={() => void savePrice()}
          >
            save pricing
          </button>
        </details>
      )}
    </div>
  );
}

function ChannelCard({
  channel,
  workers,
  workerStats,
  assignmentsByWorker,
  positions,
  quota,
  contract,
  prices,
  adminEnabled,
  onChanged,
}: {
  channel: Channel;
  workers: Worker[];
  workerStats: Map<string | null, Stat>;
  assignmentsByWorker: Map<string, Assignment[]>;
  positions: Map<string, Position>;
  quota?: Quota;
  contract?: Contract;
  prices: Map<string, Price>;
  adminEnabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [priority, setPriority] = useState(String(channel.priority ?? 0));
  const [remaining, setRemaining] = useState(String(quota?.remaining ?? ''));
  const [limit, setLimit] = useState(String(quota?.limit ?? ''));
  const [billingKind, setBillingKind] = useState(contract?.billingKind ?? 'metered');
  const [fixedCost, setFixedCost] = useState(String(contract?.fixedCost ?? 0));
  const [busy, setBusy] = useState(false);
  const lifecycleManaged =
    channel.providerId === 'cpa' && channel.metadata?.source !== 'usage-discovery';

  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-2 border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">🏭 {channel.name}</span>
        <span className="text-xs">
          {channel.enabled ? '●' : '○'} {channel.health}
        </span>
      </div>
      <div className="mt-1 text-xs text-text-muted">
        policy P{channel.priority} · weight {channel.weight} · last test {channel.lastTest ?? '—'}
      </div>
      {contract && (
        <div className="text-xs text-text-muted">
          {contract.billingKind} · {money(contract.fixedCost)} / {contract.billingPeriod}
        </div>
      )}
      {quota && (
        <div className="text-xs text-text-muted">
          Balance {quota.remaining ?? '—'} / {quota.limit ?? '—'} {quota.unit}
        </div>
      )}

      {adminEnabled && (
        <details className="my-2 border-y border-border py-1 text-xs">
          <summary className="cursor-pointer text-text-muted">Contractor controls</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label>
              Priority
              <input
                className="ml-1 w-14 border border-border bg-transparent px-1"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              />
            </label>
            <button
              className="underline"
              disabled={busy}
              type="button"
              onClick={() =>
                void perform(() =>
                  api(`/api/model/admin/channels/${encodeURIComponent(channel.id)}/policy`, {
                    method: 'PATCH',
                    body: JSON.stringify({ priority: Number(priority) || 0 }),
                  }),
                )
              }
            >
              save policy
            </button>
            {lifecycleManaged && (
              <>
                <button
                  className="underline"
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void perform(() =>
                      api(
                        `/api/model/admin/channels/${encodeURIComponent(channel.id)}/actions/test`,
                        {
                          method: 'POST',
                          body: '{}',
                        },
                      ),
                    )
                  }
                >
                  test
                </button>
                <button
                  className="underline"
                  disabled={busy}
                  type="button"
                  onClick={() => {
                    if (channel.enabled && !window.confirm(`Disable ${channel.name}?`)) return;
                    void perform(() =>
                      api(
                        `/api/model/admin/channels/${encodeURIComponent(channel.id)}/actions/${channel.enabled ? 'disable' : 'enable'}`,
                        { method: 'POST', body: JSON.stringify({ reason: 'pixel-agents-admin' }) },
                      ),
                    );
                  }}
                >
                  {channel.enabled ? 'disable' : 'enable'}
                </button>
              </>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label>
              Remaining
              <input
                className="ml-1 w-20 border border-border bg-transparent px-1"
                value={remaining}
                onChange={(event) => setRemaining(event.target.value)}
              />
            </label>
            <label>
              Limit
              <input
                className="ml-1 w-20 border border-border bg-transparent px-1"
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
              />
            </label>
            <button
              className="underline"
              disabled={busy}
              type="button"
              onClick={() =>
                void perform(() =>
                  api('/api/model/admin/quotas', {
                    method: 'POST',
                    body: JSON.stringify({
                      id: `quota:${channel.id}:credits`,
                      channelId: channel.id,
                      kind: 'credits',
                      remaining: numberOrUndefined(remaining),
                      limit: numberOrUndefined(limit),
                      unit: 'USD',
                      source: 'pixel-agents-admin',
                    }),
                  }),
                )
              }
            >
              save quota
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              className="border border-border bg-transparent px-1"
              value={billingKind}
              onChange={(event) => setBillingKind(event.target.value)}
            >
              <option value="metered">metered</option>
              <option value="subscription">subscription</option>
              <option value="free">free</option>
              <option value="sponsored">sponsored</option>
            </select>
            <label>
              Fixed cost
              <input
                className="ml-1 w-20 border border-border bg-transparent px-1"
                value={fixedCost}
                onChange={(event) => setFixedCost(event.target.value)}
              />
            </label>
            <button
              className="underline"
              disabled={busy}
              type="button"
              onClick={() =>
                void perform(() =>
                  api('/api/model/admin/contracts', {
                    method: 'POST',
                    body: JSON.stringify({
                      id: `contract:${channel.id}`,
                      channelId: channel.id,
                      billingKind,
                      fixedCost: Number(fixedCost) || 0,
                      currency: 'USD',
                      billingPeriod: 'month',
                      metadata: { source: 'pixel-agents-admin' },
                    }),
                  }),
                )
              }
            >
              save contract
            </button>
          </div>
        </details>
      )}

      <div className="mt-2 flex flex-col gap-2">
        {workers.map((worker) => (
          <WorkerRow
            key={worker.id}
            worker={worker}
            stat={workerStats.get(worker.id)}
            assignments={assignmentsByWorker.get(worker.id) ?? []}
            positions={positions}
            price={prices.get(worker.id)}
            adminEnabled={adminEnabled}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}

function AddChannelForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [alias, setAlias] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enable, setEnable] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await api('/api/model/admin/channels', {
        method: 'POST',
        body: JSON.stringify({
          name,
          protocol,
          baseUrl,
          apiKey,
          models: [{ name: model, alias: alias || model }],
          test: true,
          enable,
        }),
      });
      setApiKey('');
      setStatus(
        enable ? 'Channel added, tested and enabled.' : 'Channel added and tested; left disabled.',
      );
      await onChanged();
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 border border-border p-2 text-xs">
      <button className="underline" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? 'close contractor onboarding' : '+ add contractor channel'}
      </button>
      {open && (
        <div
          className="mt-2 grid gap-2"
          style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}
        >
          <label>
            Channel name
            <input
              className="block w-full border border-border bg-transparent px-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Protocol
            <select
              className="block w-full border border-border bg-transparent px-1"
              value={protocol}
              onChange={(event) => setProtocol(event.target.value)}
            >
              <option value="openai-compatible">openai-compatible</option>
              <option value="codex-responses">codex-responses</option>
              <option value="anthropic-messages">anthropic-messages</option>
            </select>
          </label>
          <label>
            Base URL
            <input
              className="block w-full border border-border bg-transparent px-1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            Upstream model
            <input
              className="block w-full border border-border bg-transparent px-1"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label>
            Alias (optional)
            <input
              className="block w-full border border-border bg-transparent px-1"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
            />
          </label>
          <label>
            API key (never stored in Control Plane)
            <input
              className="block w-full border border-border bg-transparent px-1"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-1 self-end">
            <input
              type="checkbox"
              checked={enable}
              onChange={(event) => setEnable(event.target.checked)}
            />
            enable only after health test passes
          </label>
          <div className="self-end">
            <button
              className="underline"
              disabled={busy || !name || !baseUrl || !model || !apiKey}
              type="button"
              onClick={() => void submit()}
            >
              {busy ? 'onboarding…' : 'add + test channel'}
            </button>
          </div>
          {status && <div className="col-span-full text-text-muted">{status}</div>}
        </div>
      )}
    </div>
  );
}

export function ModelWorkforcePanel() {
  const [snapshot, setSnapshot] = useState<WorkforceSnapshot | null>(null);
  const [adminEnabled, setAdminEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [workforceResponse, configResponse] = await Promise.all([
        fetch('/api/model/workforce'),
        fetch('/api/model/config'),
      ]);
      if (!workforceResponse.ok) throw new Error(`HTTP ${workforceResponse.status}`);
      setSnapshot((await workforceResponse.json()) as WorkforceSnapshot);
      if (configResponse.ok) {
        const config = (await configResponse.json()) as { adminEnabled?: boolean };
        setAdminEnabled(config.adminEnabled === true);
      }
      setError(null);
    } catch (loadError) {
      setError(String(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
    const source = new EventSource('/api/model/events');
    source.onmessage = () => void load();
    source.onerror = () =>
      setError((value) => value ?? 'Model Control Plane event stream reconnecting');
    return () => source.close();
  }, [load]);

  const workerStats = useMemo(
    () => new Map((snapshot?.stats.workers ?? []).map((stat) => [stat.id, stat])),
    [snapshot],
  );
  const positions = useMemo(
    () => new Map((snapshot?.positions ?? []).map((position) => [position.id, position])),
    [snapshot],
  );
  const assignmentsByWorker = useMemo(() => {
    const result = new Map<string, Assignment[]>();
    for (const assignment of snapshot?.assignments ?? []) {
      const values = result.get(assignment.workerId) ?? [];
      values.push(assignment);
      result.set(assignment.workerId, values);
    }
    return result;
  }, [snapshot]);
  const prices = useMemo(
    () =>
      new Map(
        (snapshot?.prices ?? [])
          .filter((price) => price.workerId)
          .map((price) => [price.workerId!, price]),
      ),
    [snapshot],
  );

  if (!snapshot) {
    return (
      <div className="pixel-panel p-4 text-sm text-text-muted">
        Model Workforce: {error ?? 'Loading control plane…'}
      </div>
    );
  }

  return (
    <div className="pixel-panel p-5" style={{ backgroundColor: 'var(--color-bg)' }}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-lg">🧑‍💼 External Model Workforce</div>
          <div className="text-xs text-text-muted">
            Control Plane · {snapshot.channels.length} channels · {snapshot.workers.length} workers
            · {snapshot.positions.length} positions ·{' '}
            {adminEnabled ? 'management enabled' : 'read only'}
          </div>
        </div>
        {error && <span className="text-xs text-text-muted">{error}</span>}
      </div>
      {adminEnabled && <AddChannelForm onChanged={load} />}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}
      >
        {snapshot.channels.map((channel) => (
          <ChannelCard
            key={channel.id}
            channel={channel}
            workers={snapshot.workers.filter((worker) => worker.channelId === channel.id)}
            workerStats={workerStats}
            assignmentsByWorker={assignmentsByWorker}
            positions={positions}
            quota={snapshot.quotas.find(
              (quota) => quota.channelId === channel.id && !quota.workerId,
            )}
            contract={snapshot.contracts.find((contract) => contract.channelId === channel.id)}
            prices={prices}
            adminEnabled={adminEnabled}
            onChanged={load}
          />
        ))}
      </div>
    </div>
  );
}
