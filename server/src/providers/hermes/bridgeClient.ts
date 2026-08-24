/**
 * Hermes bridge SSE client.
 *
 * Subscribes to `GET /api/events` (Server-Sent Events) on the hermes-office-bridge
 * server. Every `event: board` frame carries a JSON snapshot of the full board
 * (profiles + workers). On disconnect, falls back to polling `GET /api/board`
 * every few seconds and re-subscribes to SSE as soon as it reconnects.
 *
 * Uses only the global `fetch` + a `ReadableStream` to parse SSE — no third-party
 * dependency (Node 20+ ships both).
 */

// ── Wire types (hermes-office-bridge) ────────────────────────

export interface HermesGateway {
  version?: string;
  busy?: boolean;
  active_agents?: number;
  active_sessions?: number;
}

export interface HermesWorkerTokens {
  input?: number;
  output?: number;
  cache_read?: number;
  reasoning?: number;
}

export interface HermesWorker {
  id: string;
  num?: number;
  runtime?: string;
  model?: string;
  task?: string;
  action?: string;
  status?: string;
  elapsed_sec?: number;
  tokens?: HermesWorkerTokens;
  cost_usd?: number;
  source?: string;
  chat_id?: string;
  thread_id?: string;
  last_activity_at?: number;
  offline?: boolean;
  /** Parent worker id (session parent chain) — enables multi-level trees. */
  parent_id?: string;
  /** Exact delegated role from Hermes subagent_start observer hook when available. */
  role_hint?: string;
  /** Process id reported by the bridge (may be absent → process matching). */
  process_id?: number;
  /** Working directory the worker is running in. */
  workspace?: string;
}

export interface HermesController {
  session_id?: string;
  status?: string;
  model?: string;
  action?: string;
  title?: string;
  source?: string;
  thread_id?: string;
  started_at?: number;
  is_active?: boolean;
  last_activity_at?: number;
}

export interface HermesTeam {
  name: string;
  display?: string;
  configured_provider?: string;
  configured_model?: string;
  worker_total?: number;
  worker_active?: number;
  mission?: string;
  elapsed_sec?: number;
  cost_usd?: number;
  controller?: HermesController | null;
  workers: HermesWorker[];
}

export interface HermesProcess {
  pid: number;
  cwd?: string;
  command?: string;
  runtime?: string;
  model?: string;
  profile_hint?: string;
}

export interface HermesBoard {
  gateway?: HermesGateway;
  teams: HermesTeam[];
  processes?: HermesProcess[];
}

// ── Kanban wire types (hermes-office-bridge /api/kanban) ─────

export interface HermesKanbanTask {
  id: string;
  title?: string;
  assignee?: string;
  status?: string;
  priority?: string | number;
  workspace_path?: string;
}

export interface HermesKanbanLink {
  id?: string;
  parent_id?: string;
  child_id?: string;
}

export interface HermesKanbanRun {
  id?: number;
  task_id?: string;
  profile?: string;
  status?: string;
  worker_pid?: number;
  last_heartbeat_at?: number;
  started_at?: number;
}

export interface HermesKanban {
  tasks: HermesKanbanTask[];
  links: HermesKanbanLink[];
  runs: HermesKanbanRun[];
  events?: Array<Record<string, unknown>>;
  plans?: Array<Record<string, unknown>>;
}

// ── Spawn wire types (hermes-office-bridge /api/spawns) ───────

export interface HermesSpawn {
  profileId: string;
  runId?: string;
  parentNodeId?: string;
  sessionId?: string;
  runtime: string;
  cwd?: string;
  model?: string;
  processId?: number;
  command?: string;
  createdAt: number;
}

export interface SseEvent {
  event: string;
  data: string;
}

// ── SSE parsing (pure, unit-testable) ────────────────────────

/**
 * Incremental SSE stream parser. Feed it decoded text chunks; it returns the
 * events completed so far. Handles `\r\n` line endings and multi-line `data:`
 * blocks (joined with `\n`, per the SSE spec).
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const events: SseEvent[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const parsed = parseSseBlock(raw);
      if (parsed) events.push(parsed);
    }
    return events;
  }
}

function parseSseBlock(raw: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    } else if (line.startsWith(':')) {
      // comment / keep-alive — ignore
      continue;
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// ── Client ───────────────────────────────────────────────────

export interface BridgeClientOptions {
  /** Base URL of the hermes-office-bridge (default http://127.0.0.1:8787). */
  baseUrl: string;
  /** Called with each board frame (SSE event or poll result). */
  onBoard: (board: HermesBoard) => void;
  /** Called with each kanban snapshot from `GET /api/kanban`. */
  onKanban?: (kanban: HermesKanban) => void;
  /** Called with each spawn list from `GET /api/spawns`. */
  onSpawns?: (spawns: HermesSpawn[]) => void;
  /** Polling interval while disconnected from SSE. Default 5000ms. */
  pollIntervalMs?: number;
  /** Kanban polling interval. Default 30000ms. */
  kanbanPollIntervalMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class BridgeClient {
  private controller: AbortController | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private kanbanTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private subscribed = false;

  constructor(private readonly opts: BridgeClientOptions) {}

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** True while an SSE stream is currently connected. */
  isSubscribed(): boolean {
    return this.subscribed;
  }

  /** Begin subscribing to the SSE stream (reconnecting / polling as needed). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.subscribeSse();
    this.startKanbanPolling();
  }

  /** Stop all network activity. */
  stop(): void {
    this.running = false;
    this.subscribed = false;
    this.controller?.abort();
    this.controller = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopKanbanPolling();
  }

  private fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private async subscribeSse(): Promise<void> {
    if (!this.running) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const fetchImpl = this.fetchImpl();

    try {
      const res = await fetchImpl(`${this.opts.baseUrl}/api/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status}`);
      }

      this.subscribed = true;
      this.stopPolling();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
        for (const ev of parser.push(chunk)) {
          if (ev.event === 'board') {
            try {
              this.opts.onBoard(JSON.parse(ev.data) as HermesBoard);
            } catch {
              /* ignore malformed board frames */
            }
          }
        }
      }
    } catch {
      /* aborted on stop() or a network failure — fall through to polling */
    }

    this.subscribed = false;
    if (this.running) {
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    const interval = this.opts.pollIntervalMs ?? 5000;
    const tick = async () => {
      if (!this.running) return;
      await this.fetchBoard();
      // Re-subscribe to SSE as soon as it's reachable again.
      if (this.running && !this.subscribed) {
        void this.subscribeSse();
      }
    };
    this.pollTimer = setInterval(() => void tick(), interval);
    void tick();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async fetchBoard(): Promise<void> {
    const fetchImpl = this.fetchImpl();
    try {
      const res = await fetchImpl(`${this.opts.baseUrl}/api/board`);
      if (!res.ok) return;
      const board = (await res.json()) as HermesBoard;
      this.opts.onBoard(board);
    } catch {
      /* ignore transient poll failures */
    }
  }

  private startKanbanPolling(): void {
    if (this.kanbanTimer) return;
    const hasKanban = !!this.opts.onKanban;
    const hasSpawns = !!this.opts.onSpawns;
    if (!hasKanban && !hasSpawns) return;
    const interval = this.opts.kanbanPollIntervalMs ?? 30000;
    this.kanbanTimer = setInterval(() => {
      if (hasKanban) void this.fetchKanban();
      if (hasSpawns) void this.fetchSpawns();
    }, interval);
    if (hasKanban) void this.fetchKanban();
    if (hasSpawns) void this.fetchSpawns();
  }

  private stopKanbanPolling(): void {
    if (this.kanbanTimer) {
      clearInterval(this.kanbanTimer);
      this.kanbanTimer = null;
    }
  }

  private async fetchKanban(): Promise<void> {
    if (!this.opts.onKanban) return;
    const fetchImpl = this.fetchImpl();
    try {
      const res = await fetchImpl(`${this.opts.baseUrl}/api/kanban`);
      if (!res.ok) return;
      const kanban = (await res.json()) as HermesKanban;
      this.opts.onKanban(kanban);
    } catch {
      /* ignore transient kanban poll failures */
    }
  }

  private async fetchSpawns(): Promise<void> {
    if (!this.opts.onSpawns) return;
    const fetchImpl = this.fetchImpl();
    try {
      const res = await fetchImpl(`${this.opts.baseUrl}/api/spawns`);
      if (!res.ok) return;
      const data = (await res.json()) as HermesSpawn[] | { spawns?: HermesSpawn[] };
      // The bridge wraps the list in `{ spawns: [...] }`; accept a bare array too.
      const spawns = Array.isArray(data) ? data : (data.spawns ?? []);
      this.opts.onSpawns(spawns);
    } catch {
      /* ignore transient spawn poll failures */
    }
  }
}
