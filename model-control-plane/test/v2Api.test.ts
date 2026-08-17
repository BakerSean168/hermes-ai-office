import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import type {
  GatewayExecutionPort,
  GatewayInvocationPort,
  GatewayInvocationRequest,
  GatewayProvisioningPort,
  GatewayProvisionRouteInput,
  GatewayRouteRef,
} from '../src/gateway/ports.js';
import { GatewayRegistry } from '../src/gateway/registry.js';
import { SupplyRepository } from '../src/v2/supply.js';

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

test('supplier staffing preferences are an idempotent V2 command contract', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
  });
  const seeded = runtime.v2.bootstrapReference(reference);
  try {
    const payload = {
      enabledEmployeeIds: [seeded.employeeId],
      defaultEmployeeId: seeded.employeeId,
    };
    const first = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/suppliers/${seeded.supplierId}/staffing-preferences`,
      headers: { 'Idempotency-Key': 'supplier-pref-api-1' },
      payload,
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().metadata.staffingPreferences.enabledEmployeeIds, [
      seeded.employeeId,
    ]);
    assert.equal(first.json().metadata.staffingPreferences.defaultEmployeeId, seeded.employeeId);

    const replay = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/suppliers/${seeded.supplierId}/staffing-preferences`,
      headers: { 'Idempotency-Key': 'supplier-pref-api-1' },
      payload,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');

    const projection = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/supply',
    });
    const supplier = projection
      .json()
      .suppliers.find((item: { id: string }) => item.id === seeded.supplierId);
    assert.deepEqual(supplier.metadata.staffingPreferences.enabledEmployeeIds, [seeded.employeeId]);
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

class ApiFakeGateway implements GatewayExecutionPort, GatewayInvocationPort {
  readonly gatewayId = 'litellm-reference';
  calls = 0;

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

  async invoke(request: GatewayInvocationRequest) {
    this.calls += 1;
    return {
      gatewayRequestId: 'api_call',
      externalDeploymentRef: 'api_deployment',
      outputText: 'API_REVIEW_OK',
      responseModel: request.route.externalRouteRef,
      status: 'succeeded' as const,
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      reasoningTokens: 1,
      actualCost: 0.01,
      currency: 'USD',
      latencyMs: 7,
      metadata: { attemptedRetries: 0 },
    };
  }
}

class ProvisioningApiFakeGateway implements GatewayExecutionPort, GatewayProvisioningPort {
  readonly gatewayId = 'litellm-reference';
  provisioned: GatewayProvisionRouteInput | null = null;

  async resolveRoute(_employmentId: string) {
    return { route: null, routable: false, reasons: ['NOT_BOUND_YET'], observedAt: Date.now() };
  }

  async getRouteHealth(_route: GatewayRouteRef) {
    return 'healthy' as const;
  }

  async provisionRoute(input: GatewayProvisionRouteInput) {
    this.provisioned = input;
    return {
      route: {
        gatewayId: this.gatewayId,
        employmentId: input.employmentId,
        externalRouteRef: input.externalRouteRef,
        protocol: input.protocol,
      },
      externalDeploymentRef: 'deployment_custom',
      credentialName: input.credential.name,
      created: true,
      observedAt: Date.now(),
    };
  }
}

test('internal gateway provisioning stores only safe Employment routing facts', async () => {
  const gateway = new ProvisioningApiFakeGateway();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([gateway]),
  });
  const supply = new SupplyRepository(runtime.v2);
  runtime.v2.getOrCreateGateway({
    slug: 'litellm-reference',
    kind: 'LITELLM',
    displayName: 'LiteLLM Reference Gateway',
  });
  const catalog = supply.registerCatalogEntry({
    supplier: { slug: 'custom-router', name: 'Custom Router' },
    supplierModel: { key: 'team-model', name: 'Team Model' },
    agreement: { externalAccountRef: 'custom-router-primary', name: 'Custom Router Primary' },
  });
  const employment = catalog.employment as Record<string, unknown>;
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/internal/employments/${employment.id}/gateway-route`,
      payload: {
        gatewaySlug: 'litellm-reference',
        protocol: 'openai-chat-completions',
        upstreamProvider: 'openai',
        upstreamModel: 'team-model',
        upstreamBaseUrl: 'https://proxy.example/v1',
        secretMaterial: { api_key: 'ephemeral-upstream-secret' },
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.route.externalRouteRef, `employment:${employment.id}`);
    assert.equal(body.runtimeSelectors.OPENCODE.model, `hermes-office/employment:${employment.id}`);
    assert.equal(JSON.stringify(body).includes('ephemeral-upstream-secret'), false);
    assert.equal(
      gateway.provisioned?.credential.name,
      `hermes-agreement-${employment.supplyAgreementId}`,
    );
    assert.deepEqual(gateway.provisioned?.credential.secretMaterial, {
      api_key: 'ephemeral-upstream-secret',
    });

    const stored = JSON.stringify({
      channels: runtime.v2.listChannels('litellm-reference'),
      bindings: runtime.v2.findActiveGatewayBinding(String(employment.id), 'litellm-reference'),
      events: runtime.v2.db
        .prepare('SELECT type,entity_type,entity_id,payload_json FROM v2_events')
        .all(),
    });
    assert.equal(stored.includes('ephemeral-upstream-secret'), false);
    assert.equal(
      runtime.v2.findActiveGatewayBinding(String(employment.id), 'litellm-reference')
        ?.externalRouteRef,
      `employment:${employment.id}`,
    );
  } finally {
    await runtime.app.close();
  }
});

test('V2 command API opens a Run, Duty and dispatches current Employee', async () => {
  const gateway = new ApiFakeGateway();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([gateway]),
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

    const invocationPayload = {
      input: 'Review the API test change.',
      correlationId: 'corr_api_test',
    };
    const invokeResponse = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/internal/duties/${duty.id}/invoke`,
      headers: { 'Idempotency-Key': 'invoke-api-1' },
      payload: invocationPayload,
    });
    assert.equal(invokeResponse.statusCode, 200);
    assert.equal(invokeResponse.json().outputText, 'API_REVIEW_OK');
    assert.equal(invokeResponse.json().usage.inputTokens, 12);

    const replay = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/internal/duties/${duty.id}/invoke`,
      headers: { 'Idempotency-Key': 'invoke-api-1' },
      payload: invocationPayload,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.equal(replay.json().invocationId, invokeResponse.json().invocationId);
    assert.equal(replay.json().usageEntryId, invokeResponse.json().usageEntryId);
    assert.equal(gateway.calls, 1);

    const conflict = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/internal/duties/${duty.id}/invoke`,
      headers: { 'Idempotency-Key': 'invoke-api-1' },
      payload: { ...invocationPayload, input: 'A different request.' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');

    const completedDuties = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/duties?runId=${run.id}`,
    });
    assert.equal(completedDuties.json().items[0].lifecycle, 'COMPLETED');
    assert.equal(completedDuties.json().items[0].currentStaffing, null);

    const usageResponse = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/usage?runId=${run.id}`,
    });
    assert.equal(usageResponse.json().items.length, 1);
    assert.equal(usageResponse.json().items[0].actualCost, 0.01);

    const workforce = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/workforce',
    });
    assert.equal(workforce.json().summary.currentDuties, 0);
  } finally {
    await runtime.app.close();
  }
});

test('runtime access API stores native Agent configuration without secret material', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    initialSync: false,
    env: {
      MODEL_CP_V2_LITELLM: '0',
      MODEL_CP_V2_CPA_DISCOVERY: '0',
      MODEL_CP_V2_DISCOVERY: '0',
    },
  });
  try {
    const supplier = runtime.v2.getOrCreateSupplier('custom-team', 'Custom Team');
    const model = runtime.v2.getOrCreateSupplierModel({
      supplierId: String(supplier.id),
      supplierModelKey: 'alpha',
      displayName: 'Alpha',
    });
    const employee = runtime.v2.getOrCreateEmployee({
      supplierId: String(supplier.id),
      supplierModelId: String(model.id),
      displayName: 'Alpha @ Custom Team',
    });
    const agreement = runtime.v2.getOrCreateAgreement({
      supplierId: String(supplier.id),
      externalAccountRef: 'team-api',
      name: 'Team API',
    });
    const employment = runtime.v2.getOrCreateCurrentEmployment({
      employeeId: String(employee.id),
      supplyAgreementId: String(agreement.id),
    });

    const created = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/employments/${employment.id}/runtime-access`,
      headers: { 'idempotency-key': 'native-runtime-access-alpha' },
      payload: {
        runtimeKind: 'OPENCODE',
        adapterKind: 'NATIVE_CONFIG',
        providerRef: 'hao-custom-team',
        modelRef: 'alpha',
        baseUrl: 'https://proxy.example.com/v1',
        credentialRef: 'HERMES_AI_OFFICE_TEAM_API_KEY',
        protocol: 'openai-chat-completions',
        config: { package: '@ai-sdk/openai-compatible' },
      },
    });
    assert.equal(created.statusCode, 200);
    const body = created.json();
    assert.equal(body.adapterKind, 'NATIVE_CONFIG');
    assert.equal(body.credentialRef, 'HERMES_AI_OFFICE_TEAM_API_KEY');
    assert.equal(JSON.stringify(body).includes('secret-key-value'), false);

    const listed = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/runtime-access-profiles?employmentId=${employment.id}`,
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items.length, 1);
    assert.equal(listed.json().items[0].providerRef, 'hao-custom-team');
  } finally {
    await runtime.app.close();
  }
});

test('legacy runtime access import is an idempotent command and does not infer secrets', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    initialSync: false,
    env: {
      MODEL_CP_V2_LITELLM: '0',
      MODEL_CP_V2_CPA_DISCOVERY: '0',
      MODEL_CP_V2_DISCOVERY: '0',
    },
  });
  try {
    const supplier = runtime.v2.getOrCreateSupplier('opencode', 'OpenCode');
    const model = runtime.v2.getOrCreateSupplierModel({
      supplierId: String(supplier.id),
      supplierModelKey: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
    });
    const employee = runtime.v2.getOrCreateEmployee({
      supplierId: String(supplier.id),
      supplierModelId: String(model.id),
      displayName: 'DeepSeek V4 Flash @ OpenCode',
    });
    const agreement = runtime.v2.getOrCreateAgreement({
      supplierId: String(supplier.id),
      externalAccountRef: 'opencode-go',
      name: 'OpenCode Go',
    });
    const employment = runtime.v2.getOrCreateCurrentEmployment({
      employeeId: String(employee.id),
      supplyAgreementId: String(agreement.id),
    });
    const offering = runtime.v2.db
      .prepare(
        `INSERT INTO v2_model_offerings(
           id,supplier_id,supplier_model_id,supply_agreement_id,lifecycle,
           advertised_capabilities_json,protocol_options_json,commercial_metadata_json,
           created_at,updated_at)
         VALUES('offer-import',?,?,?,'ACTIVE','[]','[]',?,1,1)
         RETURNING *`,
      )
      .get(
        String(supplier.id),
        String(model.id),
        String(agreement.id),
        JSON.stringify({
          runtimeSelectors: {
            OPENCODE: { model: 'opencode-go/deepseek-v4-flash', provider: 'opencode-go' },
          },
        }),
      );
    runtime.v2.db
      .prepare('UPDATE v2_employments SET model_offering_id=? WHERE id=?')
      .run(String((offering as Record<string, unknown>).id), String(employment.id));

    const first = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/runtime-access/import-legacy',
      headers: { 'idempotency-key': 'import-runtime-access-v1' },
      payload: {},
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().imported, 1);
    const second = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/runtime-access/import-legacy',
      headers: { 'idempotency-key': 'import-runtime-access-v1' },
      payload: {},
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers['idempotency-replayed'], 'true');

    const listed = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/runtime-access-profiles?employmentId=${employment.id}`,
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items.length, 1);
    assert.equal(listed.json().items[0].providerRef, 'opencode-go');
    assert.equal(listed.json().items[0].baseUrl, null);
    assert.equal(listed.json().items[0].credentialRef, null);
  } finally {
    await runtime.app.close();
  }
});
