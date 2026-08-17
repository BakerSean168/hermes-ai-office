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
      websiteUrl: 'https://www.fastaitoken.com/',
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
  assert.equal(projection.json().items[0].website_url, 'https://www.fastaitoken.com');
  assert.equal(projection.json().items[0].profileLinks[0].profile_id, 'memoflow');
});

test('provider hub summary stays compact and detail is fetched by connection id', async (t) => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    initialSync: false,
  });
  t.after(async () => runtime.app.close());
  const supplier = runtime.v2.getOrCreateSupplier(
    'worldclaw',
    'Worldclaw',
    'https://worldclawpro.ai',
  );
  const upsert = await runtime.app.inject({
    method: 'POST',
    url: '/api/v2/commands/provider-connections/upsert',
    headers: { 'idempotency-key': 'hub-summary-worldclaw' },
    payload: {
      providerKey: 'worldclaw',
      displayName: 'worldclaw',
      supplierId: String(supplier.id),
      baseUrl: 'https://worldclawpro.ai',
      websiteUrl: 'https://worldclawpro.ai',
      protocol: 'openai-chat-completions',
      authKind: 'API_KEY',
      credentialRef: 'WORLDCLAW_API_KEY',
      credentialScope: 'GLOBAL',
      sourceKind: 'HERMES_TOOL_ONBOARDING',
      shareScope: 'GLOBAL',
      health: 'READY',
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    },
  });
  assert.equal(upsert.statusCode, 200);
  const id = String(upsert.json().id);
  const link = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/provider-connections/${id}/profile-links`,
    headers: { 'idempotency-key': 'hub-summary-worldclaw-profile' },
    payload: {
      profileId: 'memoflow',
      runtimeKind: 'CODEX',
      providerRef: 'worldclaw',
      modelRef: 'gpt-5.6-sol',
      sourceKind: 'TEST',
    },
  });
  assert.equal(link.statusCode, 200);

  const summary = await runtime.app.inject({
    method: 'GET',
    url: '/api/v2/projections/provider-hub-summary',
  });
  assert.equal(summary.statusCode, 200);
  assert.deepEqual(summary.json().items[0], {
    id,
    providerKey: 'worldclaw',
    displayName: 'worldclaw',
    health: 'READY',
    authKind: 'API_KEY',
    modelCount: 2,
    profileCount: 1,
    supplier: { id: String(supplier.id), name: 'Worldclaw', slug: 'worldclaw' },
  });
  assert.equal(JSON.stringify(summary.json()).includes('WORLDCLAW_API_KEY'), false);
  assert.equal(JSON.stringify(summary.json()).includes('worldclawpro.ai'), false);
  assert.equal(JSON.stringify(summary.json()).includes('credentialRef'), false);
  assert.equal(JSON.stringify(summary.json()).includes('websiteUrl'), false);

  const detail = await runtime.app.inject({
    method: 'GET',
    url: `/api/v2/provider-connections/${id}`,
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().credential_ref, 'WORLDCLAW_API_KEY');
  assert.equal(detail.json().website_url, 'https://worldclawpro.ai');
  assert.deepEqual(detail.json().models, ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.equal(detail.json().profileLinks[0].profile_id, 'memoflow');

  const missing = await runtime.app.inject({
    method: 'GET',
    url: '/api/v2/provider-connections/missing',
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'PROVIDER_CONNECTION_NOT_FOUND');
});
