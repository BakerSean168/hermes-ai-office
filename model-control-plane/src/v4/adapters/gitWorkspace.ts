import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { V4Error, failClosed } from '../domain/errors.js';
import { assertSafeEventPayload } from '../domain/events.js';
import type {
  CompletionEvidence,
  ImplementationCompletionEvidence,
  RepositoryObservation,
  ReviewCompletionEvidence,
  TestCommandEvidence,
  WorkspaceCompletionSnapshot,
  WorkspaceDescriptor,
  WorkspaceProviderPort,
  WorkspaceProvisionInput,
} from '../orchestration/contracts.js';

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE_BYTES = 256_000;
const MAX_DIFF_STAT_BYTES = 64_000;
const MAX_CHANGED_FILES = 1_000;
const MAX_IDENTIFIER = 180;

export interface LocalGitWorkspaceOptions {
  allowedRepositoryRoots: string[];
  managedHostRoot: string;
  executionRoot: string;
  commandTimeoutMs?: number;
  maxBufferBytes?: number;
  workspaceUid?: number;
  workspaceGid?: number;
}

interface StoredWorkspaceDescriptor extends WorkspaceDescriptor {
  version: 1;
}

function inside(candidate: string, root: string): boolean {
  const value = path.resolve(candidate);
  const boundary = path.resolve(root);
  return value === boundary || value.startsWith(boundary + path.sep);
}

function canonicalTimestamp(value: string, code: string): void {
  const parsed = Date.parse(value);
  failClosed(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, code);
}

function executionComponent(value: string): string {
  const component = value.trim();
  if (
    !component ||
    component.length > MAX_IDENTIFIER ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component)
  ) {
    throw new V4Error('WORKSPACE_EXECUTION_ID_INVALID');
  }
  return component;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new V4Error(code);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, code: string, maximum = 8_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new V4Error(code);
  return value;
}

function decodeTest(value: unknown): TestCommandEvidence {
  const item = record(value, 'WORKSPACE_TEST_EVIDENCE_INVALID');
  const status = item.status;
  if (status !== 'PASS' && status !== 'FAIL' && status !== 'SKIP')
    throw new V4Error('WORKSPACE_TEST_EVIDENCE_INVALID');
  const exitCode = item.exitCode;
  if (exitCode !== undefined && (!Number.isInteger(exitCode) || Number(exitCode) < 0))
    throw new V4Error('WORKSPACE_TEST_EVIDENCE_INVALID');
  return {
    command: requiredString(item.command, 'WORKSPACE_TEST_COMMAND_REQUIRED', 4_000),
    status,
    ...(exitCode === undefined ? {} : { exitCode: Number(exitCode) }),
    ...(typeof item.summary === 'string' ? { summary: item.summary.slice(0, 4_000) } : {}),
  };
}

function decodeImplementationEvidence(value: unknown): ImplementationCompletionEvidence {
  const root = record(value, 'WORKSPACE_EVIDENCE_INVALID');
  if (root.version !== 1 || (root.phase !== 'IMPLEMENT' && root.phase !== 'IMPLEMENT_FIX'))
    throw new V4Error('WORKSPACE_IMPLEMENTATION_EVIDENCE_INVALID');
  if (!Array.isArray(root.tests)) throw new V4Error('WORKSPACE_TEST_EVIDENCE_INVALID');
  const tests = root.tests.map(decodeTest);
  return {
    version: 1,
    executionId: requiredString(
      root.executionId,
      'WORKSPACE_EVIDENCE_EXECUTION_REQUIRED',
      MAX_IDENTIFIER,
    ),
    phase: root.phase,
    sourceRevision: requiredString(
      root.sourceRevision,
      'WORKSPACE_EVIDENCE_SOURCE_REQUIRED',
      MAX_IDENTIFIER,
    ),
    resultRevision: requiredString(
      root.resultRevision,
      'WORKSPACE_EVIDENCE_RESULT_REQUIRED',
      MAX_IDENTIFIER,
    ),
    summary: requiredString(root.summary, 'WORKSPACE_EVIDENCE_SUMMARY_REQUIRED', 8_000),
    tests,
  };
}

function decodeReviewEvidence(value: unknown): ReviewCompletionEvidence {
  const root = record(value, 'WORKSPACE_EVIDENCE_INVALID');
  if (root.version !== 1 || root.phase !== 'REVIEW')
    throw new V4Error('WORKSPACE_REVIEW_EVIDENCE_INVALID');
  if (root.verdict !== 'PASS' && root.verdict !== 'FAIL' && root.verdict !== 'INVALID')
    throw new V4Error('WORKSPACE_REVIEW_VERDICT_INVALID');
  if (
    !Array.isArray(root.findings) ||
    !root.findings.every((item) => typeof item === 'string' && item.length <= 8_000)
  ) {
    throw new V4Error('WORKSPACE_REVIEW_FINDINGS_INVALID');
  }
  if (!Array.isArray(root.checks)) throw new V4Error('WORKSPACE_REVIEW_CHECKS_INVALID');
  return {
    version: 1,
    executionId: requiredString(
      root.executionId,
      'WORKSPACE_EVIDENCE_EXECUTION_REQUIRED',
      MAX_IDENTIFIER,
    ),
    phase: 'REVIEW',
    reviewedSha: requiredString(root.reviewedSha, 'WORKSPACE_REVIEW_SHA_REQUIRED', MAX_IDENTIFIER),
    verdict: root.verdict,
    findings: root.findings as string[],
    checks: root.checks.map(decodeTest),
    summary: requiredString(root.summary, 'WORKSPACE_EVIDENCE_SUMMARY_REQUIRED', 8_000),
  };
}

function descriptorFrom(value: unknown): StoredWorkspaceDescriptor {
  const root = record(value, 'WORKSPACE_DESCRIPTOR_INVALID');
  if (root.version !== 1) throw new V4Error('WORKSPACE_DESCRIPTOR_VERSION_INVALID');
  const descriptor: StoredWorkspaceDescriptor = {
    version: 1,
    executionId: requiredString(root.executionId, 'WORKSPACE_DESCRIPTOR_INVALID', MAX_IDENTIFIER),
    hostPath: requiredString(root.hostPath, 'WORKSPACE_DESCRIPTOR_INVALID'),
    executionPath: requiredString(root.executionPath, 'WORKSPACE_DESCRIPTOR_INVALID'),
    evidenceHostPath: requiredString(root.evidenceHostPath, 'WORKSPACE_DESCRIPTOR_INVALID'),
    evidenceExecutionPath: requiredString(
      root.evidenceExecutionPath,
      'WORKSPACE_DESCRIPTOR_INVALID',
    ),
    sourceRepositoryPath: requiredString(root.sourceRepositoryPath, 'WORKSPACE_DESCRIPTOR_INVALID'),
    sourceRevision: requiredString(
      root.sourceRevision,
      'WORKSPACE_DESCRIPTOR_INVALID',
      MAX_IDENTIFIER,
    ),
    createdAt: requiredString(root.createdAt, 'WORKSPACE_DESCRIPTOR_INVALID', 100),
  };
  canonicalTimestamp(descriptor.createdAt, 'WORKSPACE_DESCRIPTOR_TIME_INVALID');
  return descriptor;
}

export class LocalGitWorkspaceAdapter implements WorkspaceProviderPort {
  readonly allowedRoots: string[];
  readonly managedHostRoot: string;
  readonly executionRoot: string;
  readonly commandTimeoutMs: number;
  readonly maxBufferBytes: number;
  readonly workspaceUid: number;
  readonly workspaceGid: number;

  constructor(options: LocalGitWorkspaceOptions) {
    failClosed(options.allowedRepositoryRoots.length > 0, 'WORKSPACE_ALLOWED_ROOT_REQUIRED');
    this.allowedRoots = options.allowedRepositoryRoots.map((root) =>
      this.canonicalDirectory(root, 'WORKSPACE_ALLOWED_ROOT_INVALID'),
    );
    this.managedHostRoot = this.canonicalDirectory(
      options.managedHostRoot,
      'WORKSPACE_MANAGED_ROOT_INVALID',
    );
    this.executionRoot = path.posix.resolve('/', options.executionRoot);
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024;
    this.workspaceUid = options.workspaceUid ?? process.getuid?.() ?? 0;
    this.workspaceGid = options.workspaceGid ?? process.getgid?.() ?? 0;
    failClosed(
      this.commandTimeoutMs >= 1_000 && this.commandTimeoutMs <= 15 * 60_000,
      'WORKSPACE_GIT_TIMEOUT_INVALID',
    );
    failClosed(
      this.maxBufferBytes >= 64 * 1024 && this.maxBufferBytes <= 64 * 1024 * 1024,
      'WORKSPACE_GIT_BUFFER_INVALID',
    );
    failClosed(
      Number.isInteger(this.workspaceUid) &&
        this.workspaceUid >= 0 &&
        Number.isInteger(this.workspaceGid) &&
        this.workspaceGid >= 0,
      'WORKSPACE_OWNER_INVALID',
    );
  }

  async observeRepository(
    repositoryPath: string,
    revision: string,
  ): Promise<RepositoryObservation> {
    const root = await this.repositoryRoot(repositoryPath);
    const headRevision = await this.git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const branch = await this.gitOptional(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const clean = (await this.git(root, ['status', '--porcelain=v1', '-z'])).length === 0;
    const commitExists = await this.gitSucceeds(root, ['cat-file', '-e', revision + '^{commit}']);
    return {
      repositoryPath: path.resolve(repositoryPath),
      rootPath: root,
      headRevision,
      ...(branch ? { branch } : {}),
      clean,
      commitExists,
      observedAt: new Date().toISOString(),
    };
  }

  async provision(input: WorkspaceProvisionInput): Promise<WorkspaceDescriptor> {
    const executionId = executionComponent(input.executionId);
    const repositoryRoot = await this.repositoryRoot(input.repositoryPath);
    failClosed(
      input.sourceRevision.trim().length > 0 && input.sourceRevision.length <= MAX_IDENTIFIER,
      'WORKSPACE_SOURCE_REVISION_REQUIRED',
    );
    const executionsRoot = this.ensureManagedExecutionParents();
    const executionDirectory = path.join(executionsRoot, executionId);
    const hostPath = path.join(executionDirectory, 'repo');
    const evidenceHostPath = path.join(executionDirectory, 'completion-evidence.json');
    const descriptorPath = path.join(executionDirectory, 'workspace.json');
    const executionPath = path.posix.join(
      this.executionRoot,
      'v4',
      'executions',
      executionId,
      'repo',
    );
    const evidenceExecutionPath = path.posix.join(
      this.executionRoot,
      'v4',
      'executions',
      executionId,
      'completion-evidence.json',
    );

    if (fs.existsSync(executionDirectory)) {
      if (!fs.existsSync(descriptorPath)) throw new V4Error('WORKSPACE_PROVISION_INCOMPLETE');
      const existing = this.readDescriptor(descriptorPath);
      const expected = {
        executionId,
        hostPath,
        executionPath,
        evidenceHostPath,
        evidenceExecutionPath,
        sourceRepositoryPath: repositoryRoot,
        sourceRevision: input.sourceRevision,
      };
      for (const [key, value] of Object.entries(expected)) {
        if (existing[key as keyof typeof existing] !== value)
          throw new V4Error('WORKSPACE_PROVENANCE_MISMATCH');
      }
      this.assertManagedWorkspace(existing.hostPath);
      if (
        !(await this.gitSucceeds(existing.hostPath, [
          'cat-file',
          '-e',
          input.sourceRevision + '^{commit}',
        ]))
      ) {
        throw new V4Error('WORKSPACE_SOURCE_REVISION_MISSING');
      }
      return existing;
    }

    let cloneSource = repositoryRoot;
    if (input.sourceWorkspace) {
      const source = this.validateWorkspace(input.sourceWorkspace);
      if (source.sourceRepositoryPath !== repositoryRoot)
        throw new V4Error('WORKSPACE_SOURCE_REPOSITORY_MISMATCH');
      if (
        !(await this.gitSucceeds(source.hostPath, [
          'cat-file',
          '-e',
          input.sourceRevision + '^{commit}',
        ]))
      ) {
        throw new V4Error('WORKSPACE_SOURCE_REVISION_MISSING');
      }
      cloneSource = source.hostPath;
    } else if (
      !(await this.gitSucceeds(repositoryRoot, [
        'cat-file',
        '-e',
        input.sourceRevision + '^{commit}',
      ]))
    ) {
      throw new V4Error('WORKSPACE_SOURCE_REVISION_MISSING');
    }

    const staging = executionDirectory + '.staging-' + randomUUID();
    fs.mkdirSync(staging, { mode: 0o750 });
    try {
      const stagingRepo = path.join(staging, 'repo');
      const sourceBundle = path.join(staging, 'source.bundle');
      await this.git(cloneSource, ['bundle', 'create', sourceBundle, '--all']);
      await this.runGit([
        'clone',
        '--no-hardlinks',
        '--no-checkout',
        '--',
        sourceBundle,
        stagingRepo,
      ]);
      fs.rmSync(sourceBundle, { force: true });
      if (input.phase === 'REVIEW') {
        await this.git(stagingRepo, ['checkout', '--detach', input.sourceRevision]);
      } else {
        await this.git(stagingRepo, [
          'switch',
          '-c',
          'pixel-v4/' + executionId,
          input.sourceRevision,
        ]);
      }
      const createdAt = new Date().toISOString();
      const descriptor: StoredWorkspaceDescriptor = {
        version: 1,
        executionId,
        hostPath,
        executionPath,
        evidenceHostPath,
        evidenceExecutionPath,
        sourceRepositoryPath: repositoryRoot,
        sourceRevision: input.sourceRevision,
        createdAt,
      };
      const descriptorFile = path.join(staging, 'workspace.json');
      fs.writeFileSync(descriptorFile, JSON.stringify(descriptor, null, 2) + '\n', {
        mode: 0o400,
        flag: 'wx',
      });
      this.assignWorkspaceOwner(staging, stagingRepo);
      if (input.phase === 'REVIEW') this.makeTreeReadOnly(stagingRepo);
      fs.renameSync(staging, executionDirectory);
      return descriptor;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async verifyImplementation(workspace: WorkspaceDescriptor): Promise<WorkspaceCompletionSnapshot> {
    const descriptor = this.validateWorkspace(workspace);
    const clean =
      (await this.git(descriptor.hostPath, ['status', '--porcelain=v1', '-z'])).length === 0;
    if (!clean) throw new V4Error('WORKSPACE_DIRTY');
    const headRevision = await this.git(descriptor.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    if (headRevision === descriptor.sourceRevision)
      throw new V4Error('WORKSPACE_IMPLEMENTATION_NOOP');
    const descendantOfSource = await this.gitSucceeds(descriptor.hostPath, [
      'merge-base',
      '--is-ancestor',
      descriptor.sourceRevision,
      headRevision,
    ]);
    if (!descendantOfSource) throw new V4Error('WORKSPACE_RESULT_NOT_DESCENDANT');
    const evidence = decodeImplementationEvidence(this.readEvidence(descriptor.evidenceHostPath));
    if (
      evidence.executionId !== descriptor.executionId ||
      evidence.sourceRevision !== descriptor.sourceRevision ||
      evidence.resultRevision !== headRevision
    ) {
      throw new V4Error('WORKSPACE_IMPLEMENTATION_EVIDENCE_MISMATCH');
    }
    if (
      evidence.tests.length === 0 ||
      evidence.tests.some((item) => item.status === 'FAIL') ||
      !evidence.tests.some((item) => item.status === 'PASS')
    ) {
      throw new V4Error('WORKSPACE_IMPLEMENTATION_TEST_GATE_FAILED');
    }
    const changedFilesRaw = await this.git(descriptor.hostPath, [
      'diff',
      '--name-only',
      '-z',
      descriptor.sourceRevision + '..' + headRevision,
    ]);
    const changedFiles = changedFilesRaw.split('\0').filter(Boolean);
    if (changedFiles.length === 0 || changedFiles.length > MAX_CHANGED_FILES)
      throw new V4Error('WORKSPACE_CHANGED_FILES_INVALID');
    const diffStat = await this.git(descriptor.hostPath, [
      'diff',
      '--stat',
      '--summary',
      descriptor.sourceRevision + '..' + headRevision,
    ]);
    if (Buffer.byteLength(diffStat, 'utf8') > MAX_DIFF_STAT_BYTES)
      throw new V4Error('WORKSPACE_DIFF_STAT_TOO_LARGE');
    return {
      workspace: descriptor,
      clean,
      headRevision,
      sourceRevision: descriptor.sourceRevision,
      descendantOfSource,
      changedFiles,
      diffStat,
      evidence,
      observedAt: new Date().toISOString(),
    };
  }

  async verifyReview(
    workspace: WorkspaceDescriptor,
    reviewedSha: string,
  ): Promise<WorkspaceCompletionSnapshot> {
    const descriptor = this.validateWorkspace(workspace);
    const clean =
      (await this.git(descriptor.hostPath, ['status', '--porcelain=v1', '-z'])).length === 0;
    if (!clean) throw new V4Error('WORKSPACE_DIRTY');
    const headRevision = await this.git(descriptor.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    if (headRevision !== reviewedSha || descriptor.sourceRevision !== reviewedSha)
      throw new V4Error('WORKSPACE_REVIEW_SHA_MISMATCH');
    const evidence = decodeReviewEvidence(this.readEvidence(descriptor.evidenceHostPath));
    if (evidence.executionId !== descriptor.executionId || evidence.reviewedSha !== reviewedSha)
      throw new V4Error('WORKSPACE_REVIEW_EVIDENCE_MISMATCH');
    if (evidence.verdict === 'PASS') {
      if (
        evidence.checks.length === 0 ||
        evidence.checks.some((item) => item.status === 'FAIL') ||
        !evidence.checks.some((item) => item.status === 'PASS')
      ) {
        throw new V4Error('WORKSPACE_REVIEW_CHECK_GATE_FAILED');
      }
    } else if (
      evidence.findings.length === 0 &&
      !evidence.checks.some((item) => item.status === 'FAIL')
    ) {
      throw new V4Error('WORKSPACE_REVIEW_FINDINGS_REQUIRED');
    }
    return {
      workspace: descriptor,
      clean,
      headRevision,
      sourceRevision: descriptor.sourceRevision,
      descendantOfSource: true,
      changedFiles: [],
      diffStat: '',
      evidence,
      observedAt: new Date().toISOString(),
    };
  }

  async integrateAcceptedRevision(input: {
    repositoryPath: string;
    expectedRevision: string;
    acceptedRevision: string;
    candidateWorkspace: WorkspaceDescriptor;
  }): Promise<RepositoryObservation> {
    const repositoryRoot = await this.repositoryRoot(input.repositoryPath);
    const candidate = this.validateWorkspace(input.candidateWorkspace);
    if (candidate.sourceRepositoryPath !== repositoryRoot)
      throw new V4Error('WORKSPACE_SOURCE_REPOSITORY_MISMATCH');
    const candidateClean =
      (await this.git(candidate.hostPath, ['status', '--porcelain=v1', '-z'])).length === 0;
    const candidateHead = await this.git(candidate.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    if (!candidateClean || candidateHead !== input.acceptedRevision)
      throw new V4Error('WORKSPACE_ACCEPTED_REVISION_NOT_PINNED');
    if (
      !(await this.gitSucceeds(candidate.hostPath, [
        'merge-base',
        '--is-ancestor',
        input.expectedRevision,
        input.acceptedRevision,
      ]))
    ) {
      throw new V4Error('WORKSPACE_ACCEPTED_REVISION_NOT_DESCENDANT');
    }
    const gitDirectory = path.resolve(
      repositoryRoot,
      await this.git(repositoryRoot, ['rev-parse', '--git-dir']),
    );
    const lockPath = path.join(gitDirectory, 'pixel-v4-integration.lock');
    let lock: number | undefined;
    try {
      lock = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new V4Error('WORKSPACE_INTEGRATION_LOCKED');
      throw new V4Error(
        'WORKSPACE_INTEGRATION_LOCK_FAILED',
        'Unable to create the integration lock: ' + (code ?? 'UNKNOWN'),
        error,
      );
    }
    const transferBundle = path.join(
      gitDirectory,
      'pixel-v4-integration-' + randomUUID() + '.bundle',
    );
    const repositoryStat = fs.statSync(repositoryRoot);
    const repositoryIdentity = { uid: repositoryStat.uid, gid: repositoryStat.gid };
    try {
      const current = await this.git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (current !== input.expectedRevision) throw new V4Error('WORKSPACE_INTEGRATION_STALE_HEAD');
      if ((await this.git(repositoryRoot, ['status', '--porcelain=v1', '-z'])).length !== 0)
        throw new V4Error('WORKSPACE_INTEGRATION_DIRTY');
      // A direct local-path fetch starts git-upload-pack in the worker-owned clone. That
      // child does not inherit our per-command safe.directory setting. An exact-HEAD
      // bundle preserves the ownership boundary and gives the controller a passive input.
      await this.git(candidate.hostPath, ['bundle', 'create', transferBundle, 'HEAD']);
      await this.git(
        repositoryRoot,
        ['fetch', '--no-tags', '--', transferBundle, input.acceptedRevision],
        repositoryIdentity,
      );
      if (
        !(await this.gitSucceeds(repositoryRoot, [
          'merge-base',
          '--is-ancestor',
          input.expectedRevision,
          input.acceptedRevision,
        ]))
      ) {
        throw new V4Error('WORKSPACE_ACCEPTED_REVISION_NOT_DESCENDANT');
      }
      const beforeMerge = await this.git(repositoryRoot, [
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ]);
      if (beforeMerge !== input.expectedRevision)
        throw new V4Error('WORKSPACE_INTEGRATION_STALE_HEAD');
      await this.git(
        repositoryRoot,
        ['merge', '--ff-only', input.acceptedRevision],
        repositoryIdentity,
      );
      const after = await this.git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (after !== input.acceptedRevision)
        throw new V4Error('WORKSPACE_INTEGRATION_RESULT_MISMATCH');
      if ((await this.git(repositoryRoot, ['status', '--porcelain=v1', '-z'])).length !== 0)
        throw new V4Error('WORKSPACE_INTEGRATION_DIRTY');
      return await this.observeRepository(repositoryRoot, input.acceptedRevision);
    } finally {
      if (lock !== undefined) fs.closeSync(lock);
      fs.rmSync(transferBundle, { force: true });
      fs.rmSync(lockPath, { force: true });
    }
  }

  private ensureManagedExecutionParents(): string {
    const managerUid = process.getuid?.();
    const managerGid = process.getgid?.();
    const directories = [
      path.join(this.managedHostRoot, 'v4'),
      path.join(this.managedHostRoot, 'v4', 'executions'),
    ];
    for (const directory of directories) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o711 });
      this.assertManagedDirectory(directory);
      const stat = fs.statSync(directory);
      if (
        managerUid !== undefined &&
        managerGid !== undefined &&
        (stat.uid !== managerUid || stat.gid !== managerGid)
      ) {
        if (managerUid !== 0) throw new V4Error('WORKSPACE_MANAGED_PARENT_OWNER_INVALID');
        fs.chownSync(directory, managerUid, managerGid);
      }
      fs.chmodSync(directory, 0o711);
    }
    return directories[1]!;
  }

  private assignWorkspaceOwner(executionDirectory: string, repository: string): void {
    fs.chownSync(executionDirectory, this.workspaceUid, this.workspaceGid);
    fs.chmodSync(executionDirectory, 0o750);
    const visit = (entry: string): void => {
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) return;
      fs.chownSync(entry, this.workspaceUid, this.workspaceGid);
      if (stat.isDirectory())
        for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
    };
    visit(repository);
  }

  private makeTreeReadOnly(root: string): void {
    const visit = (entry: string): void => {
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) return;
      fs.chmodSync(entry, stat.mode & ~0o222);
      if (stat.isDirectory())
        for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
    };
    visit(root);
  }

  private canonicalDirectory(value: string, code: string): string {
    const lexical = path.resolve(value);
    const stat = fs.lstatSync(lexical, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new V4Error(code);
    const real = fs.realpathSync(lexical);
    if (real !== lexical) throw new V4Error(code);
    return real;
  }

  private async repositoryRoot(repositoryPath: string): Promise<string> {
    const lexical = this.canonicalDirectory(repositoryPath, 'WORKSPACE_REPOSITORY_INVALID');
    if (!this.allowedRoots.some((root) => inside(lexical, root)))
      throw new V4Error('WORKSPACE_REPOSITORY_NOT_ALLOWED');
    const root = path.resolve(await this.git(lexical, ['rev-parse', '--show-toplevel']));
    const real = this.canonicalDirectory(root, 'WORKSPACE_REPOSITORY_INVALID');
    if (!this.allowedRoots.some((allowed) => inside(real, allowed)))
      throw new V4Error('WORKSPACE_REPOSITORY_NOT_ALLOWED');
    return real;
  }

  private assertManagedDirectory(directory: string): void {
    const lexical = path.resolve(directory);
    if (!inside(lexical, this.managedHostRoot)) throw new V4Error('WORKSPACE_PATH_NOT_MANAGED');
    const stat = fs.lstatSync(lexical, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(lexical) !== lexical)
      throw new V4Error('WORKSPACE_PATH_NOT_MANAGED');
  }

  private assertManagedWorkspace(hostPath: string): void {
    this.assertManagedDirectory(hostPath);
    if (!inside(hostPath, path.join(this.managedHostRoot, 'v4', 'executions')))
      throw new V4Error('WORKSPACE_PATH_NOT_MANAGED');
    const gitEntry = fs.lstatSync(path.join(hostPath, '.git'), { throwIfNoEntry: false });
    if (!gitEntry?.isDirectory() || gitEntry.isSymbolicLink())
      throw new V4Error('WORKSPACE_GIT_MISSING');
  }

  private validateWorkspace(value: WorkspaceDescriptor): WorkspaceDescriptor {
    const descriptor = descriptorFrom({ version: 1, ...value });
    this.assertManagedWorkspace(descriptor.hostPath);
    const sourceRepositoryPath = this.canonicalDirectory(
      descriptor.sourceRepositoryPath,
      'WORKSPACE_SOURCE_REPOSITORY_INVALID',
    );
    if (
      sourceRepositoryPath !== descriptor.sourceRepositoryPath ||
      !this.allowedRoots.some((root) => inside(sourceRepositoryPath, root))
    ) {
      throw new V4Error('WORKSPACE_SOURCE_REPOSITORY_INVALID');
    }
    const executionId = executionComponent(descriptor.executionId);
    const expectedDirectory = path.join(this.managedHostRoot, 'v4', 'executions', executionId);
    if (
      descriptor.hostPath !== path.join(expectedDirectory, 'repo') ||
      descriptor.evidenceHostPath !== path.join(expectedDirectory, 'completion-evidence.json')
    ) {
      throw new V4Error('WORKSPACE_PROVENANCE_MISMATCH');
    }
    if (
      descriptor.executionPath !==
      path.posix.join(this.executionRoot, 'v4', 'executions', executionId, 'repo')
    )
      throw new V4Error('WORKSPACE_PROVENANCE_MISMATCH');
    if (
      descriptor.evidenceExecutionPath !==
      path.posix.join(
        this.executionRoot,
        'v4',
        'executions',
        executionId,
        'completion-evidence.json',
      )
    )
      throw new V4Error('WORKSPACE_PROVENANCE_MISMATCH');
    const stored = this.readDescriptor(path.join(expectedDirectory, 'workspace.json'));
    if (JSON.stringify(stored) !== JSON.stringify(descriptor))
      throw new V4Error('WORKSPACE_DESCRIPTOR_MISMATCH');
    return descriptor;
  }

  private readDescriptor(file: string): StoredWorkspaceDescriptor {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 64_000)
      throw new V4Error('WORKSPACE_DESCRIPTOR_INVALID');
    try {
      return descriptorFrom(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
    } catch (error) {
      if (error instanceof V4Error) throw error;
      throw new V4Error('WORKSPACE_DESCRIPTOR_INVALID');
    }
  }

  private readEvidence(file: string): Record<string, unknown> {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (
      !stat?.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > MAX_EVIDENCE_BYTES
    )
      throw new V4Error('WORKSPACE_EVIDENCE_INVALID');
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      const decoded = record(value, 'WORKSPACE_EVIDENCE_INVALID');
      assertSafeEventPayload(decoded);
      return decoded;
    } catch (error) {
      if (error instanceof V4Error) throw error;
      throw new V4Error('WORKSPACE_EVIDENCE_INVALID');
    }
  }

  private async git(
    cwd: string,
    args: string[],
    identity?: { uid: number; gid: number },
  ): Promise<string> {
    return await this.runGit([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'safe.directory=' + cwd,
      '-C',
      cwd,
      ...args,
    ], identity);
  }

  private async gitOptional(cwd: string, args: string[]): Promise<string | undefined> {
    try {
      return await this.git(cwd, args);
    } catch {
      return undefined;
    }
  }

  private async gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
    try {
      await this.git(cwd, args);
      return true;
    } catch {
      return false;
    }
  }

  private async runGit(
    args: string[],
    identity?: { uid: number; gid: number },
  ): Promise<string> {
    try {
      const result = await execFileAsync('git', args, {
        encoding: 'utf8',
        timeout: this.commandTimeoutMs,
        maxBuffer: this.maxBufferBytes,
        ...(identity ?? {}),
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME ?? '/nonexistent',
          LANG: 'C',
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      return result.stdout.trim();
    } catch (error) {
      if (error instanceof V4Error) throw error;
      throw new V4Error('WORKSPACE_GIT_COMMAND_FAILED');
    }
  }
}
