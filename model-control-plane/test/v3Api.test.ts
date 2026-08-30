import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildControlPlane } from '../src/app.js';
import { openDb } from '../src/db.mjs';
import { ExecutionLinkRepository } from '../src/v3/correlation.js';
import type {
  ExecutionHostPort,
  ExecutionHostSnapshot,
  ModelGatewayPort,
  ObservabilityPort,
} from '../src/v3/ports.js';
import type { WorkspaceProvisioningPort } from '../src/v3/workspace.js';

class FakeHost implements ExecutionHostPort {
  creates = 0;
  createdRepositories: string[] = [];
  createdObjectives: string[] = [];
  status: ExecutionHostSnapshot['status'] = 'RUNNING';
  finalText = 'INVESTIGATION_OK';
  async health() {
    return 'OK' as const;
  }
  async recoverExecution() {
    return null;
  }
  async createExecution(input: Parameters<ExecutionHostPort['createExecution']>[0]) {
    this.creates += 1;
    this.createdRepositories.push(input.repositoryPath);
    this.createdObjectives.push(input.objective);
    return {
      conversationId: '22222222-2222-4222-8222-222222222222',
      status: this.status,
      startedAt: '2026-08-21T15:00:00Z',
    };
  }
  async getExecution() {
    return {
      conversationId: '22222222-2222-4222-8222-222222222222',
      status: this.status,
      finalText: this.status === 'SUCCEEDED' ? this.finalText : undefined,
      startedAt: '2026-08-21T15:00:00Z',
      updatedAt: '2026-08-21T15:00:05Z',
      usage: {
        source: 'OPENHANDS_REPORTED' as const,
        input: 100,
        output: 10,
        calls: 1,
      },
    };
  }
  async cancelExecution() {
    this.status = 'PAUSED';
    return this.getExecution('ignored');
  }
  async continueExecution() {
    this.status = 'RUNNING';
    return this.getExecution('ignored');
  }
}

class RecoverableFakeHost extends FakeHost {
  readonly recoverableByExecution = new Map<string, ExecutionHostSnapshot>();
  recoveries = 0;

  override async recoverExecution(input: { executionId: string }) {
    this.recoveries += 1;
    return this.recoverableByExecution.get(input.executionId) ?? null;
  }
}

const workspace: WorkspaceProvisioningPort = {
  hostPathForExecution(executionId) {
    return `/tmp/${executionId}`;
  },
  hostPathForWorkspaceRef(workspaceRef) {
    return `/host${workspaceRef}`;
  },
  async prepareWriterExecution() {
    return { startRevision: 'writer-start' };
  },
  async verifyWriterCompletion() {
    return { startRevision: 'writer-start', headRevision: 'writer-head' };
  },
  async provision(input) {
    return {
      hostPath: `/tmp/${input.executionId}`,
      executionPath: `/workspace/${input.executionId}`,
      repositoryRoot: input.repositoryPath || '/tmp/repository',
      sourceRevision: 'abc123',
    };
  },
  async integrateBatch(input) {
    return {
      revision: `integrated-${input.batchKey}`,
      ref: `refs/ai-office/plans/${input.planId}/batches/${input.batchKey}`,
    };
  },
};

const gateway: ModelGatewayPort = {
  async summary() {
    return {
      health: 'OK',
      logicalModels: ['planning-premium', 'implementation-efficient', 'review-premium'],
    };
  },
};

test('execution link workspace provenance persists repository root', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-link-repository-root-'));
  const db = openDb(path.join(directory, 'control-plane.sqlite'));
  try {
    const links = new ExecutionLinkRepository(db);
    const reserved = links.reserve({
      idempotencyKey: 'repository-root-roundtrip',
      projectKey: 'memoflow',
      phase: 'IMPLEMENT',
      objectiveSummary: 'Persist repository provenance.',
      selection: {
        backend: 'openhands-builtin',
        modelClass: 'implementation-efficient',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'isolated_write',
        sessionPolicy: 'fresh',
        reasons: ['test'],
      },
    });
    const attached = links.attachWorkspace(reserved.record.executionId, {
      workspaceRef: '/workspace/executions/example/repo',
      repositoryRoot: '/home/dev/projects/memoflow',
      gitBranch: 'ai-office/example',
      sourceRevision: 'abc123',
    });
    assert.equal(attached.repositoryRoot, '/home/dev/projects/memoflow');
    assert.equal(
      links.get(reserved.record.executionId)?.repositoryRoot,
      '/home/dev/projects/memoflow',
    );
    const withBaseline = links.attachWriterStartRevision(
      reserved.record.executionId,
      'baseline-abc',
    );
    assert.equal(withBaseline.writerStartRevision, 'baseline-abc');
    assert.equal(links.get(reserved.record.executionId)?.writerStartRevision, 'baseline-abc');
    assert.equal(
      links.attachWriterStartRevision(reserved.record.executionId, 'baseline-abc')
        .writerStartRevision,
      'baseline-abc',
    );
    assert.throws(
      () => links.attachWriterStartRevision(reserved.record.executionId, 'forged-baseline'),
      /WRITER_COMPLETION_BASELINE_MISMATCH/,
    );
    const claimedAt = Date.now();
    const firstClaim = links.claimHostLaunch(
      reserved.record.executionId,
      'launch-token-a',
      claimedAt,
      claimedAt - 120_000,
    );
    assert.equal(firstClaim.acquired, true);
    assert.equal(firstClaim.record.hostLaunchToken, 'launch-token-a');
    assert.equal(firstClaim.record.hostLaunchClaimedAt, claimedAt);
    const freshContender = links.claimHostLaunch(
      reserved.record.executionId,
      'launch-token-b',
      claimedAt + 1,
      claimedAt - 1,
    );
    assert.equal(freshContender.acquired, false);
    assert.equal(freshContender.record.hostLaunchToken, 'launch-token-a');
    const staleTakeover = links.claimHostLaunch(
      reserved.record.executionId,
      'launch-token-c',
      claimedAt + 120_001,
      claimedAt + 1,
    );
    assert.equal(staleTakeover.acquired, true);
    assert.equal(staleTakeover.record.hostLaunchToken, 'launch-token-c');
    assert.throws(
      () =>
        links.attachOpenHands(
          reserved.record.executionId,
          'conversation-stale-owner',
          undefined,
          'launch-token-a',
        ),
      /HOST_EXECUTION_ASSOCIATION_CONFLICT/,
    );
    const attachedHost = links.attachOpenHands(
      reserved.record.executionId,
      'conversation-claim-roundtrip',
      undefined,
      'launch-token-c',
    );
    assert.equal(attachedHost.openhandsConversationId, 'conversation-claim-roundtrip');
    assert.equal(attachedHost.hostLaunchToken, undefined);
    assert.equal(attachedHost.hostLaunchClaimedAt, undefined);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('external replay revalidates the persisted backend selection from pre-gate crash residue', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'external-backend-residue-'));
  const dbFile = path.join(directory, 'control-plane.sqlite');
  const db = openDb(dbFile);
  const links = new ExecutionLinkRepository(db);
  links.reserve({
    idempotencyKey: 'legacy-external-antigravity-review',
    projectKey: 'digital-biome',
    phase: 'VERIFY_REVIEW',
    objectiveSummary: 'Legacy external review reservation.',
    selection: {
      backend: 'antigravity-review',
      modelClass: 'gemini-3.1-pro-high',
      transportMode: 'PROVIDER_NATIVE',
      workspaceMode: 'review_snapshot',
      sessionPolicy: 'fresh_required',
      reasons: ['legacy:before-untrusted-external-gate'],
    },
  });
  db.close();

  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile,
    logger: false,
    v3ExecutionHost: host,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'codex-review-headless': true,
      'openhands-builtin': true,
      'antigravity-review': true,
    },
  });
  try {
    await assert.rejects(
      () =>
        runtime.v3.start(
          {
            phase: 'VERIFY_REVIEW',
            objective: 'Replay an external review after upgrade.',
            projectKey: 'digital-biome',
            repository: { path: '' },
            context: { changeOrigin: 'EXTERNAL' },
            await: false,
          },
          'legacy-external-antigravity-review',
        ),
      /EXTERNAL_CHANGE_BACKEND_NOT_ALLOWED/,
    );
    assert.equal(host.creates, 0);
  } finally {
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('V3 API provides an idempotent production execution facade', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  });

  try {
    const first = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-test-1' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Investigate startup blank screen.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
        hermes: { profile: 'memoflow', sessionId: 'session-1', turnId: 'turn-1' },
      },
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json();
    assert.equal(firstBody.phase, 'INVESTIGATE_PLAN');
    assert.equal(firstBody.selection.backend, 'openhands-builtin');
    assert.equal(firstBody.selection.transportMode, 'LITELLM_MANAGED');
    assert.equal(firstBody.status, 'RUNNING');
    assert.equal(firstBody.sourceHealth.langfuse, 'UNCONFIGURED');
    assert.equal(host.creates, 1);

    const replay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-test-1' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Investigate startup blank screen.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().executionId, firstBody.executionId);
    assert.equal(host.creates, 1);

    host.status = 'SUCCEEDED';
    const completed = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${firstBody.executionId}`,
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json().status, 'SUCCEEDED');
    assert.equal(completed.json().result.finalText, 'INVESTIGATION_OK');
    assert.equal(completed.json().usage.input, 100);
    assert.equal(completed.json().timing.durationMs, 5_000);

    const legacyHealth = await runtime.app.inject({ method: 'GET', url: '/api/v2/health' });
    assert.equal(legacyHealth.statusCode, 404);
  } finally {
    await runtime.app.close();
  }
});

test('V3 concurrent idempotent starts provision and launch an execution only once', async () => {
  const host = new FakeHost();
  let provisionCalls = 0;
  let releaseProvision!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseProvision = resolve;
  });
  const concurrentWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    async provision(input) {
      provisionCalls += 1;
      if (provisionCalls === 1) {
        markEntered();
        await gate;
      }
      return workspace.provision(input);
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: concurrentWorkspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  });
  const request = () =>
    runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'concurrent-provision-once' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Inspect one durable execution exactly once.',
        projectKey: 'concurrent-start-project',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });

  try {
    const first = request();
    await entered;
    const second = request();
    releaseProvision();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.statusCode, 201);
    assert.equal(secondResponse.statusCode, 201);
    assert.equal(firstResponse.json().executionId, secondResponse.json().executionId);
    assert.equal(provisionCalls, 1);
    assert.equal(host.creates, 1);
  } finally {
    await runtime.app.close();
  }
});

class FencedRecoveryHost extends FakeHost {
  recoveries = 0;
  readonly secondRecoveryEntered: Promise<void>;
  #markSecondRecoveryEntered!: () => void;
  #releaseSecondRecovery!: () => void;
  readonly #secondRecoveryGate: Promise<void>;

  constructor() {
    super();
    this.secondRecoveryEntered = new Promise<void>((resolve) => {
      this.#markSecondRecoveryEntered = resolve;
    });
    this.#secondRecoveryGate = new Promise<void>((resolve) => {
      this.#releaseSecondRecovery = resolve;
    });
  }

  releaseSecondRecovery() {
    this.#releaseSecondRecovery();
  }

  override async recoverExecution() {
    this.recoveries += 1;
    if (this.recoveries === 2) {
      this.#markSecondRecoveryEntered();
      await this.#secondRecoveryGate;
    }
    return null;
  }
}

test('V3 superseded launch owner is fenced before POST after a slow recovery scan', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-launch-fence-race-'));
  const dbFile = path.join(directory, 'control-plane.sqlite');
  const host = new FencedRecoveryHost();
  const runtime = await buildControlPlane({
    dbFile,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  });

  try {
    const request = runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'host-launch-fence-race' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Fence a superseded launch owner before POST.',
        projectKey: 'launch-fence-project',
        repository: { path: '/tmp/fake-repo', baseRevision: 'source-base' },
        await: false,
      },
    });

    await host.secondRecoveryEntered;
    const contenderDb = openDb(dbFile);
    try {
      const contenderLinks = new ExecutionLinkRepository(contenderDb);
      const record = contenderLinks.findByIdempotencyKey('host-launch-fence-race');
      assert.ok(record?.hostLaunchToken);
      contenderDb
        .prepare('UPDATE v3_execution_links SET host_launch_claimed_at=? WHERE execution_id=?')
        .run(Date.now() - 10 * 60_000, record.executionId);
      const takeover = contenderLinks.claimHostLaunch(
        record.executionId,
        'new-owner-token',
        Date.now(),
        Date.now() - 120_000,
      );
      assert.equal(takeover.acquired, true);
      assert.equal(takeover.record.hostLaunchToken, 'new-owner-token');
    } finally {
      contenderDb.close();
    }

    host.releaseSecondRecovery();
    const response = await request;
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().status, 'STARTING');
    assert.equal(host.creates, 0);
    assert.ok(host.recoveries >= 2);
  } finally {
    host.releaseSecondRecovery();
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('V3 fresh durable host launch claim suppresses duplicate launch across service recovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-launch-fresh-claim-'));
  const dbFile = path.join(directory, 'control-plane.sqlite');
  const db = openDb(dbFile);
  const links = new ExecutionLinkRepository(db);
  const reserved = links.reserve({
    idempotencyKey: 'host-launch-fresh-claim',
    projectKey: 'fresh-claim-project',
    phase: 'INVESTIGATE_PLAN',
    objectiveSummary: 'Do not duplicate a claimed host launch.',
    selection: {
      backend: 'openhands-builtin',
      modelClass: 'planning-premium',
      transportMode: 'LITELLM_MANAGED',
      workspaceMode: 'read_oriented',
      sessionPolicy: 'fresh',
      reasons: ['test'],
    },
  });
  const executionId = reserved.record.executionId;
  links.attachWorkspace(executionId, {
    workspaceRef: `/workspace/executions/${executionId}/repo`,
    repositoryRoot: '/tmp/fake-repo',
    sourceRevision: 'source-base',
  });
  const claimedAt = Date.now();
  assert.equal(
    links.claimHostLaunch(executionId, 'other-process-token', claimedAt, claimedAt - 120_000)
      .acquired,
    true,
  );
  db.close();

  const host = new RecoverableFakeHost();
  const runtime = await buildControlPlane({
    dbFile,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  });
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'host-launch-fresh-claim' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Do not duplicate a claimed host launch.',
        projectKey: 'fresh-claim-project',
        repository: { path: '/tmp/fake-repo', baseRevision: 'source-base' },
        await: false,
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().executionId, executionId);
    assert.equal(response.json().status, 'STARTING');
    assert.equal(host.creates, 0);
    assert.ok(host.recoveries >= 1);
  } finally {
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('V3 recovers a host execution created before the durable conversation attach without relaunching', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-launch-crash-recovery-'));
  const dbFile = path.join(directory, 'control-plane.sqlite');
  const db = openDb(dbFile);
  const links = new ExecutionLinkRepository(db);
  const reserved = links.reserve({
    idempotencyKey: 'host-launch-crash-residue',
    projectKey: 'crash-recovery-project',
    phase: 'IMPLEMENT',
    objectiveSummary: 'Recover one already-created host writer.',
    selection: {
      backend: 'openhands-builtin',
      modelClass: 'implementation-efficient',
      transportMode: 'LITELLM_MANAGED',
      workspaceMode: 'isolated_write',
      sessionPolicy: 'fresh',
      reasons: ['test'],
    },
  });
  const executionId = reserved.record.executionId;
  links.attachWorkspace(executionId, {
    workspaceRef: `/workspace/executions/${executionId}/repo`,
    repositoryRoot: '/tmp/fake-repo',
    gitBranch: `ai-office/${executionId}`,
    sourceRevision: 'writer-start',
  });
  links.attachWriterStartRevision(executionId, 'writer-start');
  const claimedAt = Date.now();
  assert.equal(
    links.claimHostLaunch(executionId, 'crashed-launch-token', claimedAt, claimedAt - 120_000)
      .acquired,
    true,
  );
  db.close();

  const host = new RecoverableFakeHost();
  host.recoverableByExecution.set(executionId, {
    conversationId: 'conversation-created-before-crash',
    status: 'RUNNING',
    startedAt: new Date(claimedAt + 10).toISOString(),
  });
  const runtime = await buildControlPlane({
    dbFile,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  });

  try {
    const recovered = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'host-launch-crash-residue' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Recover one already-created host writer.',
        projectKey: 'crash-recovery-project',
        repository: { path: '/tmp/fake-repo', baseRevision: 'writer-start' },
        await: false,
      },
    });
    assert.equal(recovered.statusCode, 201);
    assert.equal(recovered.json().executionId, executionId);
    assert.equal(
      recovered.json().refs.openhandsConversationId,
      'conversation-created-before-crash',
    );
    assert.equal(host.creates, 0);
    assert.ok(host.recoveries >= 1);
  } finally {
    await runtime.app.close();
  }

  const verifiedDb = openDb(dbFile);
  try {
    const verified = new ExecutionLinkRepository(verifiedDb).get(executionId);
    assert.equal(verified?.openhandsConversationId, 'conversation-created-before-crash');
    assert.equal(verified?.hostLaunchToken, undefined);
    assert.equal(verified?.hostLaunchClaimedAt, undefined);
  } finally {
    verifiedDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('V3 writer completion fails closed when the agent returns success without a new commit', async () => {
  const host = new FakeHost();
  const noCommitWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    async verifyWriterCompletion() {
      throw new Error('WRITER_COMPLETION_NO_COMMIT');
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: noCommitWorkspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  });

  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'writer-no-commit' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement a real committed change.',
        projectKey: 'writer-gate-project',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(started.statusCode, 201);
    const executionId = started.json().executionId as string;

    host.finalText = 'Planned the change but did not edit or commit it.';
    host.status = 'SUCCEEDED';
    const observed = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${executionId}`,
    });
    assert.equal(observed.statusCode, 200);
    const body = observed.json();
    assert.equal(body.status, 'FAILED');
    assert.equal(body.error.code, 'WRITER_COMPLETION_NO_COMMIT');
    assert.equal(body.error.retryable, false);
    assert.match(body.result.finalText, /did not edit or commit/);

    // The host keeps reporting its own SUCCEEDED terminal state. A deterministic
    // writer-completion rejection is product truth and must never be resurrected.
    const replayedObservation = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${executionId}`,
    });
    assert.equal(replayedObservation.statusCode, 200);
    assert.equal(replayedObservation.json().status, 'FAILED');
    assert.equal(replayedObservation.json().error.code, 'WRITER_COMPLETION_NO_COMMIT');
  } finally {
    await runtime.app.close();
  }
});

test('V3 review prompt preserves read-only evidence and directs write-requiring checks to disposable scratch', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  });

  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-review-source' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement the approved change.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(implementation.statusCode, 201);
    const implementationId = implementation.json().executionId;
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    host.status = 'RUNNING';
    const review = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-review-scratch-rule' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Independently verify the implementation.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    assert.equal(review.statusCode, 201);
    const lastObjective = host.createdObjectives.at(-1) ?? '';
    assert.match(lastObjective, /intentionally physically read-only/);
    assert.match(lastObjective, /fresh temporary directory under \/tmp/);
    assert.match(
      lastObjective,
      /Do not classify read-only permission errors as implementation defects/,
    );
    assert.match(lastObjective, /freezes the implementation workspace at its current HEAD/);
    assert.match(lastObjective, /refs\/ai-office\/review-base/);
    assert.match(
      lastObjective,
      /Do not fail because the delivery branch, pull request, remote checks, merge, or post-merge verification is not present yet/,
    );
    assert.match(lastObjective, /at least one focused verification command/);
    assert.match(lastObjective, /do not delegate VERIFY_REVIEW to nested task subagents/);
    assert.match(lastObjective, /short separate terminal tool invocations/);
  } finally {
    await runtime.app.close();
  }
});

test('V3 cancel keeps product status CANCELLED when OpenHands pause is the transport primitive', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  });

  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-cancel-status' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Long running investigation.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const executionId = started.json().executionId;
    const cancelled = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/executions/${executionId}/cancel`,
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, 'CANCELLED');

    const reread = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${executionId}`,
    });
    assert.equal(reread.json().status, 'CANCELLED');
  } finally {
    await runtime.app.close();
  }
});

test('V3 cancel is monotonic when the pause transport briefly still reports RUNNING', async () => {
  const host = new FakeHost();
  host.cancelExecution = async () => ({
    conversationId: '22222222-2222-4222-8222-222222222222',
    status: 'RUNNING',
  });
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: { 'openhands-builtin': true, 'opencode-acp': false },
  });
  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-cancel-race' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Cancellation race probe.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const executionId = started.json().executionId;
    const cancelled = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/executions/${executionId}/cancel`,
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, 'CANCELLED');

    const reread = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${executionId}`,
    });
    assert.equal(reread.json().status, 'CANCELLED');
  } finally {
    await runtime.app.close();
  }
});

test('V3 terminal cancellation survives a concurrent stale host observation', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: { 'openhands-builtin': true, 'opencode-acp': false },
  });
  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-cancel-concurrent-race' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Concurrent cancellation race probe.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const executionId = started.json().executionId;

    let releaseStale!: () => void;
    const staleReleased = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let staleStarted!: () => void;
    const staleObserved = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    let gets = 0;
    host.getExecution = async () => {
      gets += 1;
      if (gets === 1) {
        staleStarted();
        await staleReleased;
      }
      return {
        conversationId: '22222222-2222-4222-8222-222222222222',
        status: 'PAUSED',
      };
    };
    host.cancelExecution = async () => ({
      conversationId: '22222222-2222-4222-8222-222222222222',
      status: 'PAUSED',
    });

    const staleRead = runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${executionId}`,
    });
    await staleObserved;
    const cancelled = await runtime.app.inject({
      method: 'POST',
      url: `/api/v3/development/executions/${executionId}/cancel`,
    });
    assert.equal(cancelled.json().status, 'CANCELLED');
    releaseStale();
    assert.equal((await staleRead).json().status, 'CANCELLED');

    const reread = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${executionId}`,
    });
    assert.equal(reread.json().status, 'CANCELLED');
  } finally {
    await runtime.app.close();
  }
});

test('V3 IMPLEMENT_FIX reuses the reviewed implementation workspace and receives reviewer findings through causal lineage', async () => {
  const host = new FakeHost();
  const provisions: Array<{
    executionId: string;
    repositoryPath: string;
    workspaceMode: string;
  }> = [];
  const reuseWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    hostPathForExecution(executionId) {
      return `/host/workspaces/executions/${executionId}/repo`;
    },
    hostPathForWorkspaceRef(workspaceRef) {
      assert.match(workspaceRef, /^\/workspace\/executions\//);
      return `/host${workspaceRef}`;
    },
    async provision(input) {
      provisions.push({
        executionId: input.executionId,
        repositoryPath: input.repositoryPath,
        workspaceMode: input.workspaceMode,
      });
      return {
        hostPath: `/host/workspaces/executions/${input.executionId}/repo`,
        executionPath: `/workspace/executions/${input.executionId}/repo`,
        repositoryRoot: input.repositoryPath || '/tmp/repository',
        branch:
          input.workspaceMode === 'isolated_write' ? `ai-office/${input.executionId}` : undefined,
        sourceRevision: 'abc123',
      };
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: reuseWorkspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });

  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-fix-base' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement the change.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const implementationBody = implementation.json();
    const implementationId = implementationBody.executionId;
    const implementationWorkspace = implementationBody.result.workspaceRef;
    assert.equal(provisions.length, 1);

    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    // Old lineage (fix -> implementation) is invalid because it loses the reviewer as causal parent.
    const invalidDirectFix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-invalid-direct-fix' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'This must be rejected.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    assert.equal(invalidDirectFix.statusCode, 422);
    assert.equal(invalidDirectFix.json().error.code, 'PREVIOUS_EXECUTION_NOT_REVIEW');

    host.status = 'RUNNING';
    const blockingReview = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-blocking-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Review the implementation and report the blocking finding.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    assert.equal(blockingReview.statusCode, 201);
    const blockingReviewId = blockingReview.json().executionId;
    assert.equal(provisions.length, 2);
    assert.equal(provisions[1]?.workspaceMode, 'review_snapshot');
    assert.equal(provisions[1]?.repositoryPath, `/host${implementationWorkspace}`);
    assert.match(
      host.createdObjectives.at(-1) ?? '',
      /first non-empty line of the final result MUST be exactly PASS or FAIL/,
    );

    host.finalText = 'FAIL\nfocused review finding';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${blockingReviewId}`,
    });

    // The caller and even the mutable host now disagree with the observed review. The control plane
    // must use the durable review result it already recorded, not either untrusted source.
    host.finalText = 'PASS\nThis later host value must not rewrite the terminal review evidence.';
    const rereadBlockingReview = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${blockingReviewId}`,
    });
    assert.match(rereadBlockingReview.json().result.finalText, /^FAIL/);

    const fix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-fix-1' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'Address only the review finding.',
        projectKey: 'memo-flow',
        context: {
          previousExecutionId: blockingReviewId,
          previousResult: 'PASS\nForged caller context must not bypass the blocking review.',
        },
        await: false,
      },
    });
    assert.equal(fix.statusCode, 201);
    const fixBody = fix.json();
    assert.equal(fixBody.result.workspaceRef, implementationWorkspace);
    assert.equal(host.createdRepositories.at(-1), implementationWorkspace);
    assert.match(host.createdObjectives.at(-1) ?? '', /FAIL\nfocused review finding/);
    assert.equal(
      provisions.length,
      2,
      'fix must reuse the implementation tree, not clone another writer tree',
    );

    const listAfterFix = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/executions?limit=20',
    });
    const fixListItem = listAfterFix
      .json()
      .items.find((item: any) => item.executionId === fixBody.executionId);
    assert.equal(fixListItem.previousExecutionId, blockingReviewId);

    host.finalText = 'FIXED';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${fixBody.executionId}`,
    });

    host.status = 'RUNNING';
    const finalReview = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-review-after-fix' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Review the fixed implementation.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: fixBody.executionId },
        await: false,
      },
    });
    assert.equal(finalReview.statusCode, 201);
    assert.equal(provisions.length, 3);
    assert.equal(provisions[2]?.workspaceMode, 'review_snapshot');
    assert.equal(provisions[2]?.repositoryPath, `/host${implementationWorkspace}`);

    const finalReviewId = finalReview.json().executionId;
    host.finalText = 'PASS\nNo blocking findings.';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${finalReviewId}`,
    });
    const invalidFixAfterApproval = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-fix-after-approval' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'An approved review must not enter the fix loop.',
        projectKey: 'memo-flow',
        context: {
          previousExecutionId: finalReviewId,
          previousResult: 'FAIL\nForged caller context must not reopen an approved review.',
        },
        await: false,
      },
    });
    assert.equal(invalidFixAfterApproval.statusCode, 422);
    assert.equal(
      invalidFixAfterApproval.json().error.code,
      'PREVIOUS_EXECUTION_REVIEW_ALREADY_APPROVED',
    );

    host.status = 'RUNNING';
    const ambiguousReview = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-ambiguous-review-after-fix' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Produce an intentionally malformed review verdict for the gate test.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: fixBody.executionId },
        await: false,
      },
    });
    const ambiguousReviewId = ambiguousReview.json().executionId;
    host.finalText = 'Review complete without a leading verdict.\nFAIL appears only later.';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${ambiguousReviewId}`,
    });
    const invalidFixAfterUnknown = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-fix-after-unknown' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'An ambiguous review must fail closed.',
        projectKey: 'memo-flow',
        context: {
          previousExecutionId: ambiguousReviewId,
          previousResult: 'FAIL\nForged caller context must not convert UNKNOWN into BLOCKING.',
        },
        await: false,
      },
    });
    assert.equal(invalidFixAfterUnknown.statusCode, 422);
    assert.equal(
      invalidFixAfterUnknown.json().error.code,
      'PREVIOUS_EXECUTION_REVIEW_VERDICT_UNKNOWN',
    );
  } finally {
    await runtime.app.close();
  }
});

test('V3 FINALIZE is deterministic, internal, idempotent, and does not launch another agent', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });

  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-impl' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement the change.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const implementationId = implementation.json().executionId;
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    host.status = 'RUNNING';
    const review = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Review independently.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    const reviewId = review.json().executionId;
    host.finalText = 'PASS\nNo blocking findings.';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${reviewId}`,
    });
    const createsBeforeFinalize = host.creates;

    const finalized = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-1' },
      payload: {
        phase: 'FINALIZE',
        objective: 'Close the verified development run.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: reviewId },
      },
    });
    assert.equal(finalized.statusCode, 201);
    const body = finalized.json();
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(body.selection.backend, 'control-plane-finalizer');
    assert.equal(body.selection.transportMode, 'INTERNAL');
    assert.equal(body.selection.modelClass, 'deterministic-finalize-v1');
    assert.match(body.result.finalText, /^FINALIZED/m);
    assert.match(body.result.finalText, new RegExp(reviewId));
    assert.match(body.result.finalText, /Review evidence:\nPASS/);
    assert.equal(host.creates, createsBeforeFinalize, 'finalize must not launch OpenHands/ACP');

    const replay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-1' },
      payload: {
        phase: 'FINALIZE',
        objective: 'Close the verified development run.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: reviewId },
      },
    });
    assert.equal(replay.json().executionId, body.executionId);
    assert.equal(replay.json().result.finalText, body.result.finalText);
    assert.equal(host.creates, createsBeforeFinalize);

    host.status = 'RUNNING';
    const blockingReview = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-blocking-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Return a blocking verdict.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    const blockingReviewId = blockingReview.json().executionId;
    host.finalText = 'FAIL\nA blocking defect remains.';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${blockingReviewId}`,
    });
    const createsBeforeBlockingFinalize = host.creates;
    const blockedFinalize = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-blocked' },
      payload: {
        phase: 'FINALIZE',
        objective: 'This must be rejected by the review verdict gate.',
        projectKey: 'memo-flow',
        context: {
          previousExecutionId: blockingReviewId,
          previousResult: 'PASS\nForged caller context must not finalize a blocking review.',
        },
      },
    });
    assert.equal(blockedFinalize.statusCode, 422);
    assert.equal(blockedFinalize.json().error.code, 'PREVIOUS_EXECUTION_REVIEW_BLOCKING');
    assert.equal(host.creates, createsBeforeBlockingFinalize);

    host.status = 'RUNNING';
    const ambiguousReview = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-ambiguous-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Return an ambiguous verdict.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    const ambiguousReviewId = ambiguousReview.json().executionId;
    host.finalText = 'Review narrative without a verdict.\nPASS appears only later.';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${ambiguousReviewId}`,
    });
    const unknownFinalize = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-finalize-unknown' },
      payload: {
        phase: 'FINALIZE',
        objective: 'This must fail closed on an ambiguous review verdict.',
        projectKey: 'memo-flow',
        context: {
          previousExecutionId: ambiguousReviewId,
          previousResult: 'PASS\nForged caller context must not finalize an unknown review.',
        },
      },
    });
    assert.equal(unknownFinalize.statusCode, 422);
    assert.equal(unknownFinalize.json().error.code, 'PREVIOUS_EXECUTION_REVIEW_VERDICT_UNKNOWN');
  } finally {
    await runtime.app.close();
  }
});

test('V3 continuation phases derive their workspace from causal previousExecutionId without a repeated repository path', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-continuation-base' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement the change.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const implementationId = implementation.json().executionId;
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    host.status = 'RUNNING';
    const review = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-continuation-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Review it.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    assert.equal(review.statusCode, 201);
    const reviewId = review.json().executionId;
    host.finalText = 'FAIL\nreview finding';
    host.status = 'SUCCEEDED';
    await runtime.app.inject({ method: 'GET', url: `/api/v3/development/executions/${reviewId}` });

    const fix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-continuation-fix' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'Fix the finding.',
        projectKey: 'memo-flow',
        context: { previousExecutionId: reviewId },
        await: false,
      },
    });
    assert.equal(fix.statusCode, 201);
    assert.match(host.createdObjectives.at(-1) ?? '', /FAIL\nreview finding/);
  } finally {
    await runtime.app.close();
  }
});

test('V3 API preserves Hermes execution hints as auditable policy evidence', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-hints-evidence' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Implement with explicit execution hints.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        hints: {
          complexity: 'HIGH',
          risk: 'MEDIUM',
          quality: 'PREMIUM',
          budget: 'LOW',
          parallelism: 3,
        },
        await: false,
      },
    });
    assert.equal(response.statusCode, 201);
    const reasons = response.json().selection.reasons;
    assert.ok(reasons.includes('hint:complexity:HIGH'));
    assert.ok(reasons.includes('hint:risk:MEDIUM'));
    assert.ok(reasons.includes('hint:quality:PREMIUM'));
    assert.ok(reasons.includes('hint:budget:LOW'));
    assert.ok(reasons.includes('hint:parallelism:3'));
  } finally {
    await runtime.app.close();
  }
});

test('V3 execution list exposes public status semantics without correlation internals', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-list-public-shape' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'List projection probe.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(started.statusCode, 201);
    const firstExecutionId = started.json().executionId;
    const second = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-list-public-shape-2' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Second list projection probe.',
        projectKey: 'memo-flow',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(second.statusCode, 201);
    const secondExecutionId = second.json().executionId;

    const listed = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/executions?projectKey=memo-flow&limit=1&offset=0',
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items.length, 1);
    assert.equal(listed.json().items[0].executionId, secondExecutionId);
    const item = listed.json().items[0];
    assert.equal(item.status, 'RUNNING');
    assert.equal(item.projectKey, 'memo-flow');
    assert.equal(item.phase, 'IMPLEMENT');
    assert.equal(item.selection.backend, 'opencode-acp');
    assert.equal('statusCache' in item, false);
    assert.equal('idempotencyKey' in item, false);

    const nextPage = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/executions?projectKey=memo-flow&limit=1&offset=1',
    });
    assert.equal(nextPage.statusCode, 200);
    assert.equal(nextPage.json().items.length, 1);
    assert.equal(nextPage.json().items[0].executionId, firstExecutionId);
  } finally {
    await runtime.app.close();
  }
});

test('V3 writer admission allows two isolated writers per project and rejects the third', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    const startWriter = (key: string) =>
      runtime.app.inject({
        method: 'POST',
        url: '/api/v3/development/executions',
        headers: { 'idempotency-key': key },
        payload: {
          phase: 'IMPLEMENT',
          objective: `Parallel writer ${key}`,
          projectKey: 'parallel-project',
          repository: { path: '/tmp/fake-repo' },
          await: false,
        },
      });
    const first = await startWriter('parallel-writer-1');
    const second = await startWriter('parallel-writer-2');
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.notEqual(first.json().result.workspaceRef, second.json().result.workspaceRef);

    const third = await startWriter('parallel-writer-3');
    assert.equal(third.statusCode, 409);
    assert.equal(third.json().error.code, 'WRITER_CONCURRENCY_PROJECT_LIMIT');
    assert.equal(host.creates, 2);
  } finally {
    await runtime.app.close();
  }
});

test('V3 writer admission counts PAUSED writer leases during ACP startup', async () => {
  const host = new FakeHost();
  host.status = 'PAUSED';
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    const startWriter = (key: string) =>
      runtime.app.inject({
        method: 'POST',
        url: '/api/v3/development/executions',
        headers: { 'idempotency-key': key },
        payload: {
          phase: 'IMPLEMENT',
          objective: `Paused startup writer ${key}`,
          projectKey: 'paused-startup-project',
          repository: { path: '/tmp/fake-repo' },
          await: false,
        },
      });
    assert.equal((await startWriter('paused-writer-1')).statusCode, 201);
    assert.equal((await startWriter('paused-writer-2')).statusCode, 201);
    const third = await startWriter('paused-writer-3');
    assert.equal(third.statusCode, 409);
    assert.equal(third.json().error.code, 'WRITER_CONCURRENCY_PROJECT_LIMIT');
    assert.equal(host.creates, 2);
  } finally {
    await runtime.app.close();
  }
});

test('V3 writer admission enforces the global active writer cap across projects', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    for (let i = 1; i <= 4; i += 1) {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/v3/development/executions',
        headers: { 'idempotency-key': `global-writer-${i}` },
        payload: {
          phase: 'IMPLEMENT',
          objective: `Writer ${i}`,
          projectKey: `project-${i}`,
          repository: { path: '/tmp/fake-repo' },
          await: false,
        },
      });
      assert.equal(response.statusCode, 201);
    }
    const blocked = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'global-writer-5' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Writer 5',
        projectKey: 'project-5',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error.code, 'WRITER_CONCURRENCY_GLOBAL_LIMIT');
    assert.equal(host.creates, 4);
  } finally {
    await runtime.app.close();
  }
});

test('V3 IMPLEMENT_FIX enforces a single writer lease for the implementation workspace referenced by the review', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'lease-base-implementation' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Create the implementation to be fixed.',
        projectKey: 'lease-project',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const implementationId = implementation.json().executionId;
    const implementationWorkspace = implementation.json().result.workspaceRef;
    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });

    host.status = 'RUNNING';
    const review = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'lease-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Report the focused finding.',
        projectKey: 'lease-project',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    const reviewId = review.json().executionId;
    host.status = 'SUCCEEDED';
    host.finalText = 'FAIL\nlease finding';
    await runtime.app.inject({ method: 'GET', url: `/api/v3/development/executions/${reviewId}` });

    host.status = 'RUNNING';
    const firstFix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'lease-fix-1' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'Apply the first focused fix.',
        projectKey: 'lease-project',
        context: { previousExecutionId: reviewId, previousResult: 'FAIL\nlease finding' },
        await: false,
      },
    });
    assert.equal(firstFix.statusCode, 201);
    assert.equal(firstFix.json().result.workspaceRef, implementationWorkspace);

    const competingFix = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'lease-fix-2' },
      payload: {
        phase: 'IMPLEMENT_FIX',
        objective: 'Competing fix must not share the mutable tree.',
        projectKey: 'lease-project',
        context: { previousExecutionId: reviewId, previousResult: 'FAIL\nlease finding' },
        await: false,
      },
    });
    assert.equal(competingFix.statusCode, 409);
    assert.equal(competingFix.json().error.code, 'WORKSPACE_WRITER_LEASE_CONFLICT');
    assert.equal(host.creates, 3, 'only implementation, review, and first fix should launch');
  } finally {
    await runtime.app.close();
  }
});

test('V3 explicit list hydration refreshes durable terminal observations', async () => {
  const host = new FakeHost();
  let providerKey = 'legacy-provider';
  let observations = 0;
  const observability: ObservabilityPort = {
    source: 'LITELLM',
    async health() {
      return 'OK';
    },
    async getExecutionSummary() {
      observations += 1;
      return {
        health: 'OK',
        usage: {
          source: 'LITELLM_REPORTED',
          input: 100,
          output: 10,
          costUsd: 0,
          calls: 1,
        },
        lastObservedRoute: {
          deploymentId: 'deployment-1',
          model: 'openai/test-model',
          providerKey,
        },
        routeUsage: [
          {
            deploymentId: 'deployment-1',
            model: 'openai/test-model',
            providerKey,
            input: 100,
            output: 10,
            costUsd: 0,
            calls: 1,
          },
        ],
      };
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Observability: observability,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-list-hydrate-refresh' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Persist and then refresh route evidence.',
        projectKey: 'hydrate-project',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    const executionId = started.json().executionId;
    host.status = 'SUCCEEDED';

    const completed = await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${executionId}`,
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json().refs.upstream.routeUsage[0].providerKey, 'legacy-provider');
    const baselineObservations = observations;
    assert.ok(baselineObservations > 0);

    providerKey = 'canonical-provider';
    const cached = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/executions?projectKey=hydrate-project&limit=10',
    });
    assert.equal(cached.json().items[0].refs.upstream.routeUsage[0].providerKey, 'legacy-provider');
    assert.equal(observations, baselineObservations);

    const hydrated = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/executions?projectKey=hydrate-project&limit=10&hydrate=1',
    });
    assert.equal(hydrated.statusCode, 200);
    assert.equal(
      hydrated.json().items[0].refs.upstream.routeUsage[0].providerKey,
      'canonical-provider',
    );
    assert.equal(observations, baselineObservations + 1);
  } finally {
    await runtime.app.close();
  }
});

test('V3 execution list reconciles non-terminal cached state from the execution host', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'v3-list-reconcile' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Finish upstream without an explicit GET.',
        projectKey: 'reconcile-project',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(started.json().status, 'RUNNING');
    host.status = 'SUCCEEDED';

    const listed = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/executions?projectKey=reconcile-project&limit=10',
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items[0].status, 'SUCCEEDED');
    assert.equal(listed.json().items[0].usage.input, 100);
    assert.equal(listed.json().items[0].timing.lastObservedAt, '2026-08-21T15:00:05.000Z');
  } finally {
    await runtime.app.close();
  }
});

test('V3 continuation endpoint is retired from the public protocol', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: new FakeHost(),
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
    },
  });
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions/exec-retired/messages',
      payload: { message: 'Continue.' },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await runtime.app.close();
  }
});

test('V3 runtime summary exposes only safe execution-plane health and logical models', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
      'codex-acp': false,
      'claude-code-acp': false,
      'dsh-acp': false,
      'zcode-acp': false,
    },
  });
  try {
    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/runtime-summary',
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.sourceHealth.openhands, 'OK');
    assert.equal(body.sourceHealth.litellm, 'OK');
    assert.equal(body.sourceHealth.observability, 'UNCONFIGURED');
    assert.equal(body.sourceHealth.langfuse, 'UNCONFIGURED');
    assert.deepEqual(body.logicalModels, [
      'planning-premium',
      'implementation-efficient',
      'review-premium',
    ]);
    assert.ok(body.enabledBackends.includes('openhands-builtin'));
    assert.ok(body.enabledBackends.includes('control-plane-finalizer'));
    assert.equal(body.enabledBackends.includes('codex-acp'), false);
    assert.equal(body.enabledBackends.includes('opencode-acp'), false);
    assert.deepEqual(body.concurrency, {
      max_active_writers: 4,
      max_active_writers_per_project: 2,
    });
    assert.equal(JSON.stringify(body).includes('apiKey'), false);
    assert.equal(JSON.stringify(body).includes('masterKey'), false);
  } finally {
    await runtime.app.close();
  }
});

test('V3 readiness refuses to count probe volume as representative cutover evidence', async () => {
  const host = new FakeHost();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': false,
    },
  });
  try {
    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/v3/development/readiness',
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, 'NOT_READY');
    assert.equal(body.ready, false);
    assert.equal(body.gates.representativeWorkflows.current, 2);
    assert.equal(body.gates.representativeWorkflows.required, 10);
    assert.equal(body.gates.representativeWorkflows.pass, false);
    assert.deepEqual(body.gates.corePhaseCoverage.phases, {
      ORCHESTRATE: false,
      IMPLEMENT: false,
      VERIFY_REVIEW: false,
    });
    assert.equal(body.gates.providerFallback.pass, true);
    assert.equal(body.gates.gatewayReconnect.pass, true);
    assert.equal(body.gates.reviewVerdict.pass, true);
    assert.equal(body.gates.fixLoop.pass, false);
    assert.match(body.unknownMetrics.representativeHumanCorrectionRate, /^UNKNOWN:/);
    assert.match(body.unknownMetrics.maintenanceComplexity, /^UNKNOWN:/);
    assert.match(body.unknownMetrics.operatorInterventions, /^UNKNOWN:/);
  } finally {
    await runtime.app.close();
  }
});

test('V3 review snapshot freezes current implementation HEAD and preserves original source ref', async () => {
  const host = new FakeHost();
  const provisions: Array<{
    phaseWorkspace: string;
    baseRevision?: string;
    reviewBaseRevision?: string;
    repositoryPath: string;
  }> = [];
  const anchoredWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    hostPathForExecution(executionId) {
      return `/host/workspaces/${executionId}`;
    },
    hostPathForWorkspaceRef(workspaceRef) {
      return `/host${workspaceRef}`;
    },
    async provision(input) {
      provisions.push({
        phaseWorkspace: input.workspaceMode,
        baseRevision: input.baseRevision,
        reviewBaseRevision: input.reviewBaseRevision,
        repositoryPath: input.repositoryPath,
      });
      return {
        hostPath: `/host/workspaces/${input.executionId}`,
        executionPath: `/workspace/${input.executionId}`,
        branch:
          input.workspaceMode === 'isolated_write' ? `ai-office/${input.executionId}` : undefined,
        sourceRevision:
          input.workspaceMode === 'isolated_write'
            ? 'source-base-revision-123'
            : (input.baseRevision ?? 'unexpected-review-base'),
      };
    },
  };
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: anchoredWorkspace,
    v3BackendAvailability: {
      'openhands-builtin': true,
      'opencode-acp': true,
      'codex-review-headless': true,
    },
  });

  try {
    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'review-anchor-implementation' },
      payload: {
        phase: 'IMPLEMENT',
        objective: 'Create a change that may later be committed inside the worker workspace.',
        projectKey: 'review-anchor-project',
        repository: { path: '/tmp/fake-repo' },
        await: false,
      },
    });
    assert.equal(implementation.statusCode, 201);
    const implementationId = implementation.json().executionId;

    host.status = 'SUCCEEDED';
    await runtime.app.inject({
      method: 'GET',
      url: `/api/v3/development/executions/${implementationId}`,
    });
    host.status = 'RUNNING';

    const review = await runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'review-anchor-review' },
      payload: {
        phase: 'VERIFY_REVIEW',
        objective: 'Review the implementation against its original base.',
        projectKey: 'review-anchor-project',
        context: { previousExecutionId: implementationId },
        await: false,
      },
    });
    assert.equal(review.statusCode, 201);
    assert.equal(review.json().selection.backend, 'codex-review-headless');
    assert.equal(review.json().selection.modelClass, 'review-premium');

    const reviewProvision = provisions.find((item) => item.phaseWorkspace === 'review_snapshot');
    assert.ok(reviewProvision);
    assert.equal(reviewProvision.baseRevision, 'HEAD');
    assert.equal(reviewProvision.reviewBaseRevision, 'source-base-revision-123');
    assert.match(reviewProvision.repositoryPath, /^\/host\/workspace\//);
  } finally {
    await runtime.app.close();
  }
});

test('V3 durable workspace claim fences a stale cross-process provision owner', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-provision-cross-process-'));
  const dbFile = path.join(directory, 'control-plane.sqlite');
  let releaseFirst!: () => void;
  let markFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstProvisionCalls = 0;
  let secondProvisionCalls = 0;

  const firstWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    async provision(input) {
      firstProvisionCalls += 1;
      markFirstEntered();
      await firstGate;
      if (input.publicationFence && !(await input.publicationFence())) {
        throw new Error('WORKSPACE_PROVISION_CLAIM_LOST');
      }
      return workspace.provision(input);
    },
  };
  const secondWorkspace: WorkspaceProvisioningPort = {
    ...workspace,
    async provision(input) {
      secondProvisionCalls += 1;
      assert.equal(await input.publicationFence?.(), true);
      return workspace.provision(input);
    },
  };
  const firstHost = new FakeHost();
  const secondHost = new FakeHost();
  const firstRuntime = await buildControlPlane({
    dbFile,
    v3ExecutionHost: firstHost,
    v3ModelGateway: gateway,
    v3Workspace: firstWorkspace,
    v3BackendAvailability: { 'openhands-builtin': true, 'opencode-acp': false },
  });
  const secondRuntime = await buildControlPlane({
    dbFile,
    v3ExecutionHost: secondHost,
    v3ModelGateway: gateway,
    v3Workspace: secondWorkspace,
    v3BackendAvailability: { 'openhands-builtin': true, 'opencode-acp': false },
  });
  const request = (runtime: Awaited<ReturnType<typeof buildControlPlane>>) =>
    runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'workspace-cross-process-fence' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Provision one workspace with durable cross-process ownership.',
        projectKey: 'workspace-fence-project',
        repository: { path: '/tmp/fake-repo', baseRevision: 'source-base' },
        await: false,
      },
    });

  try {
    const firstRequest = request(firstRuntime);
    await firstEntered;

    const contenderDb = openDb(dbFile);
    try {
      const record = new ExecutionLinkRepository(contenderDb).findByIdempotencyKey(
        'workspace-cross-process-fence',
      );
      assert.ok(record?.workspaceProvisionToken);
      contenderDb
        .prepare('UPDATE v3_execution_links SET workspace_provision_claimed_at=? WHERE execution_id=?')
        .run(Date.now() - 20 * 60_000, record.executionId);
    } finally {
      contenderDb.close();
    }

    const secondResponse = await request(secondRuntime);
    assert.equal(secondResponse.statusCode, 201);
    assert.equal(secondProvisionCalls, 1);
    assert.equal(secondHost.creates, 1);

    releaseFirst();
    const firstResponse = await firstRequest;
    assert.equal(firstResponse.statusCode, 201);
    assert.equal(firstResponse.json().executionId, secondResponse.json().executionId);
    assert.equal(firstProvisionCalls, 1);
    assert.equal(firstHost.creates, 0);

    const verifyDb = openDb(dbFile);
    try {
      const record = new ExecutionLinkRepository(verifyDb).findByIdempotencyKey(
        'workspace-cross-process-fence',
      );
      assert.ok(record?.workspaceRef);
      assert.equal(record?.workspaceProvisionToken, undefined);
      assert.equal(record?.workspaceProvisionClaimedAt, undefined);
      assert.notEqual(record?.statusCache, 'FAILED');
    } finally {
      verifyDb.close();
    }
  } finally {
    releaseFirst();
    await Promise.all([firstRuntime.app.close(), secondRuntime.app.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('V3 tokenless host recovery cannot attach across a newer durable launch claim', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-recovery-token-fence-'));
  const db = openDb(path.join(directory, 'control-plane.sqlite'));
  try {
    const links = new ExecutionLinkRepository(db);
    const reserved = links.reserve({
      idempotencyKey: 'host-recovery-token-fence',
      projectKey: 'host-recovery-fence-project',
      phase: 'INVESTIGATE_PLAN',
      objectiveSummary: 'Fence stale recovery attachment.',
      selection: {
        backend: 'openhands-builtin',
        modelClass: 'planning-premium',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'read_oriented',
        sessionPolicy: 'fresh',
        reasons: ['test'],
      },
    });
    const executionId = reserved.record.executionId;
    links.attachWorkspace(executionId, {
      workspaceRef: `/workspace/executions/${executionId}/repo`,
      repositoryRoot: '/tmp/fake-repo',
      sourceRevision: 'source-base',
    });
    const now = Date.now();
    assert.equal(links.claimHostLaunch(executionId, 'old-token', now, now - 120_000).acquired, true);
    db.prepare('UPDATE v3_execution_links SET host_launch_claimed_at=? WHERE execution_id=?').run(
      now - 10 * 60_000,
      executionId,
    );
    assert.equal(
      links.claimHostLaunch(executionId, 'new-token', now + 1, now - 120_000).acquired,
      true,
    );

    assert.throws(
      () => links.attachOpenHands(executionId, 'stale-recovered-conversation', now),
      /HOST_EXECUTION_ASSOCIATION_CONFLICT/,
    );
    const fenced = links.get(executionId);
    assert.equal(fenced?.openhandsConversationId, undefined);
    assert.equal(fenced?.hostLaunchToken, 'new-token');

    const attached = links.attachOpenHands(
      executionId,
      'current-owner-conversation',
      now,
      'new-token',
    );
    assert.equal(attached.openhandsConversationId, 'current-owner-conversation');
    assert.equal(attached.hostLaunchToken, undefined);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

class StaleRecoveryAttachmentHost extends FakeHost {
  recoveries = 0;
  readonly secondRecoveryEntered: Promise<void>;
  #markSecondRecoveryEntered!: () => void;
  #releaseSecondRecovery!: () => void;
  readonly #secondRecoveryGate: Promise<void>;

  constructor() {
    super();
    this.secondRecoveryEntered = new Promise<void>((resolve) => {
      this.#markSecondRecoveryEntered = resolve;
    });
    this.#secondRecoveryGate = new Promise<void>((resolve) => {
      this.#releaseSecondRecovery = resolve;
    });
  }

  releaseSecondRecovery() {
    this.#releaseSecondRecovery();
  }

  override async recoverExecution() {
    this.recoveries += 1;
    if (this.recoveries === 2) {
      this.#markSecondRecoveryEntered();
      await this.#secondRecoveryGate;
      return {
        conversationId: 'conversation-visible-to-stale-owner',
        status: 'RUNNING' as const,
        startedAt: new Date().toISOString(),
      };
    }
    return null;
  }
}

test('V3 superseded recovery owner cannot attach a conversation after launch-token takeover', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-recovery-attach-fence-'));
  const dbFile = path.join(directory, 'control-plane.sqlite');
  const host = new StaleRecoveryAttachmentHost();
  const runtime = await buildControlPlane({
    dbFile,
    v3ExecutionHost: host,
    v3ModelGateway: gateway,
    v3Workspace: workspace,
    v3BackendAvailability: { 'openhands-builtin': true, 'opencode-acp': false },
  });

  try {
    const request = runtime.app.inject({
      method: 'POST',
      url: '/api/v3/development/executions',
      headers: { 'idempotency-key': 'host-recovery-attach-fence' },
      payload: {
        phase: 'INVESTIGATE_PLAN',
        objective: 'Do not let stale recovery clear a newer launch claim.',
        projectKey: 'host-recovery-attach-fence-project',
        repository: { path: '/tmp/fake-repo', baseRevision: 'source-base' },
        await: false,
      },
    });

    await host.secondRecoveryEntered;
    const contenderDb = openDb(dbFile);
    let executionId = '';
    try {
      const contenderLinks = new ExecutionLinkRepository(contenderDb);
      const record = contenderLinks.findByIdempotencyKey('host-recovery-attach-fence');
      assert.ok(record?.hostLaunchToken);
      executionId = record.executionId;
      contenderDb
        .prepare('UPDATE v3_execution_links SET host_launch_claimed_at=? WHERE execution_id=?')
        .run(Date.now() - 10 * 60_000, executionId);
      const takeover = contenderLinks.claimHostLaunch(
        executionId,
        'new-recovery-owner-token',
        Date.now(),
        Date.now() - 120_000,
      );
      assert.equal(takeover.acquired, true);
    } finally {
      contenderDb.close();
    }

    host.releaseSecondRecovery();
    const response = await request;
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().status, 'STARTING');
    assert.equal(host.creates, 0);

    const verifyDb = openDb(dbFile);
    try {
      const record = new ExecutionLinkRepository(verifyDb).get(executionId);
      assert.equal(record?.openhandsConversationId, undefined);
      assert.equal(record?.hostLaunchToken, 'new-recovery-owner-token');
    } finally {
      verifyDb.close();
    }
  } finally {
    host.releaseSecondRecovery();
    await runtime.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
