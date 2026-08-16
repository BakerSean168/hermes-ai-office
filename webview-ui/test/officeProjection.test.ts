import { describe, expect, it } from 'vitest';

import { orgVisualId, projectOrgOfficePresences } from '../src/org/officeProjection.js';
import type { OrgState } from '../src/org/types.js';

describe('projectOrgOfficePresences', () => {
  it('always projects one stable controller presence per profile without making it an executor node', () => {
    const org: OrgState = {
      profiles: [
        {
          profileId: 'memoflow',
          displayName: 'MemoFlow',
          availability: 'ONLINE',
          workload: 'EXECUTING',
          sessionId: 'root1',
          controllerState: 'CODING',
          controllerActive: true,
          controllerModel: 'deepseek-v4-flash',
          controllerAction: 'terminal command running',
          lastSeenAt: 1,
        },
      ],
      runs: [],
      nodes: [],
      edges: [],
    };
    const result = projectOrgOfficePresences(org);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: orgVisualId('controller:memoflow'),
      kind: 'controller',
      profileId: 'memoflow',
      agentName: 'Controller',
      runtime: 'hermes',
      state: 'CODING',
      active: true,
      currentTool: 'Write',
      activity: 'terminal command running',
    });
  });

  it('maps live graph nodes 1:1 to workers and excludes Kanban placeholder nodes', () => {
    const org: OrgState = {
      profiles: [
        {
          profileId: 'memoflow',
          displayName: 'MemoFlow',
          availability: 'ONLINE',
          workload: 'EXECUTING',
          lastSeenAt: 1,
        },
      ],
      runs: [],
      nodes: [
        {
          id: 'hermes:memoflow:s1',
          profileId: 'memoflow',
          runId: 'interactive:memoflow:root1',
          type: 'HERMES_SUBAGENT',
          role: 'SUPERVISOR',
          runtime: 'hermes',
          model: 'deepseek-v4-flash',
          state: 'THINKING',
          startedAt: 1,
          updatedAt: 1,
        },
        {
          id: 'process:42',
          profileId: 'memoflow',
          runId: 'interactive:memoflow:root1',
          parentId: 'hermes:memoflow:s1',
          type: 'CODEX',
          role: 'EXECUTOR',
          runtime: 'codex',
          model: 'gpt-5.6-sol',
          state: 'TERMINAL',
          processId: 42,
          currentAction: 'codex exec …',
          startedAt: 2,
          updatedAt: 2,
        },
        {
          id: 'kanban:t1',
          profileId: 'memoflow',
          runId: 'kanban:memoflow:1',
          type: 'OTHER',
          role: 'EXECUTOR',
          state: 'CODING',
          startedAt: 3,
          updatedAt: 3,
          metadata: { kanban: true },
        },
      ],
      edges: [],
    };
    const result = projectOrgOfficePresences(org);
    expect(result.map((p) => p.kind)).toEqual(['controller', 'worker', 'worker']);
    expect(result.find((p) => p.entityId === 'hermes:memoflow:s1')).toMatchObject({
      agentName: '#S01',
      runtime: 'hermes',
    });
    expect(result.find((p) => p.entityId === 'process:42')).toMatchObject({
      agentName: ['#', 'E01'].join(''),
      runtime: 'codex',
      processId: 42,
      activity: 'codex exec …',
    });
    expect(result.some((p) => p.entityId === 'kanban:t1')).toBe(false);
  });

  it('does not render terminal graph nodes and keeps ids deterministic', () => {
    const key = 'node:process:99';
    expect(orgVisualId(key)).toBe(orgVisualId(key));
    const org: OrgState = {
      profiles: [
        {
          profileId: 'default',
          availability: 'ONLINE',
          workload: 'READY',
          lastSeenAt: 1,
        },
      ],
      runs: [],
      nodes: [
        {
          id: 'process:99',
          profileId: 'default',
          runId: '',
          type: 'OPENCODE',
          role: 'EXECUTOR',
          state: 'DONE',
          startedAt: 1,
          updatedAt: 1,
        },
      ],
      edges: [],
    };
    const result = projectOrgOfficePresences(org);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('controller');
    expect(result[0].active).toBe(false);
  });
});
