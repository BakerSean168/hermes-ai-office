import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane, type LegacyCpaPort, type LegacyUsagePort } from '../src/app.js';
import { openDb } from '../src/db.mjs';
import { CompatibilityAuditService } from '../src/v2/compatibility.js';
import { IncidentProjectionService } from '../src/v2/incidents.js';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';

const legacySnapshot = {
  snapshot() {
    return {
      providers: [{ id: 'cpa' }],
      channels: [{ id: 'channel-a' }, { id: 'channel-b' }],
      workers: [{ id: 'worker-a' }, { id: 'worker-b' }, { id: 'worker-c' }],
      positions: [{ id: 'coding-review' }],
      assignments: [{ id: 'assignment-a' }],
    };
  },
};

function seededDomain() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const domain = new V2Repository(db);
  domain.bootstrapReference({
    supplierSlug: 'supplier-a',
    supplierName: 'Supplier A',
    supplierModelKey: 'model-a',
    supplierModelName: 'Model A',
    agreementRef: 'agreement-a',
    agreementName: 'Agreement A',
    gatewaySlug: 'gateway-a',
    gatewayKind: 'OTHER',
    gatewayName: 'Gateway A',
    workScopeSlug: 'development',
    workScopeName: 'Development',
    positionSlug: 'coding-review',
    positionName: 'Coding Reviewer',
    positionKind: 'REVIEWER',
    runtimeKind: 'CODEX',
    protocol: 'openai-responses',
  });
  db.prepare(
    `INSERT INTO v2_execution_sync_runs(
       id,source,started_at,completed_at,status,profiles_seen,runs_seen,nodes_seen,
       runtime_sessions_seen,edges_seen,issues_json,metadata_json)
     VALUES('sync-ok','HERMES_ORG',100,200,'COMPLETED',1,1,1,1,0,'[]','{}')`,
  ).run();
  new IncidentProjectionService(domain).projectIncremental();
  return { db, domain };
}

test('compatibility audit refuses V1 retirement while CPA and protected contracts remain active', () => {
  const { domain } = seededDomain();
  const audit = new CompatibilityAuditService(domain, legacySnapshot, {
    MODEL_CP_SYNC_CPA: '1',
    MODEL_CP_MANAGE_POSITION_ALIASES: '1',
  });
  const status = audit.status();

  assert.equal(status.mode, 'DUAL_RUN');
  assert.equal(status.retirementReady, false);
  assert.equal((status.v1 as Record<string, unknown>).workers, 3);
  assert.equal((status.v2 as Record<string, unknown>).employees, 1);
  assert.ok(
    (status.semanticWarnings as string[]).some((warning) =>
      warning.includes('MUST NOT be compared one-to-one'),
    ),
  );
  const blockerCodes = (status.blockers as Array<{ code: string }>).map((item) => item.code);
  assert.deepEqual(blockerCodes, [
    'LEGACY_CPA_SYNC_ACTIVE',
    'LEGACY_POSITION_ALIAS_MANAGEMENT_ACTIVE',
    'PUBLIC_V1_RETIREMENT_NOT_APPROVED',
  ]);
});

test('compatibility audit becomes retirement-ready only after explicit cutover and green technical gates', () => {
  const { domain } = seededDomain();
  const audit = new CompatibilityAuditService(domain, legacySnapshot, {
    MODEL_CP_SYNC_CPA: '0',
    MODEL_CP_MANAGE_POSITION_ALIASES: '0',
    MODEL_CP_V1_RETIREMENT_APPROVED: '1',
  });
  const status = audit.status();

  assert.equal(status.mode, 'RETIREMENT_READY');
  assert.equal(status.retirementReady, true);
  assert.deepEqual(status.blockers, []);
  assert.ok(Object.values(status.gates as Record<string, boolean>).every(Boolean));
});

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

test('compatibility status is exposed as a V2 read contract without mutating V1', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    cpa,
    cpaUsage: usage,
    initialSync: false,
    env: {
      ...process.env,
      MODEL_CP_SYNC_CPA: '0',
      MODEL_CP_MANAGE_POSITION_ALIASES: '0',
    },
  });
  try {
    runtime.v2.bootstrapReference({
      supplierSlug: 'supplier-a',
      supplierName: 'Supplier A',
      supplierModelKey: 'model-a',
      supplierModelName: 'Model A',
      agreementRef: 'agreement-a',
      agreementName: 'Agreement A',
      gatewaySlug: 'gateway-a',
      gatewayKind: 'OTHER',
      gatewayName: 'Gateway A',
      workScopeSlug: 'development',
      workScopeName: 'Development',
      positionSlug: 'coding-review',
      positionName: 'Coding Reviewer',
      positionKind: 'REVIEWER',
      runtimeKind: 'CODEX',
      protocol: 'openai-responses',
    });
    const before = runtime.store.snapshot();
    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/compatibility/status',
    });
    const after = runtime.store.snapshot();
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().mode, 'DUAL_RUN');
    assert.equal(response.json().retirementReady, false);
    assert.deepEqual(after, before);
    assert.ok(response.json().protectedContracts.length >= 3);
  } finally {
    await runtime.app.close();
  }
});
