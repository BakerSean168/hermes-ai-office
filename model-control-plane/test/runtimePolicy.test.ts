import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { runV2Migrations } from '../src/v2/migrations.js';
import { V2Repository } from '../src/v2/repository.js';
import { RuntimeAccessRepository } from '../src/v2/runtimeAccess.js';
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

test('supplier employee selection can disable discovered Employees without deleting them', () => {
  const { repository, supply, policy, position, catalog, employee } = make();
  const second = supply.registerCatalogEntry({
    supplier: { slug: 'opencode', name: 'OpenCode' },
    supplierModel: { key: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    agreement: { externalAccountRef: 'opencode-go', name: 'OpenCode Go' },
    plan: { slug: 'go', name: 'OpenCode Go', commercialType: 'SUBSCRIPTION' },
    runtimeSelectors: { OPENCODE: { model: 'opencode-go/deepseek-v4-pro' } },
  });
  const secondEmployee = second.employee as Record<string, unknown>;
  repository.getOrCreateCurrentAppointment({
    employeeId: String(secondEmployee.id),
    positionId: String(position.id),
    appointmentClass: 'PRIMARY',
    priority: 200,
  });
  const supplier = catalog.supplier as Record<string, unknown>;
  supply.setStaffingPreferences(String(supplier.id), {
    enabledEmployeeIds: [String(employee.id)],
    defaultEmployeeId: String(employee.id),
  });

  const decision = policy.resolve({
    runtimeKind: 'OPENCODE',
    policyMode: 'PREFER',
    positionSlug: 'coding-executor',
    toolCallId: 'supplier-enabled-filter',
  });
  assert.equal((decision.employee as Record<string, unknown>).id, employee.id);
  const disabled = (decision.candidateResults as Array<Record<string, unknown>>).find(
    (item) => item.employeeId === secondEmployee.id,
  );
  assert.equal(disabled?.supplierEnabled, false);
  assert.ok((disabled?.reasons as string[]).includes('SUPPLIER_EMPLOYEE_DISABLED'));
  assert.equal(repository.listEmployees().length, 2);
});

test('supplier default Employee breaks equal appointment ties but never overrides appointment priority', () => {
  const { db, repository, supply, policy, position, catalog, employee } = make();
  const second = supply.registerCatalogEntry({
    supplier: { slug: 'opencode', name: 'OpenCode' },
    supplierModel: { key: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    agreement: { externalAccountRef: 'opencode-go', name: 'OpenCode Go' },
    plan: { slug: 'go', name: 'OpenCode Go', commercialType: 'SUBSCRIPTION' },
    runtimeSelectors: { OPENCODE: { model: 'opencode-go/deepseek-v4-pro' } },
  });
  const secondEmployee = second.employee as Record<string, unknown>;
  repository.getOrCreateCurrentAppointment({
    employeeId: String(secondEmployee.id),
    positionId: String(position.id),
    appointmentClass: 'PRIMARY',
    priority: 100,
  });
  const supplier = catalog.supplier as Record<string, unknown>;
  supply.setStaffingPreferences(String(supplier.id), {
    enabledEmployeeIds: [String(employee.id), String(secondEmployee.id)],
    defaultEmployeeId: String(secondEmployee.id),
  });
  const preferred = policy.resolve({
    runtimeKind: 'OPENCODE',
    policyMode: 'PREFER',
    positionSlug: 'coding-executor',
    toolCallId: 'supplier-default-tie',
  });
  assert.equal((preferred.employee as Record<string, unknown>).id, secondEmployee.id);

  db.prepare(
    `UPDATE v2_appointments SET priority=300 WHERE employee_id=? AND position_id=? AND effective_to IS NULL`,
  ).run(String(employee.id), String(position.id));
  const priorityWins = policy.resolve({
    runtimeKind: 'OPENCODE',
    policyMode: 'PREFER',
    positionSlug: 'coding-executor',
    toolCallId: 'supplier-default-priority',
  });
  assert.equal((priorityWins.employee as Record<string, unknown>).id, employee.id);
});

test('supplier staffing preferences reject Employees from another Supplier', () => {
  const { supply, repository, catalog, employee } = make();
  const other = supply.registerCatalogEntry({
    supplier: { slug: 'deepseek', name: 'DeepSeek' },
    supplierModel: { key: 'deepseek-chat', name: 'DeepSeek Chat' },
    agreement: { externalAccountRef: 'deepseek-api', name: 'DeepSeek API' },
  });
  const supplier = catalog.supplier as Record<string, unknown>;
  const otherEmployee = other.employee as Record<string, unknown>;
  assert.throws(
    () =>
      repository.setSupplierStaffingPreferences({
        supplierId: String(supplier.id),
        enabledEmployeeIds: [String(employee.id), String(otherEmployee.id)],
        defaultEmployeeId: String(employee.id),
      }),
    /SUPPLIER_EMPLOYEE_MISMATCH/,
  );
});

test('first-class runtime access overrides legacy model-offering selector', () => {
  const { repository, supply, staffing, catalog, position, employee } = make();
  const access = new RuntimeAccessRepository(repository);
  const employment = catalog.employment as Record<string, unknown>;
  access.upsert({
    employmentId: String(employment.id),
    runtimeKind: 'OPENCODE',
    adapterKind: 'NATIVE_CONFIG',
    providerRef: 'hao-opencode-native',
    modelRef: 'deepseek-v4-flash',
    credentialRef: 'OPENCODE_GO_API_KEY',
    protocol: 'openai-chat-completions',
    priority: 200,
  });
  const policy = new RuntimePolicyService(repository, supply, staffing, access);
  const decision = policy.resolve({
    runtimeKind: 'OPENCODE',
    policyMode: 'PREFER',
    positionSlug: 'coding-executor',
    toolCallId: 'native-access-wins',
  });

  assert.equal((decision.position as Record<string, unknown>).id, position.id);
  assert.equal((decision.employee as Record<string, unknown>).id, employee.id);
  assert.equal(decision.selectedModel, 'hao-opencode-native/deepseek-v4-flash');
  const selectedAccess = decision.selectedAccess as Record<string, unknown>;
  assert.equal(selectedAccess.adapterKind, 'NATIVE_CONFIG');
  assert.equal(selectedAccess.providerRef, 'hao-opencode-native');
  assert.equal(selectedAccess.credentialRef, 'OPENCODE_GO_API_KEY');
});
