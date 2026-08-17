import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildControlPlane } from '../src/app.js';

import {
  CpaXaiPersonalChannelSource,
  Grok2ApiPersonalChannelSource,
  PersonalChannelProjectionService,
} from '../src/v2/personalChannels.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hao-personal-channel-'));
}

test('CPA personal channel projects only the imported xAI account pool and Grok models', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'xai-a.json'),
      JSON.stringify({ type: 'xai', disabled: false, access_token: 'must-never-project' }),
    );
    fs.writeFileSync(
      path.join(dir, 'xai-b.json'),
      JSON.stringify({ type: 'xai', disabled: true, access_token: 'must-never-project' }),
    );
    fs.writeFileSync(
      path.join(dir, 'claude.json'),
      JSON.stringify({ type: 'claude', disabled: false }),
    );
    const source = new CpaXaiPersonalChannelSource({
      authDir: dir,
      models: {
        async models() {
          return ['claude-opus-5', 'grok-4.5', 'grok-4.6'];
        },
      },
    });
    const result = await source.snapshot();
    assert.equal(result.id, 'my-cpa-grok');
    assert.equal(result.accounts.total, 2);
    assert.equal(result.accounts.enabled, 1);
    assert.deepEqual(
      result.models.map((item) => item.id),
      ['grok-4.5', 'grok-4.6'],
    );
    assert.equal(JSON.stringify(result).includes('must-never-project'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Grok2API personal channel summarizes account readiness and text model routes', () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'grok.db');
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE provider_accounts(
        provider TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        auth_status TEXT NOT NULL,
        cooldown_until TEXT
      );
      CREATE TABLE model_routes(
        public_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        upstream_model TEXT NOT NULL,
        capability TEXT NOT NULL,
        enabled INTEGER NOT NULL
      );
      INSERT INTO provider_accounts VALUES
        ('grok_build',1,'active',NULL),
        ('grok_build',1,'reauthRequired',NULL),
        ('grok_console',1,'active',NULL),
        ('grok_console',0,'active',NULL);
      INSERT INTO model_routes VALUES
        ('Build/grok-4.6','grok_build','grok-4.6','responses',1),
        ('Console/grok-4.5','grok_console','grok-4.5','responses',1),
        ('Console/grok-image','grok_console','grok-image','image',1);
    `);
  } finally {
    db.close();
  }
  try {
    const source = new Grok2ApiPersonalChannelSource({ dbFile });
    const result = source.snapshot();
    assert.equal(result.accounts.total, 4);
    assert.equal(result.accounts.enabled, 3);
    assert.equal(result.accounts.ready, 2);
    assert.equal(result.accounts.reauthRequired, 1);
    assert.deepEqual(
      result.models.map((item) => item.id),
      ['Build/grok-4.6', 'Console/grok-4.5'],
    );
    assert.equal(result.health, 'HEALTHY');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('personal channel projection keeps sources independent', async () => {
  const service = new PersonalChannelProjectionService([
    {
      snapshot() {
        throw new Error('offline');
      },
    },
    {
      snapshot() {
        return {
          id: 'working',
          name: 'Working pool',
          kind: 'ACCOUNT_POOL' as const,
          sourceKind: 'CPA' as const,
          provider: 'test',
          health: 'HEALTHY' as const,
          accounts: { total: 10, enabled: 8, ready: 8, disabled: 2, reauthRequired: 0 },
          models: [{ id: 'grok-test' }],
        };
      },
    },
  ]);
  const result = (await service.projection()) as {
    channels: Array<{ id: string }>;
    summary: { channels: number; accounts: number; readyAccounts: number; models: number };
  };
  assert.deepEqual(
    result.channels.map((item) => item.id),
    ['working'],
  );
  assert.deepEqual(result.summary, {
    channels: 1,
    healthyChannels: 1,
    accounts: 10,
    readyAccounts: 8,
    models: 1,
  });
});

test('personal channel projection is exposed as a V2 HTTP contract', async () => {
  const dir = tempDir();
  const authDir = path.join(dir, 'auth');
  fs.mkdirSync(authDir);
  fs.writeFileSync(
    path.join(authDir, 'xai-a.json'),
    JSON.stringify({ type: 'xai', disabled: false }),
  );
  const grokDb = path.join(dir, 'grok.db');
  const db = new DatabaseSync(grokDb);
  db.exec(`
    CREATE TABLE provider_accounts(provider TEXT,enabled INTEGER,auth_status TEXT,cooldown_until TEXT);
    CREATE TABLE model_routes(public_id TEXT,provider TEXT,upstream_model TEXT,capability TEXT,enabled INTEGER);
    INSERT INTO provider_accounts VALUES ('grok_build',1,'active',NULL);
    INSERT INTO model_routes VALUES ('Build/grok-4.6','grok_build','grok-4.6','responses',1);
  `);
  db.close();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    initialSync: false,
    env: {
      MODEL_CP_V2_LITELLM: '0',
      MODEL_CP_V2_CPA_DISCOVERY: '0',
      MODEL_CP_V2_DISCOVERY: '0',
      CPA_AUTH_DIR: authDir,
      GROK2API_DB_FILE: grokDb,
    },
    cpa: {
      async status() {
        return [];
      },
      async test() {
        return {};
      },
      async models() {
        return ['grok-4.5', 'grok-4.6'];
      },
    },
  });
  try {
    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/personal-channels',
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.channels.length, 2);
    assert.deepEqual(
      payload.channels.map((item: { id: string }) => item.id),
      ['my-cpa-grok', 'grok2api'],
    );
  } finally {
    await runtime.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('internal pool sync creates durable internal employees idempotently', async () => {
  const { openDb } = await import('../src/db.mjs');
  const { runV2Migrations } = await import('../src/v2/migrations.js');
  const { V2Repository } = await import('../src/v2/repository.js');
  const { SupplyRepository } = await import('../src/v2/supply.js');
  const { InternalPoolWorkforceSyncService } = await import('../src/v2/personalChannels.js');
  const db = openDb(':memory:');
  runV2Migrations(db);
  const domain = new V2Repository(db);
  const supply = new SupplyRepository(domain);
  const channels = new PersonalChannelProjectionService([
    {
      snapshot() {
        return {
          id: 'my-cpa-grok',
          name: 'My CPA',
          kind: 'ACCOUNT_POOL' as const,
          sourceKind: 'CPA' as const,
          provider: 'xAI / Grok',
          health: 'HEALTHY' as const,
          accounts: { total: 10, enabled: 3, ready: 3, disabled: 7, reauthRequired: 0 },
          models: [
            { id: 'grok-4.5', provider: 'xai', capability: 'responses' },
            { id: 'grok-4.6', provider: 'xai', capability: 'responses' },
          ],
        };
      },
    },
  ]);
  const sync = new InternalPoolWorkforceSyncService(channels, supply);
  assert.deepEqual(await sync.sync(), { sources: 1, employees: 2 });
  assert.deepEqual(await sync.sync(), { sources: 1, employees: 2 });
  const workforce = domain.listEmployees().filter((item) => item.recordLifecycle === 'ACTIVE');
  assert.equal(workforce.length, 2);
  assert.equal(
    workforce.every((item) => item.supplier.sourceKind === 'INTERNAL'),
    true,
  );
  assert.deepEqual(workforce.map((item) => item.supplierModel.key).sort(), [
    'grok-4.5',
    'grok-4.6',
  ]);
  const projection = supply.projection() as {
    suppliers: Array<{ name: string; sourceKind: string }>;
  };
  assert.equal(projection.suppliers.find((item) => item.name === 'My CPA')?.sourceKind, 'INTERNAL');
  const summary = (supply.projection() as { summary: Record<string, number> }).summary;
  assert.equal(summary.suppliers, 0);
  assert.equal(summary.internalSources, 1);
  assert.equal(summary.employees, 2);
  assert.equal(summary.internalEmployees, 2);
  assert.equal(summary.activeAgreements, 0);
});
