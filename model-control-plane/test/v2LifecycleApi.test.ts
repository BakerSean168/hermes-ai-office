import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import type {
  GatewayExecutionPort,
  GatewayHealth,
  GatewayRouteRef,
  GatewayRouteResolution,
} from '../src/gateway/ports.js';
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

class MutableApiGateway implements GatewayExecutionPort {
  readonly gatewayId = 'litellm-reference';
  readonly routable = new Set<string>();

  async resolveRoute(employmentId: string): Promise<GatewayRouteResolution> {
    const routable = this.routable.has(employmentId);
    return {
      route: routable
        ? {
            gatewayId: this.gatewayId,
            employmentId,
            externalRouteRef: `employment:${employmentId}`,
            protocol: 'openai-responses',
          }
        : null,
      routable,
      reasons: routable ? ['AVAILABLE'] : ['UNAVAILABLE'],
      observedAt: Date.now(),
    };
  }

  async getRouteHealth(_route: GatewayRouteRef): Promise<GatewayHealth> {
    return 'healthy';
  }
}

async function createActiveDuty(options: { withSecondaryEmployment?: boolean } = {}) {
  const gateway = new MutableApiGateway();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    gateways: new GatewayRegistry([gateway]),
  });
  const primary = runtime.v2.bootstrapReference(reference);
  const secondary = options.withSecondaryEmployment
    ? runtime.v2.bootstrapReference({
        ...reference,
        agreementRef: 'planner-pool-secondary',
        agreementName: 'Planner Pool Secondary Supply',
      })
    : null;
  gateway.routable.add(primary.employmentId);

  const run = runtime.v2.createRun({
    workScopeId: primary.workScopeId,
    title: 'Lifecycle API run',
    externalRunRef: `lifecycle-api-${Math.random()}`,
  });
  const duty = runtime.v2.openDuty({
    runId: String(run.id),
    positionId: primary.positionId,
    activity: 'REVIEWING',
  });
  const dispatch = await runtime.app.inject({
    method: 'POST',
    url: `/api/v2/commands/duties/${String(duty.id)}/dispatch`,
    payload: { correlationId: 'corr_initial_dispatch' },
  });
  assert.equal(dispatch.statusCode, 200);
  return { runtime, gateway, primary, secondary, run, duty, dispatch: dispatch.json() };
}

test('Employment suspend API performs B2 redispatch without replacing the employee seat', async () => {
  const { runtime, gateway, primary, secondary, duty, dispatch } = await createActiveDuty({
    withSecondaryEmployment: true,
  });
  assert.ok(secondary);
  gateway.routable.delete(primary.employmentId);
  gateway.routable.add(secondary.employmentId);

  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/employments/${primary.employmentId}/suspend`,
      payload: { reason: 'QUOTA_EXHAUSTED', correlationId: 'corr_b2_api' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.entity.status, 'SUSPENDED');
    assert.equal(body.redispatches.length, 1);
    assert.equal(body.redispatches[0].status, 'SUCCEEDED');
    assert.equal(body.redispatches[0].result.selected.employeeId, primary.employeeId);
    assert.equal(body.redispatches[0].result.selected.employmentId, secondary.employmentId);
    assert.equal(body.redispatches[0].result.staffingSegmentId, dispatch.staffingSegmentId);
    assert.equal(body.redispatches[0].result.replacedStaffingSegmentId, null);

    const duties = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/duties?runId=${String(duty.run_id)}`,
    });
    assert.equal(duties.json().items[0].currentStaffing.segmentId, dispatch.staffingSegmentId);
    assert.equal(
      runtime.v2.invocationContext(String(duty.id))?.employmentId,
      secondary.employmentId,
    );

    const events = runtime.v2.eventsAfter();
    const suspended = events.find((event) => event.type === 'employment.suspended');
    assert.equal(suspended?.correlation.correlationId, 'corr_b2_api');
    const redispatched = events.filter((event) => event.type === 'dispatch.decided').at(-1);
    assert.equal(redispatched?.correlation.correlationId, 'corr_b2_api');
  } finally {
    await runtime.app.close();
  }
});

test('Employment suspend API blocks Duty and closes stale staffing when no route remains', async () => {
  const { runtime, gateway, primary, duty } = await createActiveDuty();
  gateway.routable.delete(primary.employmentId);

  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/employments/${primary.employmentId}/suspend`,
      payload: { reason: 'SUPPLY_UNAVAILABLE', correlationId: 'corr_no_route' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.entity.status, 'SUSPENDED');
    assert.equal(body.redispatches[0].status, 'SUCCEEDED');
    assert.equal(body.redispatches[0].result.selected, null);

    const dutyAfter = runtime.v2.getDuty(String(duty.id));
    assert.equal(dutyAfter?.lifecycle, 'ACTIVE');
    assert.equal(dutyAfter?.current_activity, 'BLOCKED');
    assert.equal(runtime.v2.listDuties({ activeOnly: true })[0]?.currentStaffing, null);
    assert.equal(runtime.v2.employeeDossier(primary.employeeId)?.currentWork.length, 0);

    const closed = runtime.v2.db
      .prepare(
        'SELECT ended_reason FROM v2_staffing_segments WHERE duty_session_id=? ORDER BY started_at DESC LIMIT 1',
      )
      .get(String(duty.id));
    assert.equal(closed.ended_reason, 'UNAVAILABLE');
  } finally {
    await runtime.app.close();
  }
});

test('Lifecycle endpoints return deterministic not-found and conflict codes', async () => {
  const { runtime, primary } = await createActiveDuty();
  try {
    const missing = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/commands/employments/empl_missing/end',
      payload: {},
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'EMPLOYMENT_NOT_FOUND');

    const end = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/employments/${primary.employmentId}/end`,
      payload: { reason: 'TEST_END' },
    });
    assert.equal(end.statusCode, 200);

    const resume = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/commands/employments/${primary.employmentId}/resume`,
      payload: {},
    });
    assert.equal(resume.statusCode, 409);
    assert.equal(resume.json().error.code, 'EMPLOYMENT_NOT_RESUMABLE');
  } finally {
    await runtime.app.close();
  }
});
