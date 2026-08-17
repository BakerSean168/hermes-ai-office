/**
 * Hermes Organization domain model: pure TypeScript types + pure functions.
 *
 * The Hermes bridge (hermes-office-bridge) exposes a flat board of profiles and
 * workers; this module converts that into a proper organization graph (profiles,
 * runs, execution nodes, edges) and classifies runtime/status/role/state so the
 * Org view can render it. No pixel-agents runtime dependencies — it is imported
 * by both the HermesProvider and the OrgStore, and unit-tested in isolation.
 */

export type ProfileAvailability = 'ONLINE' | 'DEGRADED' | 'OFFLINE';
export type ProfileWorkload = 'READY' | 'PLANNING' | 'SUPERVISING' | 'EXECUTING' | 'BLOCKED';
export type NodeType = 'HERMES_SUBAGENT' | 'OPENCODE' | 'CODEX' | 'TERMINAL' | 'BROWSER' | 'OTHER';
export type NodeRole =
  'SUPERVISOR' | 'ORCHESTRATOR' | 'EXECUTOR' | 'REVIEWER' | 'RESEARCHER' | 'TESTER' | 'INTEGRATOR';
export type NodeState =
  | 'STARTING'
  | 'THINKING'
  | 'CODING'
  | 'TERMINAL'
  | 'BROWSING'
  | 'TESTING'
  | 'REVIEWING'
  | 'WAITING_IO'
  | 'NEEDS_INPUT'
  | 'BLOCKED'
  | 'DONE'
  | 'FAILED';
export type EdgeRelation = 'SPAWNED' | 'DELEGATED' | 'SUPERVISES' | 'REVIEWS' | 'DEPENDS_ON';

export interface ProfileController {
  profileId: string;
  /** Friendly display name (from the bridge team display, falling back to name). */
  displayName?: string;
  availability: ProfileAvailability;
  workload: ProfileWorkload;
  sessionId?: string;
  /** Root Hermes controller state. The controller is presence/control-plane, never an ExecutionNode. */
  controllerState?: NodeState;
  controllerStatus?: string;
  controllerModel?: string;
  /** Effective provider/model configuration reported by Hermes /api/profiles. */
  configuredProvider?: string;
  configuredModel?: string;
  controllerAction?: string;
  controllerActive?: boolean;
  /** Profile mission (from the bridge team) — used as the run title fallback. */
  mission?: string;
  lastSeenAt: number;
  lastResponseAt?: number;
}

export interface Run {
  id: string;
  profileId: string;
  title: string;
  status: 'PLANNING' | 'RUNNING' | 'BLOCKED' | 'FINALIZING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ExecutionNode {
  id: string;
  profileId: string;
  runId: string;
  parentId?: string;
  type: NodeType;
  role: NodeRole;
  runtime?: string;
  model?: string;
  taskId?: string;
  taskTitle?: string;
  /** Worker ordinal within its profile (from the bridge's `num` field). */
  num?: number;
  state: NodeState;
  sessionId?: string;
  processId?: number;
  cwd?: string;
  workspace?: string;
  worktree?: string;
  branch?: string;
  currentTool?: string;
  currentAction?: string;
  tokensIn?: number;
  tokensOut?: number;
  cachedTokens?: number;
  cost?: number;
  /** Seconds the worker has been running the current action (bridge elapsed_sec). */
  elapsedSec?: number;
  startedAt: number;
  updatedAt: number;
  lastHeartbeatAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionEdge {
  id: string;
  runId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: EdgeRelation;
}

/**
 * Minimal worker shape the aggregate functions read. The Hermes bridge supplies
 * richer workers (tokens, cost, source, chat_id, ...); this is the slice the
 * pure helpers actually need, so they stay decoupled from the wire format.
 */
export interface WorkerLike {
  id?: string;
  status?: string;
  action?: string;
  runtime?: string;
  offline?: boolean;
}

// ── Node type inference ──────────────────────────────────────

/** Map a worker runtime id to an org node type. */
export function inferNodeType(runtime: string): NodeType {
  switch (runtime.trim().toLowerCase()) {
    case 'opencode':
      return 'OPENCODE';
    case 'codex':
      return 'CODEX';
    case 'hermes':
      return 'HERMES_SUBAGENT';
    case 'terminal':
      return 'TERMINAL';
    case 'browser':
      return 'BROWSER';
    default:
      return 'OTHER';
  }
}

// ── Node role inference ──────────────────────────────────────

/** Classify a worker's role from its status + action text. */
export function inferNodeRole(status: string, action: string): NodeRole {
  const haystack = `${status} ${action}`.toLowerCase();
  if (haystack.includes('review') || haystack.includes('审查')) return 'REVIEWER';
  if (haystack.includes('test')) return 'TESTER';
  if (haystack.includes('plan')) return 'ORCHESTRATOR';
  return 'EXECUTOR';
}

// ── Node state inference ─────────────────────────────────────

/**
 * Map a Hermes bridge worker status to an org node state.
 * idle maps to DONE (resting / not active); everything else maps to an active
 * state (isActiveState returns false only for DONE/FAILED).
 */
export function inferNodeState(status: string): NodeState {
  switch (status.trim().toLowerCase()) {
    case 'llm_running':
    case 'planning':
      return 'THINKING';
    case 'coding':
    case 'working':
      return 'CODING';
    case 'browsing':
      return 'BROWSING';
    case 'testing':
      return 'TESTING';
    case 'reviewing':
      return 'REVIEWING';
    case 'waiting_io':
      return 'WAITING_IO';
    case 'blocked':
      return 'BLOCKED';
    case 'idle':
    case '':
      return 'DONE';
    case 'done':
    case 'completed':
    case 'finished':
    case 'cancelled':
      return 'DONE';
    case 'failed':
    case 'error':
      return 'FAILED';
    default:
      return 'THINKING';
  }
}

// ── Profile aggregation ──────────────────────────────────────

/**
 * Aggregate a profile's workers into an availability/workload summary.
 *
 * - availability: ONLINE whenever any worker is active; otherwise ONLINE in v1
 *   (unless every worker carries an explicit `offline` marker → OFFLINE, or some
 *   do → DEGRADED).
 * - workload: any worker blocked → BLOCKED; else any active worker → EXECUTING;
 *   all idle → READY.
 *
 * DONE / FAILED / CANCELLED workers are NOT active — a profile of finished
 * workers collapses back to READY. `opts.kanbanActive` (and `opts.kanbanBlocked`)
 * fold the profile's kanban tasks into the same workload signal, since kanban
 * nodes are not part of `workers`.
 *
 * KEY invariant: WAITING_IO / BLOCKED workers are still active, so a profile of
 * workers stuck waiting must NOT collapse to READY.
 */
export interface AggregateProfileOptions {
  /** Number of active kanban tasks for this profile (any non-done task). */
  kanbanActive?: number;
  /** Number of blocked kanban tasks for this profile. */
  kanbanBlocked?: number;
  /** Number of live external runtime processes attributed to this profile. */
  runtimeActive?: number;
  /** Root/ProfileController activity. It affects workload but is never a worker node. */
  controllerStatus?: string;
}

export function aggregateProfile(
  workers: WorkerLike[],
  opts?: AggregateProfileOptions,
): { availability: ProfileAvailability; workload: ProfileWorkload } {
  let anyBlocked = false;
  let anyActive = false;
  let anyOffline = false;

  for (const w of workers) {
    const state = inferNodeState(w.status ?? 'idle');
    if (state === 'BLOCKED') anyBlocked = true;
    if (isActiveState(state)) anyActive = true;
    if (w.offline === true) anyOffline = true;
  }

  let availability: ProfileAvailability = 'ONLINE';
  if (anyOffline) {
    availability = workers.every((w) => w.offline === true) ? 'OFFLINE' : 'DEGRADED';
  }

  const kanbanActive = opts?.kanbanActive ?? 0;
  const kanbanBlocked = opts?.kanbanBlocked ?? 0;
  const runtimeActive = opts?.runtimeActive ?? 0;
  const controllerStatus = (opts?.controllerStatus ?? '').trim().toLowerCase();
  const controllerState = controllerStatus ? inferNodeState(controllerStatus) : 'DONE';
  const controllerActive = isActiveState(controllerState);

  let workload: ProfileWorkload;
  if (anyBlocked || kanbanBlocked > 0 || controllerState === 'BLOCKED') {
    workload = 'BLOCKED';
  } else if (controllerStatus === 'planning') {
    workload = 'PLANNING';
  } else if (anyActive || kanbanActive > 0 || runtimeActive > 0 || controllerActive) {
    workload = 'EXECUTING';
  } else {
    workload = 'READY';
  }

  return { availability, workload };
}

// ── Active-state helper ──────────────────────────────────────

/** True for every node state except DONE/FAILED (a worker is still "doing something"). */
export function isActiveState(state: NodeState): boolean {
  return state !== 'DONE' && state !== 'FAILED';
}
