import * as assert from 'node:assert/strict';

import { test } from 'vitest';

import type { OrgSnapshot } from '../src/orgStore.js';
import { HermesWorkforceSyncClient } from '../src/providers/hermes/workforceSyncClient.js';

function snapshot(tag: string): OrgSnapshot {
  return {
    profiles: [
      {
        profileId: tag,
        displayName: tag,
        availability: 'ONLINE',
        workload: 'READY',
        lastSeenAt: 1,
      },
    ],
    runs: [],
    nodes: [],
    edges: [],
  };
}

test('Hermes workforce sync is single-flight and latest-wins under bursty snapshots', async () => {
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let count = 0;
  const client = new HermesWorkforceSyncClient({
    baseUrl: 'http://127.0.0.1:8320/',
    fetchImpl: (async (_url, init) => {
      count += 1;
      const body = JSON.parse(String(init?.body)) as {
        profiles: Array<{ profileId: string }>;
        sourceRevision: string;
      };
      calls.push(body.profiles[0]!.profileId);
      assert.ok(body.sourceRevision.startsWith('hermes-org:'));
      if (count === 1) await firstGate;
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });

  client.enqueue(snapshot('first'));
  client.enqueue(snapshot('second'));
  client.enqueue(snapshot('latest'));
  await Promise.resolve();
  assert.deepEqual(calls, ['first']);
  releaseFirst?.();
  await client.waitForIdle();

  assert.deepEqual(calls, ['first', 'latest']);
});

test('Hermes workforce sync failure is isolated and the next latest snapshot still converges', async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  let count = 0;
  const client = new HermesWorkforceSyncClient({
    baseUrl: 'http://control-plane',
    fetchImpl: (async (_url, init) => {
      count += 1;
      const body = JSON.parse(String(init?.body)) as { profiles: Array<{ profileId: string }> };
      calls.push(body.profiles[0]!.profileId);
      return new Response('{}', { status: count === 1 ? 503 : 200 });
    }) as typeof fetch,
    onError: (error) => errors.push(error.message),
  });

  client.enqueue(snapshot('unavailable'));
  await client.waitForIdle();
  client.enqueue(snapshot('recovered'));
  await client.waitForIdle();

  assert.deepEqual(calls, ['unavailable', 'recovered']);
  assert.deepEqual(errors, ['HERMES_WORKFORCE_SYNC_HTTP_503']);
});
