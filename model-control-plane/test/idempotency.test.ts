import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import {
  commandRequestHash,
  IdempotencyConflictError,
  IdempotencyService,
} from '../src/v2/idempotency.js';
import { runV2Migrations } from '../src/v2/migrations.js';

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  return { db, service: new IdempotencyService(db) };
}

test('canonical request hashing is independent of object key order', () => {
  assert.equal(
    commandRequestHash({ b: 2, a: { d: 4, c: 3 } }),
    commandRequestHash({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test('completed command is replayed without executing the operation twice', async () => {
  const { service } = make();
  let calls = 0;
  const operation = async () => {
    calls += 1;
    return { statusCode: 201, body: { id: 'created' } };
  };

  const first = await service.execute({
    key: 'create-1',
    commandType: 'run.create',
    request: { title: 'A' },
    operation,
  });
  const second = await service.execute({
    key: 'create-1',
    commandType: 'run.create',
    request: { title: 'A' },
    operation,
  });

  assert.equal(calls, 1);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.body, { id: 'created' });
  assert.equal(second.statusCode, 201);
});

test('concurrent duplicate commands share one execution', async () => {
  const { service } = make();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = async () => {
    calls += 1;
    await gate;
    return { statusCode: 200, body: { value: 42 } };
  };

  const first = service.execute({
    key: 'concurrent-1',
    commandType: 'invoke',
    request: { input: 'hello' },
    operation,
  });
  const second = service.execute({
    key: 'concurrent-1',
    commandType: 'invoke',
    request: { input: 'hello' },
    operation,
  });
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(left.replayed, false);
  assert.equal(right.replayed, true);
  assert.deepEqual(right.body, { value: 42 });
});

test('same key with different payload is rejected', async () => {
  const { service } = make();
  await service.execute({
    key: 'conflict-1',
    commandType: 'run.create',
    request: { title: 'A' },
    operation: () => ({ statusCode: 200, body: { ok: true } }),
  });

  await assert.rejects(
    () =>
      service.execute({
        key: 'conflict-1',
        commandType: 'run.create',
        request: { title: 'B' },
        operation: () => ({ statusCode: 200, body: { ok: true } }),
      }),
    IdempotencyConflictError,
  );
});

test('unexpected operation failure is persisted as a deterministic safe response', async () => {
  const { service } = make();
  let calls = 0;
  const execute = () =>
    service.execute({
      key: 'failed-1',
      commandType: 'invoke',
      request: { input: 'x' },
      operation: () => {
        calls += 1;
        throw new Error('UPSTREAM_TIMEOUT');
      },
    });

  const first = await execute();
  const second = await execute();
  assert.equal(calls, 1);
  assert.equal(first.statusCode, 500);
  assert.deepEqual(first.body, { error: { code: 'UPSTREAM_TIMEOUT' } });
  assert.equal(second.replayed, true);
  assert.deepEqual(second.body, first.body);
});

test('completed command is replayed by a fresh service instance from durable storage', async () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  let calls = 0;
  const operation = () => {
    calls += 1;
    return { statusCode: 200, body: { durable: true } };
  };

  const first = await new IdempotencyService(db).execute({
    key: 'durable-1',
    commandType: 'duty.dispatch',
    request: { dutySessionId: 'duty_1' },
    operation,
  });
  const replay = await new IdempotencyService(db).execute({
    key: 'durable-1',
    commandType: 'duty.dispatch',
    request: { dutySessionId: 'duty_1' },
    operation,
  });

  assert.equal(calls, 1);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, { durable: true });
});
