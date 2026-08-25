import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  PLAN_LIMITS,
  WORKSPACE_GIT_LARGE_BUFFER_BYTES,
  WORKSPACE_GIT_MAX_BUFFER_BYTES,
  WORKSPACE_GIT_TIMEOUT_MS,
  WORKSPACE_LONG_COMMAND_TIMEOUT_MS,
  WORKSPACE_PERMISSION_TIMEOUT_MS,
} from './planConstants.js';
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
  provision(input: {
    executionId: string;
    repositoryPath: string;
    baseRevision?: string;
    workspaceMode: WorkspaceMode;
    reviewBaseRevision?: string;
  }): Promise<ProvisionedWorkspace>;
  integrateBatch(input: {
    planId: string;
    batchKey: string;
    repositoryPath: string;
    baseRevision: string;
    implementations: Array<{ workspaceRef: string; sourceRevision: string }>;
  }): Promise<{ revision: string; ref: string }>;
}

interface UnixIdentity {
  uid: number;
  gid: number;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function writerBaselineRef(executionId: string): string {
  const safe = executionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `refs/ai-office/writers/${safe}/start`;
}

function safeDirectory(directory: string): string[] {
  return [
    '-c',
    `safe.directory=${directory}`,
    '-c',
    `safe.directory=${path.join(directory, '.git')}`,
  ];
}

async function git(cwd: string, args: string[], identity?: UnixIdentity): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
      encoding: 'utf8',
      timeout: WORKSPACE_GIT_TIMEOUT_MS,
      maxBuffer: WORKSPACE_GIT_MAX_BUFFER_BYTES,
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    const detail = failure.stderr?.trim() || failure.message;
    throw new Error(`GIT_COMMAND_FAILED:${detail.slice(0, PLAN_LIMITS.errorDetailCharacters)}`);
  }
}

async function gitNullList(
  cwd: string,
  args: string[],
  identity?: UnixIdentity,
): Promise<string[]> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
    encoding: 'utf8',
    timeout: WORKSPACE_GIT_TIMEOUT_MS,
    maxBuffer: WORKSPACE_GIT_LARGE_BUFFER_BYTES,
  });
  return result.stdout.split('\0').filter(Boolean);
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

async function chownTree(target: string, owner: UnixIdentity): Promise<void> {
  await execFileAsync('chown', ['-R', `${owner.uid}:${owner.gid}`, target], {
    timeout: WORKSPACE_GIT_TIMEOUT_MS,
  });
}

export class WorkspaceProvisioner implements WorkspaceProvisioningPort {
  readonly #hostRoot: string;
  readonly #executionRoot: string;
  readonly #allowedRepositoryRoots: string[];
  readonly #executionOwner?: UnixIdentity;

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

  async prepareWriterExecution(input: {
    executionId: string;
    workspaceRef: string;
  }): Promise<{ startRevision: string }> {
    const hostPath = this.hostPathForWorkspaceRef(input.workspaceRef);
    const trusted = safeDirectory(hostPath);
    const ref = writerBaselineRef(input.executionId);
    try {
      const existing = await git(hostPath, [...trusted, 'rev-parse', '--verify', ref]);
      return { startRevision: existing };
    } catch {
      const head = await git(hostPath, [...trusted, 'rev-parse', 'HEAD']);
      await git(hostPath, [...trusted, 'update-ref', ref, head]);
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
      startRevision = await git(hostPath, [...trusted, 'rev-parse', '--verify', ref]);
    } catch {
      throw new Error('WRITER_COMPLETION_BASELINE_MISSING');
    }
    const headRevision = await git(hostPath, [...trusted, 'rev-parse', 'HEAD']);
    const dirty = await git(hostPath, [...trusted, 'status', '--porcelain']);
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

    // Clone into the service-private staging area as the repository owner. This keeps the
    // source-side Git trust boundary intact even when the control-plane service itself is root.
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ai-office-v3-'));
    const stagingRepo = path.join(stagingRoot, 'repo');
    fs.chownSync(stagingRoot, sourceOwner.uid, sourceOwner.gid);
    let branch: string | undefined;
    try {
      await execFileAsync('git', ['clone', '--local', '--no-hardlinks', repoRoot, stagingRepo], {
        uid: sourceOwner.uid,
        gid: sourceOwner.gid,
        encoding: 'utf8',
        timeout: WORKSPACE_LONG_COMMAND_TIMEOUT_MS,
        maxBuffer: WORKSPACE_GIT_LARGE_BUFFER_BYTES,
      });

      if (
        input.workspaceMode === 'isolated_write' ||
        input.workspaceMode === 'reuse_implementation_workspace'
      ) {
        branch = `ai-office/${directory}`;
        await git(stagingRepo, ['checkout', '-B', branch, resolvedRevision], sourceOwner);
      } else {
        await git(stagingRepo, ['checkout', '--detach', resolvedRevision], sourceOwner);
      }

      if (input.workspaceMode === 'review_snapshot' && input.reviewBaseRevision?.trim()) {
        const resolvedReviewBase = await git(
          stagingRepo,
          ['rev-parse', '--verify', input.reviewBaseRevision.trim()],
          sourceOwner,
        );
        await git(
          stagingRepo,
          ['update-ref', 'refs/ai-office/review-base', resolvedReviewBase],
          sourceOwner,
        );
      }

      if (input.workspaceMode === 'review_snapshot') {
        // Review must inspect the implementation artifact, not merely its last committed HEAD.
        // Freeze exactly the Git-visible working tree: tracked files plus non-ignored untracked
        // files, including tracked deletions. Ignored build/cache material (node_modules, dist,
        // etc.) is intentionally excluded. This preserves an uncommitted implementation while
        // keeping the reviewer on an independent, physically read-only clone.
        const workingTreeEntries = await gitNullList(
          repoRoot,
          ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
          sourceOwner,
        );
        overlayWorkingTree(repoRoot, stagingRepo, workingTreeEntries);
      }

      fs.cpSync(stagingRepo, hostPath, {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }

    if (this.#executionOwner) {
      // OpenHands must be able to traverse the per-execution directory as well as the repo itself.
      await chownTree(path.dirname(hostPath), this.#executionOwner);
    }

    if (
      input.workspaceMode === 'isolated_write' ||
      input.workspaceMode === 'reuse_implementation_workspace'
    ) {
      await execFileAsync('chmod', ['-R', 'u+rwX,go-rwx', hostPath], {
        timeout: WORKSPACE_PERMISSION_TIMEOUT_MS,
      });
      return { hostPath, executionPath, branch, sourceRevision: resolvedRevision };
    }

    // Read/review phases get a physically read-only clone. OpenHands owns the files but
    // cannot mutate them, so a prompt mistake cannot silently turn investigation into implementation.
    await execFileAsync('chmod', ['-R', 'a-w', hostPath], {
      timeout: WORKSPACE_PERMISSION_TIMEOUT_MS,
    });
    return { hostPath, executionPath, sourceRevision: resolvedRevision };
  }

  async integrateBatch(input: {
    planId: string;
    batchKey: string;
    repositoryPath: string;
    baseRevision: string;
    implementations: Array<{ workspaceRef: string; sourceRevision: string }>;
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
    try {
      const sourceBundle = path.join(integrationRoot, 'source.bundle');
      await git(repoRoot, ['bundle', 'create', sourceBundle, '--all'], sourceOwner);
      await execFileAsync('git', ['clone', '--no-hardlinks', sourceBundle, integrationRepo], {
        encoding: 'utf8',
        timeout: WORKSPACE_LONG_COMMAND_TIMEOUT_MS,
        maxBuffer: WORKSPACE_GIT_LARGE_BUFFER_BYTES,
      });
      await git(integrationRepo, ['checkout', '--detach', input.baseRevision]);
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
        const fetchedRef = `refs/ai-office/incoming/${index}`;
        const implementationBundle = path.join(integrationRoot, `implementation-${index}.bundle`);
        await git(implementationPath, [
          ...trustedImplementation,
          'bundle',
          'create',
          implementationBundle,
          'HEAD',
        ]);
        await git(integrationRepo, ['fetch', implementationBundle, `HEAD:${fetchedRef}`]);
        await git(integrationRepo, [
          '-c',
          'user.name=Hermes AI Office',
          '-c',
          'user.email=ai-office@localhost',
          'merge',
          '--no-ff',
          '--no-edit',
          fetchedRef,
        ]);
      }
      const revision = await git(integrationRepo, ['rev-parse', 'HEAD']);
      const integrationBundle = path.join(integrationRoot, 'integrated.bundle');
      await git(integrationRepo, ['bundle', 'create', integrationBundle, 'HEAD']);
      fs.chownSync(integrationBundle, sourceOwner.uid, sourceOwner.gid);
      await git(repoRoot, ['fetch', integrationBundle, `+HEAD:${integrationRef}`], sourceOwner);
      return { revision, ref: integrationRef };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('BATCH_INTEGRATION_')) throw error;
      throw new Error(`BATCH_INTEGRATION_FAILED:${message}`);
    } finally {
      fs.rmSync(integrationRoot, { recursive: true, force: true });
    }
  }
}
