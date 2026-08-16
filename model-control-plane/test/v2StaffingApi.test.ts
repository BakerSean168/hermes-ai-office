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

test('capability, requirement, qualification, staffing rule and constraint APIs are durable idempotent contracts', async () => {
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

    const capability1 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/capabilities/create',
      headers: { 'Idempotency-Key': 'staff-capability-1' },
      payload: { slug: 'coding', name: 'Coding', valueType: 'NUMERIC', unit: 'score' },
    });
    const capability2 = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/capabilities/create',
      headers: { 'Idempotency-Key': 'staff-capability-1' },
      payload: { slug: 'coding', name: 'Coding', valueType: 'NUMERIC', unit: 'score' },
    });
    assert.equal(capability1.statusCode, 200);
    assert.equal(capability2.headers['idempotency-replayed'], 'true');
    const capabilityId = capability1.json().id as string;

    const claim = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/capability-claims/add',
      headers: { 'Idempotency-Key': 'staff-claim-1' },
      payload: {
        subjectType: 'SUPPLIER',
        subjectId: seeded.supplierId,
        capabilityId,
        value: 80,
        source: 'MANUAL',
      },
    });
    assert.equal(claim.statusCode, 200);

    const requirements = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/requirement-sets/create',
      headers: { 'Idempotency-Key': 'staff-requirements-1' },
      payload: {
        name: 'Reviewer v1',
        requirements: [{ capability: 'coding', operator: 'GTE', value: 90, hard: true }],
      },
    });
    assert.equal(requirements.statusCode, 200);
    const requirementSetId = requirements.json().id as string;

    const assigned = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/positions/${seeded.positionId}/set-requirements`,
      headers: { 'Idempotency-Key': 'staff-position-requirements-1' },
      payload: { requirementSetId },
    });
    assert.equal(assigned.statusCode, 200);

    const assessment = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/qualifications/assess',
      headers: { 'Idempotency-Key': 'staff-assessment-1' },
      payload: { employeeId: seeded.employeeId, positionId: seeded.positionId },
    });
    assert.equal(assessment.statusCode, 200);
    assert.equal(assessment.json().qualified, false);
    assert.ok(assessment.json().reasons.includes('REQUIREMENT_coding_FAILED'));

    const secondScope = runtime.v2.getOrCreateWorkScope({
      slug: 'profile-two',
      name: 'Profile Two',
    });
    const lead = runtime.v2.getOrCreatePosition({
      workScopeId: String(secondScope.id),
      slug: 'lead',
      name: 'Profile Two Lead',
      kind: 'PROFILE_LEAD',
      runtimeKind: 'HERMES_PROFILE',
    });
    const rule = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/staffing-rules/create',
      headers: { 'Idempotency-Key': 'staff-rule-1' },
      payload: {
        name: 'Employee leads profiles',
        employeeSelector: { employeeIds: [seeded.employeeId] },
        positionSelector: { kinds: ['PROFILE_LEAD'] },
        appointmentClass: 'PRIMARY',
        priority: 90,
      },
    });
    assert.equal(rule.statusCode, 200);
    const materialized = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/staffing-rules/${rule.json().id}/materialize`,
      headers: { 'Idempotency-Key': 'staff-rule-materialize-1' },
      payload: {},
    });
    assert.equal(materialized.statusCode, 200);
    assert.equal(materialized.json().created, 1);
    assert.ok(
      runtime.v2
        .listAppointments({ employeeId: seeded.employeeId })
        .some((item) => item.positionId === lead.id),
    );

    const constraint = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/staffing-constraints/create',
      headers: { 'Idempotency-Key': 'staff-constraint-1' },
      payload: {
        name: 'Reviewer separation',
        scopeType: 'POSITION',
        scopeId: seeded.positionId,
        constraintType: 'SEPARATION_OF_DUTIES',
        strength: 'HARD',
        expression: { positionKinds: ['DEVELOPER'] },
      },
    });
    assert.equal(constraint.statusCode, 200);

    const capabilities = await runtime.app.inject({ method: 'GET', url: '/api/v2/capabilities' });
    const claims = await runtime.app.inject({ method: 'GET', url: '/api/v2/capability-claims' });
    const assessments = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/qualification-assessments?employeeId=${seeded.employeeId}`,
    });
    const rules = await runtime.app.inject({ method: 'GET', url: '/api/v2/staffing-rules' });
    const constraints = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/staffing-constraints',
    });
    assert.equal(capabilities.json().items.length, 1);
    assert.equal(claims.json().items.length, 1);
    assert.equal(assessments.json().items.length, 1);
    assert.equal(rules.json().items.length, 1);
    assert.equal(constraints.json().items.length, 1);
  } finally {
    await runtime.app.close();
  }
});
