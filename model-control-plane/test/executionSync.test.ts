import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { HermesExecutionSyncService, type HermesOrgSnapshotInput } from '../src/v2/execution.js';
import { runV2Migrations } from '../src/v2/migrations.js';
import { OrganizationRepository } from '../src/v2/organization.js';
import { V2Repository } from '../src/v2/repository.js';

function make() {
  const db = openDb(':memory:');
  runV2Migrations(db);
  const repository = new V2Repository(db);
  const organization = new OrganizationRepository(repository);
  const execution = new HermesExecutionSyncService(repository, organization);
  const seeded = repository.bootstrapReference({
    supplierSlug: 'planner-pool',
    supplierName: 'Planner Pool',
    supplierModelKey: 'deepseek-v4-flash',
    supplierModelName: 'DeepSeek V4 Flash',
    agreementRef: 'planner-pool-primary',
    agreementName: 'Planner Pool Primary Supply',
    gatewaySlug: 'fixture-runtime',
    gatewayKind: 'OTHER',
    gatewayName: 'Fixture Runtime Gateway',
    workScopeSlug: 'development',
    workScopeName: 'Development',
    externalProfileRef: 'development',
    positionSlug: 'coding-review',
    positionName: 'Coding Reviewer',
    positionKind: 'REVIEWER',
    runtimeKind: 'CODEX',
    protocol: 'openai-responses',
  });
  return { db, repository, organization, execution, seeded };
}

function runningSnapshot(): HermesOrgSnapshotInput {
  return {
    sourceRevision: 'rev-1',
    profiles: [
      {
        profileId: 'development',
        displayName: 'Development',
        availability: 'ONLINE',
        workload: 'SUPERVISING',
        sessionId: 'profile-session-1',
        controllerState: 'THINKING',
        controllerStatus: 'planning delegation',
        controllerModel: 'deepseek-v4-flash',
        controllerActive: true,
        mission: 'Ship the runtime projection',
        lastSeenAt: 1_000,
      },
    ],
    runs: [
      {
        id: 'interactive:development:profile-session-1',
        profileId: 'development',
        title: 'Ship the runtime projection',
        status: 'RUNNING',
        createdAt: 900,
        startedAt: 950,
      },
    ],
    nodes: [
      {
        id: 'node-codex-1',
        profileId: 'development',
        runId: 'interactive:development:profile-session-1',
        type: 'CODEX',
        role: 'EXECUTOR',
        runtime: 'codex',
        model: 'gpt-5.6-sol',
        taskTitle: 'Implement runtime projection',
        state: 'CODING',
        sessionId: 'codex-session-1',
        processId: '321',
        cwd: '/workspace/repos/pixel-agents',
        worktree: '/workspace/repos/pixel-agents',
        currentTool: 'shell',
        currentAction: 'editing',
        startedAt: 970,
        updatedAt: 1_010,
      },
      {
        id: 'node-review-1',
        profileId: 'development',
        runId: 'interactive:development:profile-session-1',
        parentId: 'node-codex-1',
        type: 'HERMES_SUBAGENT',
        role: 'REVIEWER',
        runtime: 'hermes-subagent',
        model: 'claude-sonnet',
        taskTitle: 'Review runtime projection',
        state: 'REVIEWING',
        sessionId: 'review-session-1',
        startedAt: 980,
        updatedAt: 1_015,
      },
    ],
    edges: [
      {
        id: 'edge-1',
        runId: 'interactive:development:profile-session-1',
        fromNodeId: 'node-codex-1',
        toNodeId: 'node-review-1',
        relation: 'DELEGATED',
      },
    ],
  };
}

test('Hermes org snapshot projects into standing and run-scoped positions without creating Employees', async () => {
  const { db, repository, organization, execution, seeded } = make();
  const first = await execution.sync(runningSnapshot());

  assert.equal(first.workScopesCreated, 0);
  assert.equal(first.runsCreated, 1);
  assert.equal(first.positionsCreated, 2);
  assert.equal(first.runtimeSessionsCreated, 3);
  assert.equal(first.dutiesCreated, 3);
  assert.equal(first.edgesSeen, 1);
  assert.equal(first.issues.length, 0);

  assert.equal(repository.listEmployees().length, 1);
  assert.equal(repository.listEmployees()[0]?.id, seeded.employeeId);

  const scopes = db.prepare('SELECT * FROM v2_work_scopes').all() as Array<Record<string, unknown>>;
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.external_profile_ref, 'development');

  const run = repository
    .listRuns(20)
    .find((item) => item.externalRunRef === 'hermes:interactive:development:profile-session-1');
  assert.ok(run);
  assert.equal(run.status, 'RUNNING');

  const positions = repository.listPositions();
  const lead = positions.find((item) => item.slug === 'profile-lead');
  const codex = positions.find((item) => item.externalPositionRef === 'node-codex-1');
  const reviewer = positions.find((item) => item.externalPositionRef === 'node-review-1');
  assert.ok(lead && codex && reviewer);
  assert.equal(lead.lifecyclePolicy, 'STANDING');
  assert.equal(lead.runtimePolicy.kind, 'HERMES_PROFILE');
  assert.equal(codex.lifecyclePolicy, 'RUN_SCOPED');
  assert.equal(codex.runtimePolicy.kind, 'CODEX');
  assert.equal(codex.role?.slug, 'executor');
  assert.equal(reviewer.role?.slug, 'reviewer');

  const runtimes = execution.listRuntimeSessions({ runId: String(run.id) });
  assert.equal(runtimes.length, 3);
  assert.equal(runtimes.filter((item) => item.lifecycle === 'ACTIVE').length, 3);
  assert.ok(runtimes.some((item) => item.runtimeKind === 'HERMES_PROFILE'));
  assert.ok(
    runtimes.some((item) => item.runtimeKind === 'CODEX' && item.modelHint === 'gpt-5.6-sol'),
  );
  assert.equal(execution.listRuntimeEdges(String(run.id)).length, 1);

  const relations = organization.listPositionRelations();
  assert.ok(
    relations.some(
      (item) =>
        item.fromPositionId === lead.id &&
        item.toPositionId === codex.id &&
        item.relationType === 'SUPERVISES',
    ),
  );
  assert.ok(
    relations.some(
      (item) =>
        item.fromPositionId === codex.id &&
        item.toPositionId === reviewer.id &&
        item.relationType === 'DELEGATES_TO',
    ),
  );

  const firstActivityCount = execution.listActivityEvents(String(run.id), 100).length;
  const second = await execution.sync(runningSnapshot());
  assert.equal(second.runsCreated, 0);
  assert.equal(second.positionsCreated, 0);
  assert.equal(second.runtimeSessionsCreated, 0);
  assert.equal(second.dutiesCreated, 0);
  assert.equal(repository.listEmployees().length, 1);
  assert.equal(execution.listRuntimeSessions({ runId: String(run.id) }).length, 3);
  assert.equal(execution.listActivityEvents(String(run.id), 100).length, firstActivityCount);
  assert.equal(execution.listSyncRuns().length, 2);
});

test('terminal Hermes snapshot closes duties/runtimes and retires only run-scoped positions', async () => {
  const { repository, execution } = make();
  await execution.sync(runningSnapshot());
  const terminal = runningSnapshot();
  terminal.sourceRevision = 'rev-2';
  terminal.profiles[0]!.workload = 'READY';
  terminal.profiles[0]!.controllerActive = false;
  terminal.profiles[0]!.controllerState = 'DONE';
  terminal.profiles[0]!.lastSeenAt = 2_000;
  terminal.runs[0]!.status = 'COMPLETED';
  terminal.runs[0]!.completedAt = 2_000;
  terminal.nodes = terminal.nodes.map((node, index) => ({
    ...node,
    state: 'DONE' as const,
    updatedAt: 1_990 + index,
  }));

  await execution.sync(terminal);

  const run = repository
    .listRuns(20)
    .find((item) => item.externalRunRef === 'hermes:interactive:development:profile-session-1');
  assert.ok(run);
  assert.equal(run.status, 'COMPLETED');
  const runtimes = execution.listRuntimeSessions({ runId: String(run.id) });
  assert.equal(runtimes.length, 3);
  assert.ok(runtimes.every((item) => item.lifecycle === 'COMPLETED'));
  const duties = repository.listDuties({ runId: String(run.id) });
  assert.equal(duties.length, 3);
  assert.ok(duties.every((item) => item.lifecycle === 'COMPLETED'));

  const positions = repository.listPositions();
  const lead = positions.find((item) => item.slug === 'profile-lead');
  assert.ok(lead);
  assert.equal(lead.lifecycle, 'ACTIVE');
  const runScoped = positions.filter((item) => item.originRunId === run.id);
  assert.equal(runScoped.length, 2);
  assert.ok(runScoped.every((item) => item.lifecycle === 'RETIRED'));
});

test('missing active runtime in a current snapshot is cancelled without deleting history', async () => {
  const { repository, execution } = make();
  await execution.sync(runningSnapshot());
  const run = repository
    .listRuns(20)
    .find((item) => item.externalRunRef === 'hermes:interactive:development:profile-session-1');
  assert.ok(run);
  const missing = runningSnapshot();
  missing.sourceRevision = 'rev-2';
  missing.nodes = [missing.nodes[0]!];
  missing.edges = [];

  const result = await execution.sync(missing);
  assert.equal(result.runtimeSessionsClosed, 1);
  const runtimes = execution.listRuntimeSessions({ runId: String(run.id) });
  const review = runtimes.find((item) => item.externalSessionRef === 'review-session-1');
  assert.ok(review);
  assert.equal(review.lifecycle, 'CANCELLED');
  assert.equal(review.state, 'SNAPSHOT_MISSING');
  assert.equal(
    repository.listPositions().find((item) => item.externalPositionRef === 'node-review-1')
      ?.lifecycle,
    'ACTIVE',
  );
});

test('first sync can ingest an already terminal historical Run', async () => {
  const { repository, execution } = make();
  const snapshot = runningSnapshot();
  snapshot.runs[0]!.status = 'COMPLETED';
  snapshot.runs[0]!.completedAt = 2_000;
  snapshot.nodes = snapshot.nodes.map((node) => ({
    ...node,
    state: 'DONE' as const,
    updatedAt: 2_000,
  }));

  await execution.sync(snapshot);

  const run = repository
    .listRuns(20)
    .find((item) => item.externalRunRef === 'hermes:interactive:development:profile-session-1');
  assert.ok(run);
  assert.equal(run.status, 'COMPLETED');
  assert.ok(
    repository
      .listPositions()
      .filter((item) => item.originRunId === run.id)
      .every((item) => item.lifecycle === 'RETIRED'),
  );
});

test('runtime reappearance after a transient missing snapshot opens a new Duty without duplicating the RuntimeSession', async () => {
  const { repository, execution } = make();
  await execution.sync(runningSnapshot());
  const run = repository
    .listRuns(20)
    .find((item) => item.externalRunRef === 'hermes:interactive:development:profile-session-1');
  assert.ok(run);
  const missing = runningSnapshot();
  missing.nodes = [missing.nodes[0]!];
  missing.edges = [];
  await execution.sync(missing);
  const before = repository
    .listDuties({ runId: String(run.id) })
    .filter(
      (duty) =>
        duty.positionId ===
        repository.listPositions().find((item) => item.externalPositionRef === 'node-review-1')?.id,
    );
  assert.equal(before.length, 1);
  assert.equal(before[0]?.lifecycle, 'CANCELLED');

  await execution.sync(runningSnapshot());
  const reviewPosition = repository
    .listPositions()
    .find((item) => item.externalPositionRef === 'node-review-1');
  assert.ok(reviewPosition);
  const after = repository
    .listDuties({ runId: String(run.id) })
    .filter((duty) => duty.positionId === reviewPosition.id);
  assert.equal(after.length, 2);
  assert.equal(after.filter((duty) => duty.lifecycle === 'ACTIVE').length, 1);
  const reviewRuntimes = execution
    .listRuntimeSessions({ runId: String(run.id) })
    .filter((runtime) => runtime.externalSessionRef === 'review-session-1');
  assert.equal(reviewRuntimes.length, 1);
  assert.equal(reviewRuntimes[0]?.lifecycle, 'ACTIVE');
  assert.equal(
    reviewRuntimes[0]?.dutySessionId,
    after.find((duty) => duty.lifecycle === 'ACTIVE')?.id,
  );
});

test('repeated terminal snapshots remain duty-idempotent', async () => {
  const { repository, execution } = make();
  const terminal = runningSnapshot();
  terminal.runs[0]!.status = 'COMPLETED';
  terminal.runs[0]!.completedAt = 2_000;
  terminal.nodes = terminal.nodes.map((node) => ({
    ...node,
    state: 'DONE' as const,
    updatedAt: 2_000,
  }));
  terminal.profiles[0]!.controllerState = 'DONE';
  await execution.sync(terminal);
  const run = repository
    .listRuns(20)
    .find((item) => item.externalRunRef === 'hermes:interactive:development:profile-session-1');
  assert.ok(run);
  const firstDutyCount = repository.listDuties({ runId: String(run.id) }).length;
  await execution.sync(terminal);
  assert.equal(repository.listDuties({ runId: String(run.id) }).length, firstDutyCount);
});

test('Hermes profile config creates and reconciles an automatic Profile Lead appointment', async () => {
  const { repository: repo, execution: service } = make();
  const supplier = repo.getOrCreateSupplier('opencode', 'OpenCode');
  const model = repo.getOrCreateSupplierModel({
    supplierId: String(supplier.id),
    supplierModelKey: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
  });
  const employee = repo.getOrCreateEmployee({
    supplierId: String(supplier.id),
    supplierModelId: String(model.id),
    displayName: 'DeepSeek V4 Flash @ OpenCode',
  });
  const agreement = repo.getOrCreateAgreement({
    supplierId: String(supplier.id),
    externalAccountRef: 'test:opencode-go',
    name: 'OpenCode Go test',
  });
  repo.getOrCreateCurrentEmployment({
    employeeId: String(employee.id),
    supplyAgreementId: String(agreement.id),
  });

  const snapshot = {
    profiles: [
      {
        profileId: 'coder',
        displayName: 'Coder',
        availability: 'ONLINE' as const,
        workload: 'READY' as const,
        configuredProvider: 'opencode-go',
        configuredModel: 'deepseek-v4-flash',
        lastSeenAt: 1000,
      },
    ],
    runs: [],
    nodes: [],
    edges: [],
  };
  const first = await service.sync(snapshot);
  assert.equal(first.issues.length, 0);
  const lead = repo.listPositions().find((item) => item.slug === 'profile-lead');
  assert.ok(lead);
  const appointment = repo.listAppointments({ positionId: String(lead.id) })[0];
  assert.equal(appointment.employeeId, employee.id);
  assert.equal(appointment.source, 'HERMES_PROFILE_CONFIG');
  assert.equal(appointment.metadata.provider, 'opencode-go');

  const second = await service.sync({
    ...snapshot,
    profiles: [{ ...snapshot.profiles[0], configuredModel: 'deepseek-v4-pro', lastSeenAt: 2000 }],
  });
  assert.equal(second.issues[0]?.code, 'PROFILE_EMPLOYEE_NOT_REGISTERED');
  const ended = repo.getAppointment(String(appointment.id));
  // No replacement employee means we preserve the last valid automatic appointment
  // instead of creating a false vacancy from an incomplete catalog.
  assert.equal(ended?.status, 'CURRENT');
});

test('Hermes profile config does not guess an Employee from a bare model hint', async () => {
  const { repository: repo, execution: service } = make();
  const snapshot = {
    profiles: [
      {
        profileId: 'coder',
        displayName: 'Coder',
        availability: 'ONLINE' as const,
        workload: 'READY' as const,
        configuredProvider: 'deepseek',
        configuredModel: 'deepseek-v4-flash',
        controllerModel: 'deepseek-v4-flash',
        lastSeenAt: 1000,
      },
    ],
    runs: [],
    nodes: [],
    edges: [],
  };
  const result = await service.sync(snapshot);
  assert.equal(result.issues[0]?.code, 'PROFILE_EMPLOYEE_NOT_REGISTERED');
  const lead = repo.listPositions().find((item) => item.slug === 'profile-lead');
  assert.ok(lead);
  assert.equal(repo.listAppointments({ positionId: String(lead.id) }).length, 0);
});

test('active Hermes Profile runtime is attributed through its config-derived Appointment', async () => {
  const { db, repository: repo, execution } = make();
  const supplier = repo.getOrCreateSupplier('opencode', 'OpenCode');
  const model = repo.getOrCreateSupplierModel({
    supplierId: String(supplier.id),
    supplierModelKey: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
  });
  const employee = repo.getOrCreateEmployee({
    supplierId: String(supplier.id),
    supplierModelId: String(model.id),
    displayName: 'DeepSeek V4 Flash @ OpenCode',
  });
  const agreement = repo.getOrCreateAgreement({
    supplierId: String(supplier.id),
    externalAccountRef: 'test:opencode-go-profile',
    name: 'OpenCode Go profile test',
  });
  repo.getOrCreateCurrentEmployment({
    employeeId: String(employee.id),
    supplyAgreementId: String(agreement.id),
  });

  await execution.sync({
    profiles: [
      {
        profileId: 'coder',
        displayName: 'Coder',
        availability: 'ONLINE',
        workload: 'EXECUTING',
        sessionId: 'root-profile',
        controllerState: 'CODING',
        controllerModel: 'deepseek-v4-flash',
        configuredProvider: 'opencode-go',
        configuredModel: 'deepseek-v4-flash',
        lastSeenAt: 2_000,
      },
    ],
    runs: [
      {
        id: 'interactive:coder:root-profile',
        profileId: 'coder',
        title: 'Coding',
        status: 'RUNNING',
        createdAt: 1_000,
        startedAt: 1_100,
      },
    ],
    nodes: [],
    edges: [],
  });
  const run = repo
    .listRuns(10)
    .find((item) => item.externalRunRef === 'hermes:interactive:coder:root-profile');
  assert.ok(run);
  const duty = repo.listDuties({ runId: String(run.id) })[0];
  assert.ok(duty);
  const segments = db
    .prepare('SELECT * FROM v2_staffing_segments WHERE duty_session_id=? AND ended_at IS NULL')
    .all(String(duty.id)) as Array<Record<string, unknown>>;
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.employee_id, employee.id);
  const decision = repo.listDispatchDecisions(String(duty.id))[0];
  assert.equal(decision.policyVersion, 'hermes-profile-config-v1');
});

test('authoritative Hermes snapshot closes a previously active run that disappears', async () => {
  const { repository: repo, execution } = make();
  await execution.sync(runningSnapshot());
  const active = repo
    .listRuns(20)
    .find((item) => item.externalRunRef === 'hermes:interactive:development:profile-session-1');
  assert.ok(active);
  const snapshot = runningSnapshot();
  snapshot.sourceRevision = 'rev-no-runs';
  snapshot.runs = [];
  snapshot.nodes = [];
  snapshot.edges = [];
  const result = await execution.sync(snapshot);
  assert.equal(
    result.issues.some((item) => item.code === 'HERMES_RUN_SNAPSHOT_MISSING'),
    true,
  );
  const closed = repo.getRun(String(active.id));
  assert.equal(closed?.status, 'CANCELLED');
  assert.equal(
    execution.listRuntimeSessions({ runId: String(active.id), activeOnly: true }).length,
    0,
  );
  assert.equal(
    repo.listDuties({ runId: String(active.id) }).some((item) => item.lifecycle === 'ACTIVE'),
    false,
  );
});
