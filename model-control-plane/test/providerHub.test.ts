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
  assert.equal(projection.summary.ready, 0);
  assert.equal(projection.summary.available, 0);
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

test('operational attempt evidence transitions availability state and manages failure streaks', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const hub = new ProviderHubRepository(new V2Repository(db));
  const connection = hub.upsertConnection({
    providerKey: 'deepseek',
    displayName: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com/v1',
    sourceKind: 'TEST',
  });
  const id = String(connection.id);

  // 1. Initial state is UNKNOWN, admin ENABLED, routable (trial)
  let detail = hub.connectionDetail(id)!;
  assert.equal(detail.adminState, 'ENABLED');
  assert.equal(detail.availabilityState, 'UNKNOWN');
  assert.equal(detail.effectiveState, 'UNKNOWN');
  assert.equal(detail.routable, true);

  // 2. Success transitions to AVAILABLE, sets lastSuccessAt
  const t1 = Date.now();
  detail = hub.recordAttempt(id, {
    outcome: 'SUCCESS',
    observedAt: t1,
  });
  assert.equal(detail.availabilityState, 'AVAILABLE');
  assert.equal(detail.effectiveState, 'AVAILABLE');
  assert.equal(detail.routable, true);
  assert.equal(detail.health, 'READY');
  assert.equal(detail.totalSuccesses, 1);
  assert.equal(detail.consecutiveFailures, 0);
  assert.equal(detail.lastSuccessAt, t1);

  // 3. 429 / RATE_LIMIT records CONGESTED and backoff window without permanent disabling
  const t2 = t1 + 1000;
  detail = hub.recordAttempt(id, {
    outcome: 'THROTTLED',
    errorKind: 'RATE_LIMIT',
    httpStatus: 429,
    retryAfterSeconds: 60,
    observedAt: t2,
  });
  assert.equal(detail.availabilityState, 'CONGESTED');
  assert.equal(detail.effectiveState, 'CONGESTED');
  assert.equal(detail.routable, false); // in backoff
  assert.equal(detail.retryable, true);
  assert.equal(detail.consecutiveFailures, 1);
  assert.equal(detail.totalFailures, 1);
  assert.equal(detail.lastErrorStatus, 429);
  assert.equal(detail.retryAfterAt, t2 + 60000);

  // 4. Consecutive network failures: 1st and 2nd are DEGRADED, 3rd becomes TEMP_UNAVAILABLE
  const t3 = t2 + 1000;
  hub.recordAttempt(id, {
    outcome: 'FAILURE',
    errorKind: 'NETWORK',
    observedAt: t3,
  });
  detail = hub.connectionDetail(id)!;
  assert.equal(detail.consecutiveFailures, 2);
  assert.equal(detail.availabilityState, 'DEGRADED');

  const t4 = t3 + 1000;
  detail = hub.recordAttempt(id, {
    outcome: 'FAILURE',
    errorKind: 'TIMEOUT',
    observedAt: t4,
  });
  assert.equal(detail.consecutiveFailures, 3);
  assert.equal(detail.availabilityState, 'TEMP_UNAVAILABLE');
  assert.equal(detail.effectiveState, 'TEMP_UNAVAILABLE');
  assert.equal(detail.routable, false);
  assert.ok(detail.retryAfterAt != null && Number(detail.retryAfterAt) > t4);

  // 5. Successful attempt clears failure streak and restores AVAILABLE
  const t5 = t4 + 2000;
  detail = hub.recordAttempt(id, {
    outcome: 'SUCCESS',
    observedAt: t5,
  });
  assert.equal(detail.availabilityState, 'AVAILABLE');
  assert.equal(detail.effectiveState, 'AVAILABLE');
  assert.equal(detail.consecutiveFailures, 0);
  assert.equal(detail.totalSuccesses, 2);
  assert.equal(detail.retryAfterAt, null);
  assert.equal(detail.routable, true);

  // 6. AUTH error (401) transitions to UNAVAILABLE
  const t6 = t5 + 1000;
  detail = hub.recordAttempt(id, {
    outcome: 'FAILURE',
    errorKind: 'AUTH',
    httpStatus: 401,
    message: 'Invalid API key sk-secret123456789 provided in Bearer token',
    observedAt: t6,
  });
  assert.equal(detail.availabilityState, 'UNAVAILABLE');
  assert.equal(detail.effectiveState, 'UNAVAILABLE');
  assert.equal(detail.routable, false);
  assert.equal(detail.retryable, false);
  assert.equal(detail.health, 'UNAVAILABLE');
  // Verify secret was redacted in the persisted message
  assert.equal(detail.lastErrorMessage?.includes('sk-secret'), false);
  assert.ok(detail.lastErrorMessage?.includes('[REDACTED]'));

  // Verify recent attempts are recorded and bounded
  const attempts = hub.listAttempts(id, 10);
  assert.equal(attempts.length, 6);
  assert.equal(attempts[0].errorKind, 'AUTH');
  assert.equal(attempts[0].errorMessage?.includes('sk-secret'), false);
});

test('operator manual control can disable and reset connections', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const hub = new ProviderHubRepository(new V2Repository(db));
  const connection = hub.upsertConnection({
    providerKey: 'openrouter',
    displayName: 'OpenRouter',
    sourceKind: 'TEST',
  });
  const id = String(connection.id);

  // Record an AUTH failure to make it UNAVAILABLE
  hub.recordAttempt(id, {
    outcome: 'FAILURE',
    errorKind: 'AUTH',
    httpStatus: 401,
  });
  let detail = hub.connectionDetail(id)!;
  assert.equal(detail.availabilityState, 'UNAVAILABLE');
  assert.equal(detail.routable, false);

  // Manual enable acts as a reset-to-trial (availability -> UNKNOWN, routable -> true)
  detail = hub.setControl(id, {
    enabled: true,
    reason: 'Rotated credentials',
  });
  assert.equal(detail.adminState, 'ENABLED');
  assert.equal(detail.availabilityState, 'UNKNOWN');
  assert.equal(detail.effectiveState, 'UNKNOWN');
  assert.equal(detail.routable, true);
  assert.equal(detail.consecutiveFailures, 0);
  assert.equal(detail.operatorNote, 'Rotated credentials');

  // Manual disable makes it DISABLED and not routable
  detail = hub.setControl(id, {
    enabled: false,
    reason: 'Scheduled maintenance',
  });
  assert.equal(detail.adminState, 'DISABLED');
  assert.equal(detail.effectiveState, 'DISABLED');
  assert.equal(detail.routable, false);
  assert.equal(detail.operatorNote, 'Scheduled maintenance');
});

test('provider hub summary projection tracks availability counts', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const hub = new ProviderHubRepository(new V2Repository(db));
  const c1 = hub.upsertConnection({
    providerKey: 'p1',
    displayName: 'P1',
    sourceKind: 'TEST',
  });
  const c2 = hub.upsertConnection({
    providerKey: 'p2',
    displayName: 'P2',
    sourceKind: 'TEST',
  });
  const c3 = hub.upsertConnection({
    providerKey: 'p3',
    displayName: 'P3',
    sourceKind: 'TEST',
  });

  hub.recordAttempt(String(c1.id), { outcome: 'SUCCESS' });
  hub.recordAttempt(String(c2.id), {
    outcome: 'THROTTLED',
    errorKind: 'RATE_LIMIT',
    retryAfterSeconds: 60,
  });
  hub.setControl(String(c3.id), { enabled: false });

  const summary = hub.summaryProjection();
  assert.equal(summary.summary.connections, 3);
  assert.equal(summary.summary.available, 1);
  assert.equal(summary.summary.congested, 1);
  assert.equal(summary.summary.disabled, 1);
});

test('new/upserted provider with legacy health=READY does not become AVAILABLE without evidence', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const hub = new ProviderHubRepository(new V2Repository(db));
  const connection = hub.upsertConnection({
    providerKey: 'anthropic',
    displayName: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com',
    authKind: 'API_KEY',
    credentialRef: 'ANTHROPIC_API_KEY',
    sourceKind: 'CODEX_CONFIG',
    health: 'READY',
  });
  const id = String(connection.id);
  const detail = hub.connectionDetail(id)!;
  // Must NOT be AVAILABLE merely because configuration/credentials exist
  assert.equal(detail.availabilityState, 'UNKNOWN');
  assert.equal(detail.effectiveState, 'UNKNOWN');
  assert.equal(detail.health, 'UNKNOWN');
  assert.equal(detail.routable, true); // trial-routable

  // Verify raw SQLite row also does not record false READY health
  const rawInsert = db
    .prepare('SELECT health, availability_state FROM v2_provider_connections WHERE id=?')
    .get(id) as any;
  assert.equal(rawInsert.availability_state, 'UNKNOWN');
  assert.equal(rawInsert.health, 'UNKNOWN');

  // Upsert again with health: 'READY' should still remain UNKNOWN
  hub.upsertConnection({
    providerKey: 'anthropic',
    displayName: 'Anthropic Claude Updated',
    sourceKind: 'CODEX_CONFIG',
    health: 'READY',
  });
  const updatedDetail = hub.connectionDetail(id)!;
  assert.equal(updatedDetail.availabilityState, 'UNKNOWN');
  assert.equal(updatedDetail.effectiveState, 'UNKNOWN');
  assert.equal(updatedDetail.health, 'UNKNOWN');

  // Explicit availabilityState: 'AVAILABLE' or successful attempt evidence makes it AVAILABLE
  hub.recordAttempt(id, { outcome: 'SUCCESS' });
  const afterAttempt = hub.connectionDetail(id)!;
  assert.equal(afterAttempt.availabilityState, 'AVAILABLE');
  assert.equal(afterAttempt.effectiveState, 'AVAILABLE');
  assert.equal(afterAttempt.health, 'READY');

  const rawSuccess = db
    .prepare('SELECT health, availability_state FROM v2_provider_connections WHERE id=?')
    .get(id) as any;
  assert.equal(rawSuccess.availability_state, 'AVAILABLE');
  assert.equal(rawSuccess.health, 'READY');
});
