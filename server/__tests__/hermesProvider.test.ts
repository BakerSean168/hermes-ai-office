import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { OrgStore } from '../src/orgStore.js';
import type {
  HermesBoard,
  HermesKanban,
  HermesSpawn,
} from '../src/providers/hermes/bridgeClient.js';
import {
  buildKanbanNodes,
  buildProcessNodes,
  buildProfileAreaMappings,
  diffBoard,
  formatHermesToolStatus,
  hermesContextWindowForModel,
  HermesProvider,
  isActiveWorkerStatus,
  isSupervisorWorker,
  kanbanNodeId,
  kanbanStateToNodeState,
  matchSpawnsToWorkers,
  resolveWorkerProcessId,
  SPAWN_MATCH_WINDOW_SEC,
  spawnEdgeRelation,
  statusToToolName,
  workerSessionId,
} from '../src/providers/hermes/hermesProvider.js';

// ── Fixture board snapshots (mirroring hermes-office-bridge) ──

const emptyBoard: HermesBoard = { gateway: { active_agents: 0 }, teams: [] };

const oneWorkerBoard: HermesBoard = {
  gateway: { version: '0.20.0', active_agents: 1, active_sessions: 1 },
  teams: [
    {
      name: 'memoflow',
      display: 'MemoFlow',
      worker_total: 3,
      worker_active: 1,
      mission: 'Sync Engine v2',
      workers: [
        {
          id: 'w1',
          num: 1,
          runtime: 'opencode',
          model: 'deepseek-v4-flash',
          task: 'DeepSeek V4 Pro 版本状态核查',
          action: 'receiving stream response',
          status: 'llm_running',
        },
      ],
    },
  ],
};

describe('hermesProvider helpers', () => {
  it('maps status → tool name', () => {
    expect(statusToToolName('planning')).toBe('Plan');
    expect(statusToToolName('llm_running')).toBe('Think');
    expect(statusToToolName('coding')).toBe('Write');
    expect(statusToToolName('browsing')).toBe('WebSearch');
    expect(statusToToolName('testing')).toBe('Test');
    expect(statusToToolName('reviewing')).toBe('Read');
    expect(statusToToolName('waiting_io')).toBe('Wait');
    expect(statusToToolName('blocked')).toBe('Permission');
    expect(statusToToolName('working')).toBe('Write');
    expect(statusToToolName('idle')).toBe('');
    expect(statusToToolName(undefined)).toBe('');
  });

  it('classifies active vs idle worker status', () => {
    expect(isActiveWorkerStatus('idle')).toBe(false);
    expect(isActiveWorkerStatus(undefined)).toBe(false);
    expect(isActiveWorkerStatus('waiting_io')).toBe(true);
    expect(isActiveWorkerStatus('blocked')).toBe(true);
    expect(isActiveWorkerStatus('coding')).toBe(true);
  });

  it('builds stable worker session ids', () => {
    const team = { name: 'memoflow', workers: [] };
    expect(workerSessionId(team, { id: 'w1' })).toBe('hermes:memoflow:w1');
  });

  it('formats tool status with task/action/fallback', () => {
    expect(formatHermesToolStatus('Write', { task: 'Fix bug' })).toBe('Writing: Fix bug');
    expect(formatHermesToolStatus('Test')).toBe('Testing');
    expect(formatHermesToolStatus('Plan', { action: 'drafting' })).toBe('Planning: drafting');
  });

  it('resolves context windows with a 128k default', () => {
    expect(hermesContextWindowForModel('deepseek-v4-flash')).toBe(1_048_576);
    expect(hermesContextWindowForModel('deepseek-v4-pro')).toBe(1_048_576);
    expect(hermesContextWindowForModel('gpt-5.6-sol')).toBe(400_000);
    expect(hermesContextWindowForModel('unknown-model')).toBe(128_000);
    expect(hermesContextWindowForModel(undefined)).toBe(128_000);
  });
});

describe('buildProfileAreaMappings', () => {
  it('maps each team display name to itself in board order', () => {
    const { mappings, names } = buildProfileAreaMappings([
      { name: 'default', display: 'Default', workers: [] },
      { name: 'memoflow', display: 'MemoFlow', workers: [] },
      { name: 'bodysense', display: 'BodySense', workers: [] },
    ]);
    expect(names).toEqual(['Default', 'MemoFlow', 'BodySense']);
    expect(mappings).toEqual({
      Default: ['Default'],
      MemoFlow: ['MemoFlow'],
      BodySense: ['BodySense'],
    });
  });

  it('falls back to team name when display is absent', () => {
    const { mappings, names } = buildProfileAreaMappings([
      { name: 'memoflow', workers: [] },
      { name: '', display: '', workers: [] },
    ]);
    expect(names).toEqual(['memoflow']);
    expect(mappings).toEqual({ memoflow: ['memoflow'] });
  });
});

describe('diffBoard', () => {
  it('emits sessionStart + toolStart for a new active worker', () => {
    const events = diffBoard(null, oneWorkerBoard);
    expect(events.map((e) => e.event.kind)).toEqual(['sessionStart', 'toolStart']);
    expect(events[0].sessionId).toBe('hermes:memoflow:w1');
    const tool = events[1].event;
    if (tool.kind === 'toolStart') {
      expect(tool.toolName).toBe('Think');
    }
  });

  it('emits nothing for a new idle worker beyond sessionStart', () => {
    const board: HermesBoard = {
      teams: [{ name: 't', workers: [{ id: 'w1', status: 'idle' }] }],
    };
    const events = diffBoard(null, board);
    expect(events.map((e) => e.event.kind)).toEqual(['sessionStart']);
  });

  it('emits toolEnd + toolStart on status change', () => {
    const prev: HermesBoard = {
      teams: [{ name: 't', workers: [{ id: 'w1', status: 'coding' }] }],
    };
    const next: HermesBoard = {
      teams: [{ name: 't', workers: [{ id: 'w1', status: 'browsing' }] }],
    };
    const kinds = diffBoard(prev, next).map((e) => e.event.kind);
    expect(kinds).toEqual(['toolEnd', 'toolStart']);
  });

  it('emits toolEnd + turnEnd when a worker goes idle', () => {
    const prev: HermesBoard = {
      teams: [{ name: 't', workers: [{ id: 'w1', status: 'coding' }] }],
    };
    const next: HermesBoard = {
      teams: [{ name: 't', workers: [{ id: 'w1', status: 'idle' }] }],
    };
    const kinds = diffBoard(prev, next).map((e) => e.event.kind);
    expect(kinds).toEqual(['toolEnd', 'turnEnd']);
  });

  it('emits toolEnd + turnEnd + sessionEnd when a worker disappears', () => {
    const prev: HermesBoard = {
      teams: [{ name: 't', workers: [{ id: 'w1', status: 'coding' }] }],
    };
    const kinds = diffBoard(prev, emptyBoard).map((e) => e.event.kind);
    expect(kinds).toEqual(['toolEnd', 'turnEnd', 'sessionEnd']);
  });

  it('emits no events for an unchanged board', () => {
    expect(diffBoard(oneWorkerBoard, oneWorkerBoard)).toEqual([]);
  });
});

describe('resolveWorkerProcessId', () => {
  const processes = [
    { pid: 101, cwd: '/repo/a', command: 'opencode run' },
    { pid: 202, cwd: '/repo/b', command: 'codex' },
    { pid: 303, cwd: '/repo/c', command: 'node server.js' },
  ];

  it('prefers an explicit process_id over matching', () => {
    const pid = resolveWorkerProcessId(
      { process_id: 999, workspace: '/repo/a', runtime: 'opencode' },
      processes,
    );
    expect(pid).toBe(999);
  });

  it('matches by workspace + runtime when process_id is absent', () => {
    const pid = resolveWorkerProcessId({ workspace: '/repo/b', runtime: 'codex' }, processes);
    expect(pid).toBe(202);
  });

  it('matches by workspace alone when runtime is unknown', () => {
    const pid = resolveWorkerProcessId({ workspace: '/repo/a', runtime: '' }, processes);
    expect(pid).toBe(101);
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveWorkerProcessId({ workspace: '/nowhere' }, processes)).toBeUndefined();
    expect(resolveWorkerProcessId({}, processes)).toBeUndefined();
  });
});

describe('kanban mapping', () => {
  it('maps statuses to node states', () => {
    expect(kanbanStateToNodeState('todo')).toBe('STARTING');
    expect(kanbanStateToNodeState('ready')).toBe('WAITING_IO');
    expect(kanbanStateToNodeState('running')).toBe('CODING');
    expect(kanbanStateToNodeState('blocked')).toBe('BLOCKED');
    expect(kanbanStateToNodeState('done')).toBe('DONE');
    expect(kanbanStateToNodeState('archived')).toBe('DONE');
    expect(kanbanStateToNodeState(undefined)).toBe('STARTING');
  });

  it('builds kanban nodes attached directly to the profile (no parentId)', () => {
    const kanban: HermesKanban = {
      tasks: [
        {
          id: 't1',
          title: 'Wire the API',
          assignee: 'memoflow',
          status: 'running',
          priority: 2,
          workspace_path: '/repo/a',
        },
        { id: 't2', title: 'Ship docs', assignee: 'memoflow', status: 'todo' },
      ],
      links: [{ parent_id: 't2', child_id: 't1' }],
      runs: [
        {
          id: 7,
          task_id: 't1',
          profile: 'memoflow',
          status: 'running',
          worker_pid: 101,
          started_at: 100,
        },
      ],
    };
    const result = buildKanbanNodes(kanban, {
      profileIds: new Set(['memoflow']),
      processes: [{ pid: 101, cwd: '/repo/a', command: 'opencode' }],
      now: 123,
    });

    expect(result.nodes).toHaveLength(2);
    const t1 = result.nodes.find((n) => n.id === kanbanNodeId('t1'))!;
    expect(t1.parentId).toBeUndefined();
    expect(t1.runId).toBe('kanban:memoflow:7');
    expect(t1.type).toBe('OTHER');
    expect(t1.role).toBe('EXECUTOR');
    expect(t1.state).toBe('CODING');
    expect(t1.taskId).toBe('t1');
    expect(t1.taskTitle).toBe('Wire the API');
    expect(t1.processId).toBe(101);
    expect(t1.metadata).toMatchObject({ kanban: true, priority: 2 });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].relation).toBe('DEPENDS_ON');
    expect(result.edges[0].fromNodeId).toBe(kanbanNodeId('t2'));
    expect(result.edges[0].toNodeId).toBe(kanbanNodeId('t1'));

    // worker_pid → task_id association for worker nodes
    expect(result.pidToTaskId.get(101)).toBe('t1');
  });

  it('skips completed tasks from the live graph', () => {
    const result = buildKanbanNodes(
      {
        tasks: [{ id: 'done1', title: 'Old work', assignee: 'memoflow', status: 'done' }],
        links: [],
        runs: [{ id: 9, task_id: 'done1', profile: 'memoflow', status: 'done' }],
      },
      { profileIds: new Set(['memoflow']), processes: [], now: 0 },
    );
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('skips tasks whose assignee is not a known profile and unmatched pids', () => {
    const kanban: HermesKanban = {
      tasks: [{ id: 't9', title: 'Orphan', assignee: 'ghost', status: 'done' }],
      links: [],
      runs: [{ task_id: 't9', worker_pid: 404 }],
    };
    const result = buildKanbanNodes(kanban, {
      profileIds: new Set(['memoflow']),
      processes: [],
      now: 0,
    });
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

describe('process node mapping', () => {
  it('turns a live OpenCode process into an executor node attributed by cwd', () => {
    const result = buildProcessNodes(
      [
        {
          pid: 321,
          cwd: '/workspace/repos/memoflow',
          command: 'opencode run -m ds-v4',
          runtime: 'opencode',
          model: 'ds-v4',
          profile_hint: 'memoflow',
        },
      ],
      { profileIds: new Set(['memoflow']), ownedPids: new Set(), spawns: [], now: 123 },
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: 'process:321',
      profileId: 'memoflow',
      type: 'OPENCODE',
      role: 'EXECUTOR',
      state: 'TERMINAL',
      processId: 321,
      model: 'ds-v4',
    });
  });

  it('uses spawn metadata for parent/run and skips already-owned pids', () => {
    const spawn: HermesSpawn = {
      profileId: 'memoflow',
      runId: 'run-9',
      parentNodeId: 'hermes:memoflow:s1',
      runtime: 'codex',
      cwd: '/workspace/repos/memoflow',
      command: 'codex review',
      createdAt: 100,
    };
    const result = buildProcessNodes(
      [{ pid: 777, cwd: '/workspace/repos/memoflow', command: 'codex review', runtime: 'codex' }],
      { profileIds: new Set(['memoflow']), ownedPids: new Set(), spawns: [spawn], now: 123 },
    );
    expect(result.nodes[0]).toMatchObject({
      parentId: 'hermes:memoflow:s1',
      runId: 'run-9',
      type: 'CODEX',
    });
    expect(result.edges[0]).toMatchObject({
      fromNodeId: 'hermes:memoflow:s1',
      toNodeId: 'process:777',
      relation: 'SPAWNED',
    });
    expect(
      buildProcessNodes(
        [{ pid: 777, cwd: '/workspace/repos/memoflow', command: 'codex review', runtime: 'codex' }],
        { profileIds: new Set(['memoflow']), ownedPids: new Set([777]), spawns: [spawn], now: 123 },
      ).nodes,
    ).toHaveLength(0);
  });
});

describe('spawn correlation', () => {
  const spawn = (over: Partial<HermesSpawn>): HermesSpawn => ({
    profileId: 'memoflow',
    runtime: 'opencode',
    createdAt: 1_000_000,
    ...over,
  });

  it('matches a worker to a spawn within the window on profile + runtime', () => {
    const matched = matchSpawnsToWorkers(
      [
        {
          sessionId: 'hermes:memoflow:w1',
          profileId: 'memoflow',
          runtime: 'opencode',
          lastActivitySec: 1_000_100,
        },
      ],
      [spawn({ createdAt: 1_000_000 })],
      1_000_100,
    );
    expect(matched.get('hermes:memoflow:w1')?.createdAt).toBe(1_000_000);
  });

  it('skips spawns outside the 5-minute window', () => {
    const matched = matchSpawnsToWorkers(
      [
        {
          sessionId: 'hermes:memoflow:w1',
          profileId: 'memoflow',
          runtime: 'opencode',
          lastActivitySec: 1_000_000,
        },
      ],
      [spawn({ createdAt: 1_000_000 + SPAWN_MATCH_WINDOW_SEC + 1 })],
      1_000_000,
    );
    expect(matched.size).toBe(0);
  });

  it('skips spawns whose runtime disagrees with the worker', () => {
    const matched = matchSpawnsToWorkers(
      [
        {
          sessionId: 'hermes:memoflow:w1',
          profileId: 'memoflow',
          runtime: 'opencode',
          lastActivitySec: 1_000_000,
        },
      ],
      [spawn({ runtime: 'codex', createdAt: 1_000_000 })],
      1_000_000,
    );
    expect(matched.size).toBe(0);
  });

  it('assigns each spawn to at most one worker (first-come-first-serve)', () => {
    const matched = matchSpawnsToWorkers(
      [
        {
          sessionId: 'hermes:memoflow:w1',
          profileId: 'memoflow',
          runtime: 'opencode',
          lastActivitySec: 1_000_000,
        },
        {
          sessionId: 'hermes:memoflow:w2',
          profileId: 'memoflow',
          runtime: 'opencode',
          lastActivitySec: 1_000_000,
        },
      ],
      [spawn({ createdAt: 1_000_000 })],
      1_000_000,
    );
    expect(matched.size).toBe(1);
  });

  it('matches the nearest spawn when several are within the window', () => {
    const matched = matchSpawnsToWorkers(
      [
        {
          sessionId: 'hermes:memoflow:w1',
          profileId: 'memoflow',
          runtime: 'opencode',
          lastActivitySec: 1_000_000,
        },
      ],
      [spawn({ createdAt: 999_800 }), spawn({ createdAt: 999_950 })],
      1_000_000,
    );
    expect(matched.get('hermes:memoflow:w1')?.createdAt).toBe(999_950);
  });

  it('flags a worker as supervisor via delegation text or being a spawn parent', () => {
    expect(
      isSupervisorWorker({ task: 'dispatch work', action: '' }, 'hermes:memoflow:w1', []),
    ).toBe(true);
    expect(isSupervisorWorker({ task: '', action: '派发任务' }, 'hermes:memoflow:w1', [])).toBe(
      true,
    );
    expect(isSupervisorWorker({ task: '', action: 'idle' }, 'hermes:memoflow:w1', [])).toBe(false);
    expect(
      isSupervisorWorker({ task: '', action: 'idle' }, 'hermes:memoflow:w1', [
        spawn({ parentNodeId: 'hermes:memoflow:w1' }),
      ]),
    ).toBe(true);
  });

  it('derives the edge relation from the spawn parent', () => {
    expect(spawnEdgeRelation(spawn({}), undefined)).toBe('SPAWNED');
    expect(spawnEdgeRelation(spawn({ parentNodeId: 'memoflow:root' }), 'SUPERVISOR')).toBe(
      'SUPERVISES',
    );
    expect(spawnEdgeRelation(spawn({ parentNodeId: 'memoflow:root' }), 'EXECUTOR')).toBe(
      'DELEGATED',
    );
  });
});

describe('HermesProvider spawn correlation integration', () => {
  async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('condition not met within timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('correlates a spawn to a worker (parentId, metadata, supervisor edge)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const board: HermesBoard = {
      teams: [
        {
          name: 'memoflow',
          display: 'MemoFlow',
          workers: [
            {
              id: 'w-super',
              num: 1,
              runtime: 'hermes',
              task: 'dispatch work',
              action: '',
              status: 'idle',
              last_activity_at: nowSec,
            },
            {
              id: 'w-exec',
              num: 2,
              runtime: 'opencode',
              task: 'run',
              action: '',
              status: 'coding',
              last_activity_at: nowSec,
            },
          ],
        },
      ],
    };
    const spawns: HermesSpawn[] = [
      {
        profileId: 'memoflow',
        runtime: 'opencode',
        parentNodeId: 'hermes:memoflow:w-super',
        cwd: '/workspace/repos/memoflow',
        command: 'opencode run',
        createdAt: nowSec,
      },
    ];
    const emptyKanban: HermesKanban = { tasks: [], links: [], runs: [] };

    const store = new AgentStateStore();
    const orgStore = new OrgStore();
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/events')) {
        return new Response('unavailable', { status: 503 });
      }
      if (u.endsWith('/api/board')) {
        return new Response(JSON.stringify(board), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.endsWith('/api/spawns')) {
        return new Response(JSON.stringify(spawns), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.endsWith('/api/kanban')) {
        return new Response(JSON.stringify(emptyKanban), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const provider = new HermesProvider({ store, orgStore, baseUrl: 'http://test', fetchImpl });
    provider.start();
    try {
      await waitFor(
        () => orgStore.nodes.get('hermes:memoflow:w-exec')?.metadata?.spawnId !== undefined,
      );

      const exec = orgStore.nodes.get('hermes:memoflow:w-exec')!;
      expect(exec.parentId).toBe('hermes:memoflow:w-super');
      expect((exec.metadata?.spawnId as HermesSpawn).command).toBe('opencode run');

      const supervisor = orgStore.nodes.get('hermes:memoflow:w-super')!;
      expect(supervisor.role).toBe('SUPERVISOR');

      const edge = orgStore.snapshot().edges.find((e) => e.toNodeId === 'hermes:memoflow:w-exec')!;
      expect(edge.fromNodeId).toBe('hermes:memoflow:w-super');
      expect(edge.relation).toBe('SUPERVISES');
    } finally {
      provider.stop();
    }
  });
});

describe('HermesProvider profile aggregation integration', () => {
  async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('condition not met within timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function makeFetchImpl(
    board: HermesBoard,
    kanban: HermesKanban,
    spawns: HermesSpawn[] = [],
  ): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/events')) {
        return new Response('unavailable', { status: 503 });
      }
      if (u.endsWith('/api/board')) {
        return new Response(JSON.stringify(board), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.endsWith('/api/spawns')) {
        return new Response(JSON.stringify(spawns), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.endsWith('/api/kanban')) {
        return new Response(JSON.stringify(kanban), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  }

  const emptyKanban: HermesKanban = { tasks: [], links: [], runs: [] };

  it('does not create a fake root supervisor node or a default run', async () => {
    const board: HermesBoard = {
      teams: [
        {
          name: 'memoflow',
          display: 'MemoFlow',
          mission: 'Sync Engine v2',
          workers: [{ id: 'w1', num: 1, runtime: 'opencode', status: 'coding', task: 'Wire API' }],
        },
      ],
    };
    const store = new AgentStateStore();
    const orgStore = new OrgStore();
    const provider = new HermesProvider({
      store,
      orgStore,
      baseUrl: 'http://test',
      fetchImpl: makeFetchImpl(board, emptyKanban),
    });
    provider.start();
    try {
      await waitFor(() => orgStore.nodes.get('hermes:memoflow:w1') !== undefined);

      const snap = orgStore.snapshot();
      expect(snap.nodes.some((n) => n.id === 'memoflow:root')).toBe(false);
      expect(snap.runs.some((r) => r.id === 'memoflow:run')).toBe(false);

      const w1 = orgStore.nodes.get('hermes:memoflow:w1')!;
      expect(w1.parentId).toBeUndefined();
      expect(w1.runId).toBe('');

      const profile = orgStore.profiles.get('memoflow')!;
      expect(profile.workload).toBe('EXECUTING');
      expect(profile.displayName).toBe('MemoFlow');
      expect(profile.mission).toBe('Sync Engine v2');
    } finally {
      provider.stop();
    }
  });

  it('merges active kanban tasks into profile workload → EXECUTING', async () => {
    const board: HermesBoard = {
      teams: [{ name: 'memoflow', display: 'MemoFlow', workers: [{ id: 'w1', status: 'idle' }] }],
    };
    const kanban: HermesKanban = {
      tasks: [{ id: 't1', title: 'Wire API', assignee: 'memoflow', status: 'running' }],
      links: [],
      runs: [],
    };
    const store = new AgentStateStore();
    const orgStore = new OrgStore();
    const provider = new HermesProvider({
      store,
      orgStore,
      baseUrl: 'http://test',
      fetchImpl: makeFetchImpl(board, kanban),
    });
    provider.start();
    try {
      await waitFor(() => orgStore.profiles.get('memoflow')?.workload === 'EXECUTING');
      expect(orgStore.profiles.get('memoflow')!.workload).toBe('EXECUTING');
      expect(orgStore.nodes.has('kanban:t1')).toBe(true);
      // kanban nodes hang off a concrete task-run, not a synthetic profile run.
      const runId = orgStore.nodes.get('kanban:t1')!.runId;
      expect(runId).toBe('kanban:memoflow:task:t1');
      expect(orgStore.runs.get(runId)?.title).toBe('Wire API');
    } finally {
      provider.stop();
    }
  });

  it('marks the profile EXECUTING when the root controller is actively coding without creating a worker node', async () => {
    const board: HermesBoard = {
      teams: [
        {
          name: 'memoflow',
          controller: { session_id: 'root1', status: 'coding', is_active: true },
          workers: [],
        },
      ],
    };
    const store = new AgentStateStore();
    const orgStore = new OrgStore();
    const provider = new HermesProvider({
      store,
      orgStore,
      baseUrl: 'http://test',
      fetchImpl: makeFetchImpl(board, emptyKanban),
    });
    provider.start();
    try {
      await waitFor(() => orgStore.profiles.get('memoflow') !== undefined);
      expect(orgStore.profiles.get('memoflow')!.workload).toBe('EXECUTING');
      expect(orgStore.nodes.size).toBe(0);
    } finally {
      provider.stop();
    }
  });

  it('leaves a profile READY when its only worker is DONE and no kanban is active', async () => {
    const board: HermesBoard = {
      teams: [{ name: 'memoflow', workers: [{ id: 'w1', status: 'done' }] }],
    };
    const store = new AgentStateStore();
    const orgStore = new OrgStore();
    const provider = new HermesProvider({
      store,
      orgStore,
      baseUrl: 'http://test',
      fetchImpl: makeFetchImpl(board, emptyKanban),
    });
    provider.start();
    try {
      await waitFor(() => orgStore.profiles.get('memoflow') !== undefined);
      expect(orgStore.profiles.get('memoflow')!.workload).toBe('READY');
    } finally {
      provider.stop();
    }
  });
});
