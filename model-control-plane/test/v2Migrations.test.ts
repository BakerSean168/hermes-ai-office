import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { loadV2Migrations, runV2Migrations } from '../src/v2/migrations.js';

function tableNames(db: ReturnType<typeof openDb>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

test('V2 schema migration is additive and idempotent', () => {
  const db = openDb(':memory:');
  const first = runV2Migrations(db);
  const second = runV2Migrations(db);

  assert.deepEqual(first.applied, [
    '001_spine',
    '002_gateway_discovery',
    '003_usage_reconciliation',
    '004_supply_capacity',
    '005_finance_evaluation',
  ]);
  assert.deepEqual(second.skipped, [
    '001_spine',
    '002_gateway_discovery',
    '003_usage_reconciliation',
    '004_supply_capacity',
    '005_finance_evaluation',
  ]);
  const tables = tableNames(db);
  assert.ok(tables.includes('providers'));
  assert.ok(tables.includes('workers'));
  assert.ok(tables.includes('v2_employees'));
  assert.ok(tables.includes('v2_employments'));
  assert.ok(tables.includes('v2_gateway_bindings'));
  assert.ok(tables.includes('v2_staffing_segments'));
  assert.ok(tables.includes('v2_usage_entries'));
  assert.ok(tables.includes('v2_channels'));
  assert.ok(tables.includes('v2_discovery_runs'));
  assert.ok(tables.includes('v2_gateway_usage_evidence'));
  assert.ok(tables.includes('v2_usage_reconciliation_runs'));
  assert.ok(tables.includes('v2_plans'));
  assert.ok(tables.includes('v2_model_offerings'));
  assert.ok(tables.includes('v2_capacity_pools'));
  assert.ok(tables.includes('v2_reference_prices'));
  assert.ok(tables.includes('v2_usage_market_valuations'));
  assert.ok(tables.includes('v2_cost_allocation_runs'));
  assert.ok(tables.includes('v2_cost_allocation_entries'));
  assert.ok(tables.includes('v2_evaluations'));
});

test('V2 migration checksums make edited history fail loudly', () => {
  const db = openDb(':memory:');
  const migrations = loadV2Migrations();
  runV2Migrations(db, migrations);

  assert.throws(
    () =>
      runV2Migrations(db, [
        {
          ...migrations[0]!,
          checksum: 'changed',
        },
      ]),
    /checksum mismatch/,
  );
});

test('V2 employee identity is unique by Supplier and SupplierModel', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const t = 1;
  db.prepare(
    'INSERT INTO v2_suppliers(id,slug,name,lifecycle,created_at,updated_at) VALUES(?,?,?,?,?,?)',
  ).run('sup_1', 'opencode', 'OpenCode', 'ACTIVE', t, t);
  db.prepare(
    'INSERT INTO v2_supplier_models(id,supplier_id,supplier_model_key,display_name,lifecycle,first_seen_at) VALUES(?,?,?,?,?,?)',
  ).run('smdl_1', 'sup_1', 'deepseek-v4-flash', 'DeepSeek V4 Flash', 'ACTIVE', t);
  const insert = db.prepare(
    'INSERT INTO v2_employees(id,supplier_id,supplier_model_id,display_name,record_lifecycle,first_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  );
  insert.run('emp_1', 'sup_1', 'smdl_1', 'DeepSeek @ OpenCode', 'ACTIVE', t, t, t);
  assert.throws(
    () => insert.run('emp_2', 'sup_1', 'smdl_1', 'Duplicate', 'ACTIVE', t, t, t),
    /UNIQUE constraint failed/,
  );
});

test('V2 permits one open StaffingSegment per DutySession', () => {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const t = 1;
  db.exec(`
    INSERT INTO v2_suppliers(id,slug,name,lifecycle,created_at,updated_at) VALUES('sup','s','S','ACTIVE',1,1);
    INSERT INTO v2_supplier_models(id,supplier_id,supplier_model_key,display_name,lifecycle,first_seen_at) VALUES('smdl','sup','m','M','ACTIVE',1);
    INSERT INTO v2_employees(id,supplier_id,supplier_model_id,display_name,record_lifecycle,first_seen_at,created_at,updated_at) VALUES('emp','sup','smdl','E','ACTIVE',1,1,1);
    INSERT INTO v2_work_scopes(id,slug,name,lifecycle,created_at,updated_at) VALUES('scope','scope','Scope','ACTIVE',1,1);
    INSERT INTO v2_positions(id,work_scope_id,slug,name,kind,lifecycle,created_at,updated_at) VALUES('pos','scope','review','Review','REVIEWER','ACTIVE',1,1);
    INSERT INTO v2_runs(id,work_scope_id,title,status,started_at,created_at,updated_at) VALUES('run','scope','Run','RUNNING',1,1,1);
    INSERT INTO v2_duty_sessions(id,run_id,position_id,lifecycle,current_activity,opened_at) VALUES('duty','run','pos','ACTIVE','REVIEWING',1);
    INSERT INTO v2_supply_agreements(id,supplier_id,name,lifecycle,valid_from,created_at,updated_at) VALUES('agr','sup','Agreement','ACTIVE',1,1,1);
    INSERT INTO v2_employments(id,employee_id,supply_agreement_id,status,effective_from,created_at,updated_at) VALUES('empl','emp','agr','CURRENT',1,1,1);
    INSERT INTO v2_appointments(id,employee_id,position_id,appointment_class,priority,status,effective_from,source,created_at,updated_at) VALUES('apt','emp','pos','PRIMARY',100,'CURRENT',1,'MANUAL',1,1);
    INSERT INTO v2_dispatch_decisions(id,duty_session_id,selected_employee_id,selected_appointment_id,selected_employment_id,candidate_results_json,policy_version,trigger,decided_at) VALUES('disp','duty','emp','apt','empl','[]','v1','DUTY_STARTED',1);
  `);
  const insert = db.prepare(
    'INSERT INTO v2_staffing_segments(id,duty_session_id,employee_id,appointment_id,dispatch_decision_id,started_at) VALUES(?,?,?,?,?,?)',
  );
  insert.run('seg_1', 'duty', 'emp', 'apt', 'disp', t);
  assert.throws(
    () => insert.run('seg_2', 'duty', 'emp', 'apt', 'disp', t + 1),
    /UNIQUE constraint failed/,
  );
});
