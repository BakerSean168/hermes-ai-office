import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { V4Error } from '../src/v4/domain/errors.js';
import { transitionPlan } from '../src/v4/domain/plan.js';
import { transitionExecution } from '../src/v4/domain/execution.js';
import { transitionReview } from '../src/v4/domain/review.js';
import { transitionSupervisor } from '../src/v4/domain/supervisor.js';
import { transitionAction } from '../src/v4/domain/action.js';
import { openV4Database, pragmaValue } from '../src/v4/persistence/database.js';
import { resetV4Database } from '../src/v4/persistence/reset-v4-database.js';
import { EventStore } from '../src/v4/persistence/eventStore.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';
import { PlanKernel } from '../src/v4/kernel/planKernel.js';
import { buildBoundedProjection } from '../src/v4/supervisor/projection.js';
import { parseSupervisorDecision } from '../src/v4/supervisor/protocol.js';
import { SupervisorActionExecutor } from '../src/v4/supervisor/executor.js';
import { JulesAdapter } from '../src/v4/adapters/jules.js';
import { GitHubPrIntake } from '../src/v4/adapters/github.js';
import { AntiGravityReadinessAdapter } from '../src/v4/adapters/antigravity.js';
import { MaintenanceCandidateRegistry } from '../src/v4/adapters/maintenance.js';
import { SupervisorWakeScheduler } from '../src/v4/supervisor/scheduler.js';
import { SupervisorRuntime } from '../src/v4/supervisor/runtime.js';
import { OpenHandsSupervisorAdapter } from '../src/v4/adapters/openhands.js';
import { HttpSupervisorDecisionClient } from '../src/v4/supervisor/runtime.js';
import { SupervisorActionExecutor } from '../src/v4/supervisor/executor.js';

function memory() {
  return openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
}

function seedPlan(db: DatabaseSync, idempotencyKey = 'seed-plan') {
  const repos = createRepositories(db);
  const plan = repos.plans.createPlan({
    idempotencyKey, projectKey: 'pixel', objective: 'test objective', repositoryPath: '/repo', baseRevision: 'base-sha',
  }).value;
  assert.ok(plan);
  const graph = repos.plans.createGraphVersion({ planId: plan.planId, reason: 'test graph' }).value;
  assert.ok(graph);
  const item = repos.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId, itemKey: 'item', title: 'Item', objective: 'Do item',
    acceptanceCriteria: ['it passes'], dependencies: [],
  }).value;
  assert.ok(item);
  repos.plans.updateStatus(plan.planId, 'READY');
  const supervisor = repos.supervisors.create({ planId: plan.planId }).value;
  assert.ok(supervisor);
  repos.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
  return { repos, plan: repos.plans.getPlan(plan.planId), graph, item, supervisor: repos.supervisors.getById(supervisor.supervisorId) };
}

test('fresh database bootstraps once, restarts, enables WAL and foreign keys', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-schema-'));
  const file = path.join(directory, 'control-plane.sqlite');
  const first = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  assert.equal(pragmaValue(first, 'foreign_keys'), 1);
  assert.equal(pragmaValue(first, 'journal_mode'), 'wal');
  assert.equal(pragmaValue(first, 'busy_timeout'), 5000);
  first.close();
  const second = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const tables = second.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as Array<{ name: string }>;
  assert.ok(tables.some((row) => row.name === 'events'));
  second.close();
});

test('old database fails closed and explicit reset reports scope', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-reset-'));
  const file = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE legacy_state(value TEXT)');
  legacy.close();
  assert.throws(() => openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } }), (error: unknown) => error instanceof V4Error && error.code === 'V4_DATA_RESET_REQUIRED');
  const result = resetV4Database(file, { environment: 'test', env: { NODE_ENV: 'test', PIXEL_V4_ALLOW_DATA_RESET: 'true' } });
  assert.deepEqual(result, { databaseFile: file, scope: 'ALL_V4_DATA', authorized: true });
  const db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  assert.equal(db.prepare("SELECT count(*) AS count FROM schema_meta WHERE schema_id='pixel-v4'").get()?.count, 1);
  db.close();
});

test('production reset remains refused even with reset flag', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-prod-reset-'));
  const file = path.join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE legacy_state(value TEXT)');
  db.close();
  assert.throws(() => resetV4Database(file, { environment: 'production', env: { NODE_ENV: 'production', PIXEL_V4_ALLOW_DATA_RESET: 'true' } }), (error: unknown) => error instanceof V4Error && error.code === 'PRODUCTION_RESET_FORBIDDEN');
});

test('event append is monotonic, immutable by id and replayable', () => {
  const db = memory();
  const store = new EventStore(db);
  const first = store.append({ eventId: 'event-1', aggregateId: 'plan-1', aggregateType: 'PLAN', type: 'CREATED', payload: { value: 1 }, occurredAt: new Date().toISOString(), correlationId: 'corr-1' });
  const second = store.append({ eventId: 'event-2', aggregateId: 'plan-1', aggregateType: 'PLAN', type: 'UPDATED', payload: { value: 2 }, occurredAt: new Date().toISOString(), correlationId: 'corr-1' });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.throws(() => store.append({ ...first, eventId: 'event-3' }), (error: unknown) => error instanceof V4Error && error.code === 'EVENT_SEQUENCE_CONFLICT');
  assert.throws(() => store.append({ ...first }), (error: unknown) => error instanceof V4Error && error.code === 'DUPLICATE_KEY');
  assert.deepEqual(store.replay('plan-1', 0, (value, event) => value + Number((event.payload as { value: number }).value)), 3);
  assert.throws(() => store.append({ eventId: 'event-secret', aggregateId: 'plan-1', aggregateType: 'PLAN', type: 'BAD', payload: { secret: 'x' }, occurredAt: new Date().toISOString(), correlationId: 'corr-1' }), (error: unknown) => error instanceof V4Error && error.code === 'UNSAFE_EVENT_PAYLOAD');
  db.prepare("UPDATE events SET payload='not-json' WHERE event_id='event-2'").run();
  assert.throws(() => store.listByAggregate('plan-1'), (error: unknown) => error instanceof V4Error && error.code === 'CORRUPTED_EVENT_PAYLOAD');
  db.close();
});

test('domain terminal transitions are monotonic and invalid transitions fail closed', () => {
  const at = new Date().toISOString();
  const plan = {
    planId: 'p', idempotencyKey: 'k', projectKey: 'x', objective: 'x', repositoryPath: '/r',
    baseRevision: 'b', currentRevision: 'b', status: 'RUNNING' as const, childPlanIds: [], createdAt: at, updatedAt: at,
  };
  assert.equal(transitionPlan(plan, 'SUCCEEDED', at).status, 'SUCCEEDED');
  assert.throws(() => transitionPlan({ ...plan, status: 'SUCCEEDED' }, 'RUNNING', at), V4Error);
  const execution = { identity: { executionId: 'e', planId: 'p', attempt: 1, route: 'r' }, idempotencyKey: 'e', objective: 'x', status: 'RUNNING' as const, createdAt: at, updatedAt: at };
  assert.throws(() => transitionExecution({ ...execution, status: 'SUCCEEDED' }, 'FAILED', at), V4Error);
  const review = { reviewId: 'r', planId: 'p', implementationExecutionId: 'e', sourceRevision: 'sha', reviewedSha: 'sha', status: 'PASSED' as const, createdAt: at, updatedAt: at };
  assert.throws(() => transitionReview(review, 'STALE', at), V4Error);
  const supervisor = { supervisorId: 's', planId: 'p', status: 'COMPLETED' as const, observationCursor: 1, projectionDigest: 'd', policyId: 'p', budgetId: 'b', nextWakeAt: at, createdAt: at, updatedAt: at };
  assert.throws(() => transitionSupervisor(supervisor, 'ACTIVE', at), V4Error);
  const action = { actionId: 'a', version: 1 as const, type: 'NO_ACTION' as const, planId: 'p', supervisorId: 's', observationCursor: 1, projectionDigest: 'd', idempotencyKey: 'a', preconditionSnapshot: {}, payload: { type: 'NO_ACTION' as const, reason: 'x' }, status: 'SUCCEEDED' as const, createdAt: at, updatedAt: at };
  assert.throws(() => transitionAction(action, 'FAILED', at), V4Error);
});

test('repositories enforce idempotency, CAS, exact review lineage and leases', () => {
  const db = memory();
  const { repos, plan, item, supervisor } = seedPlan(db);
  const same = repos.plans.createPlan({ idempotencyKey: 'seed-plan', projectKey: 'pixel', objective: 'test objective', repositoryPath: '/repo', baseRevision: 'base-sha' });
  assert.equal(same.status, 'existing');
  assert.equal(repos.plans.compareAndSetStatus(plan.planId, 'DRAFT', 'RUNNING').status, 'rejected');
  assert.equal(repos.plans.compareAndSetStatus(plan.planId, 'READY', 'RUNNING').status, 'updated');
  const execution = repos.executions.create({
    idempotencyKey: 'exec-1', identity: { executionId: 'exec-1', planId: plan.planId, workItemId: item.workItemId, attempt: 1, route: 'test' }, objective: item.objective,
  }).value;
  assert.ok(execution);
  repos.executions.updateStatus(execution.identity.executionId, 'RUNNING');
  repos.executions.recordResult(execution.identity.executionId, { status: 'SUCCEEDED', resultRevision: 'sha-a' });
  const review = repos.reviews.create({ idempotencyKey: 'review-1', planId: plan.planId, workItemId: item.workItemId, implementationExecutionId: execution.identity.executionId, sourceRevision: 'sha-a' }).value;
  assert.ok(review);
  assert.throws(() => repos.reviews.create({ idempotencyKey: 'review-2', planId: plan.planId, workItemId: item.workItemId, implementationExecutionId: execution.identity.executionId, sourceRevision: 'sha-c' }), (error: unknown) => error instanceof V4Error && error.code === 'REVIEW_SOURCE_NOT_IMPLEMENTATION_RESULT');
  const lease = repos.supervisors.claimLease(supervisor.supervisorId, 'owner-a', 10, 1000);
  assert.ok(lease.value);
  assert.equal(repos.supervisors.claimLease(supervisor.supervisorId, 'owner-b', 10, 1001).status, 'rejected');
  assert.equal(repos.supervisors.renewLease(supervisor.supervisorId, 'owner-a', lease.value.leaseToken, 10, 1011).status, 'rejected');
  const takeover = repos.supervisors.claimLease(supervisor.supervisorId, 'owner-b', 10, 1011);
  assert.equal(takeover.status, 'updated');
  db.close();
});

test('parent-child relationships reject duplicates, self cycles and indirect cycles', () => {
  const db = memory();
  const repos = createRepositories(db);
  const create = (key: string) => repos.plans.createPlan({ idempotencyKey: key, projectKey: 'p', objective: key, repositoryPath: '/r', baseRevision: 'b' }).value!;
  const parent = create('parent');
  const child = create('child');
  const other = create('other');
  repos.relationships.createParentChild({ parentPlanId: parent.planId, childPlanId: child.planId, kind: 'SYSTEM_REPAIR' });
  assert.throws(() => repos.relationships.createParentChild({ parentPlanId: parent.planId, childPlanId: child.planId, kind: 'SYSTEM_REPAIR' }), V4Error);
  assert.throws(() => repos.relationships.createParentChild({ parentPlanId: child.planId, childPlanId: child.planId, kind: 'FOLLOW_UP' }), V4Error);
  repos.relationships.createParentChild({ parentPlanId: child.planId, childPlanId: other.planId, kind: 'FOLLOW_UP' });
  assert.throws(() => repos.relationships.createParentChild({ parentPlanId: other.planId, childPlanId: parent.planId, kind: 'FOLLOW_UP' }), V4Error);
  db.close();
});

test('plan kernel accepts graph dependencies in any input order', () => {
  const db = memory();
  const repos = createRepositories(db);
  const kernel = new PlanKernel(repos);
  const plan = kernel.createPlan({ idempotencyKey: 'graph-order', projectKey: 'p', objective: 'x', repositoryPath: '/r', baseRevision: 'b' }).value!;
  const graph = kernel.ensureReadyGraph(plan.planId, [
    { itemKey: 'dependent', title: 'Dependent', objective: 'd', dependencies: ['base'] },
    { itemKey: 'base', title: 'Base', objective: 'b', dependencies: [] },
  ]);
  assert.deepEqual(graph.items.map((item) => item.itemKey).sort(), ['base', 'dependent']);
  db.close();
});

test('supervisor protocol, bounded projection, stale decision and duplicate wake are safe', () => {
  const db = memory();
  const { repos, plan, supervisor } = seedPlan(db, 'supervisor-plan');
  const projection = buildBoundedProjection(db, supervisor.supervisorId, { maxEvents: 3, maxItems: 1 });
  assert.equal(projection.projectionVersion, 1);
  assert.equal(projection.truncated, true);
  assert.equal(projection.plan.repositoryPath, '/repo');
  const make = (key: string, cursor = projection.cursor, digest = projection.digest) => parseSupervisorDecision(JSON.stringify({
    version: 1, planId: plan.planId, supervisorId: supervisor.supervisorId, observationCursor: cursor,
    projectionDigest: digest, idempotencyKey: key, preconditionSnapshot: {},
    action: { type: 'NO_ACTION', payload: { type: 'NO_ACTION', reason: 'wait' } },
  }));
  const executor = new SupervisorActionExecutor(repos.actions, repos.decisions, {});
  const first = executor.execute(make('wake-1'), projection);
  assert.equal(first.status, 'SUCCEEDED');
  assert.equal(executor.execute(make('wake-1'), projection).status, 'DUPLICATE');
  const stale = executor.execute(make('wake-2', Math.max(0, projection.cursor - 1)), projection);
  assert.equal(stale.status, 'REJECTED');
  assert.equal(repos.decisions.listBySupervisor(supervisor.supervisorId).length, 2);
  assert.throws(() => parseSupervisorDecision('{"version":1,"version":1}'), (error: unknown) => error instanceof V4Error && error.code === 'DECISION_DUPLICATE_KEY');
  db.close();
});

test('supervisor projection survives database restart and conversation recovery is lineage-safe', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-supervisor-restart-'));
  const file = path.join(directory, 'control-plane.sqlite');
  let db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const seeded = seedPlan(db, 'restart-plan');
  const before = buildBoundedProjection(db, seeded.supervisor.supervisorId);
  db.close();
  db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const after = buildBoundedProjection(db, seeded.supervisor.supervisorId);
  assert.equal(after.digest, before.digest);
  assert.equal(after.cursor, before.cursor);
  db.close();
});

test('supervisor wake queue is durable, idempotent and atomically drained', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-wake-'));
  const file = path.join(directory, 'control-plane.sqlite');
  let db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const scheduler = new SupervisorWakeScheduler(undefined, db);
  const wake = { supervisorId: 'sup-1', observationCursor: 4, reason: 'EVENT' as const, requestedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(scheduler.schedule(wake).status, 'created');
  assert.equal(scheduler.schedule(wake).status, 'existing');
  db.close();
  db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const recovered = new SupervisorWakeScheduler(undefined, db);
  assert.deepEqual(recovered.drain(), [wake]);
  assert.deepEqual(recovered.drain(), []);
  db.close();
});

test('maintenance candidates survive database restart with immutable plan binding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-maintenance-'));
  const file = path.join(dir, 'control-plane.sqlite');
  const program = { programId: 'program-db', projectKey: 'pixel', implementationRoutes: [], reviewRoutes: [], autonomousScope: 'CONSERVATIVE' as const, autoMerge: false, enabled: true };
  let db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  db.prepare('INSERT INTO maintenance_programs(program_id,project_key,policy,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(program.programId, program.projectKey, '{}', 'ACTIVE', new Date().toISOString(), new Date().toISOString());
  const first = new MaintenanceCandidateRegistry(db);
  const created = first.create(program, { title: 'Durable candidate', evidence: ['metric:1'], risk: 'LOW' });
  first.attachPlan(created.candidate.candidateId, 'plan-1');
  db.close();
  db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const second = new MaintenanceCandidateRegistry(db);
  const recovered = second.create(program, { title: 'Durable candidate', evidence: ['metric:1'], risk: 'LOW' });
  assert.equal(recovered.status, 'existing');
  assert.equal(recovered.candidate.planId, 'plan-1');
  assert.throws(() => second.attachPlan(recovered.candidate.candidateId, 'plan-2'), V4Error);
  db.close();
});

test('supervisor runtime claims, asks typed model and releases lease', async () => {
  const db = memory();
  const seeded = seedPlan(db, 'runtime-plan');
  const scheduler = new SupervisorWakeScheduler(seeded.repos.supervisors, db);
  scheduler.schedule({ supervisorId: seeded.supervisor.supervisorId, observationCursor: 0, reason: 'NEW_PLAN', requestedAt: new Date().toISOString() });
  const client = { decide: async (input: { projection: { cursor: number; digest: string }; supervisorId: string; planId: string }) => JSON.stringify({
    version: 1, decisionId: 'decision-runtime', planId: input.planId, supervisorId: input.supervisorId, observationCursor: input.projection.cursor,
    projectionDigest: input.projection.digest, idempotencyKey: 'runtime-noop', preconditionSnapshot: {},
    action: { type: 'NO_ACTION', idempotencyKey: 'runtime-noop', payload: { type: 'NO_ACTION', reason: 'healthy' } },
  }) };
  const host = new OpenHandsSupervisorAdapter({ createSupervisorConversation: () => ({ conversationId: 'conversation-runtime', replaced: false }), resumeSupervisorConversation: () => ({ conversationId: 'conversation-runtime', replaced: false }) });
  const runtime = new SupervisorRuntime(db, seeded.repos.supervisors, scheduler, host, new SupervisorActionExecutor(seeded.repos.actions, seeded.repos.decisions, {}), client, 'runtime-test-owner');
  const result = await runtime.runOnce();
  assert.equal(result[0]?.status, 'SUCCEEDED');
  assert.equal(seeded.repos.supervisors.getById(seeded.supervisor.supervisorId).conversationId, 'conversation-runtime');
  assert.equal(seeded.repos.supervisors.getById(seeded.supervisor.supervisorId).lease, undefined);
  db.close();
});

test('supervisor runtime releases lease after model failure and can be retried', async () => {
  const db = memory();
  const seeded = seedPlan(db, 'runtime-failure-plan');
  const scheduler = new SupervisorWakeScheduler(seeded.repos.supervisors, db);
  scheduler.schedule({ supervisorId: seeded.supervisor.supervisorId, observationCursor: 0, reason: 'UNKNOWN_FAILURE', requestedAt: new Date().toISOString() });
  const host = new OpenHandsSupervisorAdapter({ createSupervisorConversation: () => ({ conversationId: 'conversation-failure', replaced: false }), resumeSupervisorConversation: () => ({ conversationId: 'conversation-failure', replaced: false }) });
  const runtime = new SupervisorRuntime(db, seeded.repos.supervisors, scheduler, host, new SupervisorActionExecutor(seeded.repos.actions, seeded.repos.decisions, {}), { decide: async () => { throw new V4Error('SUPERVISOR_MODEL_UNAVAILABLE'); } }, 'runtime-failure-owner');
  const result = await runtime.runOnce();
  assert.equal(result[0]?.status, 'FAILED');
  const supervisor = seeded.repos.supervisors.getById(seeded.supervisor.supervisorId);
  assert.equal(supervisor.lease, undefined);
  assert.equal(supervisor.status, 'SLEEPING');
  scheduler.schedule({ supervisorId: supervisor.supervisorId, observationCursor: supervisor.observationCursor, reason: 'OPERATOR_REQUEST', requestedAt: new Date().toISOString() });
  assert.equal((await runtime.runOnce())[0]?.status, 'FAILED');
  assert.equal(seeded.repos.supervisors.getById(supervisor.supervisorId).lease, undefined);
  db.close();
});

test('supervisor HTTP model client bounds requests and rejects provider failures', async () => {
  let requestInit: RequestInit | undefined;
  const okClient = new HttpSupervisorDecisionClient('http://model.test/decision', 'secret', async (_input, init) => {
    requestInit = init;
    return new Response('{"typed":true}', { status: 200 });
  });
  assert.equal(await okClient.decide({ conversationId: 'c', supervisorId: 's', planId: 'p', projection: { cursor: 0, digest: 'd' } as never }), '{"typed":true}');
  assert.ok(requestInit?.signal);
  const failing = new HttpSupervisorDecisionClient('http://model.test/decision', undefined, async () => new Response('busy', { status: 503 }));
  await assert.rejects(() => failing.decide({ conversationId: 'c', supervisorId: 's', planId: 'p', projection: { cursor: 0, digest: 'd' } as never }), (error: unknown) => error instanceof V4Error && error.code === 'SUPERVISOR_MODEL_UNAVAILABLE');
});

test('adapters deduplicate candidates, invalidate force-pushed PRs and gate resources', () => {
  const program = { programId: 'program', projectKey: 'digital-biome', implementationRoutes: ['antigravity'], reviewRoutes: ['antigravity'], autonomousScope: 'CONSERVATIVE' as const, autoMerge: false, enabled: true };
  const registry = new MaintenanceCandidateRegistry();
  const first = registry.create(program, { title: 'Improve check', evidence: ['metric:1'], risk: 'LOW' });
  const second = registry.create(program, { title: 'Improve check', evidence: ['metric:1'], risk: 'LOW' });
  assert.equal(second.status, 'existing');
  assert.equal(first.candidate.candidateId, second.candidate.candidateId);
  const github = new GitHubPrIntake();
  const change = github.adopt({ repository: 'org/repo', number: 1, baseBranch: 'main', baseSha: 'base', headSha: 'head-a', headRef: 'feature', headRepository: 'org/repo', state: 'OPEN' });
  assert.equal(github.invalidateIfHeadChanged(change.externalChangeId, 'head-b').status, 'STALE');
  assert.throws(() => github.prepareMerge(change, { currentHeadSha: 'head-b', reviewId: 'review', checksPassed: true, autoMergeAuthorized: true }), V4Error);
  const jules = new JulesAdapter({ submit: (input) => ({ sessionId: 'jules-test', repository: input.repository, baseRevision: input.baseRevision, status: 'RUNNING' as const }), getResult: () => ({ sessionId: 'jules-test', repository: 'org/repo', baseRevision: 'base', status: 'RUNNING' as const }) });
  const request = { idempotencyKey: 'jules-1', repository: 'org/repo', baseRevision: 'base', objective: 'work' };
  const result = jules.submit(request);
  assert.equal(jules.submit(request).sessionId, result.sessionId);
  assert.throws(() => jules.correlate(request, { ...result, baseRevision: 'other' }), V4Error);
  assert.throws(() => new AntiGravityReadinessAdapter().requireReady(), V4Error);
});
