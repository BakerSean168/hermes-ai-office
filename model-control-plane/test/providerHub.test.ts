import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';
import { ProviderHubRepository } from '../src/v2/providerHub.js';
import { V2Repository } from '../src/v2/repository.js';

test('provider hub shares safe connection metadata across profiles without secrets', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const domain = new V2Repository(db);
  const hub = new ProviderHubRepository(domain);
  const connection = hub.upsertConnection({
    providerKey: 'fastaitoken',
    displayName: 'FastAI Token',
    baseUrl: 'https://www.fastaitoken.com',
    websiteUrl: 'https://www.fastaitoken.com/',
    protocol: 'openai-responses',
    authKind: 'API_KEY',
    credentialRef: 'FASTAI_TOKEN_API_KEY',
    credentialScope: 'PROFILE_LOCAL',
    sourceProfileId: 'memoflow',
    sourceKind: 'CODEX_CONFIG',
    shareScope: 'GLOBAL',
    health: 'READY',
    models: ['gpt-5.6-sol'],
    metadata: { configFile: 'fastaitoken.config.toml' },
  });
  assert.equal(connection.credential_ref, 'FASTAI_TOKEN_API_KEY');
  assert.equal(connection.website_url, 'https://www.fastaitoken.com');
  assert.deepEqual(connection.models, ['gpt-5.6-sol']);
  const link = hub.linkProfile({
    connectionId: String(connection.id),
    profileId: 'memoflow',
    runtimeKind: 'CODEX',
    providerRef: 'fastaitoken',
    modelRef: 'gpt-5.6-sol',
    sourceKind: 'PROFILE_DISCOVERY',
  });
  assert.equal(link.profile_id, 'memoflow');
  const projection = hub.projection();
  assert.equal(projection.summary.connections, 1);
  assert.equal(projection.summary.ready, 1);
  assert.equal(projection.summary.profiles, 1);
  assert.equal((projection.items as any[])[0].profileLinks.length, 1);
  assert.equal(JSON.stringify(projection).includes('actual-secret'), false);
});

test('provider hub rejects secret-shaped metadata', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const hub = new ProviderHubRepository(new V2Repository(db));
  assert.throws(
    () =>
      hub.upsertConnection({
        providerKey: 'bad',
        displayName: 'Bad',
        sourceKind: 'TEST',
        metadata: { apiKey: 'do-not-store' },
      }),
    /PROVIDER_HUB_SECRET_FIELD_FORBIDDEN/,
  );
});

test('promoting a profile-local connection to global retires the duplicate and preserves profile links', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const hub = new ProviderHubRepository(new V2Repository(db));
  const local = hub.upsertConnection({
    providerKey: 'ark717',
    displayName: 'Ark717',
    baseUrl: 'https://api.ark717.com/v1',
    protocol: 'openai-responses',
    credentialRef: 'ARK717_API_KEY',
    credentialScope: 'PROFILE_LOCAL',
    sourceProfileId: 'memoflow',
    sourceKind: 'CODEX_CONFIG',
    shareScope: 'GLOBAL',
    health: 'READY',
    models: ['gpt-5.6-sol'],
  });
  hub.linkProfile({
    connectionId: String(local.id),
    profileId: 'memoflow',
    runtimeKind: 'CODEX',
    providerRef: 'ark717',
    modelRef: 'gpt-5.6-sol',
    sourceKind: 'PROFILE_DISCOVERY',
  });
  const global = hub.upsertConnection({
    providerKey: 'ark717',
    displayName: 'Ark717',
    baseUrl: 'https://api.ark717.com/v1',
    protocol: 'openai-responses',
    credentialRef: 'ARK717_API_KEY',
    credentialScope: 'GLOBAL',
    sourceKind: 'CODEX_CONFIG',
    shareScope: 'GLOBAL',
    health: 'READY',
    models: ['gpt-5.6-sol'],
  });
  const projection = hub.projection();
  assert.equal(projection.summary.connections, 1);
  assert.equal((projection.items as any[])[0].id, global.id);
  assert.equal((projection.items as any[])[0].profileLinks[0].profile_id, 'memoflow');
  assert.equal(
    db.prepare('SELECT lifecycle FROM v2_provider_connections WHERE id=?').get(local.id).lifecycle,
    'RETIRED',
  );
});
