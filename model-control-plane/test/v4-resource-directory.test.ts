import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CompositeResourceDirectory,
  LiteLlmResourceDirectory,
  LiteLlmResourceStateEffect,
  ResourceLifecycleManager,
  ResourceStateService,
  StaticResourceDirectory,
  providerNativeResources,
} from '../src/v4/adapters/resourceDirectory.js';
import { openV4Database } from '../src/v4/persistence/database.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';
import type {
  ExecutionResource,
  ExecutionResourceSelection,
} from '../src/v4/domain/resourceRouting.js';

const envFile = (): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resource-dir-')), 'env');
  fs.writeFileSync(file, 'LITELLM_MASTER_KEY=test-key\n');
  return file;
};
const response = (data: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

function row(overrides: Record<string, unknown> = {}) {
  return {
    model_name: 'route-free-deepseek',
    litellm_params: { litellm_credential_name: 'free-provider' },
    model_info: {
      id: 'deployment-1',
      blocked: false,
      metadata: {
        automatic_core: true,
        resource_id: 'free-provider',
        resource_sequence: 105,
        model_family: 'deepseek-v4-flash',
        route_model: 'route-free-deepseek',
        protocol: 'openai-chat-completions',
        commercial_type: 'FREE',
        supply_origin: 'COMMUNITY_RELAY',
        resource_lifecycle: 'RECURRING',
      },
    },
    ...overrides,
  };
}

test('LiteLLM directory projects only curated resource routes and maps GLM current', async () => {
  const glm = row({
    model_name: 'route-free-glm',
    model_info: {
      id: 'deployment-2',
      blocked: false,
      metadata: {
        automatic_core: true,
        resource_id: 'free-provider',
        resource_sequence: 105,
        model_family: 'glm-5.2',
        route_model: 'route-free-glm',
        protocol: 'openai-chat-completions',
        commercial_type: 'FREE',
        supply_origin: 'COMMUNITY_RELAY',
        resource_lifecycle: 'RECURRING',
      },
    },
  });
  const directory = new LiteLlmResourceDirectory({
    baseUrl: 'http://litellm.test',
    envFile: envFile(),
    fetchImpl: response([
      row(),
      glm,
      { ...row(), model_info: { id: 'ignored', metadata: { automatic_core: false } } },
    ]),
  });
  const resources = await directory.refresh();
  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.resourceTier, 'FREE');
  assert.deepEqual(
    resources[0]?.bindings.map((item) => item.modelFamily),
    ['deepseek-v4-flash', 'glm-current'],
  );
  assert.equal(resources[0]?.bindings[1]?.routeModel, 'route-free-glm');
  assert.equal(JSON.stringify(resources).includes('test-key'), false);
});

test('directory preserves blocked bindings and applies durable override', async () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  repositories.resourceStateOverrides.create({
    resourceId: 'free-provider',
    state: 'DISABLED',
    source: 'OPERATOR',
  });
  const blocked = row({
    model_info: { id: 'deployment-1', blocked: true, metadata: (row().model_info as any).metadata },
  });
  const directory = new LiteLlmResourceDirectory({
    baseUrl: 'http://litellm.test',
    envFile: envFile(),
    fetchImpl: response([blocked]),
    overrides: repositories.resourceStateOverrides,
  });
  const [resource] = await directory.refresh();
  assert.equal(resource?.state, 'DISABLED');
  assert.equal(resource?.ready, false);
  assert.equal(resource?.bindings[0]?.enabled, false);
  db.close();
});

test('provider-native resources reserve Business and Antigravity identities', () => {
  const resources = providerNativeResources({
    businessEnabled: true,
    businessReady: true,
    antigravityEnabled: true,
    antigravityReady: true,
  });
  assert.deepEqual(
    resources.map((item) => [item.resourceId, item.resourceSequence]),
    [
      ['chatgpt-business-primary', 120],
      ['antigravity-primary', 121],
    ],
  );
  assert.equal(
    resources[0]?.bindings.some((item) => item.modelFamily === 'gpt-5.6-sol'),
    true,
  );
  assert.equal(resources[0]?.requiresPolicy, undefined);
  assert.equal(resources[0]?.bindings[0]?.agentBackend, 'codex-acp');
  assert.equal(resources[1]?.requiresPolicy, 'provider-native-trusted-input');
  assert.equal(
    resources[1]?.bindings.some((item) => item.modelFamily === 'gemini-3.8-flash-high'),
    true,
  );
});

function selection(resourceId = 'free-provider'): ExecutionResourceSelection {
  return {
    selectionVersion: 1,
    executionId: 'execution-test',
    selectedAt: new Date().toISOString(),
    capability: 'IMPLEMENTATION',
    phase: 'IMPLEMENT',
    modelFamily: 'deepseek-v4-flash',
    agentBackend: 'dsh-acp',
    transport: 'LITELLM_MANAGED',
    resourceId,
    resourceTier: 'FREE',
    modelRank: 10,
    resourceSequence: 105,
    resourceState: 'ACTIVE',
    selectionReason: 'STATIC_POLICY',
    bindingId: 'deployment-1',
    routeModel: 'route-free-deepseek',
  };
}

function freeResource(): ExecutionResource {
  return {
    resourceId: 'free-provider',
    resourceTier: 'FREE',
    resourceSequence: 105,
    state: 'ACTIVE',
    ready: true,
    commercialType: 'FREE',
    supplyOrigin: 'COMMUNITY_RELAY',
    resourceLifecycle: 'RECURRING',
    bindings: [
      {
        bindingId: 'deployment-1',
        deploymentId: 'deployment-1',
        modelFamily: 'deepseek-v4-flash',
        transport: 'LITELLM_MANAGED',
        enabled: true,
        ready: true,
      },
    ],
  };
}

test('state service disables quota exhaustion and suspends free transient failures', () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const directory = new StaticResourceDirectory([freeResource()]);
  const service = new ResourceStateService(directory, repositories.resourceStateOverrides);
  service.failure(selection(), new Error('HTTP 429 rate limit'));
  assert.equal(repositories.resourceStateOverrides.get('free-provider')?.state, 'SUSPENDED');
  const versionBeforePolicyFailure =
    repositories.resourceStateOverrides.get('free-provider')?.version;
  service.failure(
    selection(),
    new Error('HTTP 403 litellm.PermissionDeniedError: key not allowed to access model route-x'),
  );
  assert.equal(
    repositories.resourceStateOverrides.get('free-provider')?.version,
    versionBeforePolicyFailure,
  );
  service.failure(selection(), new Error('monthly usage limit reached'));
  assert.equal(repositories.resourceStateOverrides.get('free-provider')?.state, 'DISABLED');
  db.close();
});

test('LiteLLM transient suspension stays local and does not block the probe route', async () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const calls: string[] = [];
  const effect = new LiteLlmResourceStateEffect({
    baseUrl: 'http://litellm.test',
    envFile: envFile(),
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  });
  const service = new ResourceStateService(
    new StaticResourceDirectory([freeResource()]),
    repositories.resourceStateOverrides,
    3,
    effect,
  );
  service.failure(selection(), new Error('HTTP 429 rate limit'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repositories.resourceStateOverrides.get('free-provider')?.state, 'SUSPENDED');
  assert.deepEqual(calls, []);
  db.close();
});

test('LiteLLM resource state effect blocks every selected-resource deployment', async () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const base = freeResource();
  const resource: ExecutionResource = {
    ...base,
    bindings: [
      base.bindings[0]!,
      {
        bindingId: 'deployment-2',
        deploymentId: 'deployment-2',
        modelFamily: 'glm-current',
        transport: 'LITELLM_MANAGED',
        enabled: true,
        ready: true,
      },
    ],
  };
  const calls: Array<{ url: string; body: unknown }> = [];
  const effect = new LiteLlmResourceStateEffect({
    baseUrl: 'http://litellm.test',
    envFile: envFile(),
    fetchImpl: (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  });
  const service = new ResourceStateService(
    new StaticResourceDirectory([resource]),
    repositories.resourceStateOverrides,
    3,
    effect,
  );
  const result = service.manual('free-provider', 'DISABLED', { expectedVersion: 0 });
  assert.equal(result.status, 'created');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => [call.url, call.body]),
    [
      ['http://litellm.test/model/deployment-1/update', { blocked: true }],
      ['http://litellm.test/model/deployment-2/update', { blocked: true }],
    ],
  );
  db.close();
});

test('lifecycle probes the raw source view and can reactivate a locally suspended resource', async () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  repositories.resourceStateOverrides.create({
    resourceId: 'free-provider',
    state: 'SUSPENDED',
    suspendedUntil: '2026-01-01T00:00:00.000Z',
    source: 'EXECUTION',
  });
  const raw = new StaticResourceDirectory([freeResource()]);
  const effective = new CompositeResourceDirectory([raw], repositories.resourceStateOverrides);
  assert.equal(effective.listResources()[0]?.ready, false);
  let observedReady: boolean | undefined;
  const manager = new ResourceLifecycleManager(raw, repositories.resourceStateOverrides, {
    probe: async (resource) => {
      observedReady = resource.ready;
      return resource.bindings.some((binding) => binding.enabled && binding.ready);
    },
  });
  assert.equal(await manager.reconcileOnce(new Date('2026-01-02T00:00:00.000Z')), 1);
  assert.equal(observedReady, true);
  assert.equal(repositories.resourceStateOverrides.get('free-provider')?.state, 'ACTIVE');
  assert.equal(effective.listResources()[0]?.ready, true);
  db.close();
});

test('lifecycle probes expired free suspension once and disables failure', async () => {
  const db = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  repositories.resourceStateOverrides.create({
    resourceId: 'free-provider',
    state: 'SUSPENDED',
    suspendedUntil: '2026-01-01T00:00:00.000Z',
    source: 'EXECUTION',
  });
  let calls = 0;
  const manager = new ResourceLifecycleManager(
    new StaticResourceDirectory([freeResource()]),
    repositories.resourceStateOverrides,
    {
      probe: async () => {
        calls += 1;
        return false;
      },
    },
  );
  assert.equal(await manager.reconcileOnce(new Date('2026-01-02T00:00:00.000Z')), 1);
  assert.equal(calls, 1);
  assert.equal(repositories.resourceStateOverrides.get('free-provider')?.state, 'DISABLED');
  db.close();
});

test('composite directory rejects duplicate resource identities', () => {
  const resource = freeResource();
  assert.throws(() =>
    new CompositeResourceDirectory([
      new StaticResourceDirectory([resource]),
      new StaticResourceDirectory([resource]),
    ]).listResources(),
  );
});
