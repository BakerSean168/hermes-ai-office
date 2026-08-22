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
    health: 'UNKNOWN',
    adminState: 'ENABLED',
    availabilityState: 'UNKNOWN',
    effectiveState: 'UNKNOWN',
    routable: true,
    retryable: true,
    authKind: 'API_KEY',
    modelCount: 2,
    profileCount: 1,
    supplier: {
      id: String(supplier.id),
      name: 'Worldclaw',
      slug: 'worldclaw',
      supplyOrigin: 'UNKNOWN',
      routingPolicy: 'AUTO',
    },
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

test('supplier provider connections are composed behind supplier detail', async (t) => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    initialSync: false,
  });
  t.after(async () => runtime.app.close());
  const source = await runtime.app.inject({
    method: 'POST',
    url: '/api/v2/commands/workforce-sources/upsert',
    headers: { 'idempotency-key': 'supplier-connection-source' },
    payload: {
      slug: 'worldclaw',
      name: 'Worldclaw',
      websiteUrl: 'https://worldclawpro.ai',
      sourceKind: 'EXTERNAL',
    },
  });
  assert.equal(source.statusCode, 200);
  const supplierId = String(source.json().id);
  const upsert = await runtime.app.inject({
    method: 'POST',
    url: '/api/v2/commands/provider-connections/upsert',
    headers: { 'idempotency-key': 'supplier-connection-provider' },
    payload: {
      providerKey: 'worldclaw',
      displayName: 'Worldclaw',
      supplierId,
      baseUrl: 'https://worldclawpro.ai',
      websiteUrl: 'https://worldclawpro.ai',
      protocol: 'openai-chat-completions',
      authKind: 'API_KEY',
      credentialRef: 'WORLDCLAW_API_KEY',
      credentialScope: 'GLOBAL',
      sourceKind: 'HERMES_TOOL_ONBOARDING',
      shareScope: 'GLOBAL',
      health: 'READY',
      models: ['gpt-5.6-sol'],
    },
  });
  assert.equal(upsert.statusCode, 200);
  const response = await runtime.app.inject({
    method: 'GET',
    url: `/api/v2/suppliers/${supplierId}/provider-connections`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items.length, 1);
  assert.equal(response.json().items[0].provider_key, 'worldclaw');
  assert.equal(response.json().items[0].credential_ref, 'WORLDCLAW_API_KEY');
});

test('provider connection attempts API validates inputs, redacts secrets, and updates state', async (t) => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    initialSync: false,
  });
  t.after(async () => runtime.app.close());

  const upsert = await runtime.app.inject({
    method: 'POST',
    url: '/api/v2/commands/provider-connections/upsert',
    headers: { 'idempotency-key': 'hub-api-attempts-conn' },
    payload: {
      providerKey: 'deepseek',
      displayName: 'DeepSeek API',
      baseUrl: 'https://api.deepseek.com/v1',
      sourceKind: 'TEST',
    },
  });
  assert.equal(upsert.statusCode, 200);
  const id = String(upsert.json().id);

  // Missing outcome returns 400
  const badOutcome = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/provider-connections/${id}/attempts`,
    headers: { 'idempotency-key': 'attempt-bad-outcome' },
    payload: {},
  });
  assert.equal(badOutcome.statusCode, 400);

  // Missing connection returns 404
  const missing = await runtime.app.inject({
    method: 'POST',
    url: '/api/v2/commands/provider-connections/missing-id/attempts',
    headers: { 'idempotency-key': 'attempt-missing' },
    payload: { outcome: 'SUCCESS' },
  });
  assert.equal(missing.statusCode, 404);

  // Record 429 attempt
  const attempt = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/provider-connections/${id}/attempts`,
    headers: { 'idempotency-key': 'attempt-429-1' },
    payload: {
      outcome: 'THROTTLED',
      errorKind: 'RATE_LIMIT',
      httpStatus: 429,
      message: 'Rate limit exceeded for key sk-secret123456789',
      retryAfterSeconds: 30,
      source: 'HERMES_PLUGIN',
    },
  });
  assert.equal(attempt.statusCode, 200);
  const updated = attempt.json();
  assert.equal(updated.availabilityState, 'CONGESTED');
  assert.equal(updated.effectiveState, 'CONGESTED');
  assert.equal(updated.routable, false);
  assert.equal(updated.lastErrorStatus, 429);
  assert.equal(updated.lastErrorMessage?.includes('sk-secret'), false);
  assert.ok(updated.lastErrorMessage?.includes('[REDACTED]'));
  assert.equal(updated.recentAttempts.length, 1);
});

test('provider connection profile and retire APIs support operator management', async (t) => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    initialSync: false,
  });
  t.after(async () => runtime.app.close());

  const upsert = await runtime.app.inject({
    method: 'POST',
    url: '/api/v2/commands/provider-connections/upsert',
    headers: { 'idempotency-key': 'hub-api-manage-conn' },
    payload: {
      providerKey: 'relay',
      displayName: 'Relay old',
      baseUrl: 'https://relay.example/v1',
      websiteUrl: 'https://relay.example',
      protocol: 'openai-chat-completions',
      credentialRef: 'RELAY_API_KEY',
      credentialScope: 'GLOBAL',
      sourceKind: 'TEST',
      models: ['gpt-5.5'],
    },
  });
  assert.equal(upsert.statusCode, 200);
  const id = String(upsert.json().id);

  const updated = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/provider-connections/${id}/profile`,
    headers: { 'idempotency-key': 'hub-api-manage-update' },
    payload: {
      displayName: 'Relay managed',
      baseUrl: 'https://relay.example/api/v1',
      protocol: 'openai-responses',
      models: ['gpt-5.5', 'gpt-5.6-sol'],
    },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().display_name, 'Relay managed');
  assert.equal(updated.json().protocol, 'openai-responses');

  const retired = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/provider-connections/${id}/retire`,
    headers: { 'idempotency-key': 'hub-api-manage-retire' },
    payload: { reason: 'Operator removed' },
  });
  assert.equal(retired.statusCode, 200);
  assert.equal(retired.json().lifecycle, 'RETIRED');

  const projection = await runtime.app.inject({
    method: 'GET',
    url: '/api/v2/projections/provider-hub',
  });
  assert.equal(projection.statusCode, 200);
  assert.equal(projection.json().summary.connections, 0);
});

test('provider connection control API enables and disables routing', async (t) => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    initialSync: false,
  });
  t.after(async () => runtime.app.close());

  const upsert = await runtime.app.inject({
    method: 'POST',
    url: '/api/v2/commands/provider-connections/upsert',
    headers: { 'idempotency-key': 'hub-api-control-conn' },
    payload: {
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      sourceKind: 'TEST',
    },
  });
  assert.equal(upsert.statusCode, 200);
  const id = String(upsert.json().id);

  // Invalid payload returns 400
  const invalid = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/provider-connections/${id}/control`,
    headers: { 'idempotency-key': 'control-bad' },
    payload: { enabled: 'invalid' },
  });
  assert.equal(invalid.statusCode, 400);

  // Disable connection
  const disabled = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/provider-connections/${id}/control`,
    headers: { 'idempotency-key': 'control-disable' },
    payload: { enabled: false, reason: 'Operator test' },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().adminState, 'DISABLED');
  assert.equal(disabled.json().effectiveState, 'DISABLED');
  assert.equal(disabled.json().routable, false);
  assert.equal(disabled.json().operatorNote, 'Operator test');

  // Enable connection (reset to trial)
  const enabled = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/provider-connections/${id}/control`,
    headers: { 'idempotency-key': 'control-enable' },
    payload: { enabled: true, reason: 'Restored' },
  });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.json().adminState, 'ENABLED');
  assert.equal(enabled.json().availabilityState, 'UNKNOWN');
  assert.equal(enabled.json().effectiveState, 'UNKNOWN');
  assert.equal(enabled.json().routable, true);
  assert.equal(enabled.json().operatorNote, 'Restored');
});
