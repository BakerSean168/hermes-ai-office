import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { V4Error, failClosed } from '../domain/errors.js';
import type { PlanWorktree, PlanWorktreeRole } from '../domain/worktree.js';
import type { V4Repositories } from '../persistence/repositories.js';

const execFileAsync = promisify(execFile);
const MAX_ID_BYTES = 120;

interface GitWorktreeRecord {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  lockedReason?: string;
}

export interface PlanWorktreeManagerOptions {
  repositories: V4Repositories;
  allowedRepositoryRoots: string[];
  managedHostRoot: string;
  executionRoot: string;
  commandTimeoutMs?: number;
  maxBufferBytes?: number;
}

interface WorktreeRequest {
  projectKey: string;
  rootPlanId: string;
  repositoryPath: string;
  baseRevision: string;
}

export interface WorkItemWorktreeRequest extends WorktreeRequest {
  workItemId: string;
}

export interface ReviewWorktreeRequest extends WorktreeRequest {
  reviewId: string;
  reviewedSha: string;
}

export interface DeliveryRepairWorktreeRequest extends WorktreeRequest {
  repairId: string;
  deliveryHeadSha: string;
}

function inside(candidate: string, root: string): boolean {
  const value = path.resolve(candidate);
  const boundary = path.resolve(root);
  return value === boundary || value.startsWith(boundary + path.sep);
}

export function worktreeRefComponent(value: string): string {
  const source = value.trim();
  failClosed(source.length > 0, 'WORKTREE_REF_COMPONENT_REQUIRED');
  if (
    Buffer.byteLength(source, 'utf8') <= MAX_ID_BYTES &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source) &&
    source !== '.' &&
    source !== '..' &&
    !source.endsWith('.lock') &&
    !source.includes('..')
  )
    return source;
  const encoded = 'x' + Buffer.from(source, 'utf8').toString('hex');
  failClosed(encoded.length <= 2 * MAX_ID_BYTES + 1, 'WORKTREE_REF_COMPONENT_TOO_LONG');
  return encoded;
}

function worktreeId(role: PlanWorktreeRole, rootPlanId: string, identity: string): string {
  return [
    'worktree',
    role.toLowerCase(),
    worktreeRefComponent(rootPlanId),
    worktreeRefComponent(identity),
  ].join(':');
}

export class PlanWorktreeManager {
  readonly repositories: V4Repositories;
  readonly allowedRepositoryRoots: string[];
  readonly managedHostRoot: string;
  readonly executionRoot: string;
  readonly commandTimeoutMs: number;
  readonly maxBufferBytes: number;

  constructor(options: PlanWorktreeManagerOptions) {
    failClosed(options.allowedRepositoryRoots.length > 0, 'WORKTREE_ALLOWED_ROOT_REQUIRED');
    this.repositories = options.repositories;
    this.allowedRepositoryRoots = options.allowedRepositoryRoots.map((root) =>
      fs.realpathSync(root),
    );
    this.managedHostRoot = fs.realpathSync(options.managedHostRoot);
    this.executionRoot = path.posix.resolve('/', options.executionRoot);
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024;
  }

  async ensureIntegration(input: WorktreeRequest): Promise<PlanWorktree> {
    const branchRef = this.planBranch(input.rootPlanId, 'integration');
    return await this.ensureBranched({
      ...input,
      role: 'INTEGRATION',
      identity: 'integration',
      relativePath: ['integration', 'repo'],
      branchRef,
    });
  }

  async ensureWorkItem(input: WorkItemWorktreeRequest): Promise<PlanWorktree> {
    const item = this.repositories.plans.getWorkItem(input.workItemId);
    failClosed(item.planId === input.rootPlanId, 'WORKTREE_WORK_ITEM_PLAN_MISMATCH');
    const itemComponent = worktreeRefComponent(input.workItemId);
    return await this.ensureBranched({
      ...input,
      role: 'WORK_ITEM',
      identity: input.workItemId,
      workItemId: input.workItemId,
      relativePath: ['items', itemComponent, 'repo'],
      branchRef: this.planBranch(input.rootPlanId, 'items/' + itemComponent),
    });
  }

  async ensureDeliveryRepair(input: DeliveryRepairWorktreeRequest): Promise<PlanWorktree> {
    const repairComponent = worktreeRefComponent(input.repairId);
    return await this.ensureBranched({
      ...input,
      baseRevision: input.deliveryHeadSha,
      role: 'DELIVERY_REPAIR',
      identity: input.repairId,
      relativePath: ['repairs', repairComponent, 'repo'],
      branchRef: this.planBranch(input.rootPlanId, 'repairs/' + repairComponent),
    });
  }

  async createReview(input: ReviewWorktreeRequest): Promise<PlanWorktree> {
    this.assertActivePlan(input);
    const repositoryPath = await this.repositoryRoot(input.repositoryPath);
    const reviewComponent = worktreeRefComponent(input.reviewId);
    const paths = this.paths(input.projectKey, input.rootPlanId, [
      'reviews',
      reviewComponent,
      'repo',
    ]);
    const id = worktreeId('REVIEW', input.rootPlanId, input.reviewId);
    this.assertCommit(repositoryPath, input.reviewedSha);
    const record = this.repositories.planWorktrees.create({
      worktreeId: id,
      projectKey: input.projectKey,
      rootPlanId: input.rootPlanId,
      role: 'REVIEW',
      repositoryPath,
      hostPath: paths.hostPath,
      executionPath: paths.executionPath,
      baseRevision: input.reviewedSha,
    }).value!;
    if (record.state === 'REVIEWING' || record.state === 'QUIESCENT') {
      await this.verifyRegistered(record, input.reviewedSha, undefined, true);
      return record;
    }
    if (record.state !== 'PROVISIONING') throw new V4Error('WORKTREE_STATE_NOT_RECOVERABLE');
    await this.createPhysicalWorktree(record, input.reviewedSha, undefined, true);
    const current = this.repositories.planWorktrees.get(id);
    const transitioned = this.repositories.planWorktrees.transition(
      id,
      current.version,
      'REVIEWING',
    );
    if (!transitioned.value || transitioned.status === 'rejected')
      throw new V4Error(transitioned.reason ?? 'WORKTREE_STATE_STALE');
    return transitioned.value;
  }

  async attachWriter(worktreeIdValue: string, executionId: string): Promise<PlanWorktree> {
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    failClosed(
      current.role !== 'REVIEW' && current.role !== 'INTEGRATION',
      'WORKTREE_MODEL_WRITER_ROLE_INVALID',
    );
    await this.verifyRegistered(current, current.currentRevision, current.branchRef, false);
    const status = await this.gitStatus(current.repositoryPath, current.hostPath);
    failClosed(status.length === 0, 'WORKTREE_DIRTY_BEFORE_WRITER');
    const result = this.repositories.planWorktrees.attachWriter(
      worktreeIdValue,
      executionId,
      current.version,
    );
    if (!result.value || result.status === 'rejected')
      throw new V4Error(result.reason ?? 'WORKTREE_WRITER_ATTACH_FAILED');
    return result.value;
  }

  async releaseWriter(worktreeIdValue: string, executionId: string): Promise<PlanWorktree> {
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    failClosed(current.ownerExecutionId === executionId, 'WORKTREE_WRITER_OWNER_MISMATCH');
    const head = await this.gitInWorktree(current.repositoryPath, current.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    const status = await this.gitStatus(current.repositoryPath, current.hostPath);
    failClosed(status.length === 0, 'WORKTREE_DIRTY_ON_RELEASE');
    const result = this.repositories.planWorktrees.releaseWriter(
      worktreeIdValue,
      executionId,
      current.version,
      head,
    );
    if (!result.value || result.status === 'rejected')
      throw new V4Error(result.reason ?? 'WORKTREE_WRITER_RELEASE_FAILED');
    return result.value;
  }

  async markIntegrated(worktreeIdValue: string): Promise<PlanWorktree> {
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    failClosed(!current.ownerExecutionId, 'WORKTREE_WRITER_HELD');
    const next =
      current.state === 'READY' || current.state === 'QUIESCENT' ? 'INTEGRATED' : current.state;
    if (next === current.state) return current;
    const result = this.repositories.planWorktrees.transition(
      worktreeIdValue,
      current.version,
      next,
    );
    if (!result.value || result.status === 'rejected')
      throw new V4Error(result.reason ?? 'WORKTREE_STATE_STALE');
    return result.value;
  }

  async retire(worktreeIdValue: string): Promise<PlanWorktree> {
    let current = this.repositories.planWorktrees.get(worktreeIdValue);
    failClosed(!current.ownerExecutionId, 'WORKTREE_WRITER_HELD');
    if (current.state === 'RETIRED') return current;
    await this.verifyRegistered(
      current,
      current.currentRevision,
      current.branchRef,
      current.role === 'REVIEW',
      false,
    );
    await this.git(current.repositoryPath, ['worktree', 'unlock', '--', current.hostPath], true);
    await this.git(current.repositoryPath, ['worktree', 'remove', '--', current.hostPath]);
    await this.git(current.repositoryPath, ['worktree', 'prune', '--expire', 'now']);
    failClosed(!fs.existsSync(current.hostPath), 'WORKTREE_REMOVE_INCOMPLETE');
    current = this.repositories.planWorktrees.get(worktreeIdValue);
    const result = this.repositories.planWorktrees.transition(
      worktreeIdValue,
      current.version,
      'RETIRED',
    );
    if (!result.value || result.status === 'rejected')
      throw new V4Error(result.reason ?? 'WORKTREE_STATE_STALE');
    return result.value;
  }

  async reconcile(rootPlanId: string): Promise<PlanWorktree[]> {
    const records = this.repositories.planWorktrees.listByPlan(rootPlanId);
    for (const record of records) {
      if (record.state === 'RETIRED') continue;
      await this.verifyRegistered(
        record,
        record.currentRevision,
        record.branchRef,
        record.role === 'REVIEW',
      );
    }
    return records;
  }

  private async ensureBranched(
    input: WorktreeRequest & {
      role: Exclude<PlanWorktreeRole, 'REVIEW'>;
      identity: string;
      workItemId?: string;
      relativePath: string[];
      branchRef: string;
    },
  ): Promise<PlanWorktree> {
    this.assertActivePlan(input);
    const repositoryPath = await this.repositoryRoot(input.repositoryPath);
    this.assertCommit(repositoryPath, input.baseRevision);
    const paths = this.paths(input.projectKey, input.rootPlanId, input.relativePath);
    const id = worktreeId(input.role, input.rootPlanId, input.identity);
    const existingByPath = this.repositories.planWorktrees.findByPath(paths.hostPath);
    if (existingByPath && existingByPath.worktreeId !== id)
      throw new V4Error('WORKTREE_PATH_CONFLICT');
    const result = this.repositories.planWorktrees.create({
      worktreeId: id,
      projectKey: input.projectKey,
      rootPlanId: input.rootPlanId,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      role: input.role,
      repositoryPath,
      hostPath: paths.hostPath,
      executionPath: paths.executionPath,
      branchRef: input.branchRef,
      baseRevision: input.baseRevision,
    });
    const record = result.value!;
    if (record.state === 'READY' || record.state === 'QUIESCENT' || record.state === 'INTEGRATED') {
      await this.verifyRegistered(record, record.currentRevision, record.branchRef, false);
      return record;
    }
    if (record.state === 'WRITER_ATTACHED') {
      await this.verifyRegistered(record, record.currentRevision, record.branchRef, false);
      return record;
    }
    if (record.state !== 'PROVISIONING') throw new V4Error('WORKTREE_STATE_NOT_RECOVERABLE');
    await this.createPhysicalWorktree(record, input.baseRevision, input.branchRef, false);
    const current = this.repositories.planWorktrees.get(id);
    const transitioned = this.repositories.planWorktrees.transition(id, current.version, 'READY');
    if (!transitioned.value || transitioned.status === 'rejected')
      throw new V4Error(transitioned.reason ?? 'WORKTREE_STATE_STALE');
    return transitioned.value;
  }

  private assertActivePlan(input: WorktreeRequest): void {
    const plan = this.repositories.plans.getPlan(input.rootPlanId);
    failClosed(!plan.parentPlanId, 'WORKTREE_ROOT_PLAN_REQUIRED');
    failClosed(plan.projectKey === input.projectKey, 'WORKTREE_PROJECT_MISMATCH');
    const lease = this.repositories.projectPlans.getLease(input.projectKey);
    failClosed(lease?.activeRootPlanId === input.rootPlanId, 'WORKTREE_ACTIVE_PLAN_REQUIRED');
    failClosed(lease.repositoryPath === plan.repositoryPath, 'WORKTREE_REPOSITORY_MISMATCH');
  }

  private async repositoryRoot(repositoryPath: string): Promise<string> {
    const resolved = fs.realpathSync(repositoryPath);
    failClosed(
      this.allowedRepositoryRoots.some((root) => inside(resolved, root)),
      'WORKTREE_REPOSITORY_NOT_ALLOWED',
    );
    const root = await this.git(resolved, ['rev-parse', '--show-toplevel']);
    const canonical = fs.realpathSync(root);
    failClosed(canonical === resolved, 'WORKTREE_REPOSITORY_ROOT_MISMATCH');
    return canonical;
  }

  private assertCommit(repositoryPath: string, revision: string): void {
    failClosed(revision.trim().length > 0 && revision.length <= 200, 'WORKTREE_REVISION_REQUIRED');
    try {
      execFileSyncSafe(
        'git',
        this.gitArgs(repositoryPath, ['cat-file', '-e', revision + '^{commit}']),
        this.commandTimeoutMs,
        this.maxBufferBytes,
      );
    } catch (error) {
      throw new V4Error('WORKTREE_REVISION_MISSING', 'Git revision is unavailable.', error);
    }
  }

  private paths(projectKey: string, rootPlanId: string, relativePath: string[]) {
    const project = worktreeRefComponent(projectKey);
    const plan = worktreeRefComponent(rootPlanId);
    const relative = ['v4', 'plans', project, plan, ...relativePath];
    const hostPath = path.join(this.managedHostRoot, ...relative);
    const executionPath = path.posix.join(this.executionRoot, ...relative);
    failClosed(inside(hostPath, this.managedHostRoot), 'WORKTREE_PATH_NOT_ALLOWED');
    return { hostPath, executionPath };
  }

  private planBranch(rootPlanId: string, suffix: string): string {
    return 'refs/heads/pixel-v4/' + worktreeRefComponent(rootPlanId) + '/' + suffix;
  }

  private async createPhysicalWorktree(
    record: PlanWorktree,
    revision: string,
    branchRef: string | undefined,
    detached: boolean,
  ): Promise<void> {
    this.ensurePlanDirectory(record);
    const listed = await this.worktreeAt(record.repositoryPath, record.hostPath);
    if (listed) {
      await this.verifyRegistered(record, revision, branchRef, detached);
      return;
    }
    if (fs.existsSync(record.hostPath)) throw new V4Error('WORKTREE_UNKNOWN_PATH_RESIDUE');
    if (branchRef) {
      const branchExists = await this.gitSucceeds(record.repositoryPath, [
        'show-ref',
        '--verify',
        '--quiet',
        branchRef,
      ]);
      if (branchExists) {
        const branchHead = await this.git(record.repositoryPath, [
          'rev-parse',
          '--verify',
          branchRef + '^{commit}',
        ]);
        failClosed(branchHead === revision, 'WORKTREE_BRANCH_BASE_CONFLICT');
        await this.git(record.repositoryPath, [
          'worktree',
          'add',
          '--lock',
          '--reason',
          'pixel-v4:' + record.worktreeId,
          '--',
          record.hostPath,
          branchRef,
        ]);
      } else {
        const shortBranch = branchRef.replace(/^refs\/heads\//, '');
        await this.git(record.repositoryPath, [
          'worktree',
          'add',
          '--lock',
          '--reason',
          'pixel-v4:' + record.worktreeId,
          '-b',
          shortBranch,
          '--',
          record.hostPath,
          revision,
        ]);
      }
    } else {
      await this.git(record.repositoryPath, [
        'worktree',
        'add',
        '--lock',
        '--reason',
        'pixel-v4:' + record.worktreeId,
        '--detach',
        '--',
        record.hostPath,
        revision,
      ]);
    }
    await this.verifyRegistered(record, revision, branchRef, detached);
  }

  private ensurePlanDirectory(record: PlanWorktree): void {
    const roleRoot = path.dirname(record.hostPath);
    fs.mkdirSync(roleRoot, { recursive: true, mode: 0o755 });
  }

  private async verifyRegistered(
    record: PlanWorktree,
    expectedHead: string,
    expectedBranch: string | undefined,
    detached: boolean,
    requireLock = true,
  ): Promise<void> {
    const listed = await this.worktreeAt(record.repositoryPath, record.hostPath);
    failClosed(Boolean(listed), 'WORKTREE_REGISTRY_FILESYSTEM_MISSING');
    failClosed(listed!.head === expectedHead, 'WORKTREE_HEAD_MISMATCH');
    if (detached) failClosed(listed!.detached && !listed!.branch, 'WORKTREE_REVIEW_NOT_DETACHED');
    else failClosed(listed!.branch === expectedBranch, 'WORKTREE_BRANCH_MISMATCH');
    if (requireLock)
      failClosed(
        listed!.lockedReason === 'pixel-v4:' + record.worktreeId,
        'WORKTREE_LOCK_MISMATCH',
      );
    const common = await this.gitInWorktree(record.repositoryPath, record.hostPath, [
      'rev-parse',
      '--git-common-dir',
    ]);
    const canonicalCommon = await this.git(record.repositoryPath, [
      'rev-parse',
      '--git-common-dir',
    ]);
    const commonReal = fs.realpathSync(
      path.isAbsolute(common) ? common : path.resolve(record.hostPath, common),
    );
    const canonicalReal = fs.realpathSync(
      path.isAbsolute(canonicalCommon)
        ? canonicalCommon
        : path.resolve(record.repositoryPath, canonicalCommon),
    );
    failClosed(commonReal === canonicalReal, 'WORKTREE_COMMON_DIR_MISMATCH');
  }

  private async worktreeAt(
    repositoryPath: string,
    targetPath: string,
  ): Promise<GitWorktreeRecord | undefined> {
    const output = await this.git(repositoryPath, ['worktree', 'list', '--porcelain']);
    const records = parseWorktreeList(output);
    const target = path.resolve(targetPath);
    return records.find((item) => path.resolve(item.path) === target);
  }

  private async gitStatus(repositoryPath: string, worktreePath: string): Promise<string> {
    return await this.gitInWorktree(repositoryPath, worktreePath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
  }

  private async gitInWorktree(
    repositoryPath: string,
    worktreePath: string,
    args: string[],
  ): Promise<string> {
    return await this.git(repositoryPath, ['-C', worktreePath, ...args], false, true);
  }

  private gitArgs(repositoryPath: string, args: string[]): string[] {
    return [
      '-c',
      'safe.directory=' + repositoryPath,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-C',
      repositoryPath,
      ...args,
    ];
  }

  private async git(
    repositoryPath: string,
    args: string[],
    allowFailure = false,
    argsContainCwd = false,
  ): Promise<string> {
    const invocation = argsContainCwd
      ? [
          '-c',
          'safe.directory=' + repositoryPath,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ]
      : this.gitArgs(repositoryPath, args);
    try {
      const { stdout } = await execFileAsync('git', invocation, {
        encoding: 'utf8',
        timeout: this.commandTimeoutMs,
        maxBuffer: this.maxBufferBytes,
      });
      return stdout.trim();
    } catch (error) {
      if (allowFailure) return '';
      throw new V4Error('WORKTREE_GIT_FAILED', 'Git worktree operation failed.', error);
    }
  }

  private async gitSucceeds(repositoryPath: string, args: string[]): Promise<boolean> {
    try {
      await this.git(repositoryPath, args);
      return true;
    } catch {
      return false;
    }
  }
}

function execFileSyncSafe(
  command: string,
  args: string[],
  timeout: number,
  maxBuffer: number,
): void {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer,
  });
  if (result.status !== 0)
    throw new Error(String(result.stderr || result.error || 'command failed'));
}

export function parseWorktreeList(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: Partial<GitWorktreeRecord> | undefined;
  const flush = () => {
    if (current?.path && current.head) {
      records.push({
        path: current.path,
        head: current.head,
        ...(current.branch ? { branch: current.branch } : {}),
        detached: current.detached === true,
        ...(current.lockedReason ? { lockedReason: current.lockedReason } : {}),
      });
    }
    current = undefined;
  };
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      flush();
      current = { path: value, detached: false };
    } else if (!current) {
      continue;
    } else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.lockedReason = value;
  }
  flush();
  return records;
}
