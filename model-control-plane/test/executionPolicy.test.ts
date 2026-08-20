import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { ExecutionPolicyService } from '../src/v2/executionPolicy.js';
import { runV2Migrations } from '../src/v2/migrations.js';
import { ProviderHubRepository } from '../src/v2/providerHub.js';
import { V2Repository } from '../src/v2/repository.js';
import { RuntimeAccessRepository } from '../src/v2/runtimeAccess.js';
import { SupplyRepository } from '../src/v2/supply.js';

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const supply = new SupplyRepository(repository);
  const hub = new ProviderHubRepository(repository);
  const access = new RuntimeAccessRepository(repository);
  const policy = new ExecutionPolicyService(repository, access, hub);
  return { db, repository, supply, hub, access, policy };
}

function addCandidate(
  state: ReturnType<typeof make>,
  input: {
    supplierSlug: string;
    supplierName: string;
    model: string;
    providerKey: string;
    providerName?: string;
    baseUrl?: string;
    protocol?: string;
    runtimeKind?: 'OPENCODE' | 'CODEX' | 'CLAUDE_CODE';
    providerRef?: string;
    profileRef?: string;
  },
) {
  const catalog = state.supply.registerCatalogEntry({
    supplier: { slug: input.supplierSlug, name: input.supplierName },
    supplierModel: { key: input.model, name: input.model },
    agreement: {
      externalAccountRef: `${input.providerKey}:${input.model}`,
      name: `${input.providerName ?? input.providerKey} access`,
    },
  });
  const supplier = catalog.supplier as Record<string, unknown>;
  const employee = catalog.employee as Record<string, unknown>;
  const employment = catalog.employment as Record<string, unknown>;
  const connection = state.hub.upsertConnection({
    providerKey: input.providerKey,
    displayName: input.providerName ?? input.providerKey,
    supplierId: String(supplier.id),
    baseUrl: input.baseUrl ?? `https://${input.providerKey}.example/v1`,
    credentialRef: `${input.providerKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
    protocol: input.protocol ?? 'openai-chat-completions',
    sourceKind: 'TEST',
    availabilityState: 'AVAILABLE',
    models: [input.model],
  });
  if (input.runtimeKind) {
    state.access.upsert({
      employmentId: String(employment.id),
      runtimeKind: input.runtimeKind,
      adapterKind: 'NATIVE_CONFIG',
      providerRef: input.providerRef ?? input.providerKey,
      modelRef: input.model,
      profileRef: input.profileRef,
      baseUrl: input.baseUrl,
      credentialRef: `${input.providerKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
      config: { providerHubConnectionId: connection.id },
    });
  }
  return { catalog, supplier, employee, employment, connection };
}

test('implementation peak hours prefer Luna over time-priced OpenCode Go DeepSeek', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'opencode',
    supplierName: 'OpenCode',
    model: 'deepseek-v4-flash',
    providerKey: 'opencode-go',
    providerName: 'OpenCode Go',
    runtimeKind: 'OPENCODE',
    providerRef: 'opencode-go',
  });
  addCandidate(state, {
    supplierSlug: 'worldclaw',
    supplierName: 'worldclaw',
    model: 'gpt-5.6-luna',
    providerKey: 'worldclaw',
    protocol: 'openai-responses',
    runtimeKind: 'CODEX',
    providerRef: 'worldclaw',
    profileRef: 'worldclaw-luna',
  });
  const decision = state.policy.resolve({
    intent: 'IMPLEMENT',
    at: Date.UTC(2026, 7, 20, 4, 0, 0), // 12:00 Asia/Shanghai
    availableRuntimes: [
      { kind: 'CODEX', path: '/bin/codex' },
      { kind: 'DSH', path: '/bin/dsh' },
      { kind: 'OPENCODE', path: '/bin/opencode' },
    ],
  });
  assert.equal((decision.selected as Record<string, unknown>).model, 'gpt-5.6-luna');
  const deepseek = (decision.candidates as Array<Record<string, unknown>>).find(
    (item) => item.model === 'deepseek-v4-flash',
  );
  assert.ok((deepseek?.reasons as string[]).includes('DEEPSEEK_PEAK_PRICE_PENALTY'));
});

test('implementation does not hard-code DeepSeek over a reusable healthy Luna route', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'charity-relay',
    supplierName: 'Charity Relay',
    model: 'deepseek-v4-flash',
    providerKey: 'charity-relay',
  });
  addCandidate(state, {
    supplierSlug: 'worldclaw',
    supplierName: 'worldclaw',
    model: 'gpt-5.6-luna',
    providerKey: 'worldclaw',
    protocol: 'openai-responses',
    runtimeKind: 'CODEX',
    providerRef: 'worldclaw',
    profileRef: 'worldclaw-luna',
  });
  const decision = state.policy.resolve({
    intent: 'IMPLEMENT',
    at: Date.UTC(2026, 7, 20, 13, 0, 0),
    availableRuntimes: [
      { kind: 'DSH', path: '/bin/dsh' },
      { kind: 'CODEX', path: '/bin/codex' },
    ],
  });
  const selected = decision.selected as Record<string, unknown>;
  assert.equal(selected.model, 'gpt-5.6-luna');
  assert.equal(decision.decisionScope, 'PER_EXECUTION');
  assert.equal(decision.routingPrinciple, 'INTENT_SELECTS_WORK_CLASS_MODEL_FAMILY_SELECTS_HARNESS');
  assert.match(String(selected.guidance), /per-execution placement/i);
  assert.match(String(selected.guidance), /not a fixed model or harness/i);
});

test('implementation off-peak prefers time-priced DeepSeek and uses DSH when available', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'opencode',
    supplierName: 'OpenCode',
    model: 'deepseek-v4-flash',
    providerKey: 'opencode-go',
    providerName: 'OpenCode Go',
    runtimeKind: 'OPENCODE',
    providerRef: 'opencode-go',
  });
  addCandidate(state, {
    supplierSlug: 'worldclaw',
    supplierName: 'worldclaw',
    model: 'gpt-5.6-luna',
    providerKey: 'worldclaw',
    protocol: 'openai-responses',
    runtimeKind: 'CODEX',
    providerRef: 'worldclaw',
    profileRef: 'worldclaw-luna',
  });
  const decision = state.policy.resolve({
    intent: 'IMPLEMENT',
    at: Date.UTC(2026, 7, 20, 13, 0, 0), // 21:00 Asia/Shanghai
    availableRuntimes: [
      { kind: 'DSH', path: '/opt/data/bin/dsh' },
      { kind: 'CODEX', path: '/bin/codex' },
    ],
  });
  const selected = decision.selected as Record<string, unknown>;
  assert.equal(selected.model, 'deepseek-v4-flash');
  const runtime = selected.runtime as Record<string, unknown>;
  assert.equal(runtime.preferredHarness, 'DSH');
  assert.equal(runtime.selectedHarness, 'DSH');
  assert.equal(runtime.commandTemplate, '/opt/data/bin/dsh --profile headless <task>');
  assert.ok((selected.reasons as string[]).includes('DEEPSEEK_OFFPEAK_PREFERENCE'));
});

test('DeepSeek through a third-party relay is not affected by peak pricing', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'charity-relay',
    supplierName: 'Charity Relay',
    model: 'deepseek-v4-flash',
    providerKey: 'charity-relay',
    runtimeKind: 'OPENCODE',
    providerRef: 'charity-relay',
  });
  const decision = state.policy.resolve({
    intent: 'IMPLEMENT',
    requestedModel: 'deepseek-v4-flash',
    at: Date.UTC(2026, 7, 20, 4, 0, 0),
    availableRuntimes: [{ kind: 'DSH', path: '/bin/dsh' }],
  });
  const selected = decision.selected as Record<string, unknown>;
  assert.ok((selected.reasons as string[]).includes('DEEPSEEK_ROUTE_NOT_TIME_PRICED'));
  assert.ok(!(selected.reasons as string[]).includes('DEEPSEEK_PEAK_PRICE_PENALTY'));
});

test('implementation can automatically choose GLM when other implementation routes are unavailable', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'worldclaw',
    supplierName: 'worldclaw',
    model: 'gpt-5.6-luna',
    providerKey: 'worldclaw',
    protocol: 'openai-responses',
    runtimeKind: 'CODEX',
    providerRef: 'worldclaw',
    profileRef: 'worldclaw-luna',
  });
  const glm = addCandidate(state, {
    supplierSlug: 'teamorouter',
    supplierName: 'teamorouter',
    model: 'glm-5.2',
    providerKey: 'teamorouter',
  });
  const decision = state.policy.resolve({
    intent: 'IMPLEMENT',
    availableRuntimes: [{ kind: 'OPENCODE', path: '/usr/bin/opencode' }],
    availableProviderConnectionIds: [String(glm.connection.id)],
  });
  const selected = decision.selected as Record<string, unknown>;
  assert.equal(selected.model, 'glm-5.2');
  const runtime = selected.runtime as Record<string, unknown>;
  assert.equal(runtime.preferredHarness, 'ZCODE');
  assert.equal(runtime.selectedHarness, 'OPENCODE');
});

test('review selects a premium model and prefers the model vendor official harness', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'openai-official',
    supplierName: 'OpenAI Official',
    model: 'gpt-5.6-sol',
    providerKey: 'openai-team',
    protocol: 'openai-responses',
    runtimeKind: 'CODEX',
    providerRef: 'openai',
    profileRef: 'team-sol',
  });
  addCandidate(state, {
    supplierSlug: 'opencode',
    supplierName: 'OpenCode',
    model: 'gpt-5.6-luna',
    providerKey: 'opencode-go',
    runtimeKind: 'OPENCODE',
    providerRef: 'opencode-go',
  });
  const decision = state.policy.resolve({
    intent: 'REVIEW',
    availableRuntimes: [{ kind: 'CODEX', path: '/opt/data/bin/codex' }, { kind: 'OPENCODE' }],
  });
  const selected = decision.selected as Record<string, unknown>;
  assert.equal(selected.model, 'gpt-5.6-sol');
  const runtime = selected.runtime as Record<string, unknown>;
  assert.equal(runtime.preferredHarness, 'CODEX');
  assert.equal(runtime.selectedHarness, 'CODEX');
  assert.equal(runtime.profileAction, 'REUSE_EXISTING');
  assert.equal(runtime.profileRef, 'team-sol');
  assert.match(String(selected.guidance), /never place API keys/i);
});

test('GPT on a chat-completions-only relay does not force incompatible Codex', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'chat-relay',
    supplierName: 'Chat Relay',
    model: 'gpt-5.6-luna',
    providerKey: 'chat-relay',
    protocol: 'openai-chat-completions',
    runtimeKind: 'CODEX',
    providerRef: 'chat-relay',
    profileRef: 'chat-relay-luna',
  });
  const decision = state.policy.resolve({
    intent: 'IMPLEMENT',
    requestedModel: 'gpt-5.6-luna',
    availableRuntimes: [
      { kind: 'CODEX', path: '/opt/data/runtime/npm/bin/codex' },
      { kind: 'OPENCODE', path: '/opt/data/runtime/npm/bin/opencode' },
    ],
  });
  const selected = decision.selected as Record<string, unknown>;
  const runtime = selected.runtime as Record<string, unknown>;
  assert.equal(runtime.preferredHarness, 'CODEX');
  assert.equal(runtime.selectedHarness, 'OPENCODE');
  assert.equal(runtime.officialHarnessAvailable, false);
});

test('review can select Claude and uses Claude Code when the provider is compatible', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'anthropic-official',
    supplierName: 'Anthropic Official',
    model: 'claude-opus-5',
    providerKey: 'anthropic-official',
    protocol: 'anthropic-messages',
  });
  const decision = state.policy.resolve({
    intent: 'REVIEW',
    availableRuntimes: [
      { kind: 'CLAUDE_CODE', path: '/opt/data/runtime/npm/bin/claude' },
      { kind: 'CODEX', path: '/opt/data/runtime/npm/bin/codex' },
    ],
  });
  const selected = decision.selected as Record<string, unknown>;
  assert.equal(selected.model, 'claude-opus-5');
  const runtime = selected.runtime as Record<string, unknown>;
  assert.equal(runtime.preferredHarness, 'CLAUDE_CODE');
  assert.equal(runtime.selectedHarness, 'CLAUDE_CODE');
});

test('Claude model on an OpenAI-compatible relay does not force incompatible Claude Code', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'relay',
    supplierName: 'Relay',
    model: 'claude-opus-5',
    providerKey: 'relay',
    runtimeKind: 'OPENCODE',
    providerRef: 'relay',
  });
  const decision = state.policy.resolve({
    intent: 'REVIEW',
    requestedModel: 'claude-opus-5',
    availableRuntimes: [
      { kind: 'CLAUDE_CODE', path: '/opt/data/runtime/npm/bin/claude' },
      { kind: 'OPENCODE', path: '/usr/bin/opencode' },
    ],
  });
  const selected = decision.selected as Record<string, unknown>;
  const runtime = selected.runtime as Record<string, unknown>;
  assert.equal(runtime.preferredHarness, 'CLAUDE_CODE');
  assert.equal(runtime.selectedHarness, 'OPENCODE');
  assert.ok(
    (selected.reasons as string[]).includes(
      'OFFICIAL_HARNESS_UNAVAILABLE_OR_INCOMPATIBLE_USING_OPENCODE',
    ),
  );
});

test('provider availability whitelist prevents selection of a credential-inaccessible connection', () => {
  const state = make();
  const blocked = addCandidate(state, {
    supplierSlug: 'relay-a',
    supplierName: 'Relay A',
    model: 'gpt-5.6-luna',
    providerKey: 'relay-a',
    protocol: 'openai-responses',
    runtimeKind: 'CODEX',
    providerRef: 'relay-a',
    profileRef: 'relay-a-luna',
  });
  const allowed = addCandidate(state, {
    supplierSlug: 'relay-b',
    supplierName: 'Relay B',
    model: 'gpt-5.6-luna',
    providerKey: 'relay-b',
    protocol: 'openai-responses',
    runtimeKind: 'CODEX',
    providerRef: 'relay-b',
    profileRef: 'relay-b-luna',
  });
  const decision = state.policy.resolve({
    intent: 'IMPLEMENT',
    availableRuntimes: [{ kind: 'CODEX', path: '/bin/codex' }],
    availableProviderConnectionIds: [String(allowed.connection.id)],
  });
  const selected = decision.selected as Record<string, unknown>;
  const connection = selected.providerConnection as Record<string, unknown>;
  assert.equal(connection.id, allowed.connection.id);
  assert.notEqual(connection.id, blocked.connection.id);
});

test('GLM advertises ZCode as official harness but falls back to OpenCode for headless execution', () => {
  const state = make();
  addCandidate(state, {
    supplierSlug: 'teamorouter',
    supplierName: 'teamorouter',
    model: 'glm-5.2',
    providerKey: 'teamorouter',
    runtimeKind: 'OPENCODE',
    providerRef: 'teamorouter',
  });
  const decision = state.policy.resolve({
    intent: 'IMPLEMENT',
    requestedModel: 'glm-5.2',
    availableRuntimes: [
      { kind: 'OPENCODE', path: '/usr/bin/opencode' },
      { kind: 'DSH', path: '/opt/data/bin/dsh' },
    ],
  });
  const selected = decision.selected as Record<string, unknown>;
  const runtime = selected.runtime as Record<string, unknown>;
  assert.equal(runtime.preferredHarness, 'ZCODE');
  assert.equal(runtime.selectedHarness, 'OPENCODE');
  assert.equal(runtime.officialHarnessAvailable, false);
});
