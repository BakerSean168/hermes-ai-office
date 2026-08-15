import { describe, expect, it } from 'vitest';

import { OrgStore } from '../src/orgStore.js';

describe('OrgStore', () => {
  it('upserts and snapshots profiles/runs/nodes/edges', () => {
    const store = new OrgStore();
    store.upsertProfile({
      profileId: 'p1',
      availability: 'ONLINE',
      workload: 'EXECUTING',
      lastSeenAt: 1,
    });
    store.upsertRun({
      id: 'r1',
      profileId: 'p1',
      title: 'Team 1',
      status: 'RUNNING',
      createdAt: 1,
    });
    store.upsertNode({
      id: 'w-super',
      profileId: 'p1',
      runId: 'r1',
      type: 'HERMES_SUBAGENT',
      role: 'SUPERVISOR',
      state: 'THINKING',
      startedAt: 1,
      updatedAt: 1,
    });
    store.upsertNode({
      id: 'w1',
      profileId: 'p1',
      runId: 'r1',
      parentId: 'w-super',
      type: 'OPENCODE',
      role: 'EXECUTOR',
      state: 'CODING',
      startedAt: 1,
      updatedAt: 1,
    });
    store.connect('w-super', 'w1', 'SPAWNED');

    const snap = store.snapshot();
    expect(snap.profiles).toHaveLength(1);
    expect(snap.runs).toHaveLength(1);
    expect(snap.nodes).toHaveLength(2);
    expect(snap.edges).toHaveLength(1);
    expect(snap.edges[0].relation).toBe('SPAWNED');
    expect(snap.edges[0].fromNodeId).toBe('w-super');
  });

  it('getGraph filters by run id', () => {
    const store = new OrgStore();
    store.upsertNode({
      id: 'a',
      profileId: 'p1',
      runId: 'r1',
      type: 'OTHER',
      role: 'EXECUTOR',
      state: 'DONE',
      startedAt: 1,
      updatedAt: 1,
    });
    store.upsertNode({
      id: 'b',
      profileId: 'p2',
      runId: 'r2',
      type: 'OTHER',
      role: 'EXECUTOR',
      state: 'DONE',
      startedAt: 1,
      updatedAt: 1,
    });
    expect(store.getGraph('r1').nodes.map((n) => n.id)).toEqual(['a']);
    expect(store.getGraph('r2').nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('clear empties every collection', () => {
    const store = new OrgStore();
    store.upsertProfile({
      profileId: 'p1',
      availability: 'ONLINE',
      workload: 'READY',
      lastSeenAt: 1,
    });
    store.clear();
    expect(store.snapshot().profiles).toHaveLength(0);
  });

  it('connect derives runId from the child node', () => {
    const store = new OrgStore();
    store.upsertNode({
      id: 'child',
      profileId: 'p1',
      runId: 'r9',
      type: 'OTHER',
      role: 'EXECUTOR',
      state: 'DONE',
      startedAt: 1,
      updatedAt: 1,
    });
    store.connect('parent', 'child', 'DELEGATED');
    const edges = store.snapshot().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].runId).toBe('r9');
  });
});
