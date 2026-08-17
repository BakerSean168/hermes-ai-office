import assert from 'node:assert/strict';
import test from 'node:test';
import { buildControlPlane } from '../src/app.js';

test('provider hub API persists shared connections and profile links', async (t) => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    initialSync: false,
  });
  t.after(async () => runtime.app.close());
  const upsert = await runtime.app.inject({
    method: 'POST',
    url: '/api/v2/commands/provider-connections/upsert',
    headers: { 'idempotency-key': 'hub-fastaitoken' },
    payload: {
      providerKey: 'fastaitoken',
      displayName: 'FastAI Token',
      baseUrl: 'https://www.fastaitoken.com',
      protocol: 'openai-responses',
      authKind: 'API_KEY',
      credentialRef: 'FASTAI_TOKEN_API_KEY',
      credentialScope: 'GLOBAL',
      sourceKind: 'CODEX_CONFIG',
      shareScope: 'GLOBAL',
      health: 'READY',
      models: ['gpt-5.6-sol'],
    },
  });
  assert.equal(upsert.statusCode, 200);
  const connection = upsert.json();
  const link = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/provider-connections/${connection.id}/profile-links`,
    headers: { 'idempotency-key': 'hub-fastaitoken-memoflow' },
    payload: {
      profileId: 'memoflow',
      runtimeKind: 'CODEX',
      providerRef: 'fastaitoken',
      modelRef: 'gpt-5.6-sol',
      sourceKind: 'PROFILE_DISCOVERY',
    },
  });
  assert.equal(link.statusCode, 200);
  const projection = await runtime.app.inject({
    method: 'GET',
    url: '/api/v2/projections/provider-hub',
  });
  assert.equal(projection.statusCode, 200);
  assert.equal(projection.json().summary.connections, 1);
  assert.equal(projection.json().items[0].profileLinks[0].profile_id, 'memoflow');
});
