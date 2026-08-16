/**
 * HermesProvider — the non-hook HookProvider variant for the Hermes office bridge.
 *
 * Unlike the Claude provider it installs no shell hooks and drives nothing from
 * JSONL transcripts. Instead it subscribes to the hermes-office-bridge SSE stream
 * (`GET /api/events`), rebuilds the authoritative OrgStore graph, and broadcasts
 * the `orgState` snapshot on every frame. The webview projects that graph into
 * office characters so Graph View and Office View cannot diverge.
 *
 * The older flat worker -> AgentState path remains available as pure helper logic
 * for compatibility tests, but HermesProvider no longer emits duplicate agent
 * lifecycle messages from it.
 */

import type { AgentEvent, HookProvider } from '../../../../core/src/provider.js';
import type { AgentStateStore } from '../../agentStateStore.js';
import type { OrgSnapshot, OrgStore } from '../../orgStore.js';
import {
  BridgeClient,
  type HermesBoard,
  type HermesKanban,
  type HermesProcess,
  type HermesSpawn,
  type HermesTeam,
  type HermesWorker,
} from './bridgeClient.js';
import {
  aggregateProfile,
  type EdgeRelation,
  type ExecutionEdge,
  type ExecutionNode,
  inferNodeRole,
  inferNodeState,
  inferNodeType,
  isActiveState,
  type NodeState,
  type ProfileController,
  type Run,
} from './orgModel.js';

// ── status → toolName (drives character animation) ───────────

const HERMES_TOOL_LABELS: Record<string, string> = {
  Plan: 'Planning',
  Think: 'Thinking',
  Write: 'Writing',
  WebSearch: 'Browsing',
  Test: 'Testing',
  Read: 'Reading',
  Wait: 'Waiting',
  Permission: 'Blocked',
};

/** Map a bridge worker status to a pixel-agents tool name ('' when idle). The
 *  names are case-sensitive and match the webview's STATUS_TO_TOOL prefixes. */
export function statusToToolName(status: string | undefined): string {
  switch ((status ?? 'idle').trim().toLowerCase()) {
    case 'planning':
      return 'Plan';
    case 'llm_running':
      return 'Think';
    case 'coding':
      return 'Write';
    case 'browsing':
      return 'WebSearch';
    case 'testing':
      return 'Test';
    case 'reviewing':
      return 'Read';
    case 'waiting_io':
      return 'Wait';
    case 'blocked':
      return 'Permission';
    case 'working':
      return 'Write';
    default:
      return '';
  }
}

/** True when a worker status represents activity (anything but idle). */
export function isActiveWorkerStatus(status: string | undefined): boolean {
  const s = (status ?? 'idle').trim().toLowerCase();
  return s !== 'idle' && s !== '';
}

/** Stable run id for work performed directly by a profile's root controller session. */
export function interactiveRunId(profileId: string, sessionId: string): string {
  return `interactive:${profileId}:${sessionId}`;
}

/** Translate a root controller state into the corresponding run lifecycle. */
export function controllerRunStatus(status: string | undefined): Run['status'] {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'blocked':
      return 'BLOCKED';
    case 'planning':
    case 'llm_running':
      return 'PLANNING';
    case 'idle':
    case 'done':
    case 'completed':
      return 'COMPLETED';
    case 'failed':
    case 'error':
      return 'FAILED';
    default:
      return 'RUNNING';
  }
}

/** Stable session id for a worker (independent characters per worker). */
export function workerSessionId(team: HermesTeam, worker: HermesWorker): string {
  return `hermes:${team.name}:${worker.id}`;
}

export interface BoardEvent {
  sessionId: string;
  event: AgentEvent;
}

function toolIdFor(sessionId: string, toolName: string): string {
  return `${sessionId}#${toolName}`;
}

function workerInput(worker: HermesWorker): Record<string, unknown> {
  return {
    task: worker.task,
    action: worker.action,
    model: worker.model,
    runtime: worker.runtime,
  };
}

function toolStartFor(sessionId: string, worker: HermesWorker): BoardEvent {
  const toolName = statusToToolName(worker.status);
  return {
    sessionId,
    event: {
      kind: 'toolStart',
      toolId: toolIdFor(sessionId, toolName),
      toolName,
      input: workerInput(worker),
    },
  };
}

/**
 * Diff two board frames into AgentEvents (sessionId-keyed by worker).
 *
 * - new worker → sessionStart (+ toolStart when active)
 * - status change → toolEnd(old) + toolStart(new), or turnEnd when going idle
 * - worker removed → toolEnd + turnEnd + sessionEnd
 */
export function diffBoard(prev: HermesBoard | null, next: HermesBoard): BoardEvent[] {
  const events: BoardEvent[] = [];
  const prevWorkers = new Map<string, HermesWorker>();
  const nextWorkers = new Map<string, HermesWorker>();
  for (const team of prev?.teams ?? []) {
    for (const w of team.workers) prevWorkers.set(workerSessionId(team, w), w);
  }
  for (const team of next.teams) {
    for (const w of team.workers) nextWorkers.set(workerSessionId(team, w), w);
  }

  for (const [sessionId, worker] of nextWorkers) {
    const old = prevWorkers.get(sessionId);
    if (!old) {
      events.push({ sessionId, event: { kind: 'sessionStart', source: 'hermes' } });
      if (isActiveWorkerStatus(worker.status)) {
        events.push(toolStartFor(sessionId, worker));
      }
    } else if ((old.status ?? 'idle') !== (worker.status ?? 'idle')) {
      const oldToolName = statusToToolName(old.status);
      if (oldToolName) {
        events.push({
          sessionId,
          event: { kind: 'toolEnd', toolId: toolIdFor(sessionId, oldToolName) },
        });
      }
      if (isActiveWorkerStatus(worker.status)) {
        events.push(toolStartFor(sessionId, worker));
      } else {
        events.push({ sessionId, event: { kind: 'turnEnd' } });
      }
    }
  }

  for (const [sessionId, worker] of prevWorkers) {
    if (nextWorkers.has(sessionId)) continue;
    const toolName = statusToToolName(worker.status);
    if (toolName) {
      events.push({
        sessionId,
        event: { kind: 'toolEnd', toolId: toolIdFor(sessionId, toolName) },
      });
    }
    events.push({ sessionId, event: { kind: 'turnEnd' } });
    events.push({ sessionId, event: { kind: 'sessionEnd', reason: 'worker-removed' } });
  }

  return events;
}

// ── Formatting helpers ───────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}

export function formatHermesToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as { task?: string; action?: string };
  const task = typeof inp.task === 'string' && inp.task ? inp.task : undefined;
  const action = typeof inp.action === 'string' && inp.action ? inp.action : undefined;
  const label = HERMES_TOOL_LABELS[toolName] ?? toolName;
  if (task) return `${label}: ${truncate(task, 60)}`;
  if (action) return `${label}: ${truncate(action, 60)}`;
  return label;
}

// ── Context windows ──────────────────────────────────────────

const HERMES_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v4-flash': 1_048_576,
  'deepseek-v4-pro': 1_048_576,
  'gpt-5.6-sol': 400_000,
};

export function hermesContextWindowForModel(model: string | undefined): number {
  if (!model) return 128_000;
  return HERMES_CONTEXT_WINDOWS[model] ?? 128_000;
}

// ── Process matching ─────────────────────────────────────────

/**
 * Resolve a worker's OS process id. When the bridge already reports
 * `worker.process_id`, use it directly; otherwise attempt to match the worker's
 * workspace (cwd) + runtime against the board's top-level `processes` array —
 * the same heuristic hermes-office-bridge's `_match_process` uses.
 * Returns undefined (never throws) when no process can be matched.
 */
export function resolveWorkerProcessId(
  worker: Pick<HermesWorker, 'process_id' | 'workspace' | 'runtime'>,
  processes: HermesProcess[],
): number | undefined {
  if (worker.process_id !== undefined && worker.process_id !== null) {
    return worker.process_id;
  }
  if (!worker.workspace) return undefined;
  const runtime = (worker.runtime ?? '').trim().toLowerCase();
  for (const proc of processes) {
    if (proc.cwd !== worker.workspace) continue;
    if (!runtime) return proc.pid;
    if ((proc.command ?? '').toLowerCase().includes(runtime)) return proc.pid;
  }
  return undefined;
}

/** Stable Run id for a concrete Hermes Kanban task run. */
export function kanbanRunId(profileId: string, runId: number | undefined, taskId: string): string {
  return runId !== undefined
    ? `kanban:${profileId}:${runId}`
    : `kanban:${profileId}:task:${taskId}`;
}

/** Map exact Hermes delegated role labels into the office domain vocabulary. */
export function roleFromHermesHint(role: string | undefined): ExecutionNode['role'] | undefined {
  switch ((role ?? '').trim().toLowerCase()) {
    case 'orchestrator':
      return 'ORCHESTRATOR';
    case 'supervisor':
      return 'SUPERVISOR';
    case 'reviewer':
      return 'REVIEWER';
    case 'researcher':
      return 'RESEARCHER';
    case 'tester':
      return 'TESTER';
    case 'integrator':
      return 'INTEGRATOR';
    case 'executor':
    case 'leaf':
      return 'EXECUTOR';
    default:
      return undefined;
  }
}

/**
 * Convert live external OpenCode/Codex processes into execution nodes when no
 * existing Hermes/Kanban worker already owns the PID. Attribution prefers an
 * explicit spawn record, then the process cwd profile hint from the bridge.
 */
export function buildProcessNodes(
  processes: HermesProcess[],
  opts: {
    profileIds: ReadonlySet<string>;
    ownedPids: ReadonlySet<number>;
    spawns: HermesSpawn[];
    now: number;
    parentRunById?: ReadonlyMap<string, string>;
    parentRoleById?: ReadonlyMap<string, ExecutionNode['role']>;
    /** Active run to inherit when the root controller directly launches a runtime. */
    profileRunById?: ReadonlyMap<string, string>;
  },
): { nodes: ExecutionNode[]; edges: ExecutionEdge[] } {
  const nodes: ExecutionNode[] = [];
  const edges: ExecutionEdge[] = [];
  for (const proc of processes) {
    if (opts.ownedPids.has(proc.pid)) continue;
    const runtime = (proc.runtime ?? '').trim().toLowerCase();
    if (runtime !== 'opencode' && runtime !== 'codex') continue;
    const reverseSpawns = [...opts.spawns].reverse();
    const exactSpawn = reverseSpawns.find(
      (candidate) =>
        (candidate.runtime ?? '').trim().toLowerCase() === runtime &&
        candidate.processId !== undefined &&
        candidate.processId === proc.pid,
    );
    const spawn =
      exactSpawn ??
      reverseSpawns.find((candidate) => {
        if ((candidate.runtime ?? '').trim().toLowerCase() !== runtime) return false;
        // Never allow an observer record for a *different* PID to degrade into a
        // cwd heuristic match. Only legacy records without processId may do so.
        if (candidate.processId !== undefined) return false;
        if (candidate.cwd && proc.cwd && candidate.cwd !== proc.cwd) return false;
        return true;
      });
    const profileId = spawn?.profileId || proc.profile_hint;
    if (!profileId || !opts.profileIds.has(profileId)) continue;
    const id = `process:${proc.pid}`;
    const parentId = spawn?.parentNodeId || undefined;
    const runId =
      spawn?.runId ||
      (parentId ? opts.parentRunById?.get(parentId) : undefined) ||
      opts.profileRunById?.get(profileId) ||
      '';
    nodes.push({
      id,
      profileId,
      runId,
      parentId,
      type: runtime === 'opencode' ? 'OPENCODE' : 'CODEX',
      role: 'EXECUTOR',
      runtime,
      model: proc.model,
      taskTitle: spawn?.command || proc.command,
      state: 'TERMINAL',
      processId: proc.pid,
      workspace: proc.cwd,
      currentTool: 'Terminal',
      currentAction: proc.command,
      startedAt: opts.now,
      updatedAt: opts.now,
      metadata: { processObserved: true, ...(spawn ? { spawnId: spawn } : {}) },
    });
    if (parentId) {
      edges.push({
        id: `${parentId}->${id}`,
        runId,
        fromNodeId: parentId,
        toNodeId: id,
        relation: opts.parentRoleById?.get(parentId) === 'SUPERVISOR' ? 'SUPERVISES' : 'SPAWNED',
      });
    }
  }
  return { nodes, edges };
}

// ── Spawn correlation ────────────────────────────────────────

/** Time window (seconds) a spawn's `createdAt` may sit from a worker's last
 *  activity for the two to be correlated (loose match, first-come-first-serve).
 *  Both timestamps come from the bridge, which reports Unix epoch seconds. */
export const SPAWN_MATCH_WINDOW_SEC = 5 * 60;

/** Minimal worker shape the spawn matcher reads. */
export interface SpawnMatchWorker {
  sessionId: string;
  profileId: string;
  runtime?: string;
  /** Worker's last activity in epoch seconds. */
  lastActivitySec?: number;
}

/**
 * Correlate workers with spawn records (one spawn per worker, first-come-
 * first-serve). A spawn matches a worker when they share a profileId, their
 * runtimes agree (when the worker reports one), and the spawn's `createdAt`
 * falls within `SPAWN_MATCH_WINDOW_SEC` of the worker's last activity.
 */
export function matchSpawnsToWorkers(
  workers: SpawnMatchWorker[],
  spawns: HermesSpawn[],
  nowSec: number,
): Map<string, HermesSpawn> {
  const result = new Map<string, HermesSpawn>();
  const used = new Set<HermesSpawn>();

  const byProfile = new Map<string, HermesSpawn[]>();
  for (const spawn of spawns) {
    const list = byProfile.get(spawn.profileId) ?? [];
    list.push(spawn);
    byProfile.set(spawn.profileId, list);
  }

  for (const worker of workers) {
    const candidates = byProfile.get(worker.profileId) ?? [];
    // Most recent first so the nearest spawn wins.
    const sorted = [...candidates].sort((a, b) => b.createdAt - a.createdAt);
    const workerRuntime = (worker.runtime ?? '').trim().toLowerCase();
    const lastActivitySec = worker.lastActivitySec ?? nowSec;

    for (const spawn of sorted) {
      if (used.has(spawn)) continue;
      const spawnRuntime = (spawn.runtime ?? '').trim().toLowerCase();
      if (workerRuntime && spawnRuntime && workerRuntime !== spawnRuntime) continue;
      if (Math.abs(spawn.createdAt - lastActivitySec) > SPAWN_MATCH_WINDOW_SEC) continue;
      result.set(worker.sessionId, spawn);
      used.add(spawn);
      break;
    }
  }

  return result;
}

/**
 * A worker is a supervisor when its task/action text carries a delegation
 * keyword (派发/dispatch/delegate/supervis…) or a spawn record names it as the
 * parent node of an executor.
 */
export function isSupervisorWorker(
  worker: Pick<HermesWorker, 'task' | 'action'>,
  sessionId: string,
  spawns: HermesSpawn[],
): boolean {
  const text = `${worker.task ?? ''} ${worker.action ?? ''}`.toLowerCase();
  if (/(派发|dispatch|delegate|supervis)/.test(text)) return true;
  return spawns.some((s) => s.parentNodeId === sessionId);
}

/**
 * Edge relation for a spawn-correlated worker: SPAWNED when the spawn names no
 * parent node; SUPERVISES when it names a supervisor parent; DELEGATED otherwise.
 */
export function spawnEdgeRelation(
  spawn: HermesSpawn,
  parentRole: string | undefined,
): EdgeRelation {
  if (!spawn.parentNodeId) return 'SPAWNED';
  return parentRole === 'SUPERVISOR' ? 'SUPERVISES' : 'DELEGATED';
}

// ── Kanban mapping ───────────────────────────────────────────

/** Map a kanban task status to an org node state. */
export function kanbanStateToNodeState(status: string | undefined): NodeState {
  switch ((status ?? 'todo').trim().toLowerCase()) {
    case 'todo':
      return 'STARTING';
    case 'ready':
      return 'WAITING_IO';
    case 'running':
      return 'CODING';
    case 'blocked':
      return 'BLOCKED';
    case 'done':
    case 'archived':
      return 'DONE';
    default:
      return 'STARTING';
  }
}

/** Stable node id for a kanban task. */
export function kanbanNodeId(taskId: string): string {
  return `kanban:${taskId}`;
}

export interface KanbanBuildResult {
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  /** worker_pid → task_id (associates a worker node's process with a task). */
  pidToTaskId: Map<number, string>;
}

/**
 * Map a kanban snapshot into org nodes + edges (pure, unit-testable).
 *
 * - each task → an OTHER/EXECUTOR node attached directly to its assignee's
 *   profile (parentId undefined), state mapped from the task status,
 *   `metadata: { kanban: true, ... }`
 * - task links → DEPENDS_ON edges
 * - runs → a worker_pid→task_id map; a task whose worker_pid matches a board
 *   process gets that pid as its `processId`
 */
export function buildKanbanNodes(
  kanban: HermesKanban,
  opts: { profileIds: ReadonlySet<string>; processes: HermesProcess[]; now: number },
): KanbanBuildResult {
  const pidToTaskId = new Map<number, string>();
  const taskIdToPid = new Map<string, number>();
  const taskIdToRun = new Map<string, HermesKanban['runs'][number]>();
  for (const run of kanban.runs) {
    if (run.task_id) taskIdToRun.set(run.task_id, run);
    if (run.worker_pid !== undefined && run.task_id) {
      pidToTaskId.set(run.worker_pid, run.task_id);
      taskIdToPid.set(run.task_id, run.worker_pid);
    }
  }

  const processPids = new Set(opts.processes.map((p) => p.pid));
  const nodes: ExecutionNode[] = [];
  for (const task of kanban.tasks) {
    const terminalState = kanbanStateToNodeState(task.status);
    if (terminalState === 'DONE' || terminalState === 'FAILED') continue;
    const profileId = task.assignee;
    if (!profileId) continue;
    if (!opts.profileIds.has(profileId)) continue;
    const pid = taskIdToPid.get(task.id);
    const run = taskIdToRun.get(task.id);
    nodes.push({
      id: kanbanNodeId(task.id),
      profileId,
      runId: kanbanRunId(profileId, run?.id, task.id),
      parentId: undefined,
      type: 'OTHER',
      role: 'EXECUTOR',
      state: kanbanStateToNodeState(task.status),
      taskId: task.id,
      taskTitle: task.title,
      processId: pid !== undefined && processPids.has(pid) ? pid : undefined,
      metadata: {
        kanban: true,
        priority: task.priority,
        workspace_path: task.workspace_path,
        kanbanRunId: run?.id,
        kanbanRunStatus: run?.status,
      },
      startedAt: run?.started_at ? run.started_at * 1000 : opts.now,
      updatedAt: opts.now,
      lastHeartbeatAt: run?.last_heartbeat_at ? run.last_heartbeat_at * 1000 : undefined,
    });
  }

  const edges: ExecutionEdge[] = [];
  for (const link of kanban.links) {
    const parentId = link.parent_id;
    const childId = link.child_id;
    if (!parentId || !childId) continue;
    const parentNode = nodes.find((n) => n.id === kanbanNodeId(parentId));
    const childNode = nodes.find((n) => n.id === kanbanNodeId(childId));
    if (!parentNode || !childNode) continue;
    edges.push({
      id: `${kanbanNodeId(parentId)}->${kanbanNodeId(childId)}`,
      runId: childNode.runId,
      fromNodeId: kanbanNodeId(parentId),
      toNodeId: kanbanNodeId(childId),
      relation: 'DEPENDS_ON',
    });
  }

  return { nodes, edges, pidToTaskId };
}

// ── Profile area mappings (office partition) ─────────────────

/**
 * Build the profile → Area mapping for the office's profile zones.
 *
 * Each bridge team becomes one Area whose label equals its display name, so a
 * Hermes agent (teamName = display name) can be seated in its own zone. The
 * returned mapping is written to `cfg.standalone.areaMappings` (profile name →
 * [profile name]) and broadcast as `areaMappingsLoaded`. `names` preserves the
 * board's team order for the webview's zone re-labelling.
 */
export function buildProfileAreaMappings(teams: HermesTeam[]): {
  mappings: Record<string, string[]>;
  names: string[];
} {
  const mappings: Record<string, string[]> = {};
  const names: string[] = [];
  for (const team of teams) {
    const display = (team.display ?? '').trim() || team.name;
    if (!display) continue;
    mappings[display] = [display];
    names.push(display);
  }
  return { mappings, names };
}

// ── The provider ─────────────────────────────────────────────

export interface HermesProviderOptions {
  store: AgentStateStore;
  orgStore: OrgStore;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Persist hook for the profile → Area mapping (wired by cli.ts to config.json). */
  onAreaMappingsChanged?: (mappings: Record<string, string[]>) => void;
  /** Optional side effect for forwarding the normalized organization snapshot. */
  onOrgSnapshot?: (snapshot: OrgSnapshot) => void;
}

export class HermesProvider implements HookProvider {
  readonly kind = 'hook' as const;
  readonly id = 'hermes';
  readonly displayName = 'Hermes Bridge';
  readonly protocolVersion = 1;
  readonly permissionExemptTools = new Set<string>();
  readonly subagentToolNames = new Set<string>();
  readonly readingTools = new Set(['Plan', 'WebSearch', 'Read']);

  private readonly store: AgentStateStore;
  private readonly orgStore: OrgStore;
  private readonly bridge: BridgeClient;
  /** Latest board frame (kept so kanban updates can re-apply against it). */
  private board: HermesBoard | null = null;
  /** Latest kanban snapshot (kept so board frames can re-apply kanban nodes). */
  private kanban: HermesKanban | null = null;
  /** Latest spawn list (kept so board frames can re-apply spawn correlation). */
  private spawns: HermesSpawn[] = [];
  private readonly onAreaMappingsChanged?: (mappings: Record<string, string[]>) => void;
  private readonly onOrgSnapshot?: (snapshot: OrgSnapshot) => void;
  /** Signature of the last area mapping so we only persist/broadcast on change. */
  private lastAreaSignature: string | null = null;

  constructor(opts: HermesProviderOptions) {
    this.store = opts.store;
    this.orgStore = opts.orgStore;
    this.onAreaMappingsChanged = opts.onAreaMappingsChanged;
    this.onOrgSnapshot = opts.onOrgSnapshot;
    this.bridge = new BridgeClient({
      baseUrl: opts.baseUrl ?? 'http://127.0.0.1:8787',
      onBoard: (board) => this.handleBoard(board),
      onKanban: (kanban) => this.handleKanban(kanban),
      onSpawns: (spawns) => this.handleSpawns(spawns),
      fetchImpl: opts.fetchImpl,
    });
  }

  /** Subscribe to the bridge SSE stream (no-op if already started). */
  start(): void {
    this.bridge.start();
    console.log(`[Pixel Agents] HermesProvider: subscribing to ${this.bridge.baseUrl}/api/events`);
  }

  stop(): void {
    this.bridge.stop();
  }

  // ── HookProvider interface (non-hook variant) ───────────────

  /** Hermes never receives HTTP hook events — always null. */
  normalizeHookEvent(): null {
    return null;
  }

  async installHooks(): Promise<void> {
    /* no-op */
  }

  async uninstallHooks(): Promise<void> {
    /* no-op */
  }

  async areHooksInstalled(): Promise<boolean> {
    return false;
  }

  formatToolStatus(toolName: string, input?: unknown): string {
    return formatHermesToolStatus(toolName, input);
  }

  contextWindowForModel(model: string | undefined): number {
    return hermesContextWindowForModel(model);
  }

  // ── Board handling ──────────────────────────────────────────

  private handleBoard(board: HermesBoard): void {
    this.board = board;

    this.rebuildOrgGraph(board);

    // Hermes office characters are projected exclusively from orgState in the
    // webview. Keeping the legacy flat worker -> AgentState projection in parallel
    // created duplicate characters and made the canvas disagree with Graph View.
    this.syncAreaMappings(board);
    this.broadcastOrg();
  }

  /**
   * Generate the profile → Area mapping from the board's teams and, when it
   * changed since the last frame, broadcast `areaMappingsLoaded` and hand the
   * mapping to the persistence callback (cli.ts writes cfg.standalone.areaMappings).
   */
  private syncAreaMappings(board: HermesBoard): void {
    const { mappings, names } = buildProfileAreaMappings(board.teams);
    const signature = names.join('\u0000');
    if (signature === this.lastAreaSignature) return;
    this.lastAreaSignature = signature;
    this.store.broadcast({ type: 'areaMappingsLoaded', mappings });
    this.onAreaMappingsChanged?.(mappings);
  }

  private handleKanban(kanban: HermesKanban): void {
    this.kanban = kanban;
    // Rebuild against the latest board so kanban nodes/edges are (re)attached,
    // then broadcast the orgState change on the same channel as board frames.
    if (this.board) {
      this.rebuildOrgGraph(this.board);
      this.broadcastOrg();
    }
  }

  private handleSpawns(spawns: HermesSpawn[]): void {
    this.spawns = spawns ?? [];
    // Spawn records change parent links / supervisor roles, so re-run the
    // correlation against the latest board and rebroadcast the org snapshot.
    if (this.board) {
      this.rebuildOrgGraph(this.board);
      this.broadcastOrg();
    }
  }

  private broadcastOrg(): void {
    const snapshot = this.orgStore.snapshot();
    this.store.broadcast({ type: 'orgState', ...snapshot });
    this.onOrgSnapshot?.(snapshot);
  }

  private rebuildOrgGraph(board: HermesBoard): void {
    this.orgStore.clear();
    for (const team of board.teams) {
      this.syncTeam(team, board.processes ?? []);
    }
    this.applyKanban(board.processes ?? []);
    this.applyObservedProcesses(board.processes ?? []);
  }

  private syncTeam(team: HermesTeam, processes: HermesProcess[]): void {
    const profileId = team.name;
    const now = Date.now();

    const kanbanTasks = this.kanban?.tasks.filter((t) => t.assignee === profileId) ?? [];
    const kanbanActive = kanbanTasks.filter((t) =>
      isActiveState(kanbanStateToNodeState(t.status)),
    ).length;
    const kanbanBlocked = kanbanTasks.filter(
      (t) => kanbanStateToNodeState(t.status) === 'BLOCKED',
    ).length;

    const runtimeActive = processes.filter(
      (proc) =>
        proc.profile_hint === profileId &&
        (proc.runtime === 'opencode' || proc.runtime === 'codex'),
    ).length;
    const agg = aggregateProfile(team.workers, {
      kanbanActive,
      kanbanBlocked,
      runtimeActive,
      controllerStatus: team.controller?.status,
    });
    const controllerSessionId = team.controller?.session_id || undefined;
    const controllerState = team.controller?.status
      ? inferNodeState(team.controller.status)
      : undefined;
    const controllerActive = Boolean(
      team.controller?.is_active && controllerState && isActiveState(controllerState),
    );
    const currentInteractiveRunId =
      controllerActive && controllerSessionId
        ? interactiveRunId(profileId, controllerSessionId)
        : undefined;

    const profile: ProfileController = {
      profileId,
      displayName: team.display ?? team.name,
      availability: agg.availability,
      workload: agg.workload,
      sessionId: controllerSessionId,
      controllerState,
      controllerStatus: team.controller?.status,
      controllerModel: team.controller?.model,
      controllerAction: team.controller?.action,
      controllerActive,
      mission: team.mission,
      lastSeenAt: now,
      lastResponseAt: team.controller?.last_activity_at
        ? Math.round(team.controller.last_activity_at * 1000)
        : now,
    };
    this.orgStore.upsertProfile(profile);

    if (currentInteractiveRunId && team.controller) {
      this.orgStore.upsertRun({
        id: currentInteractiveRunId,
        profileId,
        title:
          team.controller.title?.trim() ||
          team.mission?.trim() ||
          `${team.display ?? team.name} interactive work`,
        status: controllerRunStatus(team.controller.status),
        createdAt: team.controller.started_at
          ? Math.round(team.controller.started_at * 1000)
          : team.controller.last_activity_at
            ? Math.round(team.controller.last_activity_at * 1000)
            : now,
        startedAt: team.controller.started_at
          ? Math.round(team.controller.started_at * 1000)
          : undefined,
      });
    }

    const profileSpawns = this.spawns.filter((s) => s.profileId === profileId);
    const spawnBySession = matchSpawnsToWorkers(
      team.workers.map((w) => ({
        sessionId: workerSessionId(team, w),
        profileId,
        runtime: w.runtime,
        lastActivitySec: w.last_activity_at,
      })),
      profileSpawns,
      Math.floor(now / 1000),
    );

    for (const worker of team.workers) {
      const sessionId = workerSessionId(team, worker);
      const status = (worker.status ?? 'idle').trim().toLowerCase();
      const spawn = spawnBySession.get(sessionId);
      // parentId: prefer the spawn's explicit parent node, then the worker's
      // parent chain id (multi-level trees); otherwise the node hangs directly
      // off the profile (parentId undefined → UI renders it as profile-direct).
      const parentSessionId = worker.parent_id || undefined;
      const parentId = spawn?.parentNodeId
        ? spawn.parentNodeId
        : parentSessionId && parentSessionId !== controllerSessionId
          ? workerSessionId(team, { id: parentSessionId })
          : undefined;
      const processId = resolveWorkerProcessId(worker, processes);
      const supervisor = isSupervisorWorker(worker, sessionId, profileSpawns);
      const node: ExecutionNode = {
        id: sessionId,
        profileId,
        runId: spawn?.runId || currentInteractiveRunId || '',
        parentId,
        type: inferNodeType(worker.runtime ?? ''),
        role:
          roleFromHermesHint(worker.role_hint) ??
          (supervisor ? 'SUPERVISOR' : inferNodeRole(worker.status ?? '', worker.action ?? '')),
        runtime: worker.runtime,
        model: worker.model,
        taskTitle: worker.task,
        num: worker.num,
        state: inferNodeState(status),
        sessionId,
        processId,
        workspace: worker.workspace,
        currentTool: statusToToolName(status) || undefined,
        currentAction: worker.action,
        tokensIn: worker.tokens?.input,
        tokensOut: worker.tokens?.output,
        cachedTokens: worker.tokens?.cache_read,
        cost: worker.cost_usd,
        elapsedSec: worker.elapsed_sec,
        startedAt: worker.last_activity_at ? Math.round(worker.last_activity_at * 1000) : now,
        updatedAt: now,
        metadata: spawn ? { spawnId: spawn } : undefined,
      };
      this.orgStore.upsertNode(node);
    }

    // Connect edges after every node exists so spawn relations can read the
    // parent node's role (supervisor parents produce SUPERVISES edges). Nodes
    // without a parent hang directly off the profile and produce no edge.
    for (const worker of team.workers) {
      const sessionId = workerSessionId(team, worker);
      const spawn = spawnBySession.get(sessionId);
      const parentSessionId = worker.parent_id || undefined;
      const parentId = spawn?.parentNodeId
        ? spawn.parentNodeId
        : parentSessionId && parentSessionId !== controllerSessionId
          ? workerSessionId(team, { id: parentSessionId })
          : undefined;
      if (!parentId) continue;
      const parentRole = this.orgStore.nodes.get(parentId)?.role;
      const relation = spawn ? spawnEdgeRelation(spawn, parentRole) : 'SPAWNED';
      this.orgStore.connect(parentId, sessionId, relation);
    }
  }

  // ── Kanban application (task nodes + DEPENDS_ON edges + process ids) ──

  private applyKanban(processes: HermesProcess[]): void {
    const kanban = this.kanban;
    if (!kanban) return;

    const profileIds = new Set<string>();
    for (const profile of this.orgStore.profiles.keys()) profileIds.add(profile);

    const { nodes, edges, pidToTaskId } = buildKanbanNodes(kanban, {
      profileIds,
      processes,
      now: Date.now(),
    });

    // Materialize real Kanban task-runs as first-class Run objects.
    const taskById = new Map(kanban.tasks.map((task) => [task.id, task]));
    const now = Date.now();
    for (const node of nodes) {
      const task = node.taskId ? taskById.get(node.taskId) : undefined;
      const run = node.taskId
        ? kanban.runs.find((candidate) => candidate.task_id === node.taskId)
        : undefined;
      let status: Run['status'] = 'PLANNING';
      switch ((run?.status ?? task?.status ?? '').toLowerCase()) {
        case 'running':
        case 'claimed':
          status = 'RUNNING';
          break;
        case 'blocked':
          status = 'BLOCKED';
          break;
        case 'done':
        case 'completed':
          status = 'COMPLETED';
          break;
        case 'failed':
          status = 'FAILED';
          break;
        case 'cancelled':
        case 'reclaimed':
          status = 'CANCELLED';
          break;
        default:
          status = 'PLANNING';
          break;
      }
      this.orgStore.upsertRun({
        id: node.runId,
        profileId: node.profileId,
        title: task?.title ?? node.taskTitle ?? node.profileId,
        status,
        createdAt: node.startedAt || now,
        startedAt: run?.started_at ? run.started_at * 1000 : undefined,
        completedAt: task?.status === 'done' ? now : undefined,
      });
    }

    // Associate worker nodes with their kanban task (worker_pid → task_id).
    for (const node of this.orgStore.nodes.values()) {
      if (node.processId !== undefined) {
        const taskId = pidToTaskId.get(node.processId);
        if (taskId) node.taskId = taskId;
      }
    }

    for (const node of nodes) this.orgStore.upsertNode(node);
    for (const edge of edges) this.orgStore.upsertEdge(edge);
  }

  private applyObservedProcesses(processes: HermesProcess[]): void {
    if (processes.length === 0) return;
    const ownedPids = new Set<number>();
    for (const node of this.orgStore.nodes.values()) {
      if (node.processId !== undefined) ownedPids.add(node.processId);
    }
    const profileIds = new Set(this.orgStore.profiles.keys());
    const parentRunById = new Map<string, string>();
    const parentRoleById = new Map<string, ExecutionNode['role']>();
    for (const node of this.orgStore.nodes.values()) {
      if (node.runId) parentRunById.set(node.id, node.runId);
      parentRoleById.set(node.id, node.role);
    }
    const profileRunById = new Map<string, string>();
    for (const run of this.orgStore.runs.values()) {
      if (run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED')
        continue;
      if (!profileRunById.has(run.profileId) || run.id.startsWith('interactive:')) {
        profileRunById.set(run.profileId, run.id);
      }
    }
    const { nodes, edges } = buildProcessNodes(processes, {
      profileIds,
      ownedPids,
      spawns: this.spawns,
      now: Date.now(),
      parentRunById,
      parentRoleById,
      profileRunById,
    });
    for (const node of nodes) this.orgStore.upsertNode(node);
    for (const edge of edges) this.orgStore.upsertEdge(edge);
  }
}
