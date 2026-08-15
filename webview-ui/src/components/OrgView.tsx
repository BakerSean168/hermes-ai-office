import { type ReactNode, useMemo } from 'react';

import {
  ORG_AVAILABILITY_DEGRADED_COLOR,
  ORG_AVAILABILITY_OFFLINE_COLOR,
  ORG_AVAILABILITY_ONLINE_COLOR,
  ORG_STATE_COLORS,
  ORG_WORKLOAD_BLOCKED_COLOR,
  ORG_WORKLOAD_EXECUTING_COLOR,
  ORG_WORKLOAD_READY_COLOR,
} from '../constants.js';
import type { OrgNode, OrgProfile, OrgRun, OrgState } from '../org/types.js';

interface OrgViewProps {
  orgState: OrgState | null;
  onClose: () => void;
}

interface TreeNode {
  node: OrgNode;
  relation?: string;
  children: TreeNode[];
}

interface RunBlock {
  key: string;
  label: string;
  title: string;
  nodes: OrgNode[];
  tree: TreeNode[];
}

interface ProfileBlock {
  profile: OrgProfile;
  title: string;
  availability: string;
  workload: string;
  runs: RunBlock[];
}

const WORKLOAD_COLORS: Record<string, string> = {
  BLOCKED: ORG_WORKLOAD_BLOCKED_COLOR,
  EXECUTING: ORG_WORKLOAD_EXECUTING_COLOR,
  READY: ORG_WORKLOAD_READY_COLOR,
};

const AVAILABILITY_COLORS: Record<string, string> = {
  ONLINE: ORG_AVAILABILITY_ONLINE_COLOR,
  DEGRADED: ORG_AVAILABILITY_DEGRADED_COLOR,
  OFFLINE: ORG_AVAILABILITY_OFFLINE_COLOR,
};

const RUNTIME_LABELS: Record<string, string> = {
  HERMES_SUBAGENT: 'Hermes',
  OPENCODE: 'OpenCode',
  CODEX: 'Codex',
  TERMINAL: 'Terminal',
  BROWSER: 'Browser',
};

const ROLE_LABELS: Record<string, string> = {
  SUPERVISOR: 'Supervisor',
  ORCHESTRATOR: 'Orchestrator',
  REVIEWER: 'Reviewer',
  TESTER: 'Tester',
  RESEARCHER: 'Researcher',
  INTEGRATOR: 'Integrator',
};

function stateColor(state: string): string {
  return ORG_STATE_COLORS[state] ?? ORG_STATE_COLORS.DONE;
}

function isKanban(node: OrgNode): boolean {
  return node.metadata?.kanban === true;
}

/** A node is "active" unless it is DONE/FAILED (mirrors the server's isActiveState). */
function isActiveNodeState(state: string): boolean {
  return state !== 'DONE' && state !== 'FAILED';
}

function rolePrefix(role: string): string {
  switch (role) {
    case 'SUPERVISOR':
      return 'S';
    case 'ORCHESTRATOR':
      return 'O';
    case 'EXECUTOR':
      return 'E';
    case 'REVIEWER':
      return 'R';
    case 'RESEARCHER':
      return 'R';
    case 'TESTER':
      return 'T';
    case 'INTEGRATOR':
      return 'I';
    default:
      return 'X';
  }
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? '';
}

function runtimeLabel(node: OrgNode): string {
  if (node.type === 'OTHER') return node.runtime ?? 'agent';
  return RUNTIME_LABELS[node.type] ?? node.type;
}

function nodeNumber(node: OrgNode): string {
  const prefix = rolePrefix(node.role);
  if (node.num !== undefined) return `#${prefix}${String(node.num).padStart(2, '0')}`;
  return `#${prefix}--`;
}

function formatElapsed(sec?: number): string {
  if (sec === undefined || sec < 0) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `⚡ <command…>` hint for spawn-correlated nodes (first 20 chars of the command). */
function spawnCommand(node: OrgNode): string {
  const spawn = node.metadata?.spawnId as { command?: string } | undefined;
  if (!spawn || typeof spawn.command !== 'string' || !spawn.command) return '';
  const cmd = spawn.command.length > 20 ? `${spawn.command.slice(0, 20)}…` : spawn.command;
  return `⚡ ${cmd}`;
}

function buildBlocks(orgState: OrgState | null): ProfileBlock[] {
  if (!orgState) return [];
  const relationByKey = new Map<string, string>(
    orgState.edges.map((e) => [`${e.fromNodeId}->${e.toNodeId}`, e.relation]),
  );
  const runById = new Map<string, OrgRun>(orgState.runs.map((r) => [r.id, r]));

  return orgState.profiles.map((profile) => {
    const profileNodes = orgState.nodes.filter((n) => n.profileId === profile.profileId);

    const byRun = new Map<string, OrgNode[]>();
    for (const n of profileNodes) {
      const key = n.runId || 'active';
      const list = byRun.get(key) ?? [];
      list.push(n);
      byRun.set(key, list);
    }
    const keys = [...byRun.keys()].sort((a, b) => {
      if (a === 'active') return -1;
      if (b === 'active') return 1;
      return a.localeCompare(b);
    });

    const runs: RunBlock[] = keys.map((key) => {
      const nodes = byRun.get(key)!;
      const run = key === 'active' ? undefined : runById.get(key);
      const title =
        (run && run.title) ||
        nodes.find((n) => n.taskTitle)?.taskTitle ||
        profile.mission ||
        'Active';
      return {
        key,
        label: key === 'active' ? 'Active' : `Run #${key}`,
        title,
        nodes,
        tree: buildTree(nodes, relationByKey),
      };
    });

    return {
      profile,
      title: profile.displayName ?? profile.mission ?? profile.profileId,
      availability: profile.availability,
      workload: profile.workload,
      runs,
    };
  });
}

/** Build the nested tree for one run: top-level = nodes with no in-run parent. */
function buildTree(nodes: OrgNode[], relationByKey: Map<string, string>): TreeNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const byParent = new Map<string, OrgNode[]>();
  for (const n of nodes) {
    const parentId = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    const siblings = byParent.get(parentId ?? '') ?? [];
    siblings.push(n);
    byParent.set(parentId ?? '', siblings);
  }

  const visited = new Set<string>();
  const build = (node: OrgNode): TreeNode => {
    visited.add(node.id);
    const children = (byParent.get(node.id) ?? [])
      .filter((c) => !visited.has(c.id))
      .map((c) => ({
        node: c,
        relation: relationByKey.get(`${node.id}->${c.id}`),
        children: build(c).children,
      }));
    return { node, children };
  };

  return (byParent.get('') ?? []).map(build);
}

interface OrgStats {
  profiles: number;
  activeRuns: number;
  activeExecutors: number;
}

function computeStats(orgState: OrgState | null): OrgStats {
  if (!orgState) return { profiles: 0, activeRuns: 0, activeExecutors: 0 };
  const activeExecutors = orgState.nodes.filter((n) => isActiveNodeState(n.state)).length;

  // active runs = distinct (profile, run) groups containing at least one active node
  const activeRuns = new Set<string>();
  for (const n of orgState.nodes) {
    if (!isActiveNodeState(n.state)) continue;
    activeRuns.add(`${n.profileId}\u0000${n.runId || ''}`);
  }

  return {
    profiles: orgState.profiles.length,
    activeRuns: activeRuns.size,
    activeExecutors,
  };
}

export function OrgView({ orgState, onClose }: OrgViewProps) {
  const blocks = useMemo(() => buildBlocks(orgState), [orgState]);
  const stats = useMemo(() => computeStats(orgState), [orgState]);

  const nodesById = useMemo(
    () => new Map<string, OrgNode>(orgState?.nodes.map((n) => [n.id, n]) ?? []),
    [orgState],
  );
  const dependsOnByTo = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of orgState?.edges ?? []) {
      if (e.relation !== 'DEPENDS_ON') continue;
      const list = map.get(e.toNodeId) ?? [];
      list.push(e.fromNodeId);
      map.set(e.toNodeId, list);
    }
    return map;
  }, [orgState]);

  return (
    <div className="org-sans absolute inset-0 z-30 bg-bg-dark flex flex-col">
      <div className="flex items-center justify-between p-6 border-b-2 border-border">
        <div className="flex items-center gap-4">
          <span className="text-xl">🌐 Organization</span>
          <span className="text-sm text-text-muted">
            {stats.profiles} Profiles · {stats.activeRuns} Active Runs · {stats.activeExecutors}{' '}
            Active Executors
          </span>
        </div>
        <button
          onClick={onClose}
          className="px-6 py-2 text-base bg-btn-bg hover:bg-btn-hover border-2 border-border rounded-none cursor-pointer"
        >
          Back to Office
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {blocks.length === 0 ? (
          <div className="text-base text-text-muted">
            No Hermes bridge data yet. Waiting for the first board frame…
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {blocks.map((block) => (
              <div
                key={block.profile.profileId}
                className="pixel-panel p-6"
                style={{ backgroundColor: 'var(--color-bg)' }}
              >
                <div className="flex items-center gap-4 mb-4">
                  <span className="text-xl">🏢</span>
                  <span className="text-lg">{block.title}</span>
                  <Badge
                    label={block.workload}
                    color={WORKLOAD_COLORS[block.workload] ?? ORG_WORKLOAD_READY_COLOR}
                  />
                  <Badge
                    label={block.availability}
                    color={
                      AVAILABILITY_COLORS[block.availability] ?? ORG_AVAILABILITY_OFFLINE_COLOR
                    }
                  />
                </div>

                {block.runs.map((run) => (
                  <div key={run.key} className="mb-4 last:mb-0">
                    <RunHeader run={run} />
                    {run.tree.length === 0 ? (
                      <div className="pl-10 text-sm text-text-muted">No active workers</div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {run.tree.map((t) => (
                          <NodeRow
                            key={t.node.id}
                            treeNode={t}
                            depth={0}
                            nodesById={nodesById}
                            dependsOnByTo={dependsOnByTo}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RunHeader({ run }: { run: RunBlock }) {
  const active = run.nodes.filter((n) => isActiveNodeState(n.state)).length;
  const totalElapsed = run.nodes.reduce((sum, n) => {
    if (!isActiveNodeState(n.state)) return sum;
    return sum + (n.elapsedSec ?? 0);
  }, 0);
  return (
    <div className="flex items-center gap-3 text-sm text-text-muted mb-1">
      <span>└─</span>
      <span className="text-text">Run</span>
      <span className="text-text">{run.label}</span>
      <span className="text-text-muted">"{run.title}"</span>
      <span className="text-2xs">
        ({run.nodes.length} nodes · {active} active{totalElapsed > 0 ? ` · ${formatElapsed(totalElapsed)}` : ''})
      </span>
    </div>
  );
}

interface NodeRowProps {
  treeNode: TreeNode;
  depth: number;
  nodesById: Map<string, OrgNode>;
  dependsOnByTo: Map<string, string[]>;
}

function NodeRow({ treeNode, depth, nodesById, dependsOnByTo }: NodeRowProps) {
  const { node, relation } = treeNode;
  const kanban = isKanban(node);
  const pid = node.processId !== undefined ? `[PID ${node.processId}]` : '';
  const spawnCmd = spawnCommand(node);
  const indent = depth * 24;
  const elapsed = formatElapsed(node.elapsedSec);
  const role = roleLabel(node.role);

  let content: ReactNode;
  if (kanban) {
    content = (
      <>
        <span className="text-xl">📋</span>
        <span className="truncate">{node.taskTitle ?? node.taskId}</span>
        <Badge label={node.state} color={stateColor(node.state)} />
        {elapsed && <span className="text-2xs text-text-muted">{elapsed}</span>}
        {pid && <span className="text-2xs text-text-muted">{pid}</span>}
        {spawnCmd && <span className="text-2xs text-text-muted">{spawnCmd}</span>}
        {renderDependencies(node, nodesById, dependsOnByTo)}
      </>
    );
  } else {
    content = (
      <>
        <span className="text-text-muted">{nodeNumber(node)}</span>
        <span>{runtimeLabel(node)}</span>
        {role && <span className="text-text-muted">{role}</span>}
        {node.model && <span className="text-text-muted">· {node.model}</span>}
        <Badge label={node.state} color={stateColor(node.state)} />
        {elapsed && <span className="text-2xs text-text-muted">{elapsed}</span>}
        {pid && <span className="text-2xs text-text-muted">{pid}</span>}
        {spawnCmd && <span className="text-2xs text-text-muted">{spawnCmd}</span>}
      </>
    );
  }

  return (
    <>
      <div
        className="flex items-center gap-3 text-sm py-1"
        style={{ paddingLeft: indent }}
        title={relation ?? undefined}
      >
        <span className="text-text-muted">{depth === 0 ? '' : '└'}</span>
        {content}
      </div>
      {node.taskTitle && !kanban && (
        <div
          className="text-2xs text-text-muted truncate"
          style={{ paddingLeft: indent + 40 }}
          title={node.taskTitle}
        >
          {node.taskTitle}
        </div>
      )}
      {treeNode.children.map((child) => (
        <NodeRow
          key={child.node.id}
          treeNode={child}
          depth={depth + 1}
          nodesById={nodesById}
          dependsOnByTo={dependsOnByTo}
        />
      ))}
    </>
  );
}

function renderDependencies(
  node: OrgNode,
  nodesById: Map<string, OrgNode>,
  dependsOnByTo: Map<string, string[]>,
): ReactNode {
  const deps = dependsOnByTo.get(node.id);
  if (!deps || deps.length === 0) return null;
  return (
    <span className="text-2xs text-text-muted">
      depends on{' '}
      {deps
        .map((fromId) => {
          const from = nodesById.get(fromId);
          return from?.taskTitle ?? from?.taskId ?? fromId;
        })
        .join(', ')}
    </span>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-block px-3 py-1 text-2xs border-2 rounded-none"
      style={{ color, borderColor: color }}
    >
      {label}
    </span>
  );
}
