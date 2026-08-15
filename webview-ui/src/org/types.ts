/**
 * Organization graph types (Hermes bridge), mirroring the server-side orgModel.
 *
 * The webview cannot import server code (layering: webview-ui depends only on
 * core/), so these are a self-contained re-declaration of the shapes carried by
 * the `orgState` ServerMessage payload.
 */

export type ProfileAvailability = 'ONLINE' | 'DEGRADED' | 'OFFLINE';
export type ProfileWorkload = 'READY' | 'PLANNING' | 'SUPERVISING' | 'EXECUTING' | 'BLOCKED';

export interface OrgProfile {
  profileId: string;
  displayName?: string;
  availability: ProfileAvailability;
  workload: ProfileWorkload;
  sessionId?: string;
  mission?: string;
  lastSeenAt: number;
  lastResponseAt?: number;
}

export interface OrgRun {
  id: string;
  profileId: string;
  title: string;
  status: string;
  createdAt: number;
}

export interface OrgNode {
  id: string;
  profileId: string;
  runId: string;
  parentId?: string;
  type: string;
  role: string;
  runtime?: string;
  model?: string;
  taskId?: string;
  taskTitle?: string;
  num?: number;
  state: string;
  sessionId?: string;
  processId?: number;
  workspace?: string;
  currentTool?: string;
  currentAction?: string;
  tokensIn?: number;
  tokensOut?: number;
  cachedTokens?: number;
  cost?: number;
  elapsedSec?: number;
  startedAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface OrgEdge {
  id: string;
  runId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: string;
}

export interface OrgState {
  profiles: OrgProfile[];
  runs: OrgRun[];
  nodes: OrgNode[];
  edges: OrgEdge[];
}
