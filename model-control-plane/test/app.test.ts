import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type CpaProbePort, type CpaUsagePort } from '../src/app.js';

const emptyCpa: CpaProbePort = {
  async status() {
    return [];
  },
  async test() {},
};

const emptyUsage: CpaUsagePort = {
  async snapshot() {
    return { range: '30d', stats: { groups: [] }, costs: { models: [] } };
  },
};

test('typed app factory exposes V2 only and retires public V1 routes', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa: emptyCpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), {
      status: 'ok',
      service: 'hermes-model-control-plane',
      apiVersion: 2,
      v3Enabled: false,
      db: ':memory:',
    });

    const v2Health = await runtime.app.inject({ method: 'GET', url: '/api/v2/health' });
    assert.equal(v2Health.statusCode, 200);
    assert.equal(v2Health.json().apiVersion, 2);

    const v2Workforce = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/workforce',
    });
    assert.equal(v2Workforce.statusCode, 200);
    assert.deepEqual(v2Workforce.json().summary, {
      employees: 0,
      employed: 0,
      dormant: 0,
      currentDuties: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      actualCost: 0,
      marketValue: 0,
      observedUsage: {
        authoritative: false,
        scope: 'GATEWAY_AGGREGATE',
        evidenceCount: 0,
        attributedEvidenceCount: 0,
        unattributedEvidenceCount: 0,
        totalRequests: 0,
        attributedRequests: 0,
        unattributedRequests: 0,
        failedRequests: 0,
        successfulRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        actualCost: 0,
        windows: [],
        latestGeneratedAt: 0,
      },
    });

    const supply = await runtime.app.inject({ method: 'GET', url: '/api/v2/projections/supply' });
    assert.equal(supply.statusCode, 200);
    assert.equal(supply.json().summary.suppliers, 0);
    assert.deepEqual(supply.json().suppliers, []);

    for (const url of [
      '/api/v1/snapshot',
      '/api/v1/dashboard/workforce',
      '/api/v1/events',
      '/api/v2/compatibility/status',
    ]) {
      const retired = await runtime.app.inject({ method: 'GET', url });
      assert.equal(retired.statusCode, 404, `${url} must remain retired`);
    }
  } finally {
    await runtime.app.close();
  }
});

test('V2 gateway discovery replaces legacy CPA synchronization', async () => {
  const cpa: CpaProbePort = {
    async status() {
      return [
        {
          name: 'route-a',
          protocol: 'openai-compatible',
          enabled: true,
          models: ['model-a'],
          health: 'healthy',
          lastTest: 'pass',
        },
      ];
    },
    async test() {},
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    assert.equal(runtime.v2.listGateways().length, 0);
    await runtime.reconcileGateways();
    const gateways = runtime.v2.listGateways();
    assert.equal(gateways.length, 1);
    assert.equal(gateways[0]?.slug, 'cpa-compat');
    assert.equal(gateways[0]?.kind, 'CPA');
    assert.equal(gateways[0]?.displayName, 'My CPA');
    assert.equal(runtime.v2.listEmployees().length, 0);
  } finally {
    await runtime.app.close();
  }
});

test('gateway discovery refreshes an existing gateway display descriptor', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa: emptyCpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    runtime.v2.getOrCreateGateway({
      slug: 'cpa-compat',
      kind: 'CPA',
      displayName: 'CPA Compatibility Gateway',
    });
    await runtime.reconcileGateways();
    const gateway = runtime.v2.findGatewayBySlug('cpa-compat');
    assert.equal(gateway?.display_name, 'My CPA');
  } finally {
    await runtime.app.close();
  }
});

test('supplier profile update renames generated employee labels without changing identity', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa: emptyCpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    const catalogResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/supply-catalog/register',
      headers: { 'idempotency-key': 'catalog-relay-one-opus' },
      payload: {
        supplier: { slug: 'relay-one', name: 'Kiro', websiteUrl: 'https://relay.example/' },
        supplierModel: { key: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
        agreement: { externalAccountRef: 'relay-one-kiro', name: 'Kiro / Current access' },
      },
    });
    assert.equal(catalogResponse.statusCode, 200);
    const catalog = catalogResponse.json();
    const employeeId = String(catalog.employee.id);
    const supplierId = String(catalog.supplier.id);

    const response = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/suppliers/${supplierId}/profile`,
      headers: { 'idempotency-key': 'supplier-profile-relay-one' },
      payload: { name: 'Commercial Relay 1', websiteUrl: 'https://commercial-relay.example/' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().name, 'Commercial Relay 1');
    assert.equal(response.json().website_url, 'https://commercial-relay.example');
    const supplierProjection = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/supply',
    });
    assert.equal(
      supplierProjection.json().suppliers[0].websiteUrl,
      'https://commercial-relay.example',
    );
    const employee = runtime.v2.listEmployees().find((item) => item.id === employeeId);
    assert.equal(employee?.displayName, 'Claude Opus 4.6 @ Commercial Relay 1');
    assert.equal(employee?.id, employeeId);
  } finally {
    await runtime.app.close();
  }
});

test('supplier retirement preserves history and removes the supplier from current projections', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa: emptyCpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    const seeded = runtime.v2.bootstrapReference({
      supplierSlug: 'legacy-pool',
      supplierName: 'Legacy Pool',
      supplierModelKey: 'model-a',
      supplierModelName: 'Model A',
      agreementRef: 'legacy-pool-primary',
      agreementName: 'Legacy Pool / Primary',
      gatewaySlug: 'litellm-reference',
      gatewayKind: 'LITELLM',
      gatewayName: 'LiteLLM Reference Gateway',
      workScopeSlug: 'development',
      workScopeName: 'Development',
      positionSlug: 'coding-review',
      positionName: 'Coding Reviewer',
      positionKind: 'REVIEWER',
      runtimeKind: 'CODEX',
      protocol: 'openai-responses',
    });

    const blocked = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/suppliers/${seeded.supplierId}/retire`,
      headers: { 'idempotency-key': 'retire-legacy-pool-blocked' },
      payload: { reason: 'MIGRATED_TO_NATIVE_ACCESS' },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error.code, 'SUPPLIER_HAS_OPEN_RELATIONSHIPS');

    const appointmentEnd = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/appointments/${seeded.appointmentId}/end`,
      payload: { reason: 'SUPPLIER_RETIRED' },
    });
    assert.equal(appointmentEnd.statusCode, 200);
    const employmentEnd = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/employments/${seeded.employmentId}/end`,
      payload: { reason: 'SUPPLIER_RETIRED' },
    });
    assert.equal(employmentEnd.statusCode, 200);

    const retired = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/suppliers/${seeded.supplierId}/retire`,
      headers: { 'idempotency-key': 'retire-legacy-pool' },
      payload: { reason: 'MIGRATED_TO_NATIVE_ACCESS' },
    });
    assert.equal(retired.statusCode, 200);
    assert.equal(retired.json().lifecycle, 'RETIRED');

    const replay = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/suppliers/${seeded.supplierId}/retire`,
      headers: { 'idempotency-key': 'retire-legacy-pool' },
      payload: { reason: 'MIGRATED_TO_NATIVE_ACCESS' },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');

    const supplyProjection = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/supply',
    });
    assert.equal(supplyProjection.statusCode, 200);
    assert.equal(supplyProjection.json().summary.suppliers, 0);
    assert.deepEqual(supplyProjection.json().suppliers, []);

    const workforceProjection = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/workforce',
    });
    assert.equal(workforceProjection.statusCode, 200);
    assert.equal(workforceProjection.json().summary.employees, 0);
    assert.deepEqual(workforceProjection.json().employees, []);

    const dossier = runtime.v2.employeeDossier(seeded.employeeId);
    assert.equal((dossier?.identity as Record<string, unknown>).lifecycle, 'RETIRED');
    assert.equal(
      ((dossier?.organization as Record<string, unknown>).currentAppointments as unknown[]).length,
      0,
    );
    assert.equal(
      (
        (
          (dossier?.cooperation as Record<string, unknown>).employmentHistory as Array<
            Record<string, unknown>
          >
        )[0] as Record<string, unknown>
      ).status,
      'ENDED',
    );
    assert.equal(runtime.v2.getAppointment(seeded.appointmentId)?.status, 'ENDED');
    assert.equal(runtime.v2.getEmployment(seeded.employmentId)?.status, 'ENDED');
    assert.equal(
      runtime.v2.findGatewayBinding(
        seeded.employmentId,
        seeded.gatewayId,
        `employment:${seeded.employmentId}`,
      )?.lifecycle,
      'RETIRED',
    );
  } finally {
    await runtime.app.close();
  }
});

test('operator force retirement closes active relationships and retires supplier provider connections', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa: emptyCpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    const seeded = runtime.v2.bootstrapReference({
      supplierSlug: 'operator-removable',
      supplierName: 'Operator Removable',
      supplierModelKey: 'model-a',
      supplierModelName: 'Model A',
      agreementRef: 'operator-removable-primary',
      agreementName: 'Operator Removable / Primary',
      gatewaySlug: 'litellm-reference',
      gatewayKind: 'LITELLM',
      gatewayName: 'LiteLLM Reference Gateway',
      workScopeSlug: 'development',
      workScopeName: 'Development',
      positionSlug: 'coding-review',
      positionName: 'Coding Reviewer',
      positionKind: 'REVIEWER',
      runtimeKind: 'CODEX',
      protocol: 'openai-responses',
    });
    const connection = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/provider-connections/upsert',
      headers: { 'idempotency-key': 'operator-removable-provider' },
      payload: {
        providerKey: 'operator-removable',
        displayName: 'Operator Removable',
        supplierId: seeded.supplierId,
        baseUrl: 'https://relay.example/v1',
        protocol: 'openai-responses',
        credentialRef: 'REMOVABLE_API_KEY',
        credentialScope: 'GLOBAL',
        sourceKind: 'TEST',
        models: ['model-a'],
      },
    });
    assert.equal(connection.statusCode, 200);

    const retired = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/suppliers/${seeded.supplierId}/retire`,
      headers: { 'idempotency-key': 'operator-removable-force-retire' },
      payload: { reason: 'OPERATOR_REMOVED', force: true },
    });
    assert.equal(retired.statusCode, 200);
    assert.equal(retired.json().lifecycle, 'RETIRED');
    assert.equal(runtime.v2.getAppointment(seeded.appointmentId)?.status, 'ENDED');
    assert.equal(runtime.v2.getEmployment(seeded.employmentId)?.status, 'ENDED');

    const supplyProjection = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/supply',
    });
    assert.equal(supplyProjection.json().summary.suppliers, 0);
    const providerProjection = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/provider-hub',
    });
    assert.equal(providerProjection.json().summary.connections, 0);
  } finally {
    await runtime.app.close();
  }
});

test('supplier economics command persists orthogonal tags and assigns commercial plan to active agreements', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa: emptyCpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });
  try {
    const seeded = runtime.v2.bootstrapReference({
      supplierSlug: 'community-free',
      supplierName: 'Community Free',
      supplierModelKey: 'gpt-5.6-sol',
      supplierModelName: 'GPT-5.6 Sol',
      agreementRef: 'community-free-current',
      agreementName: 'Community Free / Current',
      gatewaySlug: 'litellm-reference',
      gatewayKind: 'LITELLM',
      gatewayName: 'LiteLLM Reference Gateway',
      workScopeSlug: 'development',
      workScopeName: 'Development',
      positionSlug: 'review',
      positionName: 'Reviewer',
      positionKind: 'REVIEWER',
      runtimeKind: 'CODEX',
      protocol: 'openai-responses',
    });
    const response = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/suppliers/${seeded.supplierId}/economics`,
      headers: { 'idempotency-key': 'community-free-economics' },
      payload: {
        supplyOrigin: 'COMMUNITY_RELAY',
        routingPolicy: 'AUTO',
        commercialType: 'SPONSORED',
        planSlug: 'free',
        planName: 'Community sponsored access',
      },
    });
    assert.equal(response.statusCode, 200);
    const supply = await runtime.app.inject({ method: 'GET', url: '/api/v2/projections/supply' });
    const supplier = supply
      .json()
      .suppliers.find((item: Record<string, unknown>) => item.id === seeded.supplierId);
    assert.equal(supplier.supplyOrigin, 'COMMUNITY_RELAY');
    assert.equal(supplier.routingPolicy, 'AUTO');
    assert.equal(supplier.plans[0].commercialType, 'SPONSORED');
    assert.equal(supplier.agreements[0].commercialType, 'SPONSORED');
  } finally {
    await runtime.app.close();
  }
});

test('explicit supply catalog registration classifies gateway evidence without creating an Appointment', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa: emptyCpa,
    cpaUsage: emptyUsage,
    initialSync: false,
  });

  try {
    const gateway = runtime.v2.getOrCreateGateway({
      slug: 'cpa-compat',
      kind: 'CPA',
      displayName: 'CPA Gateway',
    });
    runtime.v2.upsertChannelObservation({
      gatewayId: String(gateway.id),
      externalRouteRef: 'cpa/channel/opencode-go/model/deepseek-v4-flash',
      name: 'opencode-go',
      protocol: 'openai-chat-completions',
      health: 'DEGRADED',
      supplierModelHint: 'deepseek-v4-flash',
      capabilities: [],
      metadata: { source: 'test-gateway-evidence' },
      observedAt: Date.now(),
    });

    const payload = {
      supplier: { slug: 'opencode', name: 'OpenCode' },
      supplierModel: { key: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      plan: { slug: 'go', name: 'OpenCode Go', commercialType: 'SUBSCRIPTION' },
      agreement: { externalAccountRef: 'opencode-go-primary', name: 'OpenCode Go / Primary' },
      runtimeSelectors: { OPENCODE: { model: 'opencode-go/deepseek-v4-flash' } },
      gatewayRoute: {
        gatewaySlug: 'cpa-compat',
        externalRouteRef: 'cpa/channel/opencode-go/model/deepseek-v4-flash',
        activateBinding: false,
      },
    };
    const first = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/supply-catalog/register',
      headers: { 'idempotency-key': 'catalog-opencode-flash' },
      payload,
    });
    assert.equal(first.statusCode, 200);
    const body = first.json();
    assert.equal(body.employee.displayName, 'DeepSeek V4 Flash @ OpenCode');
    assert.equal(body.plan.name, 'OpenCode Go');
    assert.equal(body.binding, null);
    assert.equal(
      body.offering.commercial_metadata_json.includes('opencode-go/deepseek-v4-flash'),
      true,
    );
    const selectors = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/model-offerings/${body.offering.id}/runtime-selectors`,
      headers: { 'idempotency-key': 'selectors-opencode-flash' },
      payload: { runtimeSelectors: { OPENCODE: { model: 'opencode-go/deepseek-v4-flash' } } },
    });
    assert.equal(selectors.statusCode, 200);
    assert.equal(
      selectors.json().commercial_metadata_json.includes('opencode-go/deepseek-v4-flash'),
      true,
    );
    assert.equal(runtime.v2.listAppointments({ employeeId: body.employee.id }).length, 0);

    const replay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/supply-catalog/register',
      headers: { 'idempotency-key': 'catalog-opencode-flash' },
      payload,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.equal(replay.json().employee.id, body.employee.id);
    assert.equal(runtime.v2.listEmployees().length, 1);
    assert.equal(runtime.v2.listAppointments().length, 0);

    const scope = runtime.v2.getOrCreateWorkScope({
      slug: 'development',
      name: 'Development',
      externalProfileRef: 'coder',
    });
    const positionResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/positions/create',
      headers: { 'idempotency-key': 'position-opencode-executor' },
      payload: {
        workScopeId: String(scope.id),
        slug: 'coding-executor',
        name: 'Coding Executor',
        kind: 'EXECUTOR',
        runtimeKind: 'OPENCODE',
      },
    });
    assert.equal(positionResponse.statusCode, 200);
    const position = positionResponse.json();
    const appointmentResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/appointments/create',
      headers: { 'idempotency-key': 'appointment-opencode-flash' },
      payload: { employeeId: String(body.employee.id), positionId: String(position.id) },
    });
    assert.equal(appointmentResponse.statusCode, 200);
    const decision = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/runtime-launch/resolve',
      headers: { 'idempotency-key': 'runtime-opencode-tool-1' },
      payload: {
        runtimeKind: 'OPENCODE',
        policyMode: 'PREFER',
        positionSlug: 'coding-executor',
        workScopeSlug: 'development',
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        commandName: 'opencode run',
      },
    });
    assert.equal(decision.statusCode, 200);
    assert.equal(decision.json().status, 'SELECTED');
    assert.equal(decision.json().employee.id, body.employee.id);
    assert.equal(decision.json().selectedModel, 'opencode-go/deepseek-v4-flash');
    const decisions = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/runtime-launch-decisions?limit=10',
    });
    assert.equal(decisions.statusCode, 200);
    assert.equal(decisions.json().items[0].toolCallId, 'tool-1');

    const projection = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/projections/supply',
    });
    const supply = projection.json();
    assert.equal(supply.suppliers[0].name, 'OpenCode');
    assert.equal(supply.suppliers[0].agreements[0].channels[0].name, 'opencode-go');
    assert.equal(supply.summary.unmappedChannels, 0);
  } finally {
    await runtime.app.close();
  }
});
