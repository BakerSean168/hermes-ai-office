import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LocalGitWorkspaceAdapter } from '../src/v4/adapters/gitWorkspace.js';
import { V4Error } from '../src/v4/domain/errors.js';
import { REPOSITORY_COMPLETION_EVIDENCE_FILE } from '../src/v4/orchestration/contracts.js';
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
  write(path.join(repositoryPath, '.gitignore'), 'node_modules/\n');
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
    minimumFreeBytes: 0,
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

test('LocalGitWorkspace fails closed before provisioning when managed storage is below threshold', async () => {
  const value = fixture();
  const adapter = new LocalGitWorkspaceAdapter({
    allowedRepositoryRoots: [value.allowedRoot],
    managedHostRoot: value.managedRoot,
    executionRoot: '/workspace',
    commandTimeoutMs: 30_000,
    minimumFreeBytes: 8 * 1024 * 1024 * 1024,
    freeBytes: () => 1024,
  });
  await assert.rejects(
    () =>
      adapter.provision({
        executionId: 'exec-capacity-low',
        repositoryPath: value.repositoryPath,
        sourceRevision: value.baseRevision,
        phase: 'IMPLEMENT',
      }),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_CAPACITY_LOW',
  );
  assert.equal(
    fs.existsSync(path.join(value.managedRoot, 'v4', 'executions', 'exec-capacity-low')),
    false,
  );
});

test('LocalGitWorkspace prunes only ignored cache directories from explicitly terminal workspaces', async () => {
  const value = fixture();
  const workspace = await value.adapter.provision({
    executionId: 'exec-terminal-cache-prune',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  write(path.join(workspace.hostPath, 'node_modules', 'pkg', 'index.js'), 'cache\n');
  write(path.join(workspace.hostPath, 'kept', 'artifact.txt'), 'keep\n');
  write(workspace.evidenceHostPath, '{"terminal":true}\n');
  const result = await value.adapter.pruneTerminalCaches([workspace, workspace]);
  assert.equal(result.workspacesScanned, 1);
  assert.equal(result.cacheDirectoriesPruned, 1);
  assert.equal(fs.existsSync(path.join(workspace.hostPath, 'node_modules')), false);
  assert.equal(
    fs.readFileSync(path.join(workspace.hostPath, 'kept', 'artifact.txt'), 'utf8'),
    'keep\n',
  );
  assert.equal(fs.existsSync(path.join(workspace.hostPath, '.git')), true);
  assert.equal(fs.existsSync(workspace.evidenceHostPath), true);
  fs.rmSync(value.directory, { recursive: true, force: true });
});

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

test('LocalGitWorkspace preserves only a non-secret source repository identity for isolated harness matching', async () => {
  const value = fixture();
  git(value.repositoryPath, [
    'remote',
    'add',
    'origin',
    'https://oauth-user:super-secret@example.invalid/owner/memoflow.git?token=also-secret',
  ]);
  const workspace = await value.adapter.provision({
    executionId: 'exec-source-identity',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'REVIEW',
  });
  assert.equal(
    git(workspace.hostPath, ['remote', 'get-url', 'origin']),
    'https://pixel.invalid/source/memoflow.git',
  );
  const config = fs.readFileSync(path.join(workspace.hostPath, '.git', 'config'), 'utf8');
  assert.equal(config.includes('super-secret'), false);
  assert.equal(config.includes('also-secret'), false);
});

test('LocalGitWorkspace materializes exact initialized submodules without using remote URLs', async () => {
  const value = fixture();
  const childRoot = path.join(value.allowedRoot, 'child-source');
  fs.mkdirSync(childRoot, { recursive: true });
  const child = repository(childRoot);
  git(value.repositoryPath, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--',
    child.repositoryPath,
    'vendor/child',
  ]);
  const gitmodules = path.join(value.repositoryPath, '.gitmodules');
  write(
    gitmodules,
    fs
      .readFileSync(gitmodules, 'utf8')
      .replace(child.repositoryPath, 'https://invalid.example/child.git'),
  );
  const parentRevision = commit(value.repositoryPath, 'feat: add exact child submodule');
  const workspace = await value.adapter.provision({
    executionId: 'exec-submodule',
    repositoryPath: value.repositoryPath,
    sourceRevision: parentRevision,
    phase: 'IMPLEMENT',
  });
  const childWorkspace = path.join(workspace.hostPath, 'vendor/child');
  assert.equal(git(childWorkspace, ['rev-parse', 'HEAD']), child.baseRevision);
  assert.equal(git(workspace.hostPath, ['status', '--porcelain=v1']), '');
  assert.ok(fs.statSync(path.join(childWorkspace, '.git')).isDirectory());
});

test('LocalGitWorkspace review provisioning recovers an exact submodule from the canonical local object store when the implementation submodule is deinitialized', async () => {
  const value = fixture();
  const childRoot = path.join(value.allowedRoot, 'child-fallback-source');
  fs.mkdirSync(childRoot, { recursive: true });
  const child = repository(childRoot);
  git(value.repositoryPath, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--',
    child.repositoryPath,
    'vendor/child',
  ]);
  const gitmodules = path.join(value.repositoryPath, '.gitmodules');
  write(
    gitmodules,
    fs
      .readFileSync(gitmodules, 'utf8')
      .replace(child.repositoryPath, 'https://invalid.example/child.git'),
  );
  const parentRevision = commit(value.repositoryPath, 'feat: add fallback child submodule');
  const canonicalChild = path.join(value.repositoryPath, 'vendor/child');
  // The exact gitlink object remains in the trusted local object database even though
  // the canonical submodule checkout is intentionally on a different commit.
  git(canonicalChild, ['checkout', '--detach', child.rootRevision]);
  git(canonicalChild, ['branch', '-D', 'main']);
  assert.equal(git(canonicalChild, ['rev-parse', 'HEAD']), child.rootRevision);
  assert.equal(git(canonicalChild, ['cat-file', '-t', child.baseRevision]), 'commit');
  assert.equal(
    git(canonicalChild, ['for-each-ref', '--contains', child.baseRevision, '--format=%(refname)']),
    'refs/remotes/origin/HEAD\nrefs/remotes/origin/main',
  );

  const implementation = await value.adapter.provision({
    executionId: 'exec-submodule-fallback-implementation',
    repositoryPath: value.repositoryPath,
    sourceRevision: parentRevision,
    phase: 'IMPLEMENT',
  });
  const implementationChild = path.join(implementation.hostPath, 'vendor/child');
  assert.equal(git(implementationChild, ['rev-parse', 'HEAD']), child.baseRevision);

  // Simulate the real delivery-repair case: the implementation leaves the superproject
  // clean with the submodule uninitialized, so the review workspace cannot copy it from
  // the mutable implementation checkout and must use the canonical local object store.
  fs.rmSync(implementationChild, { recursive: true, force: true });
  fs.mkdirSync(implementationChild, { recursive: true });
  assert.equal(git(implementation.hostPath, ['status', '--porcelain=v1']), '');

  const review = await value.adapter.provision({
    executionId: 'exec-submodule-fallback-review',
    repositoryPath: value.repositoryPath,
    sourceRevision: parentRevision,
    phase: 'REVIEW',
    sourceWorkspace: implementation,
  });
  const reviewChild = path.join(review.hostPath, 'vendor/child');
  assert.equal(git(reviewChild, ['rev-parse', 'HEAD']), child.baseRevision);
  assert.equal(git(review.hostPath, ['status', '--porcelain=v1']), '');
  assert.ok(fs.statSync(path.join(reviewChild, '.git')).isDirectory());
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
  write(
    workspace.evidenceHostPath,
    JSON.stringify(implementationEvidence(workspace, value.baseRevision, { outcome: 'SATISFIED' })),
  );
  const satisfied = await value.adapter.verifyImplementation(workspace);
  assert.equal(satisfied.headRevision, value.baseRevision);
  assert.equal(satisfied.descendantOfSource, true);
  assert.deepEqual(satisfied.changedFiles, []);
  assert.equal(satisfied.diffStat, '');
  assert.equal(satisfied.evidence.outcome, 'SATISFIED');
  fs.rmSync(workspace.evidenceHostPath);
  configureWriter(workspace);
  write(path.join(workspace.hostPath, 'feature.txt'), 'feature\n');
  const resultRevision = commit(workspace.hostPath, 'feat: add feature');
  write(path.join(workspace.hostPath, 'dirty.txt'), 'dirty\n');
  await assert.rejects(
    () => value.adapter.verifyImplementation(workspace),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_DIRTY',
  );
  fs.rmSync(path.join(workspace.hostPath, 'dirty.txt'));
  write(
    workspace.evidenceHostPath,
    JSON.stringify(implementationEvidence(workspace, resultRevision, { outcome: 'SATISFIED' })),
  );
  await assert.rejects(
    () => value.adapter.verifyImplementation(workspace),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_IMPLEMENTATION_OUTCOME_INVALID',
  );
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

test('LocalGitWorkspace promotes controller-staged repository evidence and rejects unsafe staging files', async () => {
  const value = fixture();
  const workspace = await value.adapter.provision({
    executionId: 'exec-repository-evidence',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(workspace);
  write(path.join(workspace.hostPath, 'feature.txt'), 'feature\n');
  const resultRevision = commit(workspace.hostPath, 'feat: repository evidence');
  const staged = path.join(workspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE);
  write(staged, JSON.stringify(implementationEvidence(workspace, resultRevision)));
  write(path.join(workspace.hostPath, '_gen_evidence.py'), 'temporary evidence helper\n');
  assert.equal(value.adapter.hasCompletionEvidence(workspace), true);
  const beforeEvidenceFingerprint = await value.adapter.progressFingerprint(workspace);
  assert.match(
    git(workspace.hostPath, ['status', '--porcelain=v1']),
    /\?\? \.pixel-v4-completion-evidence\.json/,
  );
  const verified = await value.adapter.verifyImplementation(workspace);
  assert.equal(verified.headRevision, resultRevision);
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.existsSync(workspace.evidenceHostPath), true);
  assert.deepEqual(verified.ephemeralArtifactsPruned, ['_gen_evidence.py']);
  assert.equal(fs.existsSync(path.join(workspace.hostPath, '_gen_evidence.py')), false);
  assert.equal(value.adapter.hasCompletionEvidence(workspace), true);
  const afterEvidenceFingerprint = await value.adapter.progressFingerprint(workspace);
  assert.notEqual(beforeEvidenceFingerprint, afterEvidenceFingerprint);
  assert.equal(git(workspace.hostPath, ['status', '--porcelain=v1']), '');

  const tracked = await value.adapter.provision({
    executionId: 'exec-tracked-evidence',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(tracked);
  write(path.join(tracked.hostPath, 'feature.txt'), 'feature\n');
  write(path.join(tracked.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE), '{}');
  const trackedRevision = commit(tracked.hostPath, 'feat: wrongly track evidence');
  write(
    path.join(tracked.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
    JSON.stringify(implementationEvidence(tracked, trackedRevision)),
  );
  await assert.rejects(
    () => value.adapter.verifyImplementation(tracked),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_REPOSITORY_EVIDENCE_TRACKED',
  );

  const symlinked = await value.adapter.provision({
    executionId: 'exec-symlink-evidence',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(symlinked);
  write(path.join(symlinked.hostPath, 'feature.txt'), 'feature\n');
  const symlinkRevision = commit(symlinked.hostPath, 'feat: symlink evidence fixture');
  write(
    '/tmp/pixel-v4-evidence-target.json',
    JSON.stringify(implementationEvidence(symlinked, symlinkRevision)),
  );
  fs.symlinkSync(
    '/tmp/pixel-v4-evidence-target.json',
    path.join(symlinked.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
  );
  await assert.rejects(
    () => value.adapter.verifyImplementation(symlinked),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_REPOSITORY_EVIDENCE_INVALID',
  );
  fs.rmSync('/tmp/pixel-v4-evidence-target.json', { force: true });
});

test('LocalGitWorkspace refuses semantically invalid staged evidence before sealing it', async () => {
  const value = fixture();
  const workspace = await value.adapter.provision({
    executionId: 'exec-invalid-staged-outcome',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(workspace);
  write(path.join(workspace.hostPath, 'feature.txt'), 'feature\n');
  const resultRevision = commit(workspace.hostPath, 'feat: invalid staged outcome');
  const staged = path.join(workspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE);
  write(
    staged,
    JSON.stringify(implementationEvidence(workspace, resultRevision, { outcome: 'SATISFIED' })),
  );
  await assert.rejects(
    () => value.adapter.verifyImplementation(workspace),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_IMPLEMENTATION_OUTCOME_INVALID',
  );
  assert.equal(fs.existsSync(staged), true);
  assert.equal(fs.existsSync(workspace.evidenceHostPath), false);
  fs.rmSync(value.directory, { recursive: true, force: true });
});

test('LocalGitWorkspace atomically replaces an old invalid sealed evidence record with valid staged evidence from the same execution', async () => {
  const value = fixture();
  const workspace = await value.adapter.provision({
    executionId: 'exec-replace-invalid-evidence',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(workspace);
  write(path.join(workspace.hostPath, 'feature.txt'), 'feature\n');
  const resultRevision = commit(workspace.hostPath, 'feat: replace invalid evidence');
  write(
    workspace.evidenceHostPath,
    JSON.stringify(implementationEvidence(workspace, resultRevision, { outcome: 'SATISFIED' })),
  );
  const staged = path.join(workspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE);
  write(
    staged,
    JSON.stringify(implementationEvidence(workspace, resultRevision, { outcome: 'CHANGED' })),
  );
  write(path.join(workspace.hostPath, '_write_evidence.py'), 'temporary helper\n');
  const verified = await value.adapter.verifyImplementation(workspace);
  assert.equal(verified.headRevision, resultRevision);
  assert.equal(verified.evidence.phase, 'IMPLEMENT');
  if (verified.evidence.phase === 'IMPLEMENT') assert.equal(verified.evidence.outcome, 'CHANGED');
  assert.equal(verified.replacedInvalidEvidenceHash?.length, 64);
  assert.deepEqual(verified.ephemeralArtifactsPruned, ['_write_evidence.py']);
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.existsSync(path.join(workspace.hostPath, '_write_evidence.py')), false);
  assert.equal(JSON.parse(fs.readFileSync(workspace.evidenceHostPath, 'utf8')).outcome, 'CHANGED');
  assert.equal(git(workspace.hostPath, ['status', '--porcelain=v1']), '');
  fs.rmSync(value.directory, { recursive: true, force: true });
});

test('LocalGitWorkspace never prunes a symlink or non-allowlisted untracked artifact during evidence finalization', async () => {
  const value = fixture();
  const workspace = await value.adapter.provision({
    executionId: 'exec-no-unsafe-prune',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(workspace);
  write(path.join(workspace.hostPath, 'feature.txt'), 'feature\n');
  const resultRevision = commit(workspace.hostPath, 'feat: unsafe helper guard');
  write(
    workspace.evidenceHostPath,
    JSON.stringify(implementationEvidence(workspace, resultRevision)),
  );
  const target = path.join(value.directory, 'outside-helper.py');
  write(target, 'outside\n');
  fs.symlinkSync(target, path.join(workspace.hostPath, '_gen_evidence.py'));
  write(path.join(workspace.hostPath, 'unexpected.tmp'), 'keep\n');
  await assert.rejects(
    () => value.adapter.verifyImplementation(workspace),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_DIRTY',
  );
  assert.equal(
    fs.lstatSync(path.join(workspace.hostPath, '_gen_evidence.py')).isSymbolicLink(),
    true,
  );
  assert.equal(fs.existsSync(path.join(workspace.hostPath, 'unexpected.tmp')), true);
  fs.rmSync(value.directory, { recursive: true, force: true });
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
  write(path.join(review.hostPath, 'node_modules', '.cache', 'review-probe'), 'runtime\n');
  assert.equal(git(review.hostPath, ['status', '--porcelain=v1']), '');
  const stagedReviewEvidence = path.join(review.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE);
  write(stagedReviewEvidence, JSON.stringify(reviewEvidence(review, reviewedSha)));
  const stagedReview = await value.adapter.verifyReview(review, reviewedSha);
  if (stagedReview.evidence.phase === 'REVIEW') assert.equal(stagedReview.evidence.verdict, 'PASS');
  assert.equal(fs.existsSync(stagedReviewEvidence), false);
  assert.equal(git(review.hostPath, ['status', '--porcelain=v1']), '');
  fs.rmSync(review.evidenceHostPath);
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

  write(review.evidenceHostPath, JSON.stringify(reviewEvidence(review, reviewedSha)) + '\\n\n');
  const normalizedTrailingLiteralNewline = await value.adapter.verifyReview(review, reviewedSha);
  if (normalizedTrailingLiteralNewline.evidence.phase === 'REVIEW')
    assert.equal(normalizedTrailingLiteralNewline.evidence.verdict, 'PASS');

  write(
    review.evidenceHostPath,
    JSON.stringify(reviewEvidence(review, reviewedSha)) + ' trailing-garbage',
  );
  await assert.rejects(
    () => value.adapter.verifyReview(review, reviewedSha),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_EVIDENCE_INVALID',
  );

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

  const gitDirectory = path.resolve(
    value.repositoryPath,
    git(value.repositoryPath, ['rev-parse', '--git-dir']),
  );
  const integrationLock = path.join(gitDirectory, 'pixel-v4-integration.lock');
  write(integrationLock, 'held');
  await assert.rejects(
    () =>
      value.adapter.integrateAcceptedRevision({
        repositoryPath: value.repositoryPath,
        expectedRevision: value.baseRevision,
        acceptedRevision,
        candidateWorkspace: candidate,
      }),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKSPACE_INTEGRATION_LOCKED',
  );
  fs.rmSync(integrationLock);

  const repositoryOwner = fs.statSync(value.repositoryPath);
  const repositoryGitCalls: Array<{
    args: string[];
    identity?: { uid: number; gid: number };
  }> = [];
  type GitInternals = {
    git(cwd: string, args: string[], identity?: { uid: number; gid: number }): Promise<string>;
  };
  const internals = value.adapter as unknown as GitInternals;
  const originalGit = internals.git.bind(value.adapter);
  internals.git = async (cwd, args, identity) => {
    if (path.resolve(cwd) === path.resolve(value.repositoryPath))
      repositoryGitCalls.push({ args, ...(identity ? { identity } : {}) });
    return await originalGit(cwd, args, identity);
  };

  const previousDifferentOwner = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  let integrated;
  try {
    integrated = await value.adapter.integrateAcceptedRevision({
      repositoryPath: value.repositoryPath,
      expectedRevision: value.baseRevision,
      acceptedRevision,
      candidateWorkspace: candidate,
    });
  } finally {
    if (previousDifferentOwner === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = previousDifferentOwner;
  }
  assert.equal(integrated.headRevision, acceptedRevision);
  assert.equal(integrated.clean, true);
  assert.equal(git(value.repositoryPath, ['rev-parse', 'HEAD']), acceptedRevision);
  const indexOwner = fs.statSync(path.join(gitDirectory, 'index'));
  assert.equal(indexOwner.uid, repositoryOwner.uid);
  assert.equal(indexOwner.gid, repositoryOwner.gid);
  assert.ok(repositoryGitCalls.length > 0);
  assert.ok(
    repositoryGitCalls.every(
      ({ identity }) =>
        identity?.uid === repositoryOwner.uid && identity.gid === repositoryOwner.gid,
    ),
  );
});

test('LocalGitWorkspace adopts an exact reviewed revision already contained by a later clean canonical head without moving HEAD backwards', async () => {
  const value = fixture();
  const candidate = await value.adapter.provision({
    executionId: 'exec-already-contained',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  configureWriter(candidate);
  write(path.join(candidate.hostPath, 'accepted.txt'), 'accepted\n');
  const acceptedRevision = commit(candidate.hostPath, 'feat: accepted historical change');

  git(value.repositoryPath, ['fetch', candidate.hostPath, acceptedRevision]);
  git(value.repositoryPath, ['merge', '--ff-only', acceptedRevision]);
  write(path.join(value.repositoryPath, 'later.txt'), 'later\n');
  const laterHead = commit(value.repositoryPath, 'feat: later canonical change');
  assert.equal(git(value.repositoryPath, ['rev-parse', 'HEAD']), laterHead);

  const integrated = await value.adapter.integrateAcceptedRevision({
    repositoryPath: value.repositoryPath,
    expectedRevision: value.baseRevision,
    acceptedRevision,
    candidateWorkspace: candidate,
  });
  assert.equal(integrated.headRevision, laterHead);
  assert.equal(integrated.integratedRevision, acceptedRevision);
  assert.equal(integrated.clean, true);
  assert.equal(integrated.commitExists, true);
  assert.equal(git(value.repositoryPath, ['rev-parse', 'HEAD']), laterHead);
  assert.equal(fs.readFileSync(path.join(value.repositoryPath, 'later.txt'), 'utf8'), 'later\n');

  fs.rmSync(value.directory, { recursive: true, force: true });
});

test('LocalGitWorkspace integration aligns initialized submodules and replays a post-fast-forward submodule checkout crash safely', async () => {
  const value = fixture();
  const childRoot = path.join(value.allowedRoot, 'integration-child-source');
  fs.mkdirSync(childRoot, { recursive: true });
  const child = repository(childRoot);
  git(value.repositoryPath, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--',
    child.repositoryPath,
    'vendor/child',
  ]);
  const parentRevision = commit(value.repositoryPath, 'feat: add integration child');
  const canonicalChild = path.join(value.repositoryPath, 'vendor/child');
  assert.equal(git(canonicalChild, ['rev-parse', 'HEAD']), child.baseRevision);

  const candidate = await value.adapter.provision({
    executionId: 'exec-integrate-submodule',
    repositoryPath: value.repositoryPath,
    sourceRevision: parentRevision,
    phase: 'IMPLEMENT',
  });
  const candidateChild = path.join(candidate.hostPath, 'vendor/child');
  configureWriter({ ...candidate, hostPath: candidateChild });
  write(path.join(candidateChild, 'next.txt'), 'next\n');
  const nextChildRevision = commit(candidateChild, 'feat: advance child');
  git(canonicalChild, [
    '-c',
    'protocol.file.allow=always',
    'fetch',
    '--no-tags',
    '--',
    candidateChild,
    nextChildRevision,
  ]);
  assert.equal(git(canonicalChild, ['cat-file', '-t', nextChildRevision]), 'commit');
  assert.equal(git(canonicalChild, ['rev-parse', 'HEAD']), child.baseRevision);

  configureWriter(candidate);
  git(candidate.hostPath, ['add', 'vendor/child']);
  git(candidate.hostPath, ['commit', '-m', 'chore: advance child gitlink']);
  const acceptedRevision = git(candidate.hostPath, ['rev-parse', 'HEAD']);
  assert.equal(git(value.repositoryPath, ['status', '--porcelain=v1']), '');

  const integrated = await value.adapter.integrateAcceptedRevision({
    repositoryPath: value.repositoryPath,
    expectedRevision: parentRevision,
    acceptedRevision,
    candidateWorkspace: candidate,
  });
  assert.equal(integrated.headRevision, acceptedRevision);
  assert.equal(integrated.clean, true);
  assert.equal(git(canonicalChild, ['rev-parse', 'HEAD']), nextChildRevision);
  assert.equal(git(value.repositoryPath, ['status', '--porcelain=v1']), '');

  // Reconstruct the real crash window: superproject HEAD already moved, durable state did
  // not, and an initialized submodule checkout was left on the prior gitlink.
  git(canonicalChild, ['checkout', '--detach', child.baseRevision]);
  assert.equal(git(value.repositoryPath, ['status', '--porcelain=v1']), 'M vendor/child');
  const replayed = await value.adapter.integrateAcceptedRevision({
    repositoryPath: value.repositoryPath,
    expectedRevision: parentRevision,
    acceptedRevision,
    candidateWorkspace: candidate,
  });
  assert.equal(replayed.headRevision, acceptedRevision);
  assert.equal(replayed.clean, true);
  assert.equal(git(canonicalChild, ['rev-parse', 'HEAD']), nextChildRevision);
  assert.equal(git(value.repositoryPath, ['status', '--porcelain=v1']), '');

  // Uncommitted content inside an initialized submodule must never be overwritten by replay.
  git(canonicalChild, ['checkout', '--detach', child.baseRevision]);
  write(path.join(canonicalChild, 'operator-local.txt'), 'keep me\n');
  await assert.rejects(
    () =>
      value.adapter.integrateAcceptedRevision({
        repositoryPath: value.repositoryPath,
        expectedRevision: parentRevision,
        acceptedRevision,
        candidateWorkspace: candidate,
      }),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'WORKSPACE_INTEGRATION_SUBMODULE_DIRTY',
  );
  assert.ok(fs.existsSync(path.join(canonicalChild, 'operator-local.txt')));
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

test('LocalGitWorkspace keeps managed parents controller-owned but traversable by the worker', async () => {
  const value = fixture();
  const workspace = await value.adapter.provision({
    executionId: 'exec-parent-permissions',
    repositoryPath: value.repositoryPath,
    sourceRevision: value.baseRevision,
    phase: 'IMPLEMENT',
  });
  const v4Root = path.join(value.managedRoot, 'v4');
  const executionsRoot = path.join(v4Root, 'executions');
  const executionDirectory = path.dirname(workspace.hostPath);
  for (const directory of [v4Root, executionsRoot]) {
    const stat = fs.statSync(directory);
    assert.equal(stat.mode & 0o777, 0o711);
    assert.equal(stat.uid, process.getuid?.() ?? stat.uid);
    assert.equal(stat.gid, process.getgid?.() ?? stat.gid);
  }
  assert.equal(fs.statSync(executionDirectory).mode & 0o777, 0o750);
});
