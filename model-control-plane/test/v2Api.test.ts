import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import type { GatewayExecutionPort, GatewayRouteRef } from '../src/gateway/ports.js';
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

class ApiFakeGateway implements GatewayExecutionPort {
  readonly gatewayId = 'litellm-reference';

  async resolveRoute(employmentId: string) {
    return {
      route: {
        gatewayId: this.gatewayId,
        employmentId,
        externalRouteRef: `employment:${employmentId}`,
        protocol: 'openai-responses' as const,
      },
      routable: true,
      reasons: ['API_TEST_ROUTE'],
      observedAt: Date.now(),
    };
  }

  async getRouteHealth(_route: GatewayRouteRef) {
    return 'healthy' as const;
  }
}

test('V2 command API opens a Run, Duty and dispatches current Employee', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([new ApiFakeGateway()]),
  });
  const seeded = runtime.v2.bootstrapReference(reference);

  try {
    const runResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/runs/create',
      payload: {
        workScopeId: seeded.workScopeId,
        title: 'API review run',
        externalRunRef: 'api-review-run',
      },
    });
    assert.equal(runResponse.statusCode, 200);
    const run = runResponse.json();

    const dutyResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/duties/open',
      payload: {
        runId: run.id,
        positionId: seeded.positionId,
        activity: 'REVIEWING',
      },
    });
    assert.equal(dutyResponse.statusCode, 200);
    const duty = dutyResponse.json();

    const dispatchResponse = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/duties/${duty.id}/dispatch`,
      payload: { correlationId: 'corr_api_test' },
    });
    assert.equal(dispatchResponse.statusCode, 200);
    const dispatch = dispatchResponse.json();
    assert.equal(dispatch.selected.employeeId, seeded.employeeId);
    assert.equal(dispatch.selected.employmentId, seeded.employmentId);

    const duties = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/duties?runId=${run.id}`,
    });
    assert.equal(duties.json().items[0].currentStaffing.employeeId, seeded.employeeId);

    const workforce = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/workforce',
    });
    assert.equal(workforce.json().summary.currentDuties, 1);
  } finally {
    await runtime.app.close();
  }
});
