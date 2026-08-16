import type { OrgSnapshot } from '../../orgStore.js';

type FetchLike = typeof fetch;

export interface HermesWorkforceSyncClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  onError?: (error: Error) => void;
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function revision(snapshot: OrgSnapshot): string {
  let observedAt = 0;
  for (const profile of snapshot.profiles) {
    observedAt = Math.max(observedAt, profile.lastSeenAt ?? 0, profile.lastResponseAt ?? 0);
  }
  for (const run of snapshot.runs) {
    observedAt = Math.max(observedAt, run.completedAt ?? 0, run.startedAt ?? 0, run.createdAt ?? 0);
  }
  for (const node of snapshot.nodes) {
    observedAt = Math.max(
      observedAt,
      node.updatedAt ?? 0,
      node.lastHeartbeatAt ?? 0,
      node.startedAt ?? 0,
    );
  }
  return `hermes-org:${snapshot.profiles.length}:${snapshot.runs.length}:${snapshot.nodes.length}:${snapshot.edges.length}:${observedAt}`;
}

export class HermesWorkforceSyncClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #onError?: (error: Error) => void;
  #pending: OrgSnapshot | null = null;
  #running = false;
  #idleWaiters: Array<() => void> = [];

  constructor(options: HermesWorkforceSyncClientOptions) {
    this.#baseUrl = normalizedBaseUrl(options.baseUrl);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#onError = options.onError;
  }

  enqueue(snapshot: OrgSnapshot): void {
    this.#pending = snapshot;
    if (!this.#running) void this.#drain();
  }

  async waitForIdle(): Promise<void> {
    if (!this.#running && !this.#pending) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  async #push(snapshot: OrgSnapshot): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/v2/internal/hermes/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...snapshot, sourceRevision: revision(snapshot) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HERMES_WORKFORCE_SYNC_HTTP_${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#pending) {
        const snapshot = this.#pending;
        this.#pending = null;
        try {
          await this.#push(snapshot);
        } catch (error) {
          this.#onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.#running = false;
      const waiters = this.#idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}

let singleton: HermesWorkforceSyncClient | null = null;
let singletonKey = '';
let configuredBaseUrl: string | null = null;

export function configureHermesWorkforceSync(baseUrl: string | null): void {
  configuredBaseUrl = baseUrl?.trim() || null;
}

export function enqueueHermesWorkforceSnapshot(snapshot: OrgSnapshot): void {
  if (process.env.HERMES_WORKFORCE_SYNC === '0') return;
  const baseUrl = configuredBaseUrl ?? process.env.MODEL_CONTROL_PLANE_URL?.trim();
  if (!baseUrl) return;
  if (!singleton || singletonKey !== baseUrl) {
    singletonKey = baseUrl;
    singleton = new HermesWorkforceSyncClient({ baseUrl });
  }
  singleton.enqueue(snapshot);
}
