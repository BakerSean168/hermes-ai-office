import { describe, expect, it } from 'vitest';

import {
  aggregateProfile,
  inferNodeRole,
  inferNodeState,
  inferNodeType,
  isActiveState,
} from '../src/providers/hermes/orgModel.js';

describe('orgModel', () => {
  describe('inferNodeType', () => {
    it('maps opencode → OPENCODE', () => {
      expect(inferNodeType('opencode')).toBe('OPENCODE');
    });
    it('maps codex → CODEX', () => {
      expect(inferNodeType('codex')).toBe('CODEX');
    });
    it('maps hermes → HERMES_SUBAGENT', () => {
      expect(inferNodeType('hermes')).toBe('HERMES_SUBAGENT');
    });
    it('maps unknown runtimes → OTHER', () => {
      expect(inferNodeType('claude')).toBe('OTHER');
      expect(inferNodeType('')).toBe('OTHER');
    });
  });

  describe('inferNodeRole', () => {
    it('detects reviewer from review/审查 keywords', () => {
      expect(inferNodeRole('reviewing', '')).toBe('REVIEWER');
      expect(inferNodeRole('idle', 'code 审查')).toBe('REVIEWER');
    });
    it('detects tester from test keyword', () => {
      expect(inferNodeRole('testing', '')).toBe('TESTER');
      expect(inferNodeRole('idle', 'running tests')).toBe('TESTER');
    });
    it('detects orchestrator from plan keyword', () => {
      expect(inferNodeRole('planning', '')).toBe('ORCHESTRATOR');
    });
    it('defaults to EXECUTOR', () => {
      expect(inferNodeRole('coding', 'writing file')).toBe('EXECUTOR');
    });
  });

  describe('inferNodeState', () => {
    it('maps llm_running → THINKING', () => {
      expect(inferNodeState('llm_running')).toBe('THINKING');
    });
    it('maps coding → CODING', () => {
      expect(inferNodeState('coding')).toBe('CODING');
    });
    it('maps browsing/testing/reviewing/waiting_io/blocked', () => {
      expect(inferNodeState('browsing')).toBe('BROWSING');
      expect(inferNodeState('testing')).toBe('TESTING');
      expect(inferNodeState('reviewing')).toBe('REVIEWING');
      expect(inferNodeState('waiting_io')).toBe('WAITING_IO');
      expect(inferNodeState('blocked')).toBe('BLOCKED');
    });
    it('maps idle → DONE', () => {
      expect(inferNodeState('idle')).toBe('DONE');
    });
    it('maps done/completed/finished/cancelled → DONE', () => {
      expect(inferNodeState('done')).toBe('DONE');
      expect(inferNodeState('completed')).toBe('DONE');
      expect(inferNodeState('finished')).toBe('DONE');
      expect(inferNodeState('cancelled')).toBe('DONE');
    });
    it('maps failed/error → FAILED', () => {
      expect(inferNodeState('failed')).toBe('FAILED');
      expect(inferNodeState('error')).toBe('FAILED');
    });
  });

  describe('aggregateProfile', () => {
    it('all idle → READY', () => {
      const agg = aggregateProfile([{ status: 'idle' }, { status: 'idle' }]);
      expect(agg.workload).toBe('READY');
      expect(agg.availability).toBe('ONLINE');
    });
    it('DONE-only workers → READY (done is not active)', () => {
      const agg = aggregateProfile([{ status: 'done' }, { status: 'completed' }]);
      expect(agg.workload).toBe('READY');
      expect(agg.availability).toBe('ONLINE');
    });
    it('FAILED/CANCELLED workers are not active → READY', () => {
      const agg = aggregateProfile([{ status: 'failed' }, { status: 'cancelled' }]);
      expect(agg.workload).toBe('READY');
    });
    it('any active worker → EXECUTING', () => {
      const agg = aggregateProfile([{ status: 'idle' }, { status: 'coding' }]);
      expect(agg.workload).toBe('EXECUTING');
    });
    it('WAITING_IO still counts as active → EXECUTING (not READY)', () => {
      const agg = aggregateProfile([{ status: 'waiting_io' }]);
      expect(agg.workload).toBe('EXECUTING');
    });
    it('BLOCKED worker → BLOCKED workload', () => {
      const agg = aggregateProfile([{ status: 'blocked' }, { status: 'coding' }]);
      expect(agg.workload).toBe('BLOCKED');
    });
    it('kanbanActive=1 → EXECUTING (kanban tasks merge into workload)', () => {
      const agg = aggregateProfile([{ status: 'idle' }], { kanbanActive: 1 });
      expect(agg.workload).toBe('EXECUTING');
    });
    it('runtimeActive=1 → EXECUTING even when no Hermes worker is active', () => {
      const agg = aggregateProfile([], { runtimeActive: 1 });
      expect(agg.workload).toBe('EXECUTING');
    });
    it('active ProfileController affects workload without becoming a worker', () => {
      expect(aggregateProfile([], { controllerStatus: 'coding' }).workload).toBe('EXECUTING');
      expect(aggregateProfile([], { controllerStatus: 'planning' }).workload).toBe('PLANNING');
      expect(aggregateProfile([], { controllerStatus: 'idle' }).workload).toBe('READY');
    });
    it('kanbanBlocked>0 → BLOCKED even with no active workers', () => {
      const agg = aggregateProfile([{ status: 'idle' }], { kanbanActive: 1, kanbanBlocked: 1 });
      expect(agg.workload).toBe('BLOCKED');
    });
    it('no kanban tasks → READY when all workers idle', () => {
      const agg = aggregateProfile([{ status: 'idle' }], { kanbanActive: 0, kanbanBlocked: 0 });
      expect(agg.workload).toBe('READY');
    });
    it('empty workers → READY/ONLINE', () => {
      const agg = aggregateProfile([]);
      expect(agg.workload).toBe('READY');
      expect(agg.availability).toBe('ONLINE');
    });
    it('all workers offline → OFFLINE', () => {
      const agg = aggregateProfile([{ status: 'idle', offline: true }]);
      expect(agg.availability).toBe('OFFLINE');
    });
    it('some workers offline → DEGRADED', () => {
      const agg = aggregateProfile([{ status: 'idle', offline: true }, { status: 'idle' }]);
      expect(agg.availability).toBe('DEGRADED');
    });
  });

  describe('isActiveState', () => {
    it('DONE and FAILED are inactive', () => {
      expect(isActiveState('DONE')).toBe(false);
      expect(isActiveState('FAILED')).toBe(false);
    });
    it('everything else is active', () => {
      for (const s of [
        'STARTING',
        'THINKING',
        'CODING',
        'TERMINAL',
        'BROWSING',
        'TESTING',
        'REVIEWING',
        'WAITING_IO',
        'NEEDS_INPUT',
        'BLOCKED',
      ] as const) {
        expect(isActiveState(s)).toBe(true);
      }
    });
  });
});
