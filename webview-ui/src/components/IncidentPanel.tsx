import { useEffect, useMemo, useState } from 'react';

type Incident = {
  id: string;
  kind: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  lifecycle: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  title: string;
  runId?: string | null;
  dutySessionId?: string | null;
  positionId?: string | null;
  employeeId?: string | null;
  occurrenceCount?: number;
  lastSeenAt?: number;
  resolutionNote?: string | null;
};

const panelStyle = {
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: 8,
  marginBottom: 10,
} as const;

const itemStyle = {
  border: '1px solid var(--color-border)',
  borderRadius: 3,
  padding: 7,
  marginTop: 6,
} as const;

function relativeTime(timestamp?: number): string {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function IncidentPanel() {
  const [items, setItems] = useState<Incident[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch('/api/model/v2/incidents?limit=200');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { items?: Incident[] };
        if (!cancelled) {
          setItems(body.items ?? []);
          setLoaded(true);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
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

  const active = useMemo(
    () => items.filter((item) => item.lifecycle === 'OPEN' || item.lifecycle === 'ACKNOWLEDGED'),
    [items],
  );
  const counts = useMemo(() => {
    const result = { critical: 0, error: 0, warning: 0, acknowledged: 0 };
    for (const incident of active) {
      if (incident.severity === 'CRITICAL') result.critical += 1;
      else if (incident.severity === 'ERROR') result.error += 1;
      else if (incident.severity === 'WARNING') result.warning += 1;
      if (incident.lifecycle === 'ACKNOWLEDGED') result.acknowledged += 1;
    }
    return result;
  }, [active]);

  return (
    <section style={panelStyle} aria-label="AI office incidents">
      <div
        style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}
      >
        <strong>Incidents</strong>
        <span style={{ opacity: 0.72, fontSize: 12 }}>event-replay projection</span>
      </div>
      {!loaded ? <div style={{ marginTop: 6, opacity: 0.72 }}>Loading incidents…</div> : null}
      {error ? (
        <div style={{ marginTop: 6, opacity: 0.8 }}>Incident projection unavailable: {error}</div>
      ) : null}
      {loaded && !error ? (
        <>
          <div style={{ marginTop: 4, opacity: 0.8 }}>
            {active.length} active · {counts.critical} critical · {counts.error} error ·{' '}
            {counts.warning} warning · {counts.acknowledged} acknowledged
          </div>
          {active.length === 0 ? (
            <div style={{ marginTop: 7, opacity: 0.72 }}>No active incidents.</div>
          ) : (
            active.map((incident) => (
              <article key={incident.id} style={itemStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong>{incident.title}</strong>
                  <span style={{ opacity: 0.8 }}>
                    {incident.severity.toLowerCase()} · {incident.lifecycle.toLowerCase()}
                  </span>
                </div>
                <div style={{ marginTop: 3, opacity: 0.76 }}>
                  {incident.kind}
                  {incident.occurrenceCount && incident.occurrenceCount > 1
                    ? ` · ${incident.occurrenceCount} occurrences`
                    : ''}
                  {incident.lastSeenAt ? ` · ${relativeTime(incident.lastSeenAt)}` : ''}
                </div>
                {incident.runId || incident.positionId ? (
                  <div style={{ marginTop: 3, opacity: 0.68 }}>
                    {incident.runId ? `run ${incident.runId}` : ''}
                    {incident.runId && incident.positionId ? ' · ' : ''}
                    {incident.positionId ? `position ${incident.positionId}` : ''}
                  </div>
                ) : null}
              </article>
            ))
          )}
        </>
      ) : null}
    </section>
  );
}
