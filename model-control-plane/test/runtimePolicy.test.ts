import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';
import { RuntimePolicyService } from '../src/v2/runtimePolicy.js';
import { StaffingRepository } from '../src/v2/staffing.js';
import { SupplyRepository } from '../src/v2/supply.js';

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const supply = new SupplyRepository(repository);
  const staffing = new StaffingRepository(repository);
  const policy = new RuntimePolicyService(repository, supply, staffing);
  const scope = repository.getOrCreateWorkScope({
    slug: 'development',
    name: 'Development',
    externalProfileRef: 'coder',
  });
  const position = repository.getOrCreatePosition({
    workScopeId: String(scope.id),
    slug: 'coding-executor',
    name: 'Coding Executor',
    kind: 'EXECUTOR',
    runtimeKind: 'OPENCODE',
  });
  const catalog = supply.registerCatalogEntry({
    supplier: { slug: 'opencode', name: 'OpenCode' },
    supplierModel: { key: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    agreement: { externalAccountRef: 'opencode-go', name: 'OpenCode Go' },
    plan: { slug: 'go', name: 'OpenCode Go', commercialType: 'SUBSCRIPTION' },
    runtimeSelectors: {
      OPENCODE: { model: 'opencode-go/deepseek-v4-flash' },
    },
  });
  const employee = catalog.employee as Record<string, unknown>;
  const appointment = repository.getOrCreateCurrentAppointment({
    employeeId: String(employee.id),
    positionId: String(position.id),
    appointmentClass: 'PRIMARY',
    priority: 100,
  });
  return {
    db,
    repository,
    supply,
    staffing,
    policy,
    scope,
    position,
    catalog,
    employee,
    appointment,
  };
}

test('runtime policy selects an appointed Employee and native model selector', () => {
  const { policy, employee, catalog, position } = make();
  const employment = catalog.employment as Record<string, unknown>;
  const decision = policy.resolve({
    runtimeKind: 'OPENCODE',
    policyMode: 'PREFER',
    positionSlug: 'coding-executor',
    workScopeSlug: 'development',
    sessionId: 'session-1',
    taskId: 'task-1',
    toolCallId: 'tool-1',
    commandName: 'opencode run',
  });

  assert.equal(decision.status, 'SELECTED');
  assert.equal((decision.position as Record<string, unknown>).id, position.id);
  assert.equal((decision.employee as Record<string, unknown>).id, employee.id);
  assert.equal((decision.employment as Record<string, unknown>).id, employment.id);
  assert.equal(decision.selectedModel, 'opencode-go/deepseek-v4-flash');
  assert.deepEqual(decision.reasons, ['APPOINTMENT_AND_RUNTIME_SELECTOR_SELECTED']);
});

test('runtime policy preserves unmatched explicit model unless enforcement is enabled', () => {
  const { policy } = make();
  const preferred = policy.resolve({
    runtimeKind: 'OPENCODE',
    policyMode: 'PREFER',
    positionSlug: 'coding-executor',
    requestedModel: 'opencode/other-model',
    toolCallId: 'tool-prefer',
  });
  assert.equal(preferred.status, 'EXPLICIT_OVERRIDE');
  assert.equal(preferred.employee, null);
  assert.equal(preferred.selectedModel, 'opencode/other-model');

  const enforced = policy.resolve({
    runtimeKind: 'OPENCODE',
    policyMode: 'ENFORCE',
    positionSlug: 'coding-executor',
    requestedModel: 'opencode/other-model',
    toolCallId: 'tool-enforce',
  });
  assert.equal(enforced.status, 'SELECTED');
  assert.equal(enforced.selectedModel, 'opencode-go/deepseek-v4-flash');
  assert.ok((enforced.reasons as string[]).includes('EXPLICIT_MODEL_REPLACED_BY_ENFORCED_POLICY'));
});

test('runtime launch resolution is idempotent by Hermes tool call id', () => {
  const { policy, db } = make();
  const first = policy.resolve({
    runtimeKind: 'OPENCODE',
    positionSlug: 'coding-executor',
    toolCallId: 'same-tool-call',
  });
  const second = policy.resolve({
    runtimeKind: 'OPENCODE',
    positionSlug: 'coding-executor',
    toolCallId: 'same-tool-call',
  });
  assert.deepEqual(second, first);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM v2_runtime_launch_decisions').get().count, 1);
});

test('enforced runtime policy blocks when no matching Position exists', () => {
  const { policy } = make();
  const decision = policy.resolve({
    runtimeKind: 'CODEX',
    policyMode: 'ENFORCE',
    positionSlug: 'codex-executor',
    toolCallId: 'missing-codex',
  });
  assert.equal(decision.status, 'BLOCKED');
  assert.ok((decision.reasons as string[]).includes('NO_MATCHING_POSITION'));
});
