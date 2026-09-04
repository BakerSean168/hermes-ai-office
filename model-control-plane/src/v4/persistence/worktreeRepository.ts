import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { V4Error, failClosed } from '../domain/errors.js';
import {
  transitionPlanWorktree,
  validatePlanWorktree,
  type CreatePlanWorktreeRecordInput,
  type PlanWorktree,
  type PlanWorktreeRole,
  type PlanWorktreeState,
} from '../domain/worktree.js';
import { EventStore } from './eventStore.js';
import { withTransaction } from './database.js';
import type { MutationResult } from './repositories.js';

interface Row {
  worktree_id: string;
  project_key: string;
  root_plan_id: string;
  work_item_id: string | null;
  role: PlanWorktreeRole;
  repository_path: string;
  host_path: string;
  execution_path: string;
  branch_ref: string | null;
  base_revision: string;
  current_revision: string;
  state: PlanWorktreeState;
  owner_execution_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const now = (): string => new Date().toISOString();

function record(row: Row): PlanWorktree {
  const value: PlanWorktree = {
    worktreeId: row.worktree_id,
    projectKey: row.project_key,
    rootPlanId: row.root_plan_id,
    ...(row.work_item_id ? { workItemId: row.work_item_id } : {}),
    role: row.role,
    repositoryPath: row.repository_path,
    hostPath: row.host_path,
    executionPath: row.execution_path,
    ...(row.branch_ref ? { branchRef: row.branch_ref } : {}),
    baseRevision: row.base_revision,
    currentRevision: row.current_revision,
    state: row.state,
    ...(row.owner_execution_id ? { ownerExecutionId: row.owner_execution_id } : {}),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  validatePlanWorktree(value);
  return value;
}

export class PlanWorktreeRepository {
  constructor(
    readonly db: DatabaseSync,
    readonly events = new EventStore(db),
  ) {}

  create(input: CreatePlanWorktreeRecordInput): MutationResult<PlanWorktree> {
    return withTransaction(this.db, () => {
      const existing = this.getOptional(input.worktreeId);
      if (existing) {
        if (
          existing.projectKey !== input.projectKey ||
          existing.rootPlanId !== input.rootPlanId ||
          existing.workItemId !== input.workItemId ||
          existing.role !== input.role ||
          existing.repositoryPath !== input.repositoryPath ||
          existing.hostPath !== input.hostPath ||
          existing.executionPath !== input.executionPath ||
          existing.branchRef !== input.branchRef ||
          existing.baseRevision !== input.baseRevision
        )
          throw new V4Error('WORKTREE_IDEMPOTENCY_CONFLICT');
        return { status: 'existing', value: existing };
      }
      const at = now();
      const state = input.state ?? 'PROVISIONING';
      const value: PlanWorktree = {
        ...input,
        state,
        currentRevision: input.baseRevision,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      validatePlanWorktree(value);
      this.db
        .prepare(
          'INSERT INTO plan_worktrees(worktree_id,project_key,root_plan_id,work_item_id,role,repository_path,host_path,execution_path,branch_ref,base_revision,current_revision,state,owner_execution_id,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          value.worktreeId,
          value.projectKey,
          value.rootPlanId,
          value.workItemId ?? null,
          value.role,
          value.repositoryPath,
          value.hostPath,
          value.executionPath,
          value.branchRef ?? null,
          value.baseRevision,
          value.currentRevision,
          value.state,
          null,
          value.version,
          value.createdAt,
          value.updatedAt,
        );
      this.events.appendInTransaction({
        eventId: crypto.randomUUID(),
        aggregateId: value.rootPlanId,
        aggregateType: 'PLAN',
        type: 'PLAN_WORKTREE_REGISTERED',
        payload: {
          worktreeId: value.worktreeId,
          role: value.role,
          workItemId: value.workItemId ?? null,
          baseRevision: value.baseRevision,
        },
        occurredAt: at,
        correlationId: value.rootPlanId,
      });
      return { status: 'created', value };
    });
  }

  get(worktreeId: string): PlanWorktree {
    const value = this.getOptional(worktreeId);
    if (!value) throw new V4Error('WORKTREE_NOT_FOUND');
    return value;
  }

  getOptional(worktreeId: string): PlanWorktree | undefined {
    const row = this.db
      .prepare('SELECT * FROM plan_worktrees WHERE worktree_id=?')
      .get(worktreeId) as Row | undefined;
    return row ? record(row) : undefined;
  }

  findByPath(hostPath: string): PlanWorktree | undefined {
    const row = this.db.prepare('SELECT * FROM plan_worktrees WHERE host_path=?').get(hostPath) as
      Row | undefined;
    return row ? record(row) : undefined;
  }

  findForWorkItem(rootPlanId: string, workItemId: string): PlanWorktree | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM plan_worktrees WHERE root_plan_id=? AND work_item_id=? AND role='WORK_ITEM' AND state!='RETIRED' ORDER BY created_at DESC LIMIT 1",
      )
      .get(rootPlanId, workItemId) as Row | undefined;
    return row ? record(row) : undefined;
  }

  findIntegration(rootPlanId: string): PlanWorktree | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM plan_worktrees WHERE root_plan_id=? AND role='INTEGRATION' AND state!='RETIRED' ORDER BY created_at DESC LIMIT 1",
      )
      .get(rootPlanId) as Row | undefined;
    return row ? record(row) : undefined;
  }

  listByPlan(rootPlanId: string): PlanWorktree[] {
    const rows = this.db
      .prepare('SELECT * FROM plan_worktrees WHERE root_plan_id=? ORDER BY created_at,worktree_id')
      .all(rootPlanId) as unknown as Row[];
    return rows.map(record);
  }

  transition(
    worktreeId: string,
    expectedVersion: number,
    next: PlanWorktreeState,
  ): MutationResult<PlanWorktree> {
    return withTransaction(this.db, () => {
      const current = this.get(worktreeId);
      if (current.version !== expectedVersion)
        return { status: 'rejected', value: current, reason: 'STALE_VERSION' };
      if (current.state === next) return { status: 'existing', value: current };
      transitionPlanWorktree(current, next);
      const at = now();
      const result = this.db
        .prepare(
          'UPDATE plan_worktrees SET state=?,version=version+1,updated_at=? WHERE worktree_id=? AND version=?',
        )
        .run(next, at, worktreeId, expectedVersion);
      if (Number(result.changes) !== 1)
        return { status: 'rejected', value: this.get(worktreeId), reason: 'STALE_VERSION' };
      return { status: 'updated', value: this.get(worktreeId) };
    });
  }

  attachWriter(
    worktreeId: string,
    executionId: string,
    expectedVersion: number,
  ): MutationResult<PlanWorktree> {
    failClosed(executionId.trim().length > 0, 'WORKTREE_EXECUTION_REQUIRED');
    return withTransaction(this.db, () => {
      const current = this.get(worktreeId);
      if (current.version !== expectedVersion)
        return { status: 'rejected', value: current, reason: 'STALE_VERSION' };
      if (current.ownerExecutionId) {
        return current.ownerExecutionId === executionId
          ? { status: 'existing', value: current }
          : { status: 'rejected', value: current, reason: 'WORKTREE_WRITER_HELD' };
      }
      if (current.state !== 'READY' && current.state !== 'QUIESCENT')
        return { status: 'rejected', value: current, reason: 'WORKTREE_NOT_WRITABLE' };
      const at = now();
      const result = this.db
        .prepare(
          "UPDATE plan_worktrees SET state='WRITER_ATTACHED',owner_execution_id=?,version=version+1,updated_at=? WHERE worktree_id=? AND version=? AND owner_execution_id IS NULL",
        )
        .run(executionId, at, worktreeId, expectedVersion);
      if (Number(result.changes) !== 1)
        return { status: 'rejected', value: this.get(worktreeId), reason: 'STALE_VERSION' };
      return { status: 'updated', value: this.get(worktreeId) };
    });
  }

  releaseWriter(
    worktreeId: string,
    executionId: string,
    expectedVersion: number,
    currentRevision: string,
  ): MutationResult<PlanWorktree> {
    failClosed(currentRevision.trim().length > 0, 'WORKTREE_CURRENT_REVISION_REQUIRED');
    return withTransaction(this.db, () => {
      const current = this.get(worktreeId);
      if (current.version !== expectedVersion)
        return { status: 'rejected', value: current, reason: 'STALE_VERSION' };
      if (current.ownerExecutionId !== executionId)
        return { status: 'rejected', value: current, reason: 'WORKTREE_WRITER_OWNER_MISMATCH' };
      if (current.state !== 'WRITER_ATTACHED')
        return { status: 'rejected', value: current, reason: 'WORKTREE_WRITER_STATE_INVALID' };
      const at = now();
      const result = this.db
        .prepare(
          "UPDATE plan_worktrees SET state='QUIESCENT',owner_execution_id=NULL,current_revision=?,version=version+1,updated_at=? WHERE worktree_id=? AND version=? AND owner_execution_id=?",
        )
        .run(currentRevision, at, worktreeId, expectedVersion, executionId);
      if (Number(result.changes) !== 1)
        return { status: 'rejected', value: this.get(worktreeId), reason: 'STALE_VERSION' };
      return { status: 'updated', value: this.get(worktreeId) };
    });
  }

  updateRevision(
    worktreeId: string,
    expectedVersion: number,
    currentRevision: string,
  ): MutationResult<PlanWorktree> {
    failClosed(currentRevision.trim().length > 0, 'WORKTREE_CURRENT_REVISION_REQUIRED');
    return withTransaction(this.db, () => {
      const current = this.get(worktreeId);
      if (current.version !== expectedVersion)
        return { status: 'rejected', value: current, reason: 'STALE_VERSION' };
      const at = now();
      const result = this.db
        .prepare(
          'UPDATE plan_worktrees SET current_revision=?,version=version+1,updated_at=? WHERE worktree_id=? AND version=?',
        )
        .run(currentRevision, at, worktreeId, expectedVersion);
      if (Number(result.changes) !== 1)
        return { status: 'rejected', value: this.get(worktreeId), reason: 'STALE_VERSION' };
      return { status: 'updated', value: this.get(worktreeId) };
    });
  }
}
