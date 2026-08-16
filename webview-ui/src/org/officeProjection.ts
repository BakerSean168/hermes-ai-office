import type { OrgNode, OrgProfile, OrgState } from './types.js';

export interface OrgOfficePresence {
  key: string;
  id: number;
  kind: 'controller' | 'worker';
  profileId: string;
  displayName: string;
  entityId: string;
  runId?: string;
  agentName: string;
  runtime?: string;
  model?: string;
  state: string;
  active: boolean;
  currentTool: string | null;
  activity: string;
  processId?: number;
  palette?: number;
}

const ORG_VISUAL_ID_BASE = 0x40000000;
const ORG_VISUAL_ID_MASK = 0x3fffffff;

/** Stable positive IDs in a namespace far above normal server-assigned agent ids. */
export function orgVisualId(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ORG_VISUAL_ID_BASE + ((hash >>> 0) & ORG_VISUAL_ID_MASK);
}

export function isActiveOrgState(state: string | undefined): boolean {
  return !!state && state !== 'DONE' && state !== 'FAILED';
}

function toolForState(state: string | undefined, currentTool?: string): string | null {
  if (currentTool) return currentTool;
  switch (state) {
    case 'STARTING':
    case 'THINKING':
      return 'Read';
    case 'CODING':
      return 'Write';
    case 'TERMINAL':
      return 'Terminal';
    case 'BROWSING':
      return 'WebSearch';
    case 'TESTING':
      return 'Test';
    case 'REVIEWING':
      return 'Read';
    case 'BLOCKED':
      return 'Permission';
    default:
      return null;
  }
}

function prettyState(state: string): string {
  return state
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function rolePrefix(role: string): string {
  switch (role) {
    case 'SUPERVISOR':
      return 'S';
    case 'ORCHESTRATOR':
      return 'O';
    case 'REVIEWER':
      return 'R';
    case 'RESEARCHER':
      return 'R';
    case 'TESTER':
      return 'T';
    case 'INTEGRATOR':
      return 'I';
    default:
      return 'E';
  }
}

function controllerPresence(profile: OrgProfile, profileIndex: number): OrgOfficePresence {
  const key = `controller:${profile.profileId}`;
  const state = profile.controllerState ?? (profile.workload === 'READY' ? 'DONE' : 'THINKING');
  const active = profile.controllerActive ?? profile.workload !== 'READY';
  return {
    key,
    id: orgVisualId(key),
    kind: 'controller',
    profileId: profile.profileId,
    displayName: profile.displayName ?? profile.profileId,
    entityId: profile.sessionId ?? key,
    agentName: 'Controller',
    runtime: 'hermes',
    model: profile.controllerModel,
    state,
    active,
    currentTool: toolForState(state),
    activity: profile.controllerAction?.trim() || (active ? prettyState(state) : 'Ready'),
    palette: profileIndex % 6,
  };
}

function shouldRenderNode(node: OrgNode): boolean {
  if (!isActiveOrgState(node.state)) return false;
  // Kanban task nodes are work records, not runtime identities. A real Hermes/
  // OpenCode/Codex node associated with the task is rendered separately.
  if (node.metadata?.kanban === true) return false;
  return true;
}

/** Project the authoritative organization snapshot into stable office presences. */
export function projectOrgOfficePresences(org: OrgState): OrgOfficePresence[] {
  const out: OrgOfficePresence[] = [];
  const profiles = new Map(org.profiles.map((p) => [p.profileId, p]));

  org.profiles.forEach((profile, index) => out.push(controllerPresence(profile, index)));

  const roleOrdinal = new Map<string, number>();
  const activeNodes = org.nodes
    .filter(shouldRenderNode)
    .sort(
      (a, b) =>
        a.profileId.localeCompare(b.profileId) ||
        a.startedAt - b.startedAt ||
        a.id.localeCompare(b.id),
    );

  for (const node of activeNodes) {
    const profile = profiles.get(node.profileId);
    if (!profile) continue;
    const prefix = rolePrefix(node.role);
    const ordinalKey = `${node.profileId}:${prefix}`;
    const ordinal = (roleOrdinal.get(ordinalKey) ?? 0) + 1;
    roleOrdinal.set(ordinalKey, ordinal);
    const key = `node:${node.id}`;
    out.push({
      key,
      id: orgVisualId(key),
      kind: 'worker',
      profileId: node.profileId,
      displayName: profile.displayName ?? profile.profileId,
      entityId: node.id,
      runId: node.runId || undefined,
      agentName: `#${prefix}${String(node.num ?? ordinal).padStart(2, '0')}`,
      runtime: node.runtime ?? node.type.toLowerCase(),
      model: node.model,
      state: node.state,
      active: true,
      currentTool: toolForState(node.state, node.currentTool),
      activity: node.currentAction?.trim() || node.taskTitle?.trim() || prettyState(node.state),
      processId: node.processId,
    });
  }

  return out;
}
