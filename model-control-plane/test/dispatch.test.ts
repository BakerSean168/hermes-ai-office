import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GatewayExecutionPort,
  GatewayHealth,
  GatewayRouteRef,
  GatewayRouteResolution,
} from '../src/gateway/ports.js';
import { GatewayRegistry } from '../src/gateway/registry.js';
import { DispatchService } from '../src/v2/dispatch.js';
import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';

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

class FakeGateway implements GatewayExecutionPort {
  readonly gatewayId = 'litellm-reference';
  readonly #routable = new Set<string>();

  constructor(routableEmployments: string[]) {
    for (const id of routableEmployments) this.#routable.add(id);
  }

  async resolveRoute(employmentId: string): Promise<GatewayRouteResolution> {
    const routable = this.#routable.has(employmentId);
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
      reasons: routable ? ['FAKE_AVAILABLE'] : ['FAKE_UNAVAILABLE'],
      observedAt: Date.now(),
    };
  }

  async getRouteHealth(_route: GatewayRouteRef): Promise<GatewayHealth> {
    return 'healthy';
  }
}

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const seeded = repository.bootstrapReference(reference);
  const run = repository.createRun({
    workScopeId: seeded.workScopeId,
    title: 'Review the reference change',
    externalRunRef: 'run-reference-1',
  });
  const duty = repository.openDuty({
    runId: String(run.id),
    positionId: seeded.positionId,
    activity: 'REVIEWING',
  });
  return { db, repository, seeded, run, duty };
}

test('dispatch creates one active StaffingSegment and current work projection', async () => {
  const { repository, seeded, duty } = make();
  const service = new DispatchService(
    repository,
    new GatewayRegistry([new FakeGateway([seeded.employmentId])]),
  );
  const result = await service.dispatchDuty(String(duty.id));

  assert.equal(result.selected.employeeId, seeded.employeeId);
  assert.equal(result.selected.employmentId, seeded.employmentId);
  assert.equal(result.selectedRoute.externalRouteRef, seeded.externalRouteRef);
  assert.ok(result.staffingSegmentId);

  const dossier = repository.employeeDossier(seeded.employeeId);
  assert.equal(dossier?.currentWork.length, 1);
  assert.equal(dossier?.currentWork[0].position_slug, 'coding-review');
  assert.equal(
    repository.listDuties({ activeOnly: true })[0]?.currentStaffing.employeeId,
    seeded.employeeId,
  );
  assert.ok(repository.eventsAfter().some((event) => event.type === 'dispatch.decided'));
  assert.ok(repository.eventsAfter().some((event) => event.type === 'staffing_segment.started'));
});

test('dispatch records an explicit failure when no gateway adapter is available', async () => {
  const { repository, duty } = make();
  const result = await new DispatchService(repository, new GatewayRegistry()).dispatchDuty(
    String(duty.id),
  );

  assert.equal(result.selected, null);
  assert.equal(result.staffingSegmentId, null);
  assert.deepEqual(result.candidateResults[0].routes[0].reasons, ['GATEWAY_ADAPTER_UNAVAILABLE']);
  assert.equal(repository.getDuty(String(duty.id))?.current_activity, 'BLOCKED');
  assert.ok(repository.eventsAfter().some((event) => event.type === 'dispatch.failed'));
});

test('dispatch may switch Employment without changing Employee identity', async () => {
  const { repository, seeded, duty } = make();
  const second = repository.bootstrapReference({
    ...reference,
    agreementRef: 'planner-pool-secondary',
    agreementName: 'Planner Pool Secondary Supply',
  });
  const service = new DispatchService(
    repository,
    new GatewayRegistry([new FakeGateway([second.employmentId])]),
  );
  const result = await service.dispatchDuty(String(duty.id));

  assert.equal(result.selected.employeeId, seeded.employeeId);
  assert.equal(result.selected.employmentId, second.employmentId);
  assert.notEqual(result.selected.employmentId, seeded.employmentId);
  assert.equal(repository.employeeDossier(seeded.employeeId)?.currentWork.length, 1);
});

test('subscribers receive committed events and never rolled-back events', () => {
  const { repository } = make();
  const received: string[] = [];
  repository.subscribe((event) => received.push(event.type));

  assert.throws(() =>
    repository.transaction(() => {
      repository.emit({ type: 'should.not.escape' });
      throw new Error('rollback');
    }),
  );
  assert.equal(received.includes('should.not.escape'), false);

  repository.transaction(() => repository.emit({ type: 'committed.event' }));
  assert.equal(received.includes('committed.event'), true);
});
