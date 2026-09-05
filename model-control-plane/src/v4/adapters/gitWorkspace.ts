import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { V4Error, failClosed } from '../domain/errors.js';
import { assertSafeEventPayload } from '../domain/events.js';
import { REPOSITORY_COMPLETION_EVIDENCE_FILE } from '../orchestration/contracts.js';
import type {
  CompletionEvidence,
  ImplementationCompletionEvidence,
  RepositoryObservation,
  ReviewCompletionEvidence,
  TestCommandEvidence,
  WorkspaceCachePruneResult,
  WorkspaceCompletionSnapshot,
  WorkspaceDescriptor,
  WorkspaceStorageStatus,
  WorkspaceProviderPort,
  WorkspaceProvisionInput,
} from '../orchestration/contracts.js';

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE_BYTES = 256_000;
const MAX_DIFF_STAT_BYTES = 64_000;
const MAX_CHANGED_FILES = 1_000;
const MAX_IDENTIFIER = 180;
const MAX_SUBMODULES = 64;
const MAX_SUBMODULE_DEPTH = 4;
const DEFAULT_MINIMUM_FREE_BYTES = 1024 * 1024 * 1024;
const MAX_EPHEMERAL_EVIDENCE_HELPER_BYTES = 64 * 1024;
const EPHEMERAL_EVIDENCE_HELPERS = ['_write_evidence.py', '_gen_evidence.py'] as const;

export interface LocalGitWorkspaceOptions {
  allowedRepositoryRoots: string[];
  managedHostRoot: string;
  executionRoot: string;
  commandTimeoutMs?: number;
  maxBufferBytes?: number;
  workspaceUid?: number;
  workspaceGid?: number;
  minimumFreeBytes?: number;
  freeBytes?: (targetPath: string) => number;
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

function repositoryNameFromRemote(value: string): string | undefined {
  const text = value
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  if (!text) return undefined;
  const tail =
    text
      .split('/')
      .at(-1)
      ?.split(':')
      .at(-1)
      ?.replace(/\.git$/, '') ?? '';
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(tail) || tail === '.' || tail === '..') return undefined;
  return tail;
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

export function decodeImplementationEvidence(value: unknown): ImplementationCompletionEvidence {
  const root = record(value, 'WORKSPACE_EVIDENCE_INVALID');
  if (root.version !== 1 || (root.phase !== 'IMPLEMENT' && root.phase !== 'IMPLEMENT_FIX'))
    throw new V4Error('WORKSPACE_IMPLEMENTATION_EVIDENCE_INVALID');
  if (!Array.isArray(root.tests)) throw new V4Error('WORKSPACE_TEST_EVIDENCE_INVALID');
  const outcome = root.outcome ?? 'CHANGED';
  if (outcome !== 'CHANGED' && outcome !== 'SATISFIED')
    throw new V4Error('WORKSPACE_IMPLEMENTATION_OUTCOME_INVALID');
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
    outcome,
    summary: requiredString(root.summary, 'WORKSPACE_EVIDENCE_SUMMARY_REQUIRED', 8_000),
    tests,
  };
}

export function decodeReviewEvidence(value: unknown): ReviewCompletionEvidence {
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

export function assertImplementationEvidenceGate(
  evidence: ImplementationCompletionEvidence,
  descriptor: Pick<WorkspaceDescriptor, 'executionId' | 'sourceRevision'>,
  expectedRevision: string,
): void {
  if (
    evidence.executionId !== descriptor.executionId ||
    evidence.sourceRevision !== descriptor.sourceRevision ||
    evidence.resultRevision !== expectedRevision
  )
    throw new V4Error('WORKSPACE_IMPLEMENTATION_EVIDENCE_MISMATCH');
  const satisfiedWithoutChange =
    expectedRevision === descriptor.sourceRevision && evidence.outcome === 'SATISFIED';
  if (expectedRevision === descriptor.sourceRevision && !satisfiedWithoutChange)
    throw new V4Error('WORKSPACE_IMPLEMENTATION_NOOP');
  if (expectedRevision !== descriptor.sourceRevision && evidence.outcome === 'SATISFIED')
    throw new V4Error('WORKSPACE_IMPLEMENTATION_OUTCOME_INVALID');
  if (
    evidence.tests.length === 0 ||
    evidence.tests.some((item) => item.status === 'FAIL') ||
    !evidence.tests.some((item) => item.status === 'PASS')
  )
    throw new V4Error('WORKSPACE_IMPLEMENTATION_TEST_GATE_FAILED');
}

export function assertReviewEvidenceGate(
  evidence: ReviewCompletionEvidence,
  descriptor: Pick<WorkspaceDescriptor, 'executionId'>,
  reviewedSha: string,
): void {
  if (evidence.executionId !== descriptor.executionId || evidence.reviewedSha !== reviewedSha)
    throw new V4Error('WORKSPACE_REVIEW_EVIDENCE_MISMATCH');
  if (evidence.verdict === 'PASS') {
    if (
      evidence.checks.length === 0 ||
      evidence.checks.some((item) => item.status === 'FAIL') ||
      !evidence.checks.some((item) => item.status === 'PASS')
    )
      throw new V4Error('WORKSPACE_REVIEW_CHECK_GATE_FAILED');
  } else if (
    evidence.findings.length === 0 &&
    !evidence.checks.some((item) => item.status === 'FAIL')
  )
    throw new V4Error('WORKSPACE_REVIEW_FINDINGS_REQUIRED');
}

interface EvidencePromotionMetadata {
  replacedInvalidEvidenceHash?: string;
}

export class LocalGitWorkspaceAdapter implements WorkspaceProviderPort {
  readonly allowedRoots: string[];
  readonly managedHostRoot: string;
  readonly executionRoot: string;
  readonly commandTimeoutMs: number;
  readonly maxBufferBytes: number;
  readonly workspaceUid: number;
  readonly workspaceGid: number;
  readonly minimumFreeBytes: number;
  readonly freeBytes: (targetPath: string) => number;

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
    this.minimumFreeBytes = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
    this.freeBytes =
      options.freeBytes ??
      ((targetPath: string) => {
        const stat = fs.statfsSync(targetPath);
        return Number(stat.bavail) * Number(stat.bsize);
      });
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
    failClosed(
      Number.isFinite(this.minimumFreeBytes) &&
        this.minimumFreeBytes >= 0 &&
        this.minimumFreeBytes <= 1024 ** 5,
      'WORKSPACE_CAPACITY_THRESHOLD_INVALID',
    );
  }

  async observeRepository(
    repositoryPath: string,
    revision: string,
  ): Promise<RepositoryObservation> {
    const root = await this.repositoryRoot(repositoryPath);
    const repositoryIdentity = this.repositoryIdentity(root);
    const headRevision = await this.git(
      root,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      repositoryIdentity,
    );
    const branch = await this.gitOptional(
      root,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      repositoryIdentity,
    );
    const clean =
      (await this.git(root, ['status', '--porcelain=v1', '-z'], repositoryIdentity)).length === 0;
    const commitExists = await this.gitSucceeds(
      root,
      ['cat-file', '-e', revision + '^{commit}'],
      repositoryIdentity,
    );
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

  async isRevisionAncestor(
    repositoryPath: string,
    ancestorRevision: string,
    descendantRevision: string,
  ): Promise<boolean> {
    const root = await this.repositoryRoot(repositoryPath);
    const repositoryIdentity = this.repositoryIdentity(root);
    const ancestorExists = await this.gitSucceeds(
      root,
      ['cat-file', '-e', ancestorRevision + '^{commit}'],
      repositoryIdentity,
    );
    const descendantExists = await this.gitSucceeds(
      root,
      ['cat-file', '-e', descendantRevision + '^{commit}'],
      repositoryIdentity,
    );
    if (!ancestorExists || !descendantExists) return false;
    return await this.gitSucceeds(
      root,
      ['merge-base', '--is-ancestor', ancestorRevision, descendantRevision],
      repositoryIdentity,
    );
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

    this.preflightCapacity(this.managedHostRoot);
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
      const sourceIdentity = await this.sourceRepositoryIdentity(repositoryRoot);
      if (sourceIdentity) {
        await this.git(stagingRepo, [
          'remote',
          'set-url',
          'origin',
          'https://pixel.invalid/source/' + sourceIdentity + '.git',
        ]);
      }
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
      await this.materializeSubmodules(
        cloneSource,
        stagingRepo,
        input.sourceRevision,
        staging,
        0,
        { count: 0 },
        cloneSource === repositoryRoot ? undefined : repositoryRoot,
      );
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
      // Review integrity is enforced at completion by exact-HEAD and clean-tree
      // verification. The checkout itself remains writable so the reviewer can
      // materialize lockfile-pinned dependencies and ignored tool caches.
      fs.renameSync(staging, executionDirectory);
      return descriptor;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (this.isStorageExhaustion(error))
        throw new V4Error(
          'WORKSPACE_STORAGE_EXHAUSTED',
          'Workspace provisioning ran out of storage.',
          error,
        );
      throw error;
    }
  }

  hasCompletionEvidence(workspace: WorkspaceDescriptor): boolean {
    const descriptor = this.validateWorkspace(workspace);
    const durable = fs.lstatSync(descriptor.evidenceHostPath, { throwIfNoEntry: false });
    const staged = fs.lstatSync(
      path.join(descriptor.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
      { throwIfNoEntry: false },
    );
    return Boolean(
      (durable?.isFile() && !durable.isSymbolicLink() && durable.size > 0) ||
      (staged?.isFile() && !staged.isSymbolicLink() && staged.size > 0),
    );
  }

  async progressFingerprint(workspace: WorkspaceDescriptor): Promise<string> {
    const descriptor = this.validateWorkspace(workspace);
    const head = await this.runGit([
      '-C',
      descriptor.hostPath,
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    const status = await this.runGit(['-C', descriptor.hostPath, 'status', '--porcelain=v1', '-z']);
    const unstaged = await this.runGit([
      '-C',
      descriptor.hostPath,
      'diff',
      '--no-ext-diff',
      '--numstat',
      'HEAD',
    ]);
    const staged = await this.runGit([
      '-C',
      descriptor.hostPath,
      'diff',
      '--no-ext-diff',
      '--cached',
      '--numstat',
      'HEAD',
    ]);
    let evidenceHash = '';
    const durableEvidence = fs.lstatSync(descriptor.evidenceHostPath, { throwIfNoEntry: false });
    if (durableEvidence?.isFile() && !durableEvidence.isSymbolicLink())
      evidenceHash = createHash('sha256')
        .update(fs.readFileSync(descriptor.evidenceHostPath))
        .digest('hex');
    const stagedEvidence = fs.lstatSync(
      path.join(descriptor.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
      { throwIfNoEntry: false },
    );
    const stagedEvidenceCursor = stagedEvidence
      ? `${stagedEvidence.size}:${stagedEvidence.mtimeMs}`
      : '';
    return createHash('sha256')
      .update(head)
      .update('\0')
      .update(status)
      .update('\0')
      .update(unstaged)
      .update('\0')
      .update(staged)
      .update('\0')
      .update(evidenceHash)
      .update('\0')
      .update(stagedEvidenceCursor)
      .digest('hex');
  }

  storageStatus(): WorkspaceStorageStatus {
    let stat: ReturnType<typeof fs.statfsSync>;
    try {
      stat = fs.statfsSync(this.managedHostRoot);
    } catch (error) {
      if (this.isStorageExhaustion(error))
        throw new V4Error(
          'WORKSPACE_STORAGE_EXHAUSTED',
          'Unable to inspect workspace storage because the filesystem is exhausted.',
          error,
        );
      throw new V4Error(
        'WORKSPACE_CAPACITY_PROBE_FAILED',
        'Unable to inspect workspace storage.',
        error,
      );
    }
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    if (
      !Number.isFinite(totalBytes) ||
      !Number.isFinite(freeBytes) ||
      totalBytes < 0 ||
      freeBytes < 0
    )
      throw new V4Error('WORKSPACE_CAPACITY_PROBE_FAILED');
    return {
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      minimumFreeBytes: this.minimumFreeBytes,
      lowCapacity: freeBytes < this.minimumFreeBytes,
    };
  }

  async pruneTerminalCaches(
    workspaces: readonly WorkspaceDescriptor[],
  ): Promise<WorkspaceCachePruneResult> {
    const before = this.storageStatus();
    let cacheDirectoriesPruned = 0;
    const seen = new Set<string>();
    for (const workspace of workspaces) {
      const descriptor = this.validateWorkspace(workspace);
      if (seen.has(descriptor.hostPath)) continue;
      seen.add(descriptor.hostPath);
      for (const candidate of this.cacheDirectories(descriptor.hostPath)) {
        const relative = path.relative(descriptor.hostPath, candidate);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        const ignored = await this.gitSucceeds(descriptor.hostPath, [
          'check-ignore',
          '-q',
          '--',
          relative,
        ]);
        if (!ignored) continue;
        fs.rmSync(candidate, { recursive: true, force: true });
        cacheDirectoriesPruned += 1;
      }
    }
    const after = this.storageStatus();
    return {
      workspacesScanned: seen.size,
      cacheDirectoriesPruned,
      freeBytesBefore: before.freeBytes,
      freeBytesAfter: after.freeBytes,
    };
  }

  async verifyImplementation(workspace: WorkspaceDescriptor): Promise<WorkspaceCompletionSnapshot> {
    const descriptor = this.validateWorkspace(workspace);
    const headRevision = await this.git(descriptor.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    const promotion = await this.promoteRepositoryEvidence(
      descriptor,
      'IMPLEMENTATION',
      headRevision,
    );
    const ephemeralArtifactsPruned = await this.pruneEphemeralEvidenceHelpers(
      descriptor,
      headRevision,
    );
    const clean =
      (await this.git(descriptor.hostPath, ['status', '--porcelain=v1', '-z'])).length === 0;
    if (!clean) throw new V4Error('WORKSPACE_DIRTY');
    if (headRevision === descriptor.sourceRevision && !fs.existsSync(descriptor.evidenceHostPath))
      throw new V4Error('WORKSPACE_IMPLEMENTATION_NOOP');
    const evidence = decodeImplementationEvidence(this.readEvidence(descriptor.evidenceHostPath));
    assertImplementationEvidenceGate(evidence, descriptor, headRevision);
    const satisfiedWithoutChange =
      headRevision === descriptor.sourceRevision && evidence.outcome === 'SATISFIED';
    const descendantOfSource =
      satisfiedWithoutChange ||
      (await this.gitSucceeds(descriptor.hostPath, [
        'merge-base',
        '--is-ancestor',
        descriptor.sourceRevision,
        headRevision,
      ]));
    if (!descendantOfSource) throw new V4Error('WORKSPACE_RESULT_NOT_DESCENDANT');
    const changedFiles = satisfiedWithoutChange
      ? []
      : (
          await this.git(descriptor.hostPath, [
            'diff',
            '--name-only',
            '-z',
            descriptor.sourceRevision + '..' + headRevision,
          ])
        )
          .split('\0')
          .filter(Boolean);
    if (
      changedFiles.length > MAX_CHANGED_FILES ||
      (!satisfiedWithoutChange && changedFiles.length === 0)
    )
      throw new V4Error('WORKSPACE_CHANGED_FILES_INVALID');
    const diffStat = satisfiedWithoutChange
      ? ''
      : await this.git(descriptor.hostPath, [
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
      ...(ephemeralArtifactsPruned.length > 0 ? { ephemeralArtifactsPruned } : {}),
      ...(promotion.replacedInvalidEvidenceHash
        ? { replacedInvalidEvidenceHash: promotion.replacedInvalidEvidenceHash }
        : {}),
      observedAt: new Date().toISOString(),
    };
  }

  async verifyReview(
    workspace: WorkspaceDescriptor,
    reviewedSha: string,
  ): Promise<WorkspaceCompletionSnapshot> {
    const descriptor = this.validateWorkspace(workspace);
    const headRevision = await this.git(descriptor.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    if (headRevision !== reviewedSha || descriptor.sourceRevision !== reviewedSha)
      throw new V4Error('WORKSPACE_REVIEW_SHA_MISMATCH');
    await this.promoteRepositoryEvidence(descriptor, 'REVIEW', reviewedSha);
    const clean =
      (await this.git(descriptor.hostPath, ['status', '--porcelain=v1', '-z'])).length === 0;
    if (!clean) throw new V4Error('WORKSPACE_DIRTY');
    const evidence = decodeReviewEvidence(this.readEvidence(descriptor.evidenceHostPath));
    assertReviewEvidenceGate(evidence, descriptor, reviewedSha);
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
    this.preflightCapacity(repositoryRoot);
    const repositoryIdentity = this.repositoryIdentity(repositoryRoot);
    const gitDirectory = path.resolve(
      repositoryRoot,
      await this.git(repositoryRoot, ['rev-parse', '--git-dir'], repositoryIdentity),
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
      if (code === 'ENOSPC' || code === 'EDQUOT')
        throw new V4Error(
          'WORKSPACE_STORAGE_EXHAUSTED',
          'Integration filesystem is out of storage.',
          error,
        );
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
    try {
      const current = await this.git(
        repositoryRoot,
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        repositoryIdentity,
      );
      const alreadyContained =
        current !== input.expectedRevision &&
        current !== input.acceptedRevision &&
        (await this.gitSucceeds(
          repositoryRoot,
          ['merge-base', '--is-ancestor', input.acceptedRevision, current],
          repositoryIdentity,
        ));
      if (
        current !== input.expectedRevision &&
        current !== input.acceptedRevision &&
        !alreadyContained
      )
        throw new V4Error('WORKSPACE_INTEGRATION_STALE_HEAD');

      const repositoryStatus = await this.git(
        repositoryRoot,
        ['status', '--porcelain=v1', '-z'],
        repositoryIdentity,
      );
      if ((current === input.expectedRevision || alreadyContained) && repositoryStatus.length !== 0)
        throw new V4Error('WORKSPACE_INTEGRATION_DIRTY');
      if (current === input.acceptedRevision && repositoryStatus.length !== 0)
        await this.assertReplayDirtinessRepairable(
          repositoryRoot,
          input.acceptedRevision,
          repositoryStatus,
          repositoryIdentity,
        );

      if (alreadyContained) {
        // External history can legitimately advance after the reviewed candidate was
        // produced (for example an already-merged historical delivery). Never move
        // the canonical checkout backwards. The ancestry proof above means the exact
        // accepted revision is already part of the current repository history.
        const observed = await this.observeRepository(repositoryRoot, input.acceptedRevision);
        return { ...observed, integratedRevision: input.acceptedRevision };
      }

      if (current === input.expectedRevision) {
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
          !(await this.gitSucceeds(
            repositoryRoot,
            ['merge-base', '--is-ancestor', input.expectedRevision, input.acceptedRevision],
            repositoryIdentity,
          ))
        ) {
          throw new V4Error('WORKSPACE_ACCEPTED_REVISION_NOT_DESCENDANT');
        }
        await this.preflightInitializedSubmodules(repositoryRoot, input.acceptedRevision);
        const beforeMerge = await this.git(
          repositoryRoot,
          ['rev-parse', '--verify', 'HEAD^{commit}'],
          repositoryIdentity,
        );
        if (beforeMerge !== input.expectedRevision)
          throw new V4Error('WORKSPACE_INTEGRATION_STALE_HEAD');
        await this.git(
          repositoryRoot,
          ['merge', '--ff-only', input.acceptedRevision],
          repositoryIdentity,
        );
      } else {
        // Crash replay: Git may already be at the independently reviewed SHA while
        // durable plan state is still on expectedRevision. Only submodule checkout
        // drift is repairable here; unrelated source-tree dirt remains fail-closed.
        if (
          !(await this.gitSucceeds(
            repositoryRoot,
            ['merge-base', '--is-ancestor', input.expectedRevision, input.acceptedRevision],
            repositoryIdentity,
          ))
        )
          throw new V4Error('WORKSPACE_ACCEPTED_REVISION_NOT_DESCENDANT');
        await this.preflightInitializedSubmodules(repositoryRoot, input.acceptedRevision);
      }

      await this.alignInitializedSubmodules(repositoryRoot, input.acceptedRevision);
      const after = await this.git(
        repositoryRoot,
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        repositoryIdentity,
      );
      if (after !== input.acceptedRevision)
        throw new V4Error('WORKSPACE_INTEGRATION_RESULT_MISMATCH');
      if (
        (await this.git(repositoryRoot, ['status', '--porcelain=v1', '-z'], repositoryIdentity))
          .length !== 0
      )
        throw new V4Error('WORKSPACE_INTEGRATION_DIRTY');
      const observed = await this.observeRepository(repositoryRoot, input.acceptedRevision);
      return { ...observed, integratedRevision: input.acceptedRevision };
    } finally {
      if (lock !== undefined) fs.closeSync(lock);
      fs.rmSync(transferBundle, { force: true });
      fs.rmSync(lockPath, { force: true });
    }
  }

  private gitlinkEntries(tree: string): Array<{ revision: string; relativePath: string }> {
    return tree
      .split('\0')
      .filter(Boolean)
      .flatMap((entry) => {
        const match = /^160000 commit ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
        return match ? [{ revision: match[1]!, relativePath: match[2]! }] : [];
      });
  }

  private safeSubmodulePath(repositoryRoot: string, relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    if (
      !normalized ||
      normalized.startsWith('/') ||
      path.posix.normalize(normalized) !== normalized ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new V4Error('WORKSPACE_SUBMODULE_PATH_INVALID');
    const targetPath = path.resolve(repositoryRoot, normalized);
    if (!inside(targetPath, repositoryRoot)) throw new V4Error('WORKSPACE_SUBMODULE_PATH_INVALID');
    return targetPath;
  }

  private async initializedSubmoduleState(
    repositoryRoot: string,
    relativePath: string,
  ): Promise<{ path: string; identity: { uid: number; gid: number } } | undefined> {
    const targetPath = this.safeSubmodulePath(repositoryRoot, relativePath);
    const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new V4Error('WORKSPACE_INTEGRATION_SUBMODULE_INVALID');
    if (fs.readdirSync(targetPath).length === 0) return undefined;
    const identity = this.repositoryIdentity(targetPath);
    const gitDirectory = await this.gitOptional(targetPath, ['rev-parse', '--git-dir'], identity);
    if (!gitDirectory) throw new V4Error('WORKSPACE_INTEGRATION_SUBMODULE_INVALID');
    return { path: targetPath, identity };
  }

  private async preflightInitializedSubmodules(
    repositoryRoot: string,
    revision: string,
    depth = 0,
    state: { count: number } = { count: 0 },
  ): Promise<void> {
    if (depth > MAX_SUBMODULE_DEPTH) throw new V4Error('WORKSPACE_SUBMODULE_DEPTH_EXCEEDED');
    const identity = this.repositoryIdentity(repositoryRoot);
    const tree = await this.git(repositoryRoot, ['ls-tree', '-r', '-z', revision], identity);
    for (const entry of this.gitlinkEntries(tree)) {
      if (state.count >= MAX_SUBMODULES) throw new V4Error('WORKSPACE_SUBMODULE_LIMIT_EXCEEDED');
      state.count += 1;
      const initialized = await this.initializedSubmoduleState(repositoryRoot, entry.relativePath);
      if (!initialized) continue;
      const status = await this.git(
        initialized.path,
        ['status', '--porcelain=v1', '-z'],
        initialized.identity,
      );
      if (status.length !== 0) throw new V4Error('WORKSPACE_INTEGRATION_SUBMODULE_DIRTY');
      if (
        !(await this.gitSucceeds(
          initialized.path,
          ['cat-file', '-e', entry.revision + '^{commit}'],
          initialized.identity,
        ))
      )
        throw new V4Error('WORKSPACE_INTEGRATION_SUBMODULE_REVISION_MISSING');
      await this.preflightInitializedSubmodules(initialized.path, entry.revision, depth + 1, state);
    }
  }

  private async alignInitializedSubmodules(
    repositoryRoot: string,
    revision: string,
    depth = 0,
    state: { count: number } = { count: 0 },
  ): Promise<void> {
    if (depth > MAX_SUBMODULE_DEPTH) throw new V4Error('WORKSPACE_SUBMODULE_DEPTH_EXCEEDED');
    const identity = this.repositoryIdentity(repositoryRoot);
    const tree = await this.git(repositoryRoot, ['ls-tree', '-r', '-z', revision], identity);
    for (const entry of this.gitlinkEntries(tree)) {
      if (state.count >= MAX_SUBMODULES) throw new V4Error('WORKSPACE_SUBMODULE_LIMIT_EXCEEDED');
      state.count += 1;
      const initialized = await this.initializedSubmoduleState(repositoryRoot, entry.relativePath);
      if (!initialized) continue;
      await this.git(
        initialized.path,
        ['checkout', '--detach', entry.revision],
        initialized.identity,
      );
      await this.alignInitializedSubmodules(initialized.path, entry.revision, depth + 1, state);
    }
  }

  private async assertReplayDirtinessRepairable(
    repositoryRoot: string,
    acceptedRevision: string,
    status: string,
    identity: { uid: number; gid: number },
  ): Promise<void> {
    if (status.length === 0) return;
    const tree = await this.git(
      repositoryRoot,
      ['ls-tree', '-r', '-z', acceptedRevision],
      identity,
    );
    const gitlinks = new Set(this.gitlinkEntries(tree).map((entry) => entry.relativePath));

    // Replay is allowed only for worktree-only submodule HEAD drift after the
    // superproject already reached the independently reviewed commit. Never
    // accept staged changes or untracked files as a recoverable crash artifact.
    const staged = await this.git(
      repositoryRoot,
      ['diff', '--cached', '--name-only', '-z', 'HEAD'],
      identity,
    );
    if (staged.length !== 0) throw new V4Error('WORKSPACE_INTEGRATION_DIRTY');
    const untracked = await this.git(
      repositoryRoot,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      identity,
    );
    if (untracked.length !== 0) throw new V4Error('WORKSPACE_INTEGRATION_DIRTY');
    const changed = (
      await this.git(
        repositoryRoot,
        ['diff', '--name-only', '-z', '--ignore-submodules=none', 'HEAD'],
        identity,
      )
    )
      .split('\0')
      .filter(Boolean);
    if (changed.length === 0 || changed.some((relativePath) => !gitlinks.has(relativePath)))
      throw new V4Error('WORKSPACE_INTEGRATION_DIRTY');
  }

  private async materializeSubmodules(
    sourceRepository: string,
    targetRepository: string,
    revision: string,
    bundleRoot: string,
    depth = 0,
    state: { count: number } = { count: 0 },
    fallbackRepository?: string,
  ): Promise<void> {
    if (depth > MAX_SUBMODULE_DEPTH) throw new V4Error('WORKSPACE_SUBMODULE_DEPTH_EXCEEDED');
    const tree = await this.git(sourceRepository, ['ls-tree', '-r', '-z', revision]);
    const entries = tree.split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = /^160000 commit ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
      if (!match) continue;
      if (state.count >= MAX_SUBMODULES) throw new V4Error('WORKSPACE_SUBMODULE_LIMIT_EXCEEDED');
      state.count += 1;
      const expectedRevision = match[1]!;
      const relativePath = match[2]!;
      const normalized = relativePath.replace(/\\/g, '/');
      if (
        !normalized ||
        normalized.startsWith('/') ||
        path.posix.normalize(normalized) !== normalized ||
        normalized.split('/').some((part) => !part || part === '.' || part === '..')
      ) {
        throw new V4Error('WORKSPACE_SUBMODULE_PATH_INVALID');
      }
      const sourcePath = path.resolve(sourceRepository, normalized);
      const targetPath = path.resolve(targetRepository, normalized);
      if (!inside(sourcePath, sourceRepository) || !inside(targetPath, targetRepository))
        throw new V4Error('WORKSPACE_SUBMODULE_PATH_INVALID');
      const fallbackPath = fallbackRepository
        ? path.resolve(fallbackRepository, normalized)
        : undefined;
      if (fallbackPath && !inside(fallbackPath, fallbackRepository!))
        throw new V4Error('WORKSPACE_SUBMODULE_PATH_INVALID');

      const candidatePaths = [
        sourcePath,
        ...(fallbackPath && fallbackPath !== sourcePath ? [fallbackPath] : []),
      ];
      let objectSource: string | undefined;
      for (const candidatePath of candidatePaths) {
        const candidateRoot = candidatePath === sourcePath ? sourceRepository : fallbackRepository!;
        const sourceStat = fs.lstatSync(candidatePath, { throwIfNoEntry: false });
        if (!sourceStat) continue;
        if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
          throw new V4Error('WORKSPACE_SUBMODULE_SOURCE_INVALID');
        const sourceReal = fs.realpathSync(candidatePath);
        if (!inside(sourceReal, fs.realpathSync(candidateRoot)))
          throw new V4Error('WORKSPACE_SUBMODULE_SOURCE_INVALID');
        if (
          await this.gitSucceeds(candidatePath, ['cat-file', '-e', expectedRevision + '^{commit}'])
        ) {
          objectSource = candidatePath;
          break;
        }
      }
      if (!objectSource) throw new V4Error('WORKSPACE_SUBMODULE_SOURCE_REVISION_MISMATCH');

      const existing = fs.lstatSync(targetPath, { throwIfNoEntry: false });
      if (existing) {
        if (
          !existing.isDirectory() ||
          existing.isSymbolicLink() ||
          fs.readdirSync(targetPath).length > 0
        )
          throw new V4Error('WORKSPACE_SUBMODULE_TARGET_NOT_EMPTY');
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const containingRefs = (
        await this.git(objectSource, [
          'for-each-ref',
          '--contains',
          expectedRevision,
          '--format=%(refname)',
        ])
      )
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean);
      const bundleRef = containingRefs[0];
      if (!bundleRef) throw new V4Error('WORKSPACE_SUBMODULE_SOURCE_REVISION_MISMATCH');
      const bundle = path.join(
        bundleRoot,
        '.pixel-v4-submodule-' + state.count + '-' + randomUUID() + '.bundle',
      );
      try {
        await this.git(objectSource, ['bundle', 'create', bundle, bundleRef]);
        fs.mkdirSync(targetPath, { recursive: true });
        await this.runGit(['init', '-q', '--', targetPath]);
        await this.git(targetPath, [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--',
          bundle,
          bundleRef,
        ]);
        await this.git(targetPath, ['checkout', '--detach', expectedRevision]);
      } finally {
        fs.rmSync(bundle, { force: true });
      }
      const nestedFallback =
        fallbackPath && fallbackPath !== objectSource ? fallbackPath : undefined;
      await this.materializeSubmodules(
        objectSource,
        targetPath,
        expectedRevision,
        bundleRoot,
        depth + 1,
        state,
        nestedFallback,
      );
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
    const repositoryIdentity = this.repositoryIdentity(lexical);
    const root = path.resolve(
      await this.git(lexical, ['rev-parse', '--show-toplevel'], repositoryIdentity),
    );
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

  private async promoteRepositoryEvidence(
    descriptor: WorkspaceDescriptor,
    phase: 'IMPLEMENTATION' | 'REVIEW',
    expectedRevision: string,
  ): Promise<EvidencePromotionMetadata> {
    const staged = path.join(descriptor.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE);
    const stagedStat = fs.lstatSync(staged, { throwIfNoEntry: false });
    if (!stagedStat) return {};
    if (
      !stagedStat.isFile() ||
      stagedStat.isSymbolicLink() ||
      stagedStat.size <= 0 ||
      stagedStat.size > MAX_EVIDENCE_BYTES
    )
      throw new V4Error('WORKSPACE_REPOSITORY_EVIDENCE_INVALID');
    const tracked = await this.git(descriptor.hostPath, [
      'ls-files',
      '--',
      REPOSITORY_COMPLETION_EVIDENCE_FILE,
    ]);
    if (tracked) throw new V4Error('WORKSPACE_REPOSITORY_EVIDENCE_TRACKED');

    const raw = this.readEvidence(staged);
    const evidence =
      phase === 'IMPLEMENTATION' ? decodeImplementationEvidence(raw) : decodeReviewEvidence(raw);
    if (phase === 'IMPLEMENTATION')
      assertImplementationEvidenceGate(
        evidence as ImplementationCompletionEvidence,
        descriptor,
        expectedRevision,
      );
    else
      assertReviewEvidenceGate(evidence as ReviewCompletionEvidence, descriptor, expectedRevision);

    let replacedInvalidEvidenceHash: string | undefined;
    const existingStat = fs.lstatSync(descriptor.evidenceHostPath, { throwIfNoEntry: false });
    if (existingStat) {
      if (
        !existingStat.isFile() ||
        existingStat.isSymbolicLink() ||
        existingStat.size <= 0 ||
        existingStat.size > MAX_EVIDENCE_BYTES
      )
        throw new V4Error('WORKSPACE_EVIDENCE_INVALID');
      const existingBytes = fs.readFileSync(descriptor.evidenceHostPath);
      let existingValid = false;
      let existingCanonical = '';
      try {
        const existingRaw = JSON.parse(existingBytes.toString('utf8')) as unknown;
        const existing =
          phase === 'IMPLEMENTATION'
            ? decodeImplementationEvidence(existingRaw)
            : decodeReviewEvidence(existingRaw);
        if (phase === 'IMPLEMENTATION')
          assertImplementationEvidenceGate(
            existing as ImplementationCompletionEvidence,
            descriptor,
            expectedRevision,
          );
        else
          assertReviewEvidenceGate(
            existing as ReviewCompletionEvidence,
            descriptor,
            expectedRevision,
          );
        existingCanonical = JSON.stringify(existing);
        existingValid = true;
      } catch {
        existingValid = false;
      }
      if (existingValid) {
        if (existingCanonical !== JSON.stringify(evidence))
          throw new V4Error('WORKSPACE_EVIDENCE_AMBIGUOUS');
        fs.unlinkSync(staged);
        return {};
      }
      replacedInvalidEvidenceHash = createHash('sha256').update(existingBytes).digest('hex');
    }

    const temporary = descriptor.evidenceHostPath + '.staging-' + randomUUID();
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(evidence) + '\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (existingStat) fs.renameSync(temporary, descriptor.evidenceHostPath);
      else {
        fs.linkSync(temporary, descriptor.evidenceHostPath);
        fs.unlinkSync(temporary);
      }
      fs.unlinkSync(staged);
      return replacedInvalidEvidenceHash ? { replacedInvalidEvidenceHash } : {};
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
      if (error instanceof V4Error) throw error;
      throw new V4Error('WORKSPACE_EVIDENCE_PROMOTION_FAILED');
    }
  }

  private async pruneEphemeralEvidenceHelpers(
    descriptor: WorkspaceDescriptor,
    expectedRevision: string,
  ): Promise<string[]> {
    const evidenceStat = fs.lstatSync(descriptor.evidenceHostPath, { throwIfNoEntry: false });
    if (!evidenceStat?.isFile() || evidenceStat.isSymbolicLink()) return [];
    try {
      const evidence = decodeImplementationEvidence(this.readEvidence(descriptor.evidenceHostPath));
      assertImplementationEvidenceGate(evidence, descriptor, expectedRevision);
    } catch {
      return [];
    }
    const pruned: string[] = [];
    for (const name of EPHEMERAL_EVIDENCE_HELPERS) {
      const candidate = path.join(descriptor.hostPath, name);
      const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (!stat) continue;
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_EPHEMERAL_EVIDENCE_HELPER_BYTES ||
        stat.uid !== this.workspaceUid
      )
        continue;
      const untracked = (
        await this.git(descriptor.hostPath, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '--',
          name,
        ])
      )
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean);
      if (untracked.length !== 1 || untracked[0] !== name) continue;
      fs.unlinkSync(candidate);
      pruned.push(name);
    }
    return pruned;
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
      const raw = fs.readFileSync(file, 'utf8');
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch (strictError) {
        const trimmed = raw.trimEnd();
        const normalized = trimmed.replace(/(?:\\n)+$/, '');
        if (normalized === trimmed) throw strictError;
        value = JSON.parse(normalized) as unknown;
      }
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
    return await this.runGit(
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'safe.directory=' + cwd,
        '-C',
        cwd,
        ...args,
      ],
      identity,
    );
  }

  private async gitOptional(
    cwd: string,
    args: string[],
    identity?: { uid: number; gid: number },
  ): Promise<string | undefined> {
    try {
      return identity ? await this.git(cwd, args, identity) : await this.git(cwd, args);
    } catch {
      return undefined;
    }
  }

  private async gitSucceeds(
    cwd: string,
    args: string[],
    identity?: { uid: number; gid: number },
  ): Promise<boolean> {
    try {
      if (identity) await this.git(cwd, args, identity);
      else await this.git(cwd, args);
      return true;
    } catch {
      return false;
    }
  }

  private async sourceRepositoryIdentity(repositoryRoot: string): Promise<string | undefined> {
    const identity = this.repositoryIdentity(repositoryRoot);
    const remote = await this.gitOptional(
      repositoryRoot,
      ['remote', 'get-url', 'origin'],
      identity,
    );
    return remote ? repositoryNameFromRemote(remote) : undefined;
  }

  private repositoryIdentity(repositoryRoot: string): { uid: number; gid: number } {
    const stat = fs.statSync(repositoryRoot);
    return { uid: stat.uid, gid: stat.gid };
  }

  private cacheDirectories(repositoryRoot: string): string[] {
    const names = new Set([
      'node_modules',
      '.venv',
      '.cache',
      '.pytest_cache',
      '.mypy_cache',
      '.ruff_cache',
      '.turbo',
    ]);
    const found: string[] = [];
    const walk = (directory: string, depth: number): void => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (entry.name === '.git') continue;
        const child = path.join(directory, entry.name);
        if (names.has(entry.name)) {
          found.push(child);
          continue;
        }
        walk(child, depth + 1);
      }
    };
    walk(repositoryRoot, 0);
    return found;
  }

  private preflightCapacity(targetPath: string): void {
    let available: number;
    try {
      available = this.freeBytes(targetPath);
    } catch (error) {
      if (this.isStorageExhaustion(error))
        throw new V4Error(
          'WORKSPACE_STORAGE_EXHAUSTED',
          'Unable to inspect storage because the filesystem is exhausted.',
          error,
        );
      throw new V4Error(
        'WORKSPACE_CAPACITY_PROBE_FAILED',
        'Unable to inspect workspace filesystem capacity.',
        error,
      );
    }
    if (!Number.isFinite(available) || available < 0)
      throw new V4Error('WORKSPACE_CAPACITY_PROBE_FAILED');
    if (available < this.minimumFreeBytes)
      throw new V4Error(
        'WORKSPACE_CAPACITY_LOW',
        'Workspace filesystem free space is below the configured safety threshold.',
      );
  }

  private isStorageExhaustion(error: unknown): boolean {
    if (error === null || typeof error !== 'object') return false;
    const value = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr =
      typeof value.stderr === 'string'
        ? value.stderr
        : Buffer.isBuffer(value.stderr)
          ? value.stderr.toString('utf8')
          : '';
    return (
      value.code === 'ENOSPC' ||
      value.code === 'EDQUOT' ||
      /no space left on device|disk quota exceeded/i.test(stderr + ' ' + (value.message ?? ''))
    );
  }

  private async runGit(args: string[], identity?: { uid: number; gid: number }): Promise<string> {
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
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      return result.stdout.trim();
    } catch (error) {
      if (error instanceof V4Error) throw error;
      if (this.isStorageExhaustion(error))
        throw new V4Error(
          'WORKSPACE_STORAGE_EXHAUSTED',
          'Git operation ran out of storage.',
          error,
        );
      throw new V4Error('WORKSPACE_GIT_COMMAND_FAILED');
    }
  }
}
