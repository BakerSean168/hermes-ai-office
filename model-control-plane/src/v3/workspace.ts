import { execFile } from 'node:child_process';
import fs, { type Stats } from 'node:fs';
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

function executionDirectoryName(executionId: string): string {
  if (!executionId || !/^[A-Za-z0-9._-]+$/.test(executionId)) {
    throw new Error('V3_EXECUTION_ID_INVALID');
  }
  return executionId;
}

function integrationRefComponent(value: string): string {
  const ordinary = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(value);
  if (ordinary && !value.endsWith('.lock')) return value;
  return `%x${Buffer.from(value, 'utf8').toString('hex')}`;
}

function identityCanRead(stat: Stats, identity: UnixIdentity): boolean {
  if (stat.uid === identity.uid) return (stat.mode & 0o400) !== 0;
  if (stat.gid === identity.gid) return (stat.mode & 0o040) !== 0;
  return (stat.mode & 0o004) !== 0;
}

function identityCanWrite(stat: Stats, identity: UnixIdentity): boolean {
  if (stat.uid === identity.uid) return (stat.mode & 0o200) !== 0;
  if (stat.gid === identity.gid) return (stat.mode & 0o020) !== 0;
  return (stat.mode & 0o002) !== 0;
}

function assertManagedWorkspacePath(hostPath: string, hostRoot: string): void {
  const lexicalRoot = path.resolve(hostRoot);
  const lexicalPath = path.resolve(hostPath);
  if (!inside(lexicalPath, lexicalRoot)) throw new Error('V3_EXECUTION_WORKSPACE_NOT_ALLOWED');

  const relative = path.relative(lexicalRoot, lexicalPath);
  let cursor = lexicalRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) throw new Error('V3_EXECUTION_WORKSPACE_MISSING');
    if (stat.isSymbolicLink()) throw new Error('V3_EXECUTION_WORKSPACE_SYMLINK');
  }

  const realRoot = fs.realpathSync(lexicalRoot);
  const realPath = fs.realpathSync(lexicalPath);
  if (!inside(realPath, realRoot)) throw new Error('V3_EXECUTION_WORKSPACE_NOT_ALLOWED');
  if (!fs.statSync(realPath).isDirectory()) throw new Error('V3_EXECUTION_WORKSPACE_INVALID');
}

function realPathInsideAllowedRoots(candidate: string, allowedRoots: string[]): boolean {
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return false;
  }
  return allowedRoots.some((root) => {
    try {
      return inside(realCandidate, fs.realpathSync(root));
    } catch {
      return false;
    }
  });
}

function assertPrivateGitMetadataTree(gitDirectory: string): void {
  const realGitDirectory = fs.realpathSync(gitDirectory);
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error('V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID');
      }
      if (stat.isDirectory()) {
        const realDirectory = fs.realpathSync(entryPath);
        if (!inside(realDirectory, realGitDirectory)) {
          throw new Error('V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID');
        }
        visit(entryPath);
      } else if (!stat.isFile()) {
        throw new Error('V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID');
      }
    }
  };
  visit(gitDirectory);
  if (fs.existsSync(path.join(gitDirectory, 'objects', 'info', 'alternates'))) {
    throw new Error('V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID');
  }
}

async function assertManagedGitWorkspace(
  hostPath: string,
  hostRoot: string,
  owner?: UnixIdentity,
): Promise<void> {
  assertManagedWorkspacePath(hostPath, hostRoot);
  const realWorkspace = fs.realpathSync(hostPath);
  const gitDirectory = path.join(hostPath, '.git');
  const gitStat = fs.lstatSync(gitDirectory, { throwIfNoEntry: false });
  if (!gitStat?.isDirectory() || gitStat.isSymbolicLink()) {
    throw new Error('V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID');
  }
  const realGitDirectory = fs.realpathSync(gitDirectory);
  if (!inside(realGitDirectory, realWorkspace)) {
    throw new Error('V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID');
  }

  const topLevel = path.resolve(
    await git(hostPath, [...safeDirectory(hostPath), 'rev-parse', '--show-toplevel'], owner),
  );
  if (fs.realpathSync(topLevel) !== realWorkspace) {
    throw new Error('V3_EXECUTION_WORKSPACE_REPOSITORY_MISMATCH');
  }
  const commonGitDirValue = await git(
    hostPath,
    [...safeDirectory(hostPath), 'rev-parse', '--git-common-dir'],
    owner,
  );
  const commonGitDir = fs.realpathSync(path.resolve(hostPath, commonGitDirValue));
  if (!inside(commonGitDir, realWorkspace) || commonGitDir !== realGitDirectory) {
    throw new Error('V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID');
  }
  assertPrivateGitMetadataTree(gitDirectory);
  assertWorkspaceSymlinksContained(hostPath);
}

async function assertCanonicalGitMetadataContained(
  repoRoot: string,
  owner: UnixIdentity,
): Promise<void> {
  const realRepository = fs.realpathSync(repoRoot);
  const commonGitDirValue = await git(repoRoot, ['rev-parse', '--git-common-dir'], owner);
  const commonCandidate = path.resolve(repoRoot, commonGitDirValue);
  const commonStat = fs.lstatSync(commonCandidate, { throwIfNoEntry: false });
  if (!commonStat?.isDirectory() || commonStat.isSymbolicLink()) {
    throw new Error('V3_REPOSITORY_GIT_DIRECTORY_NOT_ALLOWED');
  }
  const realCommon = fs.realpathSync(commonCandidate);
  if (!inside(realCommon, realRepository)) {
    throw new Error('V3_REPOSITORY_GIT_DIRECTORY_NOT_ALLOWED');
  }
  const objectCandidate = path.join(realCommon, 'objects');
  const objectStat = fs.lstatSync(objectCandidate, { throwIfNoEntry: false });
  if (!objectStat?.isDirectory() || objectStat.isSymbolicLink()) {
    throw new Error('V3_REPOSITORY_GIT_DIRECTORY_NOT_ALLOWED');
  }
  const realObjects = fs.realpathSync(objectCandidate);
  if (!inside(realObjects, realCommon)) {
    throw new Error('V3_REPOSITORY_GIT_DIRECTORY_NOT_ALLOWED');
  }
  if (fs.existsSync(path.join(realObjects, 'info', 'alternates')) || !inspectObjectTree(realObjects)) {
    throw new Error('V3_REPOSITORY_GIT_DIRECTORY_NOT_ALLOWED');
  }
}

function assertWorkspaceSymlinksContained(workspaceRoot: string): void {
  const lexicalRoot = path.resolve(workspaceRoot);
  const realRoot = fs.realpathSync(lexicalRoot);

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === lexicalRoot && entry.name === '.git') continue;
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(entryPath);
        if (path.isAbsolute(target)) throw new Error('V3_WORKSPACE_SYMLINK_OUTSIDE_ROOT');
        const lexicalTarget = path.resolve(path.dirname(entryPath), target);
        if (!inside(lexicalTarget, lexicalRoot)) {
          throw new Error('V3_WORKSPACE_SYMLINK_OUTSIDE_ROOT');
        }
        try {
          const realTarget = fs.realpathSync(entryPath);
          if (!inside(realTarget, realRoot)) throw new Error('V3_WORKSPACE_SYMLINK_OUTSIDE_ROOT');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        continue;
      }
      if (stat.isDirectory()) visit(entryPath);
    }
  };

  visit(lexicalRoot);
}

interface ObjectTreeInspection {
  directories: Array<{ path: string; stat: Stats }>;
  files: Array<{ path: string; relative: string; stat: Stats }>;
}

function inspectObjectTree(objectDirectory: string): ObjectTreeInspection | null {
  const rootStat = fs.lstatSync(objectDirectory, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return null;
  const device = rootStat.dev;
  const directories: ObjectTreeInspection['directories'] = [];
  const files: ObjectTreeInspection['files'] = [];

  const visit = (directory: string): boolean => {
    const directoryStat = fs.lstatSync(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      directoryStat.dev !== device
    ) {
      return false;
    }
    directories.push({ path: directory, stat: directoryStat });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.dev !== device || stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!visit(entryPath)) return false;
      } else if (stat.isFile()) {
        files.push({ path: entryPath, relative: path.relative(objectDirectory, entryPath), stat });
      } else {
        return false;
      }
    }
    return true;
  };

  return visit(objectDirectory) ? { directories, files } : null;
}

interface ObjectClonePlan {
  hardlinkObjects: boolean;
  sourceObjectDirectory?: string;
  privatizeRelativeObjectPaths: string[];
}

async function prepareSharedObjectAccess(
  repoRoot: string,
  sourceOwner: UnixIdentity,
  executionOwner: UnixIdentity,
): Promise<ObjectClonePlan> {
  const commonGitDirValue = await git(repoRoot, ['rev-parse', '--git-common-dir'], sourceOwner);
  const repoBoundary = fs.realpathSync(repoRoot);
  const commonGitDirCandidate = path.resolve(repoRoot, commonGitDirValue);
  const commonGitDirStat = fs.lstatSync(commonGitDirCandidate, { throwIfNoEntry: false });
  if (!commonGitDirStat?.isDirectory() || commonGitDirStat.isSymbolicLink()) {
    return { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };
  }
  const commonGitDir = fs.realpathSync(commonGitDirCandidate);

  // A linked worktree or redirected .git file can place the common Git directory outside the
  // validated repository root. Never normalize permissions on that external repository.
  if (!inside(commonGitDir, repoBoundary)) {
    return { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };
  }

  const objectDirectoryCandidate = path.join(commonGitDir, 'objects');
  const objectDirectoryStat = fs.lstatSync(objectDirectoryCandidate, { throwIfNoEntry: false });
  if (!objectDirectoryStat?.isDirectory() || objectDirectoryStat.isSymbolicLink()) {
    return { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };
  }
  const objectDirectory = fs.realpathSync(objectDirectoryCandidate);
  if (!inside(objectDirectory, commonGitDir) || !inside(objectDirectory, repoBoundary)) {
    return { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };
  }

  // Alternate object databases widen the object trust boundary beyond this repository.
  if (fs.existsSync(path.join(objectDirectory, 'info', 'alternates'))) {
    return { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };
  }
  const objectTree = inspectObjectTree(objectDirectory);
  if (!objectTree) return { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };

  const executionOwnedRelativePaths = objectTree.files
    .filter(({ stat }) => stat.uid === executionOwner.uid)
    .map(({ relative }) => relative);

  if (sourceOwner.uid === executionOwner.uid) {
    // Review snapshots are commonly cloned from an implementation workspace owned by the same
    // execution identity. Keep only already-readable, non-writable foreign-owned object inodes
    // shared; privatize every owner-mutable or otherwise unsafe object in the child clone.
    const privatizeRelativeObjectPaths = objectTree.files
      .filter(
        ({ stat }) =>
          stat.uid === executionOwner.uid ||
          !identityCanRead(stat, executionOwner) ||
          identityCanWrite(stat, executionOwner),
      )
      .map(({ relative }) => relative);
    return {
      hardlinkObjects: true,
      sourceObjectDirectory: objectDirectory,
      privatizeRelativeObjectPaths,
    };
  }

  // A canonical repository unexpectedly containing execution-owned object files has already
  // crossed the ownership boundary. Use a physically private clone.
  if (executionOwnedRelativePaths.length > 0) {
    return { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };
  }

  // Normalize only unique object-file inodes. If an unreadable file is already hardlinked,
  // changing its metadata could affect an arbitrary external link, so fail closed to a private
  // clone instead. Already-readable hardlinks are safe only when the execution identity cannot
  // write them. Future restrictive-umask objects are normalized on the next provisioning pass.
  for (const file of objectTree.files) {
    if (identityCanWrite(file.stat, executionOwner)) {
      return { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };
    }
    if (identityCanRead(file.stat, executionOwner)) continue;
    if (file.stat.nlink !== 1) return { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };
    fs.chownSync(file.path, file.stat.uid, executionOwner.gid);
    fs.chmodSync(file.path, (file.stat.mode & 0o700) | 0o040);
  }
  for (const directory of objectTree.directories) {
    fs.chownSync(directory.path, directory.stat.uid, executionOwner.gid);
    fs.chmodSync(directory.path, 0o2750);
  }

  return {
    hardlinkObjects: true,
    sourceObjectDirectory: objectDirectory,
    privatizeRelativeObjectPaths: [],
  };
}

function privatizeExecutionOwnedObjectLinks(
  hostPath: string,
  plan: ObjectClonePlan,
  executionOwner: UnixIdentity,
): void {
  if (!plan.hardlinkObjects || !plan.sourceObjectDirectory) return;
  const cloneObjectDirectory = path.join(hostPath, '.git', 'objects');
  for (const relative of plan.privatizeRelativeObjectPaths) {
    const sourcePath = path.resolve(plan.sourceObjectDirectory, relative);
    const clonePath = path.resolve(cloneObjectDirectory, relative);
    if (
      !inside(sourcePath, plan.sourceObjectDirectory) ||
      !inside(clonePath, cloneObjectDirectory) ||
      !fs.existsSync(sourcePath) ||
      !fs.existsSync(clonePath)
    ) {
      continue;
    }
    const sourceStat = fs.lstatSync(sourcePath);
    const cloneStat = fs.lstatSync(clonePath);
    if (!sourceStat.isFile() || !cloneStat.isFile()) continue;

    if (sourceStat.dev === cloneStat.dev && sourceStat.ino === cloneStat.ino) {
      const temporary = `${clonePath}.pixel-private-${process.pid}-${Math.random().toString(16).slice(2)}`;
      fs.copyFileSync(clonePath, temporary, fs.constants.COPYFILE_EXCL);
      fs.chownSync(temporary, executionOwner.uid, executionOwner.gid);
      fs.chmodSync(temporary, cloneStat.mode & 0o777);
      fs.renameSync(temporary, clonePath);
    } else {
      fs.chownSync(clonePath, executionOwner.uid, executionOwner.gid);
    }
  }
}

async function chownExecutionRepository(
  target: string,
  owner: UnixIdentity,
  sharedObjects: boolean,
): Promise<void> {
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
  if (!sharedObjects) {
    // Fallback clones use physically private object files, so ownership can safely move to
    // the execution identity. Shared hardlinked object files must remain source-owned.
    await execFileAsync(
      'find',
      [objectDirectory, '-type', 'f', '-exec', 'chown', `${owner.uid}:${owner.gid}`, '{}', '+'],
      { timeout: WORKSPACE_PERMISSION_TIMEOUT_MS },
    );
  }
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
    return path.join(this.#hostRoot, 'executions', executionDirectoryName(executionId), 'repo');
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
    if (!realPathInsideAllowedRoots(repoRoot, this.#allowedRepositoryRoots)) {
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
    await assertManagedGitWorkspace(hostPath, this.#hostRoot, this.#executionOwner);
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
    await assertManagedGitWorkspace(hostPath, this.#hostRoot, this.#executionOwner);
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
    if (!realPathInsideAllowedRoots(repoRoot, this.#allowedRepositoryRoots)) {
      throw new Error('V3_REPOSITORY_ROOT_NOT_ALLOWED');
    }
    const repoStat = fs.statSync(repoRoot);
    const sourceOwner = { uid: repoStat.uid, gid: repoStat.gid };
    const revision = input.baseRevision?.trim() || 'HEAD';
    const resolvedRevision = await git(repoRoot, ['rev-parse', '--verify', revision], sourceOwner);

    const directory = executionDirectoryName(input.executionId);
    const executionsRoot = path.join(this.#hostRoot, 'executions');
    fs.mkdirSync(executionsRoot, { recursive: true, mode: 0o750 });
    if (this.#executionOwner) {
      fs.chownSync(executionsRoot, this.#executionOwner.uid, this.#executionOwner.gid);
      fs.chmodSync(executionsRoot, 0o750);
    }

    const hostPath = this.hostPathForExecution(input.executionId);
    const executionPath = path.posix.join(this.#executionRoot, 'executions', directory, 'repo');
    const existingWorkspace = fs.lstatSync(hostPath, { throwIfNoEntry: false });
    if (existingWorkspace) {
      await assertManagedGitWorkspace(hostPath, this.#hostRoot, this.#executionOwner);
      // DevelopmentExecutionService calls provision() only while the durable execution has no
      // attached workspaceRef. Therefore an existing directory here is unreachable crash residue,
      // never an active/resumable writer lease. Recreate it from the requested repository/base/mode
      // instead of silently accepting an artifact whose identity cannot be proven externally.
      fs.rmSync(path.dirname(hostPath), { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(hostPath), { recursive: true, mode: 0o750 });
    assertManagedWorkspacePath(path.dirname(hostPath), this.#hostRoot);

    // Local execution clones keep private refs/index/new objects but physically share
    // pre-existing canonical objects through hardlinks. This preserves the worker trust
    // boundary without multiplying immutable Git history per execution.
    const serviceUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const objectClonePlan: ObjectClonePlan = this.#executionOwner
      ? await prepareSharedObjectAccess(repoRoot, sourceOwner, this.#executionOwner)
      : {
          // Preserve the legacy optional-owner contract. When the service and repository have
          // different owners, clone privately as sourceOwner instead of relying on a trust
          // exception or permissions the service identity may not have.
          hardlinkObjects: serviceUid !== undefined && serviceUid === sourceOwner.uid,
          privatizeRelativeObjectPaths: [],
        };

    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ai-office-v3-'));
    const stagingRepo = path.join(stagingRoot, 'repo');
    fs.chownSync(stagingRoot, sourceOwner.uid, sourceOwner.gid);
    const sameFilesystem = fs.statSync(stagingRoot).dev === fs.statSync(path.dirname(hostPath)).dev;
    const effectiveClonePlan: ObjectClonePlan = sameFilesystem
      ? objectClonePlan
      : { hardlinkObjects: false, privatizeRelativeObjectPaths: [] };
    const cloneWithServiceIdentity = effectiveClonePlan.hardlinkObjects;
    const cloneIdentity = cloneWithServiceIdentity ? undefined : sourceOwner;
    const trustedCloneConfig = path.join(stagingRoot, 'git-safe-config');

    let branch: string | undefined;
    try {
      let cloneEnv: NodeJS.ProcessEnv | undefined;
      if (cloneWithServiceIdentity && serviceUid !== sourceOwner.uid) {
        // Linux protected_hardlinks prevents the OpenHands identity from linking canonical
        // dev-owned packs. The service identity therefore performs the linked clone. When that
        // identity differs from sourceOwner (root in production), Git's internal upload-pack
        // subprocess must see the source as trusted, so use a disposable protected global config
        // scoped to the already-validated repoRoot. Nothing is persisted globally.
        await execFileAsync(
          'git',
          ['config', '--file', trustedCloneConfig, '--add', 'safe.directory', repoRoot],
          { encoding: 'utf8', timeout: WORKSPACE_GIT_TIMEOUT_MS },
        );
        await execFileAsync(
          'git',
          [
            'config',
            '--file',
            trustedCloneConfig,
            '--add',
            'safe.directory',
            path.join(repoRoot, '.git'),
          ],
          { encoding: 'utf8', timeout: WORKSPACE_GIT_TIMEOUT_MS },
        );
        cloneEnv = { ...process.env, GIT_CONFIG_GLOBAL: trustedCloneConfig };
      }

      await execFileAsync(
        'git',
        [
          'clone',
          ...(effectiveClonePlan.hardlinkObjects ? ['--local'] : ['--no-local']),
          '--no-checkout',
          repoRoot,
          stagingRepo,
        ],
        {
          ...(cloneIdentity ? { uid: cloneIdentity.uid, gid: cloneIdentity.gid } : {}),
          ...(cloneEnv ? { env: cloneEnv } : {}),
          encoding: 'utf8',
          timeout: WORKSPACE_LONG_COMMAND_TIMEOUT_MS,
          maxBuffer: WORKSPACE_GIT_LARGE_BUFFER_BYTES,
        },
      );

      const stagingIdentity = cloneWithServiceIdentity ? undefined : sourceOwner;
      if (
        input.workspaceMode === 'isolated_write' ||
        input.workspaceMode === 'reuse_implementation_workspace'
      ) {
        branch = `ai-office/${directory}`;
        await git(stagingRepo, ['checkout', '-B', branch, resolvedRevision], stagingIdentity);
      } else {
        await git(stagingRepo, ['checkout', '--detach', resolvedRevision], stagingIdentity);
      }

      if (input.workspaceMode === 'review_snapshot' && input.reviewBaseRevision?.trim()) {
        const resolvedReviewBase = await git(
          stagingRepo,
          ['rev-parse', '--verify', input.reviewBaseRevision.trim()],
          stagingIdentity,
        );
        await git(
          stagingRepo,
          ['update-ref', 'refs/ai-office/review-base', resolvedReviewBase],
          stagingIdentity,
        );
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
        overlayWorkingTree(repoRoot, stagingRepo, workingTreeEntries);
      }

      assertWorkspaceSymlinksContained(stagingRepo);

      if (sameFilesystem) {
        fs.renameSync(stagingRepo, hostPath);
      } else {
        fs.cpSync(stagingRepo, hostPath, {
          recursive: true,
          preserveTimestamps: true,
          errorOnExist: true,
          force: false,
        });
      }
    } catch (error) {
      fs.rmSync(path.dirname(hostPath), { recursive: true, force: true });
      throw error;
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }

    if (this.#executionOwner) {
      privatizeExecutionOwnedObjectLinks(hostPath, effectiveClonePlan, this.#executionOwner);
    }

    if (this.#executionOwner) {
      // The execution directory and private repository metadata belong to OpenHands. Existing
      // object files may be hardlinked to canonical storage and deliberately remain source-owned.
      fs.chownSync(path.dirname(hostPath), this.#executionOwner.uid, this.#executionOwner.gid);
      fs.chmodSync(path.dirname(hostPath), 0o750);
      await chownExecutionRepository(
        hostPath,
        this.#executionOwner,
        effectiveClonePlan.hardlinkObjects,
      );
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
    await assertManagedGitWorkspace(hostPath, this.#hostRoot, this.#executionOwner);
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
    const executionStat = fs.lstatSync(executionDirectory, { throwIfNoEntry: false });
    if (!executionStat) return false;
    if (executionStat.isSymbolicLink()) throw new Error('V3_EXECUTION_WORKSPACE_SYMLINK');
    assertManagedWorkspacePath(executionDirectory, this.#hostRoot);
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
    if (!realPathInsideAllowedRoots(repoRoot, this.#allowedRepositoryRoots)) {
      throw new Error('V3_REPOSITORY_ROOT_NOT_ALLOWED');
    }
    const repoStat = fs.statSync(repoRoot);
    const sourceOwner = { uid: repoStat.uid, gid: repoStat.gid };
    await assertCanonicalGitMetadataContained(repoRoot, sourceOwner);
    const integrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ai-office-integrate-'));
    fs.chownSync(integrationRoot, sourceOwner.uid, sourceOwner.gid);
    const integrationRepo = path.join(integrationRoot, 'repo');
    const safePlan = integrationRefComponent(input.planId);
    const safeBatch = integrationRefComponent(input.batchKey);
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
        await assertManagedGitWorkspace(implementationPath, this.#hostRoot, this.#executionOwner);
        const trustedImplementation = safeDirectory(implementationPath);
        const dirty = await git(implementationPath, [
          ...trustedImplementation,
          'status',
          '--porcelain',
        ]);
        if (dirty) throw new Error('BATCH_INTEGRATION_UNCOMMITTED_CHANGES');
        const head = await git(implementationPath, [...trustedImplementation, 'rev-parse', 'HEAD']);
        let sourceRevision: string;
        try {
          sourceRevision = await git(implementationPath, [
            ...trustedImplementation,
            'rev-parse',
            '--verify',
            `${implementation.sourceRevision}^{commit}`,
          ]);
        } catch {
          throw new Error('BATCH_INTEGRATION_SOURCE_REVISION_INVALID');
        }
        if (head === sourceRevision) {
          throw new Error('BATCH_INTEGRATION_EMPTY_IMPLEMENTATION');
        }
        try {
          await git(implementationPath, [
            ...trustedImplementation,
            'merge-base',
            '--is-ancestor',
            sourceRevision,
            head,
          ]);
        } catch {
          throw new Error('BATCH_INTEGRATION_SOURCE_NOT_ANCESTOR');
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
          `^${sourceRevision}`,
        ]);
        fs.chownSync(implementationBundle, sourceOwner.uid, sourceOwner.gid);
        await git(
          integrationRepo,
          ['fetch', '--no-tags', implementationBundle, 'HEAD'],
          sourceOwner,
        );
        const fetchedHead = await git(
          integrationRepo,
          ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
          sourceOwner,
        );
        if (fetchedHead !== head) throw new Error('BATCH_INTEGRATION_HEAD_MISMATCH');
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
