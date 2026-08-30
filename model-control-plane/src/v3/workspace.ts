import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  WORKSPACE_GIT_LARGE_BUFFER_BYTES,
  WORKSPACE_GIT_TIMEOUT_MS,
  WORKSPACE_LONG_COMMAND_TIMEOUT_MS,
  WORKSPACE_PERMISSION_TIMEOUT_MS,
} from './planConstants.js';
import {
  git,
  gitNullList,
  inside,
  safeDirectory,
  writerBaselineRef,
  type UnixIdentity,
} from './gitSupport.js';
import {
  RepositoryProgressDiscovery,
  type ExternalProgressCandidate,
} from './repositoryProgress.js';
import type { WorkspaceMode } from './types.js';

const execFileAsync = promisify(execFile);

export interface ProvisionedWorkspace {
  hostPath: string;
  executionPath: string;
  branch?: string;
  sourceRevision: string;
}

export interface WriterCompletionEvidence {
  startRevision: string;
  headRevision: string;
}

export interface ExternalHandoffVerification {
  baseRevision: string;
  headRevision: string;
  ref?: string;
  aheadBy: number;
}

export type { ExternalProgressCandidate } from './repositoryProgress.js';

export interface WorkspaceProvisioningPort {
  hostPathForExecution(executionId: string): string;
  hostPathForWorkspaceRef(workspaceRef: string): string;
  prepareWriterExecution(input: {
    executionId: string;
    workspaceRef: string;
  }): Promise<{ startRevision: string }>;
  verifyWriterCompletion(input: {
    executionId: string;
    workspaceRef: string;
  }): Promise<WriterCompletionEvidence>;
  discoverExternalProgress?(input: {
    repositoryPath: string;
    currentRevision: string;
    workItemKeys: string[];
  }): Promise<ExternalProgressCandidate | null>;
  verifyExternalHandoff?(input: {
    repositoryPath: string;
    baseRevision: string;
    headRevision: string;
    ref?: string;
  }): Promise<ExternalHandoffVerification>;
  provision(input: {
    executionId: string;
    repositoryPath: string;
    baseRevision?: string;
    workspaceMode: WorkspaceMode;
    reviewBaseRevision?: string;
  }): Promise<ProvisionedWorkspace>;
  pruneExecutionArtifacts?(input: { executionId: string; workspaceRef: string }): Promise<boolean>;
  removeExecutionWorkspace?(executionId: string): Promise<boolean>;
  integrateBatch(input: {
    planId: string;
    batchKey: string;
    repositoryPath: string;
    baseRevision: string;
    implementations: Array<{ workspaceRef: string; sourceRevision: string }>;
    requiredAncestorRevisions?: string[];
  }): Promise<{ revision: string; ref: string }>;
}

function overlayWorkingTree(sourceRepo: string, snapshotRepo: string, entries: string[]): void {
  for (const entry of entries) {
    const source = path.resolve(sourceRepo, entry);
    const destination = path.resolve(snapshotRepo, entry);
    if (!inside(source, sourceRepo) || !inside(destination, snapshotRepo)) {
      throw new Error('V3_REPOSITORY_ENTRY_INVALID');
    }

    const sourceStat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!sourceStat) {
      // A path tracked at HEAD but deleted in the implementation working tree must
      // stay deleted in the review snapshot.
      fs.rmSync(destination, { recursive: true, force: true });
      continue;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, {
      recursive: sourceStat.isDirectory(),
      preserveTimestamps: true,
      dereference: false,
    });
  }
}

async function prepareSharedObjectAccess(
  repoRoot: string,
  sourceOwner: UnixIdentity,
  executionOwner: UnixIdentity,
): Promise<void> {
  const commonGitDirValue = await git(repoRoot, ['rev-parse', '--git-common-dir'], sourceOwner);
  const commonGitDir = path.resolve(repoRoot, commonGitDirValue);
  const objectDirectory = path.join(commonGitDir, 'objects');
  if (!inside(objectDirectory, commonGitDir) || !fs.statSync(objectDirectory).isDirectory()) {
    throw new Error('V3_REPOSITORY_OBJECT_DIRECTORY_INVALID');
  }

  // A local clone hardlinks pre-existing object files. Keep those files source-owned so a
  // worker can never gain ownership of the canonical inode, but grant the execution GID
  // read access. Setgid directories make newly-created canonical objects inherit the same
  // read-sharing group without making the object files group-writable.
  await execFileAsync('chgrp', ['-R', String(executionOwner.gid), objectDirectory], {
    timeout: WORKSPACE_LONG_COMMAND_TIMEOUT_MS,
  });
  await execFileAsync(
    'find',
    [objectDirectory, '-type', 'd', '-exec', 'chmod', 'u+rwx,g+rx,g-w,o-rwx,g+s', '{}', '+'],
    { timeout: WORKSPACE_PERMISSION_TIMEOUT_MS },
  );
  await execFileAsync(
    'find',
    [objectDirectory, '-type', 'f', '-exec', 'chmod', 'u+r,g+r,g-w,o-rwx', '{}', '+'],
    { timeout: WORKSPACE_PERMISSION_TIMEOUT_MS },
  );
}

async function chownExecutionRepository(target: string, owner: UnixIdentity): Promise<void> {
  const objectDirectory = path.join(target, '.git', 'objects');
  // The checked-out tree is untrusted input. Do not pass symlinks to chown: GNU chown
  // dereferences them by default and could re-own an arbitrary host target. Directory entry
  // ownership is sufficient for the worker to replace/remove a symlink.
  await execFileAsync(
    'find',
    [
      target,
      '-path',
      objectDirectory,
      '-prune',
      '-o',
      '(',
      '-type',
      'd',
      '-o',
      '-type',
      'f',
      ')',
      '-exec',
      'chown',
      `${owner.uid}:${owner.gid}`,
      '{}',
      '+',
    ],
    { timeout: WORKSPACE_PERMISSION_TIMEOUT_MS },
  );
  if (!fs.existsSync(objectDirectory)) return;
  // Object directories in the clone are private directory entries and may be re-owned.
  // Object files may be hardlinks to canonical files and therefore must never be chowned.
  await execFileAsync(
    'find',
    [objectDirectory, '-type', 'd', '-exec', 'chown', `${owner.uid}:${owner.gid}`, '{}', '+'],
    { timeout: WORKSPACE_PERMISSION_TIMEOUT_MS },
  );
}

async function chmodExecutionRepository(target: string, writable: boolean): Promise<void> {
  const objectDirectory = path.join(target, '.git', 'objects');
  // Never chmod a repository symlink: following it would mutate permissions outside the
  // execution workspace. Only regular files/directories receive phase permissions.
  await execFileAsync(
    'find',
    [
      target,
      '-path',
      objectDirectory,
      '-prune',
      '-o',
      '(',
      '-type',
      'd',
      '-o',
      '-type',
      'f',
      ')',
      '-exec',
      'chmod',
      writable ? 'u+rwX,go-rwx' : 'a-w',
      '{}',
      '+',
    ],
    { timeout: WORKSPACE_PERMISSION_TIMEOUT_MS },
  );
  if (!fs.existsSync(objectDirectory)) return;
  // Shared object files keep their source-side mode. Only clone-local object directories
  // need to become writable for writers or traversal-only for review snapshots.
  await execFileAsync(
    'find',
    [objectDirectory, '-type', 'd', '-exec', 'chmod', writable ? '0700' : '0500', '{}', '+'],
    { timeout: WORKSPACE_PERMISSION_TIMEOUT_MS },
  );
}

export class WorkspaceProvisioner implements WorkspaceProvisioningPort {
  readonly #hostRoot: string;
  readonly #executionRoot: string;
  readonly #allowedRepositoryRoots: string[];
  readonly #executionOwner?: UnixIdentity;
  readonly #repositoryProgress: RepositoryProgressDiscovery;

  constructor(options: {
    hostRoot: string;
    executionRoot?: string;
    allowedRepositoryRoots: string[];
    executionOwner?: UnixIdentity;
  }) {
    this.#hostRoot = path.resolve(options.hostRoot);
    this.#executionRoot = options.executionRoot ?? '/workspace';
    this.#allowedRepositoryRoots = options.allowedRepositoryRoots.map((item) => path.resolve(item));
    this.#executionOwner = options.executionOwner;
    this.#repositoryProgress = new RepositoryProgressDiscovery(this.#allowedRepositoryRoots);
  }

  hostPathForExecution(executionId: string): string {
    const directory = executionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.#hostRoot, 'executions', directory, 'repo');
  }

  hostPathForWorkspaceRef(workspaceRef: string): string {
    const executionRoot = path.posix.resolve(this.#executionRoot);
    const resolved = path.posix.resolve(workspaceRef);
    const relative = path.posix.relative(executionRoot, resolved);
    if (relative === '' || relative.startsWith('..') || path.posix.isAbsolute(relative)) {
      throw new Error('V3_WORKSPACE_REF_NOT_ALLOWED');
    }
    const hostPath = path.resolve(this.#hostRoot, ...relative.split('/'));
    if (!inside(hostPath, this.#hostRoot)) throw new Error('V3_WORKSPACE_REF_NOT_ALLOWED');
    return hostPath;
  }

  async discoverExternalProgress(input: {
    repositoryPath: string;
    currentRevision: string;
    workItemKeys: string[];
  }): Promise<ExternalProgressCandidate | null> {
    return this.#repositoryProgress.discover(input);
  }

  async verifyExternalHandoff(input: {
    repositoryPath: string;
    baseRevision: string;
    headRevision: string;
    ref?: string;
  }): Promise<ExternalHandoffVerification> {
    const requested = path.resolve(input.repositoryPath);
    if (!this.#allowedRepositoryRoots.some((root) => inside(requested, root))) {
      throw new Error('V3_REPOSITORY_PATH_NOT_ALLOWED');
    }
    const requestedStat = fs.statSync(requested, { throwIfNoEntry: false });
    if (!requestedStat?.isDirectory()) throw new Error('V3_REPOSITORY_NOT_FOUND');
    const requestedOwner = { uid: requestedStat.uid, gid: requestedStat.gid };
    const repoRoot = path.resolve(
      await git(requested, ['rev-parse', '--show-toplevel'], requestedOwner),
    );
    if (!this.#allowedRepositoryRoots.some((root) => inside(repoRoot, root))) {
      throw new Error('V3_REPOSITORY_ROOT_NOT_ALLOWED');
    }
    const repoStat = fs.statSync(repoRoot);
    const sourceOwner = { uid: repoStat.uid, gid: repoStat.gid };
    const baseRevision = await git(
      repoRoot,
      ['rev-parse', '--verify', `${input.baseRevision}^{commit}`],
      sourceOwner,
    );
    const headRevision = await git(
      repoRoot,
      ['rev-parse', '--verify', `${input.headRevision}^{commit}`],
      sourceOwner,
    );
    if (baseRevision.toLowerCase() !== input.baseRevision.toLowerCase()) {
      throw new Error('HANDOFF_BASE_REVISION_MISMATCH');
    }
    if (headRevision.toLowerCase() !== input.headRevision.toLowerCase()) {
      throw new Error('HANDOFF_HEAD_REVISION_MISMATCH');
    }
    try {
      await git(repoRoot, ['merge-base', '--is-ancestor', baseRevision, headRevision], sourceOwner);
    } catch {
      throw new Error('HANDOFF_HEAD_NOT_DESCENDANT');
    }
    let ref: string | undefined;
    if (input.ref?.trim()) {
      ref = input.ref.trim();
      const refRevision = await git(
        repoRoot,
        ['rev-parse', '--verify', `${ref}^{commit}`],
        sourceOwner,
      );
      if (refRevision !== headRevision) throw new Error('HANDOFF_REF_REVISION_MISMATCH');
    }
    const aheadBy = Number(
      await git(repoRoot, ['rev-list', '--count', `${baseRevision}..${headRevision}`], sourceOwner),
    );
    if (!Number.isFinite(aheadBy) || aheadBy <= 0) throw new Error('HANDOFF_EMPTY');
    return { baseRevision, headRevision, ...(ref ? { ref } : {}), aheadBy };
  }

  async prepareWriterExecution(input: {
    executionId: string;
    workspaceRef: string;
  }): Promise<{ startRevision: string }> {
    const hostPath = this.hostPathForWorkspaceRef(input.workspaceRef);
    const trusted = safeDirectory(hostPath);
    const ref = writerBaselineRef(input.executionId);
    try {
      const existing = await git(
        hostPath,
        [...trusted, 'rev-parse', '--verify', ref],
        this.#executionOwner,
      );
      return { startRevision: existing };
    } catch {
      const head = await git(hostPath, [...trusted, 'rev-parse', 'HEAD'], this.#executionOwner);
      await git(hostPath, [...trusted, 'update-ref', ref, head], this.#executionOwner);
      return { startRevision: head };
    }
  }

  async verifyWriterCompletion(input: {
    executionId: string;
    workspaceRef: string;
  }): Promise<WriterCompletionEvidence> {
    const hostPath = this.hostPathForWorkspaceRef(input.workspaceRef);
    const trusted = safeDirectory(hostPath);
    const ref = writerBaselineRef(input.executionId);
    let startRevision: string;
    try {
      startRevision = await git(
        hostPath,
        [...trusted, 'rev-parse', '--verify', ref],
        this.#executionOwner,
      );
    } catch {
      throw new Error('WRITER_COMPLETION_BASELINE_MISSING');
    }
    const headRevision = await git(
      hostPath,
      [...trusted, 'rev-parse', 'HEAD'],
      this.#executionOwner,
    );
    const dirty = await git(hostPath, [...trusted, 'status', '--porcelain'], this.#executionOwner);
    if (dirty) throw new Error('WRITER_COMPLETION_DIRTY');
    if (headRevision === startRevision) throw new Error('WRITER_COMPLETION_NO_COMMIT');
    return { startRevision, headRevision };
  }

  async provision(input: {
    executionId: string;
    repositoryPath: string;
    baseRevision?: string;
    workspaceMode: WorkspaceMode;
    reviewBaseRevision?: string;
  }): Promise<ProvisionedWorkspace> {
    const requested = path.resolve(input.repositoryPath);
    if (!this.#allowedRepositoryRoots.some((root) => inside(requested, root))) {
      throw new Error('V3_REPOSITORY_PATH_NOT_ALLOWED');
    }
    const requestedStat = fs.statSync(requested, { throwIfNoEntry: false });
    if (!requestedStat?.isDirectory()) throw new Error('V3_REPOSITORY_NOT_FOUND');

    // Git's dubious-ownership protection is intentional. Source inspection therefore runs
    // as the source directory owner instead of weakening Git's global safe.directory policy.
    const requestedOwner = { uid: requestedStat.uid, gid: requestedStat.gid };
    const repoRoot = path.resolve(
      await git(requested, ['rev-parse', '--show-toplevel'], requestedOwner),
    );
    if (!this.#allowedRepositoryRoots.some((root) => inside(repoRoot, root))) {
      throw new Error('V3_REPOSITORY_ROOT_NOT_ALLOWED');
    }
    const repoStat = fs.statSync(repoRoot);
    const sourceOwner = { uid: repoStat.uid, gid: repoStat.gid };
    const revision = input.baseRevision?.trim() || 'HEAD';
    const resolvedRevision = await git(repoRoot, ['rev-parse', '--verify', revision], sourceOwner);

    const directory = input.executionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const executionsRoot = path.join(this.#hostRoot, 'executions');
    fs.mkdirSync(executionsRoot, { recursive: true, mode: 0o750 });
    if (this.#executionOwner) {
      fs.chownSync(executionsRoot, this.#executionOwner.uid, this.#executionOwner.gid);
      fs.chmodSync(executionsRoot, 0o750);
    }

    const hostPath = this.hostPathForExecution(input.executionId);
    const executionPath = path.posix.join(this.#executionRoot, 'executions', directory, 'repo');
    if (fs.existsSync(hostPath)) {
      return { hostPath, executionPath, sourceRevision: resolvedRevision };
    }
    fs.mkdirSync(path.dirname(hostPath), { recursive: true, mode: 0o750 });

    // Local execution clones keep private refs/index/new objects but physically share
    // pre-existing canonical objects through hardlinks. This preserves the worker trust
    // boundary without multiplying immutable Git history per execution.
    if (this.#executionOwner) {
      await prepareSharedObjectAccess(repoRoot, sourceOwner, this.#executionOwner);
    }

    let branch: string | undefined;
    try {
      await execFileAsync(
        'git',
        [
          '-c',
          `safe.directory=${repoRoot}`,
          'clone',
          '--local',
          '--no-checkout',
          repoRoot,
          hostPath,
        ],
        {
          encoding: 'utf8',
          timeout: WORKSPACE_LONG_COMMAND_TIMEOUT_MS,
          maxBuffer: WORKSPACE_GIT_LARGE_BUFFER_BYTES,
        },
      );

      if (
        input.workspaceMode === 'isolated_write' ||
        input.workspaceMode === 'reuse_implementation_workspace'
      ) {
        branch = `ai-office/${directory}`;
        await git(hostPath, [
          ...safeDirectory(hostPath),
          'checkout',
          '-B',
          branch,
          resolvedRevision,
        ]);
      } else {
        await git(hostPath, [...safeDirectory(hostPath), 'checkout', '--detach', resolvedRevision]);
      }

      if (input.workspaceMode === 'review_snapshot' && input.reviewBaseRevision?.trim()) {
        const resolvedReviewBase = await git(hostPath, [
          ...safeDirectory(hostPath),
          'rev-parse',
          '--verify',
          input.reviewBaseRevision.trim(),
        ]);
        await git(hostPath, [
          ...safeDirectory(hostPath),
          'update-ref',
          'refs/ai-office/review-base',
          resolvedReviewBase,
        ]);
      }

      if (input.workspaceMode === 'review_snapshot') {
        // Review must inspect the implementation artifact, not merely its last committed HEAD.
        // Freeze exactly the Git-visible working tree: tracked files plus non-ignored untracked
        // files, including tracked deletions. Ignored build/cache material (node_modules, dist,
        // etc.) is intentionally excluded.
        const workingTreeEntries = await gitNullList(
          repoRoot,
          ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
          sourceOwner,
        );
        overlayWorkingTree(repoRoot, hostPath, workingTreeEntries);
      }
    } catch (error) {
      fs.rmSync(path.dirname(hostPath), { recursive: true, force: true });
      throw error;
    }

    if (this.#executionOwner) {
      // The execution directory and private repository metadata belong to OpenHands. Existing
      // object files may be hardlinked to canonical storage and deliberately remain source-owned.
      fs.chownSync(path.dirname(hostPath), this.#executionOwner.uid, this.#executionOwner.gid);
      fs.chmodSync(path.dirname(hostPath), 0o750);
      await chownExecutionRepository(hostPath, this.#executionOwner);
    }

    if (
      input.workspaceMode === 'isolated_write' ||
      input.workspaceMode === 'reuse_implementation_workspace'
    ) {
      await chmodExecutionRepository(hostPath, true);
      return { hostPath, executionPath, branch, sourceRevision: resolvedRevision };
    }

    // Read/review phases get a physically read-only private clone. Shared source objects remain
    // source-owned and read-only to the execution identity.
    await chmodExecutionRepository(hostPath, false);
    return { hostPath, executionPath, sourceRevision: resolvedRevision };
  }

  async pruneExecutionArtifacts(input: {
    executionId: string;
    workspaceRef: string;
  }): Promise<boolean> {
    const hostPath = this.hostPathForWorkspaceRef(input.workspaceRef);
    if (!fs.existsSync(hostPath)) return false;
    const gitDirectory = path.join(hostPath, '.git');
    if (!fs.existsSync(gitDirectory)) return false;
    await execFileAsync(
      'git',
      ['-c', `safe.directory=${hostPath}`, '-C', hostPath, 'clean', '-ffdX'],
      {
        encoding: 'utf8',
        timeout: WORKSPACE_LONG_COMMAND_TIMEOUT_MS,
        maxBuffer: WORKSPACE_GIT_LARGE_BUFFER_BYTES,
      },
    );
    // Agent Harness state is execution-scoped, not repository recovery state. A terminal
    // execution may keep its repo for repair/review continuity without pinning tool caches,
    // model homes, and MCP materializations beside it.
    const harnessPath = path.join(path.dirname(hostPath), '.agent-harness');
    if (fs.existsSync(harnessPath)) fs.rmSync(harnessPath, { recursive: true, force: true });
    return true;
  }

  async removeExecutionWorkspace(executionId: string): Promise<boolean> {
    const hostPath = this.hostPathForExecution(executionId);
    const executionDirectory = path.dirname(hostPath);
    const executionsRoot = path.join(this.#hostRoot, 'executions');
    if (!inside(executionDirectory, executionsRoot)) {
      throw new Error('V3_EXECUTION_WORKSPACE_NOT_ALLOWED');
    }
    if (!fs.existsSync(executionDirectory)) return false;
    fs.rmSync(executionDirectory, { recursive: true, force: true });
    return true;
  }

  async integrateBatch(input: {
    planId: string;
    batchKey: string;
    repositoryPath: string;
    baseRevision: string;
    implementations: Array<{ workspaceRef: string; sourceRevision: string }>;
    requiredAncestorRevisions?: string[];
  }): Promise<{ revision: string; ref: string }> {
    const requested = path.resolve(input.repositoryPath);
    if (!this.#allowedRepositoryRoots.some((root) => inside(requested, root))) {
      throw new Error('V3_REPOSITORY_PATH_NOT_ALLOWED');
    }
    const requestedStat = fs.statSync(requested, { throwIfNoEntry: false });
    if (!requestedStat?.isDirectory()) throw new Error('V3_REPOSITORY_NOT_FOUND');
    const requestedOwner = { uid: requestedStat.uid, gid: requestedStat.gid };
    const repoRoot = path.resolve(
      await git(requested, ['rev-parse', '--show-toplevel'], requestedOwner),
    );
    const repoStat = fs.statSync(repoRoot);
    const sourceOwner = { uid: repoStat.uid, gid: repoStat.gid };
    const integrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ai-office-integrate-'));
    fs.chownSync(integrationRoot, sourceOwner.uid, sourceOwner.gid);
    const integrationRepo = path.join(integrationRoot, 'repo');
    const safePlan = input.planId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeBatch = input.batchKey.replace(/[^a-zA-Z0-9._-]/g, '_');
    const integrationRef = `refs/ai-office/plans/${safePlan}/batches/${safeBatch}`;
    let worktreeAdded = false;
    try {
      // Integration is control-plane-owned, so a real detached worktree is the smallest and
      // safest representation: it shares canonical objects/refs without exposing that common
      // Git directory to a model process.
      await git(
        repoRoot,
        ['worktree', 'add', '--detach', integrationRepo, input.baseRevision],
        sourceOwner,
      );
      worktreeAdded = true;

      for (const [index, implementation] of input.implementations.entries()) {
        const implementationPath = this.hostPathForWorkspaceRef(implementation.workspaceRef);
        const trustedImplementation = safeDirectory(implementationPath);
        const dirty = await git(implementationPath, [
          ...trustedImplementation,
          'status',
          '--porcelain',
        ]);
        if (dirty) throw new Error('BATCH_INTEGRATION_UNCOMMITTED_CHANGES');
        const head = await git(implementationPath, [...trustedImplementation, 'rev-parse', 'HEAD']);
        if (head === implementation.sourceRevision) {
          throw new Error('BATCH_INTEGRATION_EMPTY_IMPLEMENTATION');
        }
        for (const requiredRevision of input.requiredAncestorRevisions ?? []) {
          try {
            await git(implementationPath, [
              ...trustedImplementation,
              'merge-base',
              '--is-ancestor',
              requiredRevision,
              head,
            ]);
          } catch {
            throw new Error(`BATCH_INTEGRATION_REPAIR_INCOMPLETE:${requiredRevision}`);
          }
        }

        // The implementation workspace is private to the execution identity, so the source
        // owner cannot traverse it directly. Export only objects newer than the recorded source
        // revision, then let the source owner fetch that small exact bundle into the host worktree.
        const implementationBundle = path.join(integrationRoot, `implementation-${index}.bundle`);
        await git(implementationPath, [
          ...trustedImplementation,
          'bundle',
          'create',
          implementationBundle,
          'HEAD',
          `^${implementation.sourceRevision}`,
        ]);
        fs.chownSync(implementationBundle, sourceOwner.uid, sourceOwner.gid);
        await git(
          integrationRepo,
          ['fetch', '--no-tags', implementationBundle, 'HEAD'],
          sourceOwner,
        );
        try {
          await git(
            integrationRepo,
            [
              '-c',
              'user.name=Hermes AI Office',
              '-c',
              'user.email=ai-office@localhost',
              'merge',
              '--no-ff',
              '--no-edit',
              'FETCH_HEAD',
            ],
            sourceOwner,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/CONFLICT|Automatic merge failed/i.test(message)) {
            throw new Error(`BATCH_INTEGRATION_CONFLICT:${message}`);
          }
          throw error;
        }
      }
      const revision = await git(integrationRepo, ['rev-parse', 'HEAD'], sourceOwner);
      await git(repoRoot, ['update-ref', integrationRef, revision], sourceOwner);
      return { revision, ref: integrationRef };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('BATCH_INTEGRATION_')) throw error;
      throw new Error(`BATCH_INTEGRATION_FAILED:${message}`);
    } finally {
      if (worktreeAdded) {
        try {
          await git(repoRoot, ['worktree', 'remove', '--force', integrationRepo], sourceOwner);
        } catch {
          // Best-effort physical cleanup continues below; worktree prune repairs stale metadata.
        }
        try {
          await git(repoRoot, ['worktree', 'prune'], sourceOwner);
        } catch {
          // Cleanup failure must not hide the original integration result/error.
        }
      }
      fs.rmSync(integrationRoot, { recursive: true, force: true });
    }
  }
}
