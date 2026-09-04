import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { V4Error, failClosed } from '../domain/errors.js';
import type { PlanWorktree } from '../domain/worktree.js';
import type { V4Repositories } from '../persistence/repositories.js';
import {
  REPOSITORY_COMPLETION_EVIDENCE_FILE,
  type RepositoryObservation,
  type WorkspaceCachePruneResult,
  type WorkspaceCompletionSnapshot,
  type WorkspaceDescriptor,
  type WorkspaceProviderPort,
  type WorkspaceProvisionInput,
  type WorkspaceStorageStatus,
} from '../orchestration/contracts.js';
import {
  assertImplementationEvidenceGate,
  assertReviewEvidenceGate,
  decodeImplementationEvidence,
  decodeReviewEvidence,
} from './gitWorkspace.js';
import { PlanWorktreeManager } from './planWorktrees.js';

const execFileAsync = promisify(execFile);
const MAX_IDENTIFIER = 180;
const MAX_EVIDENCE_BYTES = 256_000;
const MAX_CHANGED_FILES = 1_000;
const MAX_DIFF_STAT_BYTES = 64_000;
const DEFAULT_MINIMUM_FREE_BYTES = 1024 * 1024 * 1024;
const MAX_EPHEMERAL_EVIDENCE_HELPER_BYTES = 64 * 1024;
const EPHEMERAL_EVIDENCE_HELPERS = ['_write_evidence.py', '_gen_evidence.py'] as const;

export interface LiteralWorktreeWorkspaceOptions {
  repositories: V4Repositories;
  manager: PlanWorktreeManager;
  managedHostRoot: string;
  executionRoot: string;
  workspaceUid: number;
  workspaceGid: number;
  minimumFreeBytes?: number;
  commandTimeoutMs?: number;
  maxBufferBytes?: number;
}

interface StoredDescriptor extends WorkspaceDescriptor {
  version: 1;
}

interface EvidencePromotionMetadata {
  replacedInvalidEvidenceHash?: string;
}

function component(value: string, code: string): string {
  const normalized = value.trim();
  failClosed(
    normalized.length > 0 &&
      normalized.length <= MAX_IDENTIFIER &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized),
    code,
  );
  return normalized;
}

function inside(candidate: string, root: string): boolean {
  const value = path.resolve(candidate);
  const boundary = path.resolve(root);
  return value === boundary || value.startsWith(boundary + path.sep);
}

function readJson(file: string, code: string): Record<string, unknown> {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_EVIDENCE_BYTES)
    throw new V4Error(code);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new V4Error(code);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof V4Error) throw error;
    throw new V4Error(code, code, error);
  }
}

export class LiteralWorktreeWorkspaceAdapter implements WorkspaceProviderPort {
  readonly integrationStrategy = 'PLAN_WORKTREE' as const;
  readonly repositories: V4Repositories;
  readonly manager: PlanWorktreeManager;
  readonly managedHostRoot: string;
  readonly executionRoot: string;
  readonly workspaceUid: number;
  readonly workspaceGid: number;
  readonly minimumFreeBytes: number;
  readonly commandTimeoutMs: number;
  readonly maxBufferBytes: number;

  constructor(options: LiteralWorktreeWorkspaceOptions) {
    this.repositories = options.repositories;
    this.manager = options.manager;
    this.managedHostRoot = fs.realpathSync(options.managedHostRoot);
    this.executionRoot = path.posix.resolve('/', options.executionRoot);
    this.workspaceUid = options.workspaceUid;
    this.workspaceGid = options.workspaceGid;
    this.minimumFreeBytes = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024;
    failClosed(
      Number.isInteger(this.workspaceUid) &&
        this.workspaceUid > 0 &&
        Number.isInteger(this.workspaceGid) &&
        this.workspaceGid > 0,
      'WORKSPACE_OWNER_INVALID',
    );
  }

  async assertPlanSafety(planId: string): Promise<void> {
    await this.manager.assertPlanSafety(this.rootPlan(planId).planId);
  }

  async deliveryWorkspace(planId: string): Promise<string | undefined> {
    const plan = this.repositories.plans.getPlan(planId);
    const root = this.rootPlan(planId);
    await this.manager.assertPlanSafety(root.planId);
    if (plan.planId === root.planId) {
      const integration = this.repositories.planWorktrees.findIntegration(root.planId);
      if (!integration) throw new V4Error('WORKTREE_INTEGRATION_MISSING');
      const head = await this.git(integration.hostPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
      failClosed(head === plan.currentRevision, 'WORKTREE_INTEGRATION_STALE_HEAD');
      failClosed(
        (await this.git(integration.hostPath, ['status', '--porcelain=v1', '-z'])).length === 0,
        'WORKTREE_INTEGRATION_DIRTY',
      );
      return integration.hostPath;
    }
    const childItems = this.repositories.plans.listWorkItems(plan.planId);
    const ids = new Set(childItems.map((item) => item.workItemId));
    const candidates = this.repositories.planWorktrees
      .listByPlan(root.planId)
      .filter(
        (worktree) =>
          worktree.workItemId &&
          ids.has(worktree.workItemId) &&
          worktree.currentRevision === plan.currentRevision &&
          !worktree.ownerExecutionId &&
          worktree.state !== 'RETIRED' &&
          worktree.role === 'WORK_ITEM',
      );
    if (candidates.length !== 1) throw new V4Error('WORKTREE_DELIVERY_CANDIDATE_AMBIGUOUS');
    const candidate = candidates[0]!;
    const head = await this.git(candidate.hostPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    failClosed(head === plan.currentRevision, 'WORKTREE_DELIVERY_CANDIDATE_STALE');
    failClosed(
      (await this.git(candidate.hostPath, ['status', '--porcelain=v1', '-z'])).length === 0,
      'WORKTREE_DELIVERY_CANDIDATE_DIRTY',
    );
    return candidate.hostPath;
  }

  async observeRepository(
    repositoryPath: string,
    revision: string,
  ): Promise<RepositoryObservation> {
    const root = fs.realpathSync(repositoryPath);
    const headRevision = await this.git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const branch = await this.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
    const clean = (await this.git(root, ['status', '--porcelain=v1', '-z'])).length === 0;
    const commitExists = await this.gitSucceeds(root, ['cat-file', '-e', revision + '^{commit}']);
    return {
      repositoryPath: root,
      rootPath: root,
      headRevision,
      ...(branch ? { branch } : {}),
      clean,
      commitExists,
      observedAt: new Date().toISOString(),
    };
  }

  async provision(input: WorkspaceProvisionInput): Promise<WorkspaceDescriptor> {
    const executionId = component(input.executionId, 'WORKSPACE_EXECUTION_ID_INVALID');
    const planId = component(input.planId ?? '', 'WORKSPACE_PLAN_ID_REQUIRED');
    const projectKey = component(input.projectKey ?? '', 'WORKSPACE_PROJECT_KEY_REQUIRED');
    const workItemId = component(input.workItemId ?? '', 'WORKSPACE_WORK_ITEM_ID_REQUIRED');
    const plan = this.repositories.plans.getPlan(planId);
    const rootPlan = this.rootPlan(plan.planId);
    const item = this.repositories.plans.getWorkItem(workItemId);
    failClosed(item.planId === plan.planId, 'EXECUTION_WORK_ITEM_MISMATCH');
    failClosed(rootPlan.projectKey === projectKey, 'WORKTREE_PROJECT_MISMATCH');
    failClosed(
      fs.realpathSync(input.repositoryPath) === fs.realpathSync(rootPlan.repositoryPath),
      'WORKTREE_REPOSITORY_MISMATCH',
    );
    const phase = input.phase ?? 'IMPLEMENT';

    let worktree: PlanWorktree;
    if (phase === 'REVIEW') {
      worktree = await this.manager.createReview({
        projectKey,
        rootPlanId: rootPlan.planId,
        reviewId: executionId,
        repositoryPath: rootPlan.repositoryPath,
        baseRevision: rootPlan.baseRevision,
        reviewedSha: input.sourceRevision,
      });
      await this.manager.prepareAgentAccess(
        worktree.worktreeId,
        this.workspaceUid,
        this.workspaceGid,
      );
    } else {
      worktree =
        this.repositories.planWorktrees.findForWorkItem(rootPlan.planId, workItemId) ??
        (await this.manager.ensureWorkItem({
          projectKey,
          rootPlanId: rootPlan.planId,
          workItemId,
          repositoryPath: rootPlan.repositoryPath,
          baseRevision: item.integrationBaseRevision ?? input.sourceRevision,
        }));
      worktree = await this.manager.prepareWriterForExecution(
        worktree.worktreeId,
        executionId,
        input.sourceRevision,
        this.workspaceUid,
        this.workspaceGid,
      );
    }

    return this.executionDescriptor(worktree, executionId, input.sourceRevision);
  }

  hasCompletionEvidence(workspace: WorkspaceDescriptor): boolean {
    const descriptor = this.validateWorkspace(workspace);
    return (
      fs.existsSync(descriptor.evidenceHostPath) ||
      fs.existsSync(path.join(descriptor.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE))
    );
  }

  async progressFingerprint(workspace: WorkspaceDescriptor): Promise<string> {
    const descriptor = this.validateWorkspace(workspace);
    const head = await this.git(descriptor.hostPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const status = await this.git(descriptor.hostPath, ['status', '--porcelain=v1', '-z']);
    const staged = fs.lstatSync(
      path.join(descriptor.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
      {
        throwIfNoEntry: false,
      },
    );
    const durable = fs.lstatSync(descriptor.evidenceHostPath, { throwIfNoEntry: false });
    return createHash('sha256')
      .update(head)
      .update('\0')
      .update(status)
      .update('\0')
      .update(staged ? `${staged.size}:${staged.mtimeMs}` : '-')
      .update('\0')
      .update(durable ? `${durable.size}:${durable.mtimeMs}` : '-')
      .digest('hex');
  }

  storageStatus(): WorkspaceStorageStatus {
    const stat = fs.statfsSync(this.managedHostRoot);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
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
      const record = this.repositories.planWorktrees.findByPath(workspace.hostPath);
      if (!record || record.state === 'RETIRED' || !fs.existsSync(workspace.hostPath)) continue;
      const descriptor = this.validateWorkspace(workspace);
      if (seen.has(descriptor.hostPath)) continue;
      seen.add(descriptor.hostPath);
      const execution = this.repositories.executions.get(descriptor.executionId);
      if (execution.status === 'QUEUED' || execution.status === 'RUNNING') continue;
      for (const candidate of this.cacheDirectories(descriptor.hostPath)) {
        const relative = path.relative(descriptor.hostPath, candidate);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        if (!(await this.gitSucceeds(descriptor.hostPath, ['check-ignore', '-q', '--', relative])))
          continue;
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
    const evidence = decodeImplementationEvidence(
      readJson(descriptor.evidenceHostPath, 'WORKSPACE_EVIDENCE_INVALID'),
    );
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

    const record = this.repositories.planWorktrees.findByPath(descriptor.hostPath);
    if (!record) throw new V4Error('WORKTREE_NOT_FOUND');
    if (record.ownerExecutionId === descriptor.executionId)
      await this.manager.releaseWriter(record.worktreeId, descriptor.executionId);
    else
      failClosed(
        !record.ownerExecutionId && record.currentRevision === headRevision,
        'WORKTREE_WRITER_OWNER_MISMATCH',
      );

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
    const evidence = decodeReviewEvidence(
      readJson(descriptor.evidenceHostPath, 'WORKSPACE_EVIDENCE_INVALID'),
    );
    assertReviewEvidenceGate(evidence, descriptor, reviewedSha);

    const record = this.repositories.planWorktrees.findByPath(descriptor.hostPath);
    if (!record || record.role !== 'REVIEW') throw new V4Error('WORKTREE_REVIEW_REGISTRY_MISSING');
    if (record.state === 'REVIEWING') {
      const transitioned = this.repositories.planWorktrees.transition(
        record.worktreeId,
        record.version,
        'QUIESCENT',
      );
      if (!transitioned.value || transitioned.status === 'rejected')
        throw new V4Error(transitioned.reason ?? 'WORKTREE_STATE_STALE');
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
    planId?: string;
    workItemId?: string;
    integrationBaseRevision?: string;
  }): Promise<RepositoryObservation> {
    const descriptor = this.validateWorkspace(input.candidateWorkspace);
    const planId = component(input.planId ?? '', 'WORKTREE_INTEGRATION_PLAN_REQUIRED');
    const workItemId = component(input.workItemId ?? '', 'WORKTREE_INTEGRATION_WORK_ITEM_REQUIRED');
    const base = input.integrationBaseRevision?.trim();
    failClosed(Boolean(base), 'WORK_ITEM_WAVE_BASE_REQUIRED');
    const candidateHead = await this.git(descriptor.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    failClosed(candidateHead === input.acceptedRevision, 'WORKTREE_ACCEPTED_REVISION_NOT_PINNED');
    failClosed(
      (await this.git(descriptor.hostPath, ['status', '--porcelain=v1', '-z'])).length === 0,
      'WORKTREE_ACCEPTED_REVISION_DIRTY',
    );
    const owningPlan = this.repositories.plans.getPlan(planId);
    const rootPlan = this.rootPlan(planId);
    await this.manager.assertPlanSafety(rootPlan.planId);
    if (owningPlan.planId !== rootPlan.planId) {
      const record = this.repositories.planWorktrees.findByPath(descriptor.hostPath);
      if (!record) throw new V4Error('WORKTREE_NOT_FOUND');
      if (record.state === 'QUIESCENT') await this.manager.markIntegrated(record.worktreeId);
      return {
        repositoryPath: fs.realpathSync(input.repositoryPath),
        rootPath: descriptor.hostPath,
        headRevision: input.acceptedRevision,
        ...(record.branchRef ? { branch: record.branchRef.replace(/^refs\/heads\//, '') } : {}),
        clean: true,
        commitExists: true,
        observedAt: new Date().toISOString(),
      };
    }
    const result = await this.manager.integrateReviewedCandidate({
      rootPlanId: rootPlan.planId,
      workItemId,
      candidateRevision: input.acceptedRevision,
      expectedPlanRevision: input.expectedRevision,
      integrationBaseRevision: base!,
    });
    return {
      repositoryPath: fs.realpathSync(input.repositoryPath),
      rootPath: result.worktree.hostPath,
      headRevision: result.headRevision,
      ...(result.worktree.branchRef
        ? { branch: result.worktree.branchRef.replace(/^refs\/heads\//, '') }
        : {}),
      clean: true,
      commitExists: true,
      observedAt: new Date().toISOString(),
    };
  }

  private rootPlan(planId: string) {
    let plan = this.repositories.plans.getPlan(planId);
    const visited = new Set<string>();
    while (plan.parentPlanId) {
      if (visited.has(plan.planId)) throw new V4Error('PARENT_CHILD_CYCLE');
      visited.add(plan.planId);
      plan = this.repositories.plans.getPlan(plan.parentPlanId);
    }
    return plan;
  }

  private executionDescriptor(
    worktree: PlanWorktree,
    executionId: string,
    sourceRevision: string,
  ): WorkspaceDescriptor {
    const parentHost = path.dirname(worktree.hostPath);
    const parentExecution = path.posix.dirname(worktree.executionPath);
    const executionsRoot = path.join(parentHost, '.executions');
    const executionDirectory = path.join(executionsRoot, executionId);
    const evidenceHostPath = path.join(executionDirectory, 'completion-evidence.json');
    const evidenceExecutionPath = path.posix.join(
      parentExecution,
      '.executions',
      executionId,
      'completion-evidence.json',
    );
    const controllerRoot = path.join(parentHost, '.pixel-controller');
    const descriptorFile = path.join(controllerRoot, executionId + '.json');
    this.ensurePrivateExecutionDirectory(executionsRoot, executionDirectory);
    for (const relative of [
      '.agent-harness',
      '.agent-harness/home',
      '.agent-harness/state',
      '.agent-harness/share',
      '.agent-harness/xdg',
    ]) {
      const directory = path.join(executionDirectory, relative);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chownSync(directory, this.workspaceUid, this.workspaceGid);
      fs.chmodSync(directory, 0o700);
    }
    fs.mkdirSync(controllerRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(controllerRoot, 0o700);

    if (fs.existsSync(descriptorFile)) {
      const stored = readJson(
        descriptorFile,
        'WORKSPACE_DESCRIPTOR_INVALID',
      ) as unknown as StoredDescriptor;
      const expected = {
        executionId,
        hostPath: worktree.hostPath,
        executionPath: worktree.executionPath,
        evidenceHostPath,
        evidenceExecutionPath,
        sourceRepositoryPath: worktree.repositoryPath,
        sourceRevision,
      };
      for (const [key, value] of Object.entries(expected))
        if (stored[key as keyof StoredDescriptor] !== value)
          throw new V4Error('WORKSPACE_PROVENANCE_MISMATCH');
      return stored;
    }

    const descriptor: StoredDescriptor = {
      version: 1,
      executionId,
      hostPath: worktree.hostPath,
      executionPath: worktree.executionPath,
      evidenceHostPath,
      evidenceExecutionPath,
      sourceRepositoryPath: worktree.repositoryPath,
      sourceRevision,
      createdAt: new Date().toISOString(),
    };
    const temporary = descriptorFile + '.tmp-' + randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(descriptor) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, descriptorFile);
    fs.chmodSync(descriptorFile, 0o600);
    return descriptor;
  }

  private ensurePrivateExecutionDirectory(
    executionsRoot: string,
    executionDirectory: string,
  ): void {
    fs.mkdirSync(executionsRoot, { recursive: true, mode: 0o711 });
    fs.chmodSync(executionsRoot, 0o711);
    fs.mkdirSync(executionDirectory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(executionDirectory);
    failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKSPACE_EXECUTION_DIR_UNSAFE');
    fs.chownSync(executionDirectory, this.workspaceUid, this.workspaceGid);
    fs.chmodSync(executionDirectory, 0o700);
  }

  private validateWorkspace(workspace: WorkspaceDescriptor): WorkspaceDescriptor {
    const executionId = component(workspace.executionId, 'WORKSPACE_EXECUTION_ID_INVALID');
    const record = this.repositories.planWorktrees.findByPath(workspace.hostPath);
    if (!record || record.state === 'RETIRED') throw new V4Error('WORKTREE_NOT_FOUND');
    failClosed(record.executionPath === workspace.executionPath, 'WORKSPACE_PROVENANCE_MISMATCH');
    failClosed(
      record.repositoryPath === workspace.sourceRepositoryPath,
      'WORKSPACE_SOURCE_REPOSITORY_MISMATCH',
    );
    failClosed(inside(record.hostPath, this.managedHostRoot), 'WORKSPACE_PATH_NOT_MANAGED');
    const parentHost = path.dirname(record.hostPath);
    const parentExecution = path.posix.dirname(record.executionPath);
    failClosed(
      workspace.evidenceHostPath ===
        path.join(parentHost, '.executions', executionId, 'completion-evidence.json'),
      'WORKSPACE_PROVENANCE_MISMATCH',
    );
    failClosed(
      workspace.evidenceExecutionPath ===
        path.posix.join(parentExecution, '.executions', executionId, 'completion-evidence.json'),
      'WORKSPACE_PROVENANCE_MISMATCH',
    );
    const descriptorFile = path.join(parentHost, '.pixel-controller', executionId + '.json');
    const stored = readJson(descriptorFile, 'WORKSPACE_DESCRIPTOR_INVALID');
    for (const [key, value] of Object.entries({ version: 1, ...workspace }))
      if (stored[key] !== value) throw new V4Error('WORKSPACE_DESCRIPTOR_MISMATCH');
    return workspace;
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
    const raw = readJson(staged, 'WORKSPACE_EVIDENCE_INVALID');
    const evidence =
      phase === 'IMPLEMENTATION' ? decodeImplementationEvidence(raw) : decodeReviewEvidence(raw);
    if (phase === 'IMPLEMENTATION')
      assertImplementationEvidenceGate(
        evidence as ReturnType<typeof decodeImplementationEvidence>,
        descriptor,
        expectedRevision,
      );
    else
      assertReviewEvidenceGate(
        evidence as ReturnType<typeof decodeReviewEvidence>,
        descriptor,
        expectedRevision,
      );

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
            existing as ReturnType<typeof decodeImplementationEvidence>,
            descriptor,
            expectedRevision,
          );
        else
          assertReviewEvidenceGate(
            existing as ReturnType<typeof decodeReviewEvidence>,
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
    const temporary = descriptor.evidenceHostPath + '.tmp-' + randomUUID();
    try {
      fs.writeFileSync(temporary, JSON.stringify(evidence) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(temporary, descriptor.evidenceHostPath);
      fs.unlinkSync(staged);
      return replacedInvalidEvidenceHash ? { replacedInvalidEvidenceHash } : {};
    } catch (error) {
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
      const evidence = decodeImplementationEvidence(
        readJson(descriptor.evidenceHostPath, 'WORKSPACE_EVIDENCE_INVALID'),
      );
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
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.git') continue;
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

  private async git(cwd: string, args: string[], allowFailure = false): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          '-c',
          'safe.directory=' + cwd,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-C',
          cwd,
          ...args,
        ],
        {
          encoding: 'utf8',
          timeout: this.commandTimeoutMs,
          maxBuffer: this.maxBufferBytes,
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            HOME: '/nonexistent',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            LC_ALL: 'C.UTF-8',
          },
        },
      );
      return stdout.trim();
    } catch (error) {
      if (allowFailure) return '';
      throw new V4Error('WORKSPACE_GIT_FAILED', 'Literal worktree Git command failed.', error);
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
}
