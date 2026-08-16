import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';

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

const reference = {
  supplierSlug: 'planner-pool',
  supplierName: 'Planner Pool',
  supplierModelKey: 'deepseek-v4-flash',
  supplierModelName: 'DeepSeek V4 Flash',
  agreementRef: 'planner-pool-primary',
  agreementName: 'Planner Pool Primary Supply',
  gatewaySlug: 'litellm-reference',
  gatewayKind: 'LITELLM' as const,
  gatewayName: 'LiteLLM Reference Gateway',
  gatewayBaseUrlHint: 'http://127.0.0.1:4000',
  workScopeSlug: 'development',
  workScopeName: 'Development',
  externalProfileRef: 'development',
  positionSlug: 'coding-review',
  positionName: 'Coding Reviewer',
  positionKind: 'REVIEWER',
  runtimeKind: 'CODEX',
  protocol: 'openai-responses' as const,
};

test('V2 API exposes Employee identity, Employment and Appointment separately', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
  });
  const seeded = runtime.v2.bootstrapReference(reference);

  try {
    const employees = await runtime.app.inject({ method: 'GET', url: '/api/v2/employees' });
    assert.equal(employees.statusCode, 200);
    assert.equal(employees.json().items[0].id, seeded.employeeId);

    const dossier = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/projections/employees/${seeded.employeeId}/dossier`,
    });
    assert.equal(dossier.statusCode, 200);
    const body = dossier.json();
    assert.equal(body.cooperation.currentEmployments.length, 1);
    assert.equal(body.organization.currentAppointments.length, 1);
    assert.equal(body.currentWork.length, 0);

    const positions = await runtime.app.inject({ method: 'GET', url: '/api/v2/positions' });
    assert.equal(positions.json().items[0].slug, 'coding-review');
    assert.equal(positions.json().items[0].currentAppointmentCount, 1);

    const history = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/events/history?after=0&limit=100',
    });
    assert.ok(
      history.json().items.some((event: { type: string }) => event.type === 'employee.discovered'),
    );
  } finally {
    await runtime.app.close();
  }
});

test('V2 employee dossier returns deterministic not-found error', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
  });
  try {
    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/employees/emp_missing',
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: { code: 'EMPLOYEE_NOT_FOUND' } });
  } finally {
    await runtime.app.close();
  }
});
