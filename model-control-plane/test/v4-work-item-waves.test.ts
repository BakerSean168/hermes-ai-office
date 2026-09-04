import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WorkItem } from '../src/v4/domain/workGraph.js';
import { openV4Database, SCHEMA_VERSION } from '../src/v4/persistence/database.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';
import { selectWorkItemWave } from '../src/v4/orchestration/workItemWaves.js';

function item(overrides: Partial<WorkItem> & Pick<WorkItem, 'workItemId' | 'itemKey'>): WorkItem {
  return {
    workItemId: overrides.workItemId,
    planId: 'plan-wave',
    graphVersionId: 'graph-wave',
    itemKey: overrides.itemKey,
    title: overrides.itemKey,
    objective: overrides.itemKey,
    acceptanceCriteria: [],
    dependencies: [],
    parallelSafe: false,
    writeScopes: [],
    conflictKeys: [],
    status: 'PENDING',
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

test('work-item wave selector parallelizes only explicit non-overlapping items', () => {
  const items = [
    item({ workItemId: 'a', itemKey: 'a', parallelSafe: true, writeScopes: ['web/src/a'] }),
    item({ workItemId: 'b', itemKey: 'b', parallelSafe: true, writeScopes: ['api/internal/b'] }),
    item({ workItemId: 'c', itemKey: 'c', parallelSafe: true, writeScopes: ['web/src/a/nested'] }),
    item({ workItemId: 'd', itemKey: 'd', parallelSafe: false }),
  ];
  const wave = selectWorkItemWave(items, 'base-sha', 4)!;
  assert.equal(wave.wave, 1);
  assert.equal(wave.baseRevision, 'base-sha');
  assert.deepEqual(
    wave.items.map((entry) => entry.itemKey),
    ['a', 'b'],
  );
});

test('work-item wave selector serializes unknown scope and conflict-key overlap', () => {
  const conflict = selectWorkItemWave(
    [
      item({ workItemId: 'a', itemKey: 'a', parallelSafe: true, conflictKeys: ['db-schema'] }),
      item({ workItemId: 'b', itemKey: 'b', parallelSafe: true, conflictKeys: ['db-schema'] }),
    ],
    'base-sha',
    4,
  )!;
  assert.deepEqual(
    conflict.items.map((entry) => entry.itemKey),
    ['a'],
  );

  const unknownFirst = selectWorkItemWave(
    [
      item({ workItemId: 'a', itemKey: 'a' }),
      item({ workItemId: 'b', itemKey: 'b', parallelSafe: true, writeScopes: ['api'] }),
    ],
    'base-sha',
    4,
  )!;
  assert.deepEqual(
    unknownFirst.items.map((entry) => entry.itemKey),
    ['a'],
  );
});

test('wave selector respects dependencies, active writers and durable wave numbering', () => {
  const dependency = item({
    workItemId: 'dep',
    itemKey: 'dep',
    status: 'SUCCEEDED',
    wave: 1,
    integrationBaseRevision: 's0',
  });
  const a = item({
    workItemId: 'a',
    itemKey: 'a',
    dependencies: ['dep'],
    parallelSafe: true,
    writeScopes: ['a'],
  });
  const b = item({
    workItemId: 'b',
    itemKey: 'b',
    dependencies: ['dep'],
    parallelSafe: true,
    writeScopes: ['b'],
  });
  const wave = selectWorkItemWave([dependency, a, b], 's1', 2)!;
  assert.equal(wave.wave, 2);
  assert.deepEqual(
    wave.items.map((entry) => entry.itemKey),
    ['a', 'b'],
  );
  assert.equal(selectWorkItemWave([{ ...a, status: 'RUNNING' }, b], 's1', 2), undefined);
});

test('parallel metadata and wave provenance survive schema migration and restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-wave-schema-'));
  const file = path.join(root, 'pixel.sqlite');
  let db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  db.exec("UPDATE schema_meta SET schema_version=8 WHERE schema_id='pixel-v4';");
  for (const column of [
    'integration_base_revision',
    'wave',
    'conflict_keys',
    'write_scopes',
    'parallel_safe',
  ])
    db.exec('ALTER TABLE work_items DROP COLUMN ' + column);
  db.close();

  db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  assert.equal(
    db.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()
      ?.schema_version,
    SCHEMA_VERSION,
  );
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    idempotencyKey: 'wave-plan',
    projectKey: 'wave',
    objective: 'wave',
    repositoryPath: root,
    baseRevision: 'base',
  }).value!;
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'wave',
  }).value!;
  const created = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'parallel',
    title: 'Parallel',
    objective: 'parallel',
    acceptanceCriteria: [],
    dependencies: [],
    parallelSafe: true,
    writeScopes: ['api/routes'],
    conflictKeys: ['schema:user'],
  }).value!;
  repositories.plans.assignWorkItemWave(created.workItemId, 3, 'integration-base');
  db.close();

  db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const restored = createRepositories(db).plans.getWorkItem(created.workItemId);
  assert.equal(restored.parallelSafe, true);
  assert.deepEqual(restored.writeScopes, ['api/routes']);
  assert.deepEqual(restored.conflictKeys, ['schema:user']);
  assert.equal(restored.wave, 3);
  assert.equal(restored.integrationBaseRevision, 'integration-base');
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
