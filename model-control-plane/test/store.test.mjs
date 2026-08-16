import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { ControlPlaneStore } from '../src/store.mjs';

function make() {
  return new ControlPlaneStore(openDb(':memory:'));
}

test('CPA sync creates providers channels models and distinct workers', () => {
  const s = make();
  const snap = s.syncCpa([
    {
      name: 'cheap',
      protocol: 'openai-compatible',
      enabled: true,
      models: ['deepseek-v4-flash'],
      lastTest: 'pass',
      health: 'healthy',
    },
    {
      name: 'backup',
      protocol: 'openai-compatible',
      enabled: true,
      models: ['deepseek-v4-flash'],
      lastTest: 'pass',
      health: 'healthy',
    },
  ]);
  assert.equal(snap.channels.length, 2);
  assert.equal(snap.models.length, 1);
  assert.equal(snap.workers.length, 2);
  assert.notEqual(snap.workers[0].id, snap.workers[1].id);
});

test('position resolution honors assignment priority and usage is attributable', () => {
  const s = make();
  s.upsertProvider({ id: 'p', name: 'P' });
  for (const id of ['a', 'b']) {
    s.upsertChannel({ id, providerId: 'p', name: id, health: 'healthy' });
    s.upsertModel({ id: 'm', displayName: 'M', capabilities: ['coding', 'tools'] });
    s.upsertWorker({
      id: `w-${id}`,
      channelId: id,
      modelId: 'm',
      capabilities: ['coding', 'tools'],
    });
  }
  s.upsertProfile({ id: 'dev', name: 'Dev' });
  s.upsertPosition({
    id: 'pos',
    profileId: 'dev',
    name: 'Developer',
    requiredCapabilities: ['coding', 'tools'],
  });
  s.assign({ positionId: 'pos', workerId: 'w-a', priority: 10, status: 'active' });
  s.assign({ positionId: 'pos', workerId: 'w-b', priority: 5, status: 'standby' });
  const r = s.resolve('pos');
  assert.equal(r.selected.worker.id, 'w-a');
  s.recordUsage({
    workerId: 'w-a',
    positionId: 'pos',
    inputTokens: 100,
    outputTokens: 20,
    actualCost: 0.1,
  });
  assert.equal(s.statsBy('position')[0].actualCost, 0.1);
});

test('external usage snapshot is idempotent and maps openai-compatible provider to channel worker', () => {
  const s = make();
  s.syncCpa([
    {
      name: 'planner-pool',
      protocol: 'openai-compatible',
      enabled: true,
      models: ['deepseek-v4-flash'],
      lastTest: 'pass',
      health: 'healthy',
    },
  ]);
  const snap = {
    range: '30d',
    stats: {
      generated_at: new Date().toISOString(),
      groups: [
        {
          provider: 'openai-compatible-planner-pool',
          model: 'deepseek-v4-flash',
          requests: 2,
          input_tokens: 100,
          output_tokens: 20,
          cached_tokens: 50,
          reasoning_tokens: 5,
        },
      ],
    },
    costs: {
      models: [
        { provider: 'openai-compatible-planner-pool', model: 'deepseek-v4-flash', total_usd: 0.25 },
      ],
    },
  };
  s.syncExternalUsage(snap);
  s.syncExternalUsage(snap);
  const stats = s.combinedStatsBy('worker');
  assert.equal(stats.length, 1);
  assert.equal(stats[0].runs, 2);
  assert.equal(stats[0].inputTokens, 100);
  assert.equal(stats[0].actualCost, 0.25);
});

test('reconcile leaves exactly one active worker per position', () => {
  const s = make();
  s.syncCpa([
    {
      name: 'a',
      protocol: 'openai-compatible',
      enabled: true,
      models: ['deepseek-v4-flash'],
      lastTest: 'pass',
      health: 'healthy',
    },
    {
      name: 'b',
      protocol: 'openai-compatible',
      enabled: true,
      models: ['deepseek-v4-flash'],
      lastTest: 'pass',
      health: 'healthy',
    },
  ]);
  s.upsertProfile({ id: 'h', name: 'H' });
  s.upsertPosition({
    id: 'brain',
    profileId: 'h',
    name: 'Brain',
    requiredCapabilities: ['reasoning', 'tools'],
  });
  s.autoAssignDefaults();
  const a = s.snapshot().assignments.filter((x) => x.positionId === 'brain');
  assert.equal(a.filter((x) => x.status === 'active').length, 1);
  assert.equal(a.filter((x) => x.status === 'standby').length, 1);
});

test('subscription cost allocation and market price are recomputed without duplicating usage', () => {
  const s = make();
  s.syncCpa([
    {
      name: 'paid',
      protocol: 'openai-compatible',
      enabled: true,
      models: ['m'],
      lastTest: 'pass',
      health: 'healthy',
    },
  ]);
  const worker = s.snapshot().workers[0];
  s.syncExternalUsage({
    range: '30d',
    stats: {
      generated_at: new Date().toISOString(),
      groups: [
        {
          provider: 'openai-compatible-paid',
          model: 'm',
          requests: 2,
          input_tokens: 1_000_000,
          output_tokens: 500_000,
          cached_tokens: 0,
          reasoning_tokens: 0,
        },
      ],
    },
    costs: { models: [] },
  });
  s.upsertContract({
    channelId: worker.channelId,
    billingKind: 'subscription',
    fixedCost: 20,
    currency: 'USD',
    billingPeriod: 'month',
  });
  s.upsertPrice({ modelId: 'm', workerId: worker.id, inputPerMillion: 1, outputPerMillion: 2 });
  const stat = s.combinedStatsBy('worker')[0];
  assert.equal(Math.round(stat.allocatedCost * 100) / 100, 20);
  assert.equal(Math.round(stat.marketValue * 100) / 100, 2);
});
