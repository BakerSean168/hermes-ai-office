import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import { GatewayRegistry } from '../src/gateway/registry.js';

const cpa: LegacyCpaPort = {
  async status() {
    return [];
  },
  async bindAlias() {},
  async unbindAlias() {},
  async addChannel() {},
  async test() {},
  async enable() {},
  async disable() {},
  async quarantine() {},
};
const usage: LegacyUsagePort = {
  async snapshot() {
    return { stats: { groups: [] }, costs: { models: [] } };
  },
};

test('organization topology commands are idempotent and project stable position relationships', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry(),
  });
  try {
    const seeded = runtime.v2.bootstrapReference({
      supplierSlug: 'fixture-supplier',
      supplierName: 'Fixture Supplier',
      supplierModelKey: 'fixture-model',
      supplierModelName: 'Fixture Model',
      agreementRef: 'fixture-agreement',
      agreementName: 'Fixture Agreement',
      gatewaySlug: 'fixture',
      gatewayKind: 'OTHER',
      gatewayName: 'Fixture Gateway',
      workScopeSlug: 'development',
      workScopeName: 'Development',
      positionSlug: 'coding-review',
      positionName: 'Coding Reviewer',
      positionKind: 'REVIEWER',
      runtimeKind: 'CODEX',
      protocol: 'openai-responses',
    });

    const rolePayload = { slug: 'researcher', name: 'Researcher', purpose: 'Delegated research' };
    const role1 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/roles/create',
      headers: { 'Idempotency-Key': 'org-role-1' },
      payload: rolePayload,
    });
    const role2 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/roles/create',
      headers: { 'Idempotency-Key': 'org-role-1' },
      payload: rolePayload,
    });
    assert.equal(role1.statusCode, 200);
    assert.equal(role2.headers['idempotency-replayed'], 'true');
    const roleId = role1.json().id as string;

    const template = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/position-templates/create',
      headers: { 'Idempotency-Key': 'org-template-1' },
      payload: {
        slug: 'research-subagent',
        name: 'Research Subagent',
        roleId,
        runtimePolicy: { kind: 'HERMES_SUBAGENT', requiredTools: ['web'] },
        lifecyclePolicy: 'RUN_SCOPED',
      },
    });
    assert.equal(template.statusCode, 200);

    const leadRole = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/roles/create',
      headers: { 'Idempotency-Key': 'org-role-lead-1' },
      payload: { slug: 'profile-lead', name: 'Profile Lead' },
    });
    const leadTemplate = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/position-templates/create',
      headers: { 'Idempotency-Key': 'org-template-lead-1' },
      payload: {
        slug: 'profile-lead',
        name: 'Profile Lead',
        roleId: leadRole.json().id,
        runtimePolicy: { kind: 'HERMES_PROFILE' },
        lifecyclePolicy: 'STANDING',
      },
    });
    const lead = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/positions/instantiate',
      headers: { 'Idempotency-Key': 'org-position-lead-1' },
      payload: {
        templateId: leadTemplate.json().id,
        workScopeId: seeded.workScopeId,
        slug: 'development-lead',
        name: 'Development Lead',
      },
    });
    assert.equal(lead.statusCode, 200);

    const run = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/runs/create',
      headers: { 'Idempotency-Key': 'org-run-1' },
      payload: {
        workScopeId: seeded.workScopeId,
        title: 'Organization API run',
        externalRunRef: 'org-api-run',
      },
    });
    assert.equal(run.statusCode, 200);

    const childPayload = {
      templateId: template.json().id,
      workScopeId: seeded.workScopeId,
      originRunId: run.json().id,
      name: 'Researcher 01',
    };
    const child1 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/positions/instantiate',
      headers: { 'Idempotency-Key': 'org-position-child-1' },
      payload: childPayload,
    });
    const child2 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/positions/instantiate',
      headers: { 'Idempotency-Key': 'org-position-child-1' },
      payload: childPayload,
    });
    assert.equal(child1.statusCode, 200);
    assert.equal(child2.headers['idempotency-replayed'], 'true');
    assert.equal(child2.json().id, child1.json().id);

    const relationPayload = {
      fromPositionId: lead.json().id,
      toPositionId: child1.json().id,
      relationType: 'SUPERVISES',
      source: 'MANUAL',
    };
    const relation1 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/position-relations/create',
      headers: { 'Idempotency-Key': 'org-relation-1' },
      payload: relationPayload,
    });
    const relation2 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/position-relations/create',
      headers: { 'Idempotency-Key': 'org-relation-1' },
      payload: relationPayload,
    });
    assert.equal(relation1.statusCode, 200);
    assert.equal(relation2.headers['idempotency-replayed'], 'true');

    const topology = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/organization',
    });
    assert.equal(topology.statusCode, 200);
    const body = topology.json();
    assert.equal(body.roles.length, 2);
    assert.equal(body.templates.length, 2);
    assert.ok(body.positions.some((item: { id: string }) => item.id === lead.json().id));
    assert.ok(
      body.positions.some(
        (item: { id: string; lifecyclePolicy: string; originRunId: string }) =>
          item.id === child1.json().id &&
          item.lifecyclePolicy === 'RUN_SCOPED' &&
          item.originRunId === run.json().id,
      ),
    );
    assert.equal(body.relations.length, 1);
    assert.equal(body.relations[0].relationType, 'SUPERVISES');
  } finally {
    await runtime.app.close();
  }
});
