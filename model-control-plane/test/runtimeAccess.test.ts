import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';
import { RuntimeAccessRepository } from '../src/v2/runtimeAccess.js';
import { SupplyRepository } from '../src/v2/supply.js';

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const supply = new SupplyRepository(repository);
  const catalog = supply.registerCatalogEntry({
    supplier: { slug: 'custom-team', name: 'Custom Team' },
    supplierModel: { key: 'alpha', name: 'Alpha' },
    agreement: { externalAccountRef: 'team-api', name: 'Team API' },
  });
  const employment = catalog.employment as Record<string, unknown>;
  return { db, repository, supply, employment, access: new RuntimeAccessRepository(repository) };
}

test('runtime access profile stores only non-secret native configuration', () => {
  const { access, employment } = make();
  const value = access.upsert({
    employmentId: String(employment.id),
    runtimeKind: 'OPENCODE',
    adapterKind: 'NATIVE_CONFIG',
    providerRef: 'hao-custom-team',
    modelRef: 'alpha',
    baseUrl: 'https://proxy.example.com/v1',
    credentialRef: 'HERMES_AI_OFFICE_TEAM_API_KEY',
    protocol: 'openai-chat-completions',
    config: { package: '@ai-sdk/openai-compatible' },
  });

  assert.equal(value.runtimeKind, 'OPENCODE');
  assert.equal(value.adapterKind, 'NATIVE_CONFIG');
  assert.equal(value.providerRef, 'hao-custom-team');
  assert.equal(value.modelRef, 'alpha');
  assert.equal(value.credentialRef, 'HERMES_AI_OFFICE_TEAM_API_KEY');
  assert.deepEqual(value.config, { package: '@ai-sdk/openai-compatible' });
  assert.equal(JSON.stringify(value).includes('secret-key-value'), false);
});

test('runtime access rejects secret material embedded in config', () => {
  const { access, employment } = make();
  assert.throws(
    () =>
      access.upsert({
        employmentId: String(employment.id),
        runtimeKind: 'OPENCODE',
        modelRef: 'alpha',
        config: { apiKey: 'secret-key-value' },
      }),
    /RUNTIME_ACCESS_CONFIG_SECRET_FIELD_FORBIDDEN/,
  );
});

test('runtime access resolution prefers the highest-priority active profile', () => {
  const { access, employment } = make();
  access.upsert({
    employmentId: String(employment.id),
    runtimeKind: 'OPENCODE',
    adapterKind: 'GATEWAY',
    providerRef: 'hermes-office',
    modelRef: 'employment:legacy',
    priority: 10,
  });
  access.upsert({
    employmentId: String(employment.id),
    runtimeKind: 'OPENCODE',
    adapterKind: 'NATIVE_CONFIG',
    providerRef: 'hao-custom-team',
    modelRef: 'alpha',
    priority: 100,
  });

  const selected = access.resolve(String(employment.id), 'OPENCODE');
  assert.equal(selected?.adapterKind, 'NATIVE_CONFIG');
  assert.equal(selected?.providerRef, 'hao-custom-team');
});

test('legacy runtime selectors import only explicit access facts and keep gateway compatibility explicit', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const supply = new SupplyRepository(repository);
  const native = supply.registerCatalogEntry({
    supplier: { slug: 'opencode', name: 'OpenCode' },
    supplierModel: { key: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    agreement: { externalAccountRef: 'opencode-go', name: 'OpenCode Go' },
    runtimeSelectors: {
      OPENCODE: { model: 'opencode-go/deepseek-v4-flash', provider: 'opencode-go' },
      CODEX: { model: 'deepseek-v4-flash', provider: 'anyrouter', profile: 'anyrouter' },
    },
  });
  const gateway = supply.registerCatalogEntry({
    supplier: { slug: 'legacy', name: 'Legacy Gateway Supplier' },
    supplierModel: { key: 'model-x', name: 'Model X' },
    agreement: { externalAccountRef: 'legacy', name: 'Legacy' },
    runtimeSelectors: {
      OPENCODE: { model: 'hermes-office/employment:legacy', provider: 'hermes-office' },
      CODEX: { model: 'employment:legacy', provider: 'hermes-office', profile: 'hermes-office' },
    },
  });
  const access = new RuntimeAccessRepository(repository);
  const imported = access.importLegacySelectors();
  assert.equal(imported.imported, 4);

  const nativeEmployment = native.employment as Record<string, unknown>;
  const nativeItems = access.list(String(nativeEmployment.id));
  assert.equal(nativeItems.length, 2);
  const opencode = nativeItems.find((item) => item.runtimeKind === 'OPENCODE')!;
  assert.equal(opencode.adapterKind, 'NATIVE_CONFIG');
  assert.equal(opencode.providerRef, 'opencode-go');
  assert.equal(opencode.modelRef, 'deepseek-v4-flash');
  assert.equal(opencode.baseUrl, null);
  assert.equal(opencode.credentialRef, null);
  const codex = nativeItems.find((item) => item.runtimeKind === 'CODEX')!;
  assert.equal(codex.adapterKind, 'NATIVE_CONFIG');
  assert.equal(codex.profileRef, 'anyrouter');
  assert.equal(codex.baseUrl, null);
  assert.equal(codex.credentialRef, null);

  const gatewayEmployment = gateway.employment as Record<string, unknown>;
  const gatewayItems = access.list(String(gatewayEmployment.id));
  assert.equal(gatewayItems.length, 2);
  assert.equal(
    gatewayItems.every((item) => item.adapterKind === 'GATEWAY'),
    true,
  );
  assert.equal(
    gatewayItems.every((item) => item.baseUrl == null),
    true,
  );
  assert.equal(
    gatewayItems.every((item) => item.credentialRef == null),
    true,
  );
});
