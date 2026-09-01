import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LocalGitWorkspaceAdapter } from '../src/v4/adapters/gitWorkspace.js';
import { V4Error } from '../src/v4/domain/errors.js';
import type {
  ReviewCompletionEvidence,
  WorkspaceDescriptor,
} from '../src/v4/orchestration/contracts.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();
}

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function repository(root: string): {
  repositoryPath: string;
  rootRevision: string;
  baseRevision: string;
} {
  const repositoryPath = path.join(root, 'repo');
  fs.mkdirSync(repositoryPath, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repositoryPath]);
  git(repositoryPath, ['config', 'user.name', 'Pixel V4 Test']);
  git(repositoryPath, ['config', 'user.email', 'pixel-v4-test@local']);
  write(path.join(repositoryPath, 'README.md'), '# Base\n');
  const rootRevision = commit(repositoryPath, 'chore: root');
  write(path.join(repositoryPath, 'base.txt'), 'base\n');
  const baseRevision = commit(repositoryPath, 'chore: base');
  return { repositoryPath, rootRevision, baseRevision };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-git-workspace-'));
  const allowedRoot = path.join(directory, 'repositories');
  const managedRoot = path.join(directory, 'managed');
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(managedRoot, { recursive: true });
  const repo = repository(allowedRoot);
  const adapter = new LocalGitWorkspaceAdapter({
    allowedRepositoryRoots: [allowedRoot],
    managedHostRoot: managedRoot,
    executionRoot: '/workspace',
    commandTimeoutMs: 30_000,
  });
  return { directory, allowedRoot, managedRoot, adapter, ...repo };
}

function configureWriter(workspace: WorkspaceDescriptor): void {
  git(workspace.hostPath, ['config', 'user.name', 'Pixel V4 Worker']);
  git(workspace.hostPath, ['config', 'user.email', 'pixel-v4-worker@local']);
}

function implementationEvidence(
  workspace: WorkspaceDescriptor,
  resultRevision: string,
  override: Record<string, unknown> = {},
) {
  return {
    version: 1,
    executionId: workspace.executionId,
    phase: 'IMPLEMENT',
    sourceRevision: workspace.sourceRevision,
    resultRevision,
    summary: 'Implemented and verified.',
    tests: [{ command: 'npm test', status: 'PASS', exitCode: 0, summary: 'green' }],
    ...override,
  };
}

function reviewEvidence(
  workspace: WorkspaceDescriptor,
  reviewedSha: string,
  override: Partial<ReviewCompletionEvidence> = {},
) {
  return {
    version: 1,
    executionId: workspace.executionId,
    phase: 'REVIEW',
    reviewedSha,
    verdict: 'PASS',
    findings: [],
    checks: [{ command: 'npm test', status: 'PASS', exitCode: 0, summary: 'green' }],
    summary: 'Exact revision approved.',
    ...override,
  };
}

test('LocalGitWorkspace observes allowed repositories and rejects roots and symlinks', async () => {
  const value = fixture();
  const observation = await value.adapter.observeRepository(
    value.repositoryPath,
    value.baseRevision,
  );
  assert.equal(observation.rootPath, value.repositoryPath);
  assert.equal(observation.headRevision, value.baseRevision);
  assert.equal(observation.clean, true);
  assert.equal(observation.commitExists, true);
  assert.equal(
    (await value.adapter.observeRepository(value.repositoryPath, 'missing')).commitExists,
    false,
  );

  const outsideRoot = path.join(value.directory, 'outside');
  const outside = repository(outsideRoot);
  await assert.rejects(
    () => value.adapter.observeRepository(outside.repositoryPath, outside.baseRevision),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_REPOSITORY_NOT_ALLOWED',
  );
  const link = path.join(value.allowedRoot, 'repo-link');
  fs.symlinkSync(value.repositoryPath, link, 'dir');
  await assert.rejects(
    () => value.adapter.observeRepository(link, value.baseRevision),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_REPOSITORY_INVALID',
  );
});

test('LocalGitWorkspace provisions an exact revision idempotently with durable provenance', async () => {
  const value = fixture();
  const first = await value.adapter.provision({
    executionId: 'exec-provision',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  const second = await value.adapter.provision({
    executionId: 'exec-provision',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  assert.deepEqual(second, first);
  assert.equal(git(first.hostPath, ['rev-parse', 'HEAD']), value.baseRevision);
  assert.equal(first.executionPath, '/workspace/v4/executions/exec-provision/repo');
  assert.equal(first.sourceRepositoryPath, value.repositoryPath);
  assert.ok(
    fs.existsSync(
      path.join(value.managedRoot, 'v4', 'executions', 'exec-provision', 'workspace.json'),
    ),
  );
  await assert.rejects(
    () =>
      value.adapter.provision({
        executionId: 'exec-provision',
        repositoryPath: value.repositoryPath,
        sourceRevision: value.rootRevision,
      }),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_PROVENANCE_MISMATCH',
  );
});

test('LocalGitWorkspace implementation verification rejects no-op, dirty and mismatched evidence then accepts exact committed work', async () => {
  const value = fixture();
  const workspace = await value.adapter.provision({
    executionId: 'exec-implementation',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  await assert.rejects(
    () => value.adapter.verifyImplementation(workspace),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_IMPLEMENTATION_NOOP',
  );
  configureWriter(workspace);
  write(path.join(workspace.hostPath, 'feature.txt'), 'feature\n');
  const resultRevision = commit(workspace.hostPath, 'feat: add feature');
  write(path.join(workspace.hostPath, 'dirty.txt'), 'dirty\n');
  await assert.rejects(
    () => value.adapter.verifyImplementation(workspace),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_DIRTY',
  );
  fs.rmSync(path.join(workspace.hostPath, 'dirty.txt'));
  write(workspace.evidenceHostPath, JSON.stringify(implementationEvidence(workspace, 'wrong-sha')));
  await assert.rejects(
    () => value.adapter.verifyImplementation(workspace),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_IMPLEMENTATION_EVIDENCE_MISMATCH',
  );
  write(
    workspace.evidenceHostPath,
    JSON.stringify(
      implementationEvidence(workspace, resultRevision, {
        tests: [{ command: 'npm test', status: 'FAIL', exitCode: 1 }],
      }),
    ),
  );
  await assert.rejects(
    () => value.adapter.verifyImplementation(workspace),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_IMPLEMENTATION_TEST_GATE_FAILED',
  );
  write(
    workspace.evidenceHostPath,
    JSON.stringify(implementationEvidence(workspace, resultRevision)),
  );
  const verified = await value.adapter.verifyImplementation(workspace);
  assert.equal(verified.headRevision, resultRevision);
  assert.equal(verified.descendantOfSource, true);
  assert.deepEqual(verified.changedFiles, ['feature.txt']);
  assert.equal(verified.evidence.phase, 'IMPLEMENT');
});

test('LocalGitWorkspace provisions independent exact-SHA review snapshots and validates verdict evidence', async () => {
  const value = fixture();
  const implementation = await value.adapter.provision({
    executionId: 'exec-review-source',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(implementation);
  write(path.join(implementation.hostPath, 'reviewed.txt'), 'reviewed\n');
  const reviewedSha = commit(implementation.hostPath, 'feat: reviewed change');
  const review = await value.adapter.provision({
    executionId: 'exec-review',
    repositoryPath: value.repositoryPath,
    sourceRevision: reviewedSha,
    phase: 'REVIEW',
    sourceWorkspace: implementation,
  });
  assert.equal(git(review.hostPath, ['rev-parse', 'HEAD']), reviewedSha);
  write(review.evidenceHostPath, JSON.stringify(reviewEvidence(review, 'wrong-sha')));
  await assert.rejects(
    () => value.adapter.verifyReview(review, reviewedSha),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_REVIEW_EVIDENCE_MISMATCH',
  );
  write(review.evidenceHostPath, JSON.stringify(reviewEvidence(review, reviewedSha)));
  const passed = await value.adapter.verifyReview(review, reviewedSha);
  assert.equal(passed.evidence.phase, 'REVIEW');
  if (passed.evidence.phase === 'REVIEW') assert.equal(passed.evidence.verdict, 'PASS');

  write(
    review.evidenceHostPath,
    JSON.stringify(
      reviewEvidence(review, reviewedSha, {
        verdict: 'FAIL',
        findings: ['blocking issue'],
        checks: [{ command: 'npm test', status: 'FAIL', exitCode: 1 }],
        summary: 'Rejected.',
      }),
    ),
  );
  const failed = await value.adapter.verifyReview(review, reviewedSha);
  if (failed.evidence.phase === 'REVIEW') assert.equal(failed.evidence.verdict, 'FAIL');

  assert.throws(() => write(path.join(review.hostPath, 'blocked.txt'), 'blocked\n'));
  fs.chmodSync(review.hostPath, 0o750);
  write(path.join(review.hostPath, 'dirty.txt'), 'dirty\n');
  await assert.rejects(
    () => value.adapter.verifyReview(review, reviewedSha),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_DIRTY',
  );
});

test('LocalGitWorkspace integration rejects stale, dirty and non-descendant candidates and fast-forwards exact accepted revision', async () => {
  const value = fixture();
  const candidate = await value.adapter.provision({
    executionId: 'exec-integrate',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(candidate);
  write(path.join(candidate.hostPath, 'integrated.txt'), 'integrated\n');
  const acceptedRevision = commit(candidate.hostPath, 'feat: integrate candidate');

  await assert.rejects(
    () =>
      value.adapter.integrateAcceptedRevision({
        repositoryPath: value.repositoryPath,
        expectedRevision: value.rootRevision,
        acceptedRevision,
        candidateWorkspace: candidate,
      }),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_INTEGRATION_STALE_HEAD',
  );

  write(path.join(value.repositoryPath, 'dirty.txt'), 'dirty\n');
  await assert.rejects(
    () =>
      value.adapter.integrateAcceptedRevision({
        repositoryPath: value.repositoryPath,
        expectedRevision: value.baseRevision,
        acceptedRevision,
        candidateWorkspace: candidate,
      }),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_INTEGRATION_DIRTY',
  );
  fs.rmSync(path.join(value.repositoryPath, 'dirty.txt'));

  const unrelated = await value.adapter.provision({
    executionId: 'exec-unrelated',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(unrelated);
  git(unrelated.hostPath, ['checkout', '--orphan', 'unrelated']);
  for (const entry of fs.readdirSync(unrelated.hostPath))
    if (entry !== '.git')
      fs.rmSync(path.join(unrelated.hostPath, entry), { recursive: true, force: true });
  write(path.join(unrelated.hostPath, 'unrelated.txt'), 'unrelated\n');
  const unrelatedRevision = commit(unrelated.hostPath, 'feat: unrelated');
  await assert.rejects(
    () =>
      value.adapter.integrateAcceptedRevision({
        repositoryPath: value.repositoryPath,
        expectedRevision: value.baseRevision,
        acceptedRevision: unrelatedRevision,
        candidateWorkspace: unrelated,
      }),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_ACCEPTED_REVISION_NOT_DESCENDANT',
  );

  const integrated = await value.adapter.integrateAcceptedRevision({
    repositoryPath: value.repositoryPath,
    expectedRevision: value.baseRevision,
    acceptedRevision,
    candidateWorkspace: candidate,
  });
  assert.equal(integrated.headRevision, acceptedRevision);
  assert.equal(integrated.clean, true);
  assert.equal(git(value.repositoryPath, ['rev-parse', 'HEAD']), acceptedRevision);
});

test('LocalGitWorkspace provisions from a linked worktree under forced different ownership', async () => {
  const value = fixture();
  const linked = path.join(value.allowedRoot, 'linked-worktree');
  git(value.repositoryPath, ['worktree', 'add', '--detach', linked, value.baseRevision]);
  const previous = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  let workspace: WorkspaceDescriptor;
  try {
    workspace = await value.adapter.provision({
      executionId: 'exec-linked-worktree',
      repositoryPath: linked,
      sourceRevision: value.baseRevision,
      phase: 'IMPLEMENT',
    });
  } finally {
    if (previous === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = previous;
  }
  assert.equal(git(workspace.hostPath, ['rev-parse', 'HEAD']), value.baseRevision);
  assert.equal(workspace.sourceRepositoryPath, linked);
  assert.equal(fs.existsSync(path.join(path.dirname(workspace.hostPath), 'source.bundle')), false);
});
