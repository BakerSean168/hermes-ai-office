import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible, scoreCandidate } from '../src/domain.mjs';

test('eligibility rejects unhealthy channel and missing capability', () => {
  const p = { requiredCapabilities: ['coding'], weights: {} };
  const w = { enabled: 1, capabilities: ['coding'], contextWindow: 128000 };
  assert.equal(eligible(w, p, { enabled: 1, health: 'healthy' }, null), true);
  assert.equal(eligible(w, p, { enabled: 1, health: 'degraded' }, null), false);
  assert.equal(
    eligible({ ...w, capabilities: ['text'] }, p, { enabled: 1, health: 'healthy' }, null),
    false,
  );
});

test('priority dominates score while quota reset can improve tie score', () => {
  const position = { weights: { quality: 35, reliability: 20, cost: 20, latency: 10, quota: 15 } };
  const base = {
    enabled: 1,
    qualityScore: 0.8,
    reliabilityScore: 0.8,
    costScore: 0.8,
    latencyScore: 0.8,
  };
  const channel = { priority: 0 };
  const low = scoreCandidate({
    worker: base,
    position,
    channel,
    assignment: { priority: 1 },
    quota: { limit: 100, remaining: 20, resetAt: Date.now() + 86400000 },
  });
  const high = scoreCandidate({
    worker: base,
    position,
    channel,
    assignment: { priority: 2 },
    quota: { limit: 100, remaining: 1 },
  });
  assert.ok(high > low);
});
