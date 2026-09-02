import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { validatePlanDeliveryConfig, type DeliveryObservation, type DeliveryStatus, type PlanDelivery, type PlanDeliveryConfig } from '../domain/delivery.js';
import { DuplicateKeyError, StaleStateError, V4Error, failClosed } from '../domain/errors.js';
import { assertSafeEventPayload, type EventEnvelope } from '../domain/events.js';
import { transitionExecution, validateExecutionIdentity, type Execution, type ExecutionIdentity, type ExecutionPhase, type ExecutionStatus } from '../domain/execution.js';
import { transitionPlan, validatePlanInput, type CreatePlanInput, type Plan, type PlanStatus } from '../domain/plan.js';
import { transitionReview, validateReviewLineage, type Review, type ReviewStatus } from '../domain/review.js';
import { type Lease, validateResourceObservation, type ResourceObservation } from '../domain/resource.js';
import { transitionAction, validateActionShape, type ActionStatus, type SupervisorAction } from '../domain/action.js';
import { transitionSupervisor, validateSupervisor, type Supervisor, type SupervisorDecision, type SupervisorStatus, type SupervisorWakeReason } from '../domain/supervisor.js';
import { transitionWorkItem, validateGraphItems, type GraphVersion, type WorkItem, type WorkItemStatus } from '../domain/workGraph.js';
import { withTransaction } from './database.js';
import { EventStore } from './eventStore.js';
import { ExecutionEvidenceRepository, ExecutionSessionRepository } from './executionArtifacts.js';

export type MutationStatus = 'created' | 'existing' | 'updated' | 'rejected';
export interface MutationResult<T> { status: MutationStatus; value?: T; reason?: string; }

const iso = (): string => new Date().toISOString();
const id = (prefix: string): string => prefix + '_' + randomUUID();
const encode = (value: unknown): string => JSON.stringify(value);
const decode = <T>(value: string): T => JSON.parse(value) as T;

function makeEvent(aggregateId: string, aggregateType: EventEnvelope['aggregateType'], type: string, payload: Record<string, unknown>, correlationId = aggregateId) {
  return { eventId: randomUUID(), aggregateId, aggregateType, type, payload, occurredAt: iso(), correlationId };
}


function scheduleSupervisorWakeForPlan(
  db: DatabaseSync,
  planId: string,
  reason: SupervisorWakeReason,
  requestedAt = iso(),
): void {
  const supervisor = db.prepare('SELECT supervisor_id,observation_cursor FROM supervisors WHERE plan_id=?').get(planId) as
    | { supervisor_id: string; observation_cursor: number }
    | undefined;
  if (!supervisor) return;
  const row = db.prepare('SELECT COALESCE(MAX(event_order),0) AS cursor FROM events').get() as { cursor: number };
  const cursor = Number(row.cursor);
  if (!Number.isInteger(cursor) || cursor <= supervisor.observation_cursor) return;
  const wakeKey = supervisor.supervisor_id + ':' + cursor + ':' + reason;
  db.prepare('INSERT OR IGNORE INTO supervisor_wakes(wake_key,supervisor_id,observation_cursor,reason,requested_at) VALUES(?,?,?,?,?)').run(
    wakeKey,
    supervisor.supervisor_id,
    cursor,
    reason,
    requestedAt,
  );
}

interface PlanRow {
  plan_id: string; idempotency_key: string; project_key: string; objective: string; repository_path: string;
  base_revision: string; current_revision: string; status: PlanStatus; active_graph_version_id: string | null;
  parent_plan_id: string | null; created_at: string; updated_at: string;
}
function planFrom(row: PlanRow, children: string[] = []): Plan {
  return { planId: row.plan_id, idempotencyKey: row.idempotency_key, projectKey: row.project_key, objective: row.objective,
    repositoryPath: row.repository_path, baseRevision: row.base_revision, currentRevision: row.current_revision,
    status: row.status, activeGraphVersionId: row.active_graph_version_id ?? undefined, parentPlanId: row.parent_plan_id ?? undefined,
    childPlanIds: children, createdAt: row.created_at, updatedAt: row.updated_at };
}

interface DeliveryRow {
  plan_id: string; remote: string; branch: string; target_branch: string; auto_merge: number; merge_method: PlanDeliveryConfig['mergeMethod'];
  required_checks: string; status: DeliveryStatus; head_sha: string | null; pull_request_number: number | null;
  pull_request_url: string | null; merge_sha: string | null; error_code: string | null; superseded_by_plan_id: string | null; created_at: string; updated_at: string;
}
function deliveryFrom(row: DeliveryRow): PlanDelivery {
  return {
    planId: row.plan_id,
    remote: row.remote,
    branch: row.branch,
    targetBranch: row.target_branch,
    autoMerge: Boolean(row.auto_merge),
    mergeMethod: row.merge_method,
    requiredChecks: decode<string[]>(row.required_checks),
    status: row.status,
    headSha: row.head_sha ?? undefined,
    pullRequestNumber: row.pull_request_number ?? undefined,
    pullRequestUrl: row.pull_request_url ?? undefined,
    mergeSha: row.merge_sha ?? undefined,
    errorCode: row.error_code ?? undefined,
    supersededByPlanId: row.superseded_by_plan_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DELIVERY_STAGE: Record<DeliveryStatus, number> = {
  PENDING: 0,
  PUSHED: 1,
  PR_OPEN: 2,
  CHECKS_PENDING: 2,
  READY_TO_MERGE: 3,
  MERGED: 4,
  VERIFIED: 5,
  SUPERSEDED: 6,
};

interface GraphRow {
  graph_version_id: string; plan_id: string; version: number; parent_graph_version_id: string | null;
  reason: string; triggering_observation_cursor: number | null; status: GraphVersion['status']; created_at: string;
}
function graphFrom(row: GraphRow): GraphVersion {
  return { graphVersionId: row.graph_version_id, planId: row.plan_id, version: row.version,
    parentGraphVersionId: row.parent_graph_version_id ?? undefined, reason: row.reason,
    triggeringObservationCursor: row.triggering_observation_cursor ?? undefined, status: row.status, createdAt: row.created_at };
}

interface WorkRow {
  work_item_id: string; plan_id: string; graph_version_id: string; item_key: string; title: string; objective: string;
  acceptance_criteria: string; dependencies: string; status: WorkItemStatus; exact_accepted_revision: string | null;
  created_at: string; updated_at: string;
}
function workFrom(row: WorkRow): WorkItem {
  return { workItemId: row.work_item_id, planId: row.plan_id, graphVersionId: row.graph_version_id, itemKey: row.item_key,
    title: row.title, objective: row.objective, acceptanceCriteria: decode<string[]>(row.acceptance_criteria),
    dependencies: decode<string[]>(row.dependencies), status: row.status, exactAcceptedRevision: row.exact_accepted_revision ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export class PlanRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}

  createPlan(input: CreatePlanInput): MutationResult<Plan> {
    validatePlanInput(input);
    if (input.delivery) validatePlanDeliveryConfig(input.delivery);
    return withTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM plans WHERE idempotency_key=?').get(input.idempotencyKey) as PlanRow | undefined;
      if (existing) {
        if (existing.project_key !== input.projectKey || existing.objective !== input.objective || existing.repository_path !== input.repositoryPath || existing.base_revision !== input.baseRevision) throw new DuplicateKeyError(input.idempotencyKey);
        const existingDelivery = this.getDelivery(existing.plan_id);
        const requestedDelivery = input.delivery;
        if (Boolean(existingDelivery) !== Boolean(requestedDelivery)) throw new DuplicateKeyError(input.idempotencyKey);
        if (existingDelivery && requestedDelivery && !this.deliveryConfigEqual(existingDelivery, requestedDelivery)) throw new DuplicateKeyError(input.idempotencyKey);
        return { status: 'existing', value: this.getPlan(existing.plan_id) };
      }
      const planId = input.planId ?? id('plan');
      const createdAt = iso();
      this.db.prepare('INSERT INTO plans(plan_id,idempotency_key,project_key,objective,repository_path,base_revision,current_revision,status,parent_plan_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        planId, input.idempotencyKey, input.projectKey, input.objective, input.repositoryPath, input.baseRevision, input.baseRevision, 'DRAFT', input.parentPlanId ?? null, createdAt, createdAt);
      if (input.delivery) this.insertDelivery(planId, input.delivery, createdAt);
      this.events.appendInTransaction(makeEvent(planId, 'PLAN', 'PLAN_CREATED', { planId, projectKey: input.projectKey, objective: input.objective, repositoryPath: input.repositoryPath, baseRevision: input.baseRevision, deliveryRequired: Boolean(input.delivery) }, input.idempotencyKey));
      return { status: 'created', value: this.getPlan(planId) };
    });
  }

  createChildPlan(input: {
    parentPlanId: string;
    childPlanId: string;
    repositoryPath: string;
    objective: string;
    relation: 'SYSTEM_REPAIR' | 'INFRASTRUCTURE_REPAIR' | 'FOLLOW_UP';
  }): { plan: Plan; relationshipId: string } {
    return withTransaction(this.db, () => {
      const parent = this.getPlan(input.parentPlanId);
      const childInput: CreatePlanInput = {
        planId: input.childPlanId,
        idempotencyKey: 'child-plan:' + input.parentPlanId + ':' + input.childPlanId,
        projectKey: parent.projectKey,
        objective: input.objective,
        repositoryPath: input.repositoryPath,
        baseRevision: parent.currentRevision,
        parentPlanId: parent.planId,
      };
      validatePlanInput(childInput);
      let row = this.db.prepare('SELECT * FROM plans WHERE idempotency_key=?').get(childInput.idempotencyKey) as PlanRow | undefined;
      if (row) {
        if (row.plan_id !== input.childPlanId || row.parent_plan_id !== parent.planId || row.objective !== input.objective || row.repository_path !== input.repositoryPath || row.base_revision !== parent.currentRevision) {
          throw new DuplicateKeyError(childInput.idempotencyKey);
        }
      } else {
        const conflictingId = this.db.prepare('SELECT plan_id FROM plans WHERE plan_id=?').get(input.childPlanId);
        if (conflictingId) throw new DuplicateKeyError(input.childPlanId);
        const createdAt = iso();
        this.db.prepare('INSERT INTO plans(plan_id,idempotency_key,project_key,objective,repository_path,base_revision,current_revision,status,parent_plan_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
          input.childPlanId, childInput.idempotencyKey, childInput.projectKey, childInput.objective, childInput.repositoryPath,
          childInput.baseRevision, childInput.baseRevision, 'DRAFT', parent.planId, createdAt, createdAt);
        this.events.appendInTransaction(makeEvent(input.childPlanId, 'PLAN', 'PLAN_CREATED', {
          planId: input.childPlanId, projectKey: childInput.projectKey, objective: childInput.objective,
          repositoryPath: childInput.repositoryPath, baseRevision: childInput.baseRevision, parentPlanId: parent.planId,
        }, childInput.idempotencyKey));
        row = this.db.prepare('SELECT * FROM plans WHERE plan_id=?').get(input.childPlanId) as unknown as PlanRow;
      }

      const existing = this.db.prepare('SELECT relationship_id,parent_plan_id,kind FROM plan_relationships WHERE child_plan_id=?').get(input.childPlanId) as { relationship_id: string; parent_plan_id: string; kind: string } | undefined;
      let relationshipId: string;
      if (existing) {
        if (existing.parent_plan_id !== parent.planId || existing.kind !== input.relation) throw new V4Error('PARENT_CHILD_PARENT_CONFLICT');
        relationshipId = existing.relationship_id;
      } else {
        if (parent.planId === input.childPlanId) throw new V4Error('PARENT_CHILD_SELF_CYCLE');
        const cycle = this.db.prepare('WITH RECURSIVE descendants(plan_id) AS (SELECT child_plan_id FROM plan_relationships WHERE parent_plan_id=? UNION SELECT relationships.child_plan_id FROM plan_relationships relationships JOIN descendants ON relationships.parent_plan_id=descendants.plan_id) SELECT plan_id FROM descendants WHERE plan_id=? LIMIT 1').get(input.childPlanId, parent.planId);
        if (cycle) throw new V4Error('PARENT_CHILD_CYCLE');
        relationshipId = id('relationship');
        this.db.prepare('INSERT INTO plan_relationships(relationship_id,parent_plan_id,child_plan_id,kind,created_at) VALUES(?,?,?,?,?)').run(
          relationshipId, parent.planId, input.childPlanId, input.relation, iso());
        this.events.appendInTransaction(makeEvent(relationshipId, 'RELATIONSHIP', 'PARENT_CHILD_CREATED', {
          relationshipId, parentPlanId: parent.planId, childPlanId: input.childPlanId, kind: input.relation,
        }));
      }

      if ((input.relation === 'SYSTEM_REPAIR' || input.relation === 'INFRASTRUCTURE_REPAIR') && (parent.status === 'READY' || parent.status === 'RUNNING')) {
        const updated = transitionPlan(parent, 'WAITING_FOR_SYSTEM_REPAIR', iso());
        this.db.prepare('UPDATE plans SET status=?,updated_at=? WHERE plan_id=? AND status=?').run(updated.status, updated.updatedAt, parent.planId, parent.status);
        this.events.appendInTransaction(makeEvent(parent.planId, 'PLAN', 'PLAN_STATUS_CHANGED', { from: parent.status, to: updated.status }));
      }
      return { plan: this.getPlan(row.plan_id), relationshipId };
    });
  }

  getPlan(planId: string): Plan {
    const row = this.db.prepare('SELECT * FROM plans WHERE plan_id=?').get(planId) as PlanRow | undefined;
    if (!row) throw new V4Error('PLAN_NOT_FOUND', 'Plan not found: ' + planId);
    const children = this.db.prepare('SELECT child_plan_id FROM plan_relationships WHERE parent_plan_id=? ORDER BY created_at').all(planId) as unknown as Array<{ child_plan_id: string }>;
    const delivery = this.getDelivery(planId);
    return { ...planFrom(row, children.map((child) => child.child_plan_id)), ...(delivery ? { delivery } : {}) };
  }

  getDelivery(planId: string): PlanDelivery | undefined {
    const row = this.db.prepare('SELECT * FROM plan_deliveries WHERE plan_id=?').get(planId) as DeliveryRow | undefined;
    return row ? deliveryFrom(row) : undefined;
  }

  attachDelivery(planId: string, config: PlanDeliveryConfig): MutationResult<PlanDelivery> {
    validatePlanDeliveryConfig(config);
    return withTransaction(this.db, () => {
      this.getPlan(planId);
      const existing = this.getDelivery(planId);
      if (existing) {
        if (!this.deliveryConfigEqual(existing, config)) throw new V4Error('PLAN_DELIVERY_CONFLICT');
        return { status: 'existing', value: existing };
      }
      const createdAt = iso();
      this.insertDelivery(planId, config, createdAt);
      this.events.appendInTransaction(makeEvent(planId, 'DELIVERY', 'PLAN_DELIVERY_ATTACHED', {
        remote: config.remote, branch: config.branch, targetBranch: config.targetBranch,
        autoMerge: config.autoMerge, mergeMethod: config.mergeMethod, requiredChecks: config.requiredChecks,
      }));
      return { status: 'created', value: this.getDelivery(planId)! };
    });
  }

  recordDeliveryObservation(planId: string, observation: DeliveryObservation): MutationResult<PlanDelivery> {
    return withTransaction(this.db, () => {
      const current = this.getDelivery(planId);
      if (!current) throw new V4Error('PLAN_DELIVERY_REQUIRED');
      if (DELIVERY_STAGE[observation.status] < DELIVERY_STAGE[current.status]) throw new V4Error('DELIVERY_STATUS_REGRESSION');
      const immutable = <T>(previous: T | undefined, next: T | undefined, code: string): T | undefined => {
        if (previous !== undefined && next !== undefined && previous !== next) throw new V4Error(code);
        return next ?? previous;
      };
      const headSha = immutable(current.headSha, observation.headSha, 'DELIVERY_HEAD_SHA_CONFLICT');
      const pullRequestNumber = immutable(current.pullRequestNumber, observation.pullRequestNumber, 'DELIVERY_PR_CONFLICT');
      const pullRequestUrl = immutable(current.pullRequestUrl, observation.pullRequestUrl, 'DELIVERY_PR_CONFLICT');
      const mergeSha = immutable(current.mergeSha, observation.mergeSha, 'DELIVERY_MERGE_SHA_CONFLICT');
      const updatedAt = iso();
      this.db.prepare('UPDATE plan_deliveries SET status=?,head_sha=?,pull_request_number=?,pull_request_url=?,merge_sha=?,error_code=?,updated_at=? WHERE plan_id=?').run(
        observation.status, headSha ?? null, pullRequestNumber ?? null, pullRequestUrl ?? null, mergeSha ?? null,
        observation.errorCode ?? null, updatedAt, planId);
      this.events.appendInTransaction(makeEvent(planId, 'DELIVERY', 'PLAN_DELIVERY_OBSERVED', {
        status: observation.status, headSha: headSha ?? null, pullRequestNumber: pullRequestNumber ?? null,
        mergeSha: mergeSha ?? null, errorCode: observation.errorCode ?? null,
      }));
      return { status: 'updated', value: this.getDelivery(planId)! };
    });
  }

  supersedeDelivery(planId: string, childPlanId: string): MutationResult<PlanDelivery> {
    return withTransaction(this.db, () => {
      const parent = this.getPlan(planId);
      const current = this.getDelivery(planId);
      if (!current) throw new V4Error('PLAN_DELIVERY_REQUIRED');
      if (current.status === 'VERIFIED') throw new V4Error('DELIVERY_ALREADY_VERIFIED');
      if (current.status === 'SUPERSEDED') {
        if (current.supersededByPlanId !== childPlanId) throw new V4Error('DELIVERY_SUPERSEDED_CHILD_CONFLICT');
        return { status: 'existing', value: current };
      }
      const child = this.getPlan(childPlanId);
      const relation = this.db.prepare(
        'SELECT kind FROM plan_relationships WHERE parent_plan_id=? AND child_plan_id=?',
      ).get(planId, childPlanId) as { kind: string } | undefined;
      if (!relation || relation.kind !== 'FOLLOW_UP') throw new V4Error('DELIVERY_SUPERSEDING_CHILD_RELATION_REQUIRED');
      if (child.parentPlanId !== planId) throw new V4Error('DELIVERY_SUPERSEDING_CHILD_PARENT_MISMATCH');
      if (child.baseRevision !== parent.currentRevision)
        throw new V4Error('DELIVERY_SUPERSEDING_CHILD_BASE_MISMATCH');
      if (child.status !== 'SUCCEEDED' || child.delivery?.status !== 'VERIFIED')
        throw new V4Error('DELIVERY_SUPERSEDING_CHILD_NOT_VERIFIED');
      const childDelivery = child.delivery;
      if (childDelivery.headSha !== child.currentRevision || !childDelivery.mergeSha)
        throw new V4Error('DELIVERY_SUPERSEDING_CHILD_EXACT_REVISION_REQUIRED');
      if (!this.deliveryConfigEqual(current, childDelivery))
        throw new V4Error('DELIVERY_SUPERSEDING_CHILD_CONFIG_MISMATCH');
      if (
        current.pullRequestNumber !== undefined &&
        childDelivery.pullRequestNumber !== undefined &&
        current.pullRequestNumber !== childDelivery.pullRequestNumber
      )
        throw new V4Error('DELIVERY_SUPERSEDING_CHILD_PR_MISMATCH');
      const updatedAt = iso();
      this.db.prepare(
        'UPDATE plan_deliveries SET status=?,superseded_by_plan_id=?,merge_sha=?,error_code=NULL,updated_at=? WHERE plan_id=?',
      ).run('SUPERSEDED', childPlanId, childDelivery.mergeSha ?? current.mergeSha ?? null, updatedAt, planId);
      this.events.appendInTransaction(makeEvent(planId, 'DELIVERY', 'PLAN_DELIVERY_SUPERSEDED', {
        childPlanId,
        childHeadSha: childDelivery.headSha ?? null,
        mergeSha: childDelivery.mergeSha ?? null,
        pullRequestNumber: childDelivery.pullRequestNumber ?? null,
      }));
      return { status: 'updated', value: this.getDelivery(planId)! };
    });
  }

  recordDeliveryError(planId: string, errorCode: string): MutationResult<PlanDelivery> {
    failClosed(errorCode.trim().length > 0 && errorCode.length <= 500, 'DELIVERY_ERROR_CODE_INVALID');
    return withTransaction(this.db, () => {
      const current = this.getDelivery(planId);
      if (!current) throw new V4Error('PLAN_DELIVERY_REQUIRED');
      const updatedAt = iso();
      this.db.prepare('UPDATE plan_deliveries SET error_code=?,updated_at=? WHERE plan_id=?').run(errorCode, updatedAt, planId);
      this.events.appendInTransaction(makeEvent(planId, 'DELIVERY', 'PLAN_DELIVERY_ERROR_RECORDED', { status: current.status, errorCode }));
      return { status: 'updated', value: this.getDelivery(planId)! };
    });
  }

  private insertDelivery(planId: string, config: PlanDeliveryConfig, createdAt: string): void {
    this.db.prepare('INSERT INTO plan_deliveries(plan_id,remote,branch,target_branch,auto_merge,merge_method,required_checks,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      planId, config.remote, config.branch, config.targetBranch, config.autoMerge ? 1 : 0, config.mergeMethod,
      encode(config.requiredChecks), 'PENDING', createdAt, createdAt);
  }

  private deliveryConfigEqual(left: PlanDelivery, right: PlanDeliveryConfig): boolean {
    return left.remote === right.remote && left.branch === right.branch && left.targetBranch === right.targetBranch
      && left.autoMerge === right.autoMerge && left.mergeMethod === right.mergeMethod
      && JSON.stringify(left.requiredChecks) === JSON.stringify(right.requiredChecks);
  }

  getPlanByIdempotencyKey(key: string): Plan | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE idempotency_key=?').get(key) as PlanRow | undefined;
    return row ? this.getPlan(row.plan_id) : undefined;
  }

  listPlans(input: { status?: PlanStatus; limit?: number } = {}): Plan[] {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
    const rows = input.status
      ? this.db.prepare('SELECT plan_id FROM plans WHERE status=? ORDER BY updated_at DESC LIMIT ?').all(input.status, limit) as unknown as Array<{ plan_id: string }>
      : this.db.prepare('SELECT plan_id FROM plans ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as Array<{ plan_id: string }>;
    return rows.map((row) => this.getPlan(row.plan_id));
  }

  reconcileCurrentRevision(planId: string, expectedRevision: string, observedRevision: string, reason: string): MutationResult<Plan> {
    failClosed(expectedRevision.trim().length > 0 && observedRevision.trim().length > 0, 'PLAN_REVISION_REQUIRED');
    failClosed(reason.trim().length > 0, 'PLAN_REVISION_REASON_REQUIRED');
    return withTransaction(this.db, () => {
      const current = this.getPlan(planId);
      if (current.currentRevision === observedRevision) return { status: 'existing', value: current };
      if (current.currentRevision !== expectedRevision) return { status: 'rejected', value: current, reason: 'STALE_REVISION' };
      if (current.status === 'SUCCEEDED' || current.status === 'FAILED' || current.status === 'CANCELLED') throw new V4Error('PLAN_REVISION_TERMINAL');
      const updatedAt = iso();
      const result = this.db.prepare('UPDATE plans SET current_revision=?,updated_at=? WHERE plan_id=? AND current_revision=?').run(observedRevision, updatedAt, planId, expectedRevision);
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.getPlan(planId), reason: 'STALE_REVISION' };
      this.events.appendInTransaction(makeEvent(planId, 'PLAN', 'PLAN_REVISION_RECONCILED', { from: expectedRevision, to: observedRevision, reason }));
      return { status: 'updated', value: this.getPlan(planId) };
    });
  }

  advanceAcceptedRevision(planId: string, expectedRevision: string, acceptedRevision: string, reason: string): MutationResult<Plan> {
    failClosed(expectedRevision.trim().length > 0 && acceptedRevision.trim().length > 0, 'PLAN_REVISION_REQUIRED');
    failClosed(reason.trim().length > 0, 'PLAN_REVISION_REASON_REQUIRED');
    return withTransaction(this.db, () => {
      const current = this.getPlan(planId);
      if (current.currentRevision === acceptedRevision) return { status: 'existing', value: current };
      if (current.currentRevision !== expectedRevision) return { status: 'rejected', value: current, reason: 'STALE_REVISION' };
      if (current.status !== 'RUNNING') throw new V4Error('PLAN_NOT_RUNNING');
      const updatedAt = iso();
      const result = this.db.prepare('UPDATE plans SET current_revision=?,updated_at=? WHERE plan_id=? AND current_revision=? AND status=?').run(acceptedRevision, updatedAt, planId, expectedRevision, 'RUNNING');
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.getPlan(planId), reason: 'STALE_REVISION' };
      this.events.appendInTransaction(makeEvent(planId, 'PLAN', 'PLAN_ACCEPTED_REVISION_ADVANCED', { from: expectedRevision, to: acceptedRevision, reason }));
      return { status: 'updated', value: this.getPlan(planId) };
    });
  }

  updateStatus(planId: string, next: PlanStatus): MutationResult<Plan> {
    return withTransaction(this.db, () => {
      const current = this.getPlan(planId);
      const updated = transitionPlan(current, next, iso());
      this.db.prepare('UPDATE plans SET status=?,updated_at=? WHERE plan_id=?').run(next, updated.updatedAt, planId);
      this.events.appendInTransaction(makeEvent(planId, 'PLAN', 'PLAN_STATUS_CHANGED', { from: current.status, to: next }));
      return { status: 'updated', value: updated };
    });
  }

  compareAndSetStatus(planId: string, expected: PlanStatus, next: PlanStatus): MutationResult<Plan> {
    return withTransaction(this.db, () => {
      const current = this.getPlan(planId);
      if (current.status !== expected) return { status: 'rejected', value: current, reason: 'STALE_STATUS' };
      if (expected === next) return { status: 'existing', value: current };
      const updated = transitionPlan(current, next, iso());
      const result = this.db.prepare('UPDATE plans SET status=?,updated_at=? WHERE plan_id=? AND status=?').run(next, updated.updatedAt, planId, expected);
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.getPlan(planId), reason: 'STALE_STATUS' };
      this.events.appendInTransaction(makeEvent(planId, 'PLAN', 'PLAN_STATUS_CHANGED', { from: expected, to: next }));
      return { status: 'updated', value: this.getPlan(planId) };
    });
  }

  createGraphVersion(input: { planId: string; reason: string; parentGraphVersionId?: string; triggeringObservationCursor?: number; version?: number }): MutationResult<GraphVersion> {
    failClosed(input.reason.trim().length > 0, 'GRAPH_REASON_REQUIRED');
    return withTransaction(this.db, () => {
      this.getPlan(input.planId);
      const previous = this.db.prepare('SELECT graph_version_id FROM graph_versions WHERE plan_id=? AND status=?').get(input.planId, 'ACTIVE') as { graph_version_id: string } | undefined;
      const latest = this.db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM graph_versions WHERE plan_id=?').get(input.planId) as { version: number };
      const version = input.version ?? latest.version + 1;
      if (version !== latest.version + 1) throw new StaleStateError('Graph version must be append-only');
      const graph: GraphVersion = { graphVersionId: id('graph'), planId: input.planId, version,
        parentGraphVersionId: input.parentGraphVersionId, reason: input.reason, triggeringObservationCursor: input.triggeringObservationCursor,
        status: 'ACTIVE', createdAt: iso() };
      this.db.prepare('UPDATE graph_versions SET status=? WHERE plan_id=? AND status=?').run('SUPERSEDED', input.planId, 'ACTIVE');
      this.db.prepare('INSERT INTO graph_versions(graph_version_id,plan_id,version,parent_graph_version_id,reason,triggering_observation_cursor,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(
        graph.graphVersionId, graph.planId, graph.version, graph.parentGraphVersionId ?? null, graph.reason, graph.triggeringObservationCursor ?? null, graph.status, graph.createdAt);
      this.db.prepare('UPDATE plans SET active_graph_version_id=?,updated_at=? WHERE plan_id=?').run(graph.graphVersionId, graph.createdAt, input.planId);
      if (previous) this.events.appendInTransaction(makeEvent(previous.graph_version_id, 'PLAN', 'GRAPH_VERSION_SUPERSEDED', { planId: input.planId, graphVersionId: previous.graph_version_id }));
      this.events.appendInTransaction(makeEvent(graph.graphVersionId, 'PLAN', 'GRAPH_VERSION_CREATED', { planId: input.planId, version, reason: input.reason }));
      return { status: 'created', value: graph };
    });
  }

  supersedeGraphVersion(planId: string, graphVersionId: string): MutationResult<GraphVersion> {
    return withTransaction(this.db, () => {
      const graph = this.getGraphVersion(graphVersionId);
      if (graph.planId !== planId) throw new V4Error('GRAPH_PLAN_MISMATCH');
      if (graph.status === 'SUPERSEDED') return { status: 'existing', value: graph };
      if (graph.status !== 'ACTIVE') return { status: 'rejected', value: graph, reason: 'GRAPH_NOT_ACTIVE' };
      this.db.prepare('UPDATE graph_versions SET status=? WHERE graph_version_id=? AND status=?').run('SUPERSEDED', graphVersionId, 'ACTIVE');
      this.events.appendInTransaction(makeEvent(graphVersionId, 'PLAN', 'GRAPH_VERSION_SUPERSEDED', { planId, graphVersionId }));
      return { status: 'updated', value: { ...graph, status: 'SUPERSEDED' } };
    });
  }

  getActiveGraphVersion(planId: string): GraphVersion | undefined {
    const row = this.db.prepare('SELECT * FROM graph_versions WHERE plan_id=? AND status=?').get(planId, 'ACTIVE') as GraphRow | undefined;
    return row ? graphFrom(row) : undefined;
  }

  getGraphVersion(graphVersionId: string): GraphVersion {
    const row = this.db.prepare('SELECT * FROM graph_versions WHERE graph_version_id=?').get(graphVersionId) as GraphRow | undefined;
    if (!row) throw new V4Error('GRAPH_VERSION_NOT_FOUND');
    return graphFrom(row);
  }

  appendGraphWorkItem(input: { graphVersionId: string; itemKey: string; title: string; objective: string; acceptanceCriteria: string[]; dependencies: string[] }): MutationResult<WorkItem> {
    failClosed(input.itemKey.trim().length > 0, 'GRAPH_ITEM_KEY_REQUIRED');
    failClosed(input.objective.trim().length > 0, 'GRAPH_ITEM_OBJECTIVE_REQUIRED');
    return withTransaction(this.db, () => {
      const graph = this.getGraphVersion(input.graphVersionId);
      if (graph.status !== 'ACTIVE') throw new V4Error('GRAPH_VERSION_NOT_ACTIVE');
      const duplicate = this.db.prepare('SELECT * FROM work_items WHERE graph_version_id=? AND item_key=?').get(input.graphVersionId, input.itemKey) as WorkRow | undefined;
      if (duplicate) {
        if (duplicate.title !== input.title || duplicate.objective !== input.objective) throw new DuplicateKeyError(input.itemKey);
        return { status: 'existing', value: workFrom(duplicate) };
      }
      const existing = this.listWorkItems(graph.planId, graph.graphVersionId);
      validateGraphItems([...existing.map((item) => ({ itemKey: item.itemKey, dependencies: item.dependencies })), { itemKey: input.itemKey, dependencies: input.dependencies }]);
      const createdAt = iso();
      const item: WorkItem = { workItemId: id('work'), planId: graph.planId, graphVersionId: graph.graphVersionId, itemKey: input.itemKey,
        title: input.title, objective: input.objective, acceptanceCriteria: input.acceptanceCriteria, dependencies: input.dependencies,
        status: 'PENDING', createdAt, updatedAt: createdAt };
      this.db.prepare('INSERT INTO work_items(work_item_id,plan_id,graph_version_id,item_key,title,objective,acceptance_criteria,dependencies,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        item.workItemId, item.planId, item.graphVersionId, item.itemKey, item.title, item.objective, encode(item.acceptanceCriteria), encode(item.dependencies), item.status, item.createdAt, item.updatedAt);
      this.events.appendInTransaction(makeEvent(item.workItemId, 'WORK_ITEM', 'WORK_ITEM_APPENDED', { planId: item.planId, graphVersionId: item.graphVersionId, itemKey: item.itemKey }));
      return { status: 'created', value: item };
    });
  }

  listWorkItems(planId: string, graphVersionId?: string): WorkItem[] {
    const versionId = graphVersionId ?? this.getActiveGraphVersion(planId)?.graphVersionId;
    if (!versionId) return [];
    const rows = this.db.prepare('SELECT * FROM work_items WHERE plan_id=? AND graph_version_id=? ORDER BY created_at,item_key').all(planId, versionId) as unknown as WorkRow[];
    return rows.map(workFrom);
  }

  getWorkItem(workItemId: string): WorkItem {
    const row = this.db.prepare('SELECT * FROM work_items WHERE work_item_id=?').get(workItemId) as WorkRow | undefined;
    if (!row) throw new V4Error('WORK_ITEM_NOT_FOUND');
    return workFrom(row);
  }

  updateWorkItemStatus(workItemId: string, next: WorkItemStatus): MutationResult<WorkItem> {
    return withTransaction(this.db, () => {
      const current = this.getWorkItem(workItemId);
      if (current.status === next) return { status: 'existing', value: current };
      const updated = transitionWorkItem(current, next, iso());
      this.db.prepare('UPDATE work_items SET status=?,updated_at=? WHERE work_item_id=?').run(next, updated.updatedAt, workItemId);
      this.events.appendInTransaction(makeEvent(workItemId, 'WORK_ITEM', 'WORK_ITEM_STATUS_CHANGED', { planId: current.planId, from: current.status, to: next }));
      return { status: 'updated', value: this.getWorkItem(workItemId) };
    });
  }


  recoverFailedPlanWorkItem(planId: string, workItemId: string): { plan: Plan; workItem: WorkItem } {
    return withTransaction(this.db, () => {
      const plan = this.getPlan(planId);
      const item = this.getWorkItem(workItemId);
      failClosed(item.planId === planId, 'PLAN_RECOVERY_WORK_ITEM_MISMATCH');
      if (plan.status === 'RUNNING' && item.status === 'RUNNING')
        return { plan, workItem: item };
      if (plan.status !== 'FAILED') throw new V4Error('PLAN_NOT_RECOVERABLE');
      if (item.status !== 'FAILED' && item.status !== 'BLOCKED')
        throw new V4Error('PLAN_RECOVERY_WORK_ITEM_INVALID');

      const updatedAt = iso();
      const readyItem = transitionWorkItem(item, 'READY', updatedAt);
      const runningItem = transitionWorkItem(readyItem, 'RUNNING', updatedAt);
      transitionPlan(plan, 'RUNNING', updatedAt);
      const itemResult = this.db.prepare('UPDATE work_items SET status=?,updated_at=? WHERE work_item_id=? AND status=?').run(
        'RUNNING',
        runningItem.updatedAt,
        workItemId,
        item.status,
      );
      if (Number(itemResult.changes) !== 1) throw new StaleStateError('WORK_ITEM_RECOVERY_STALE');
      const planResult = this.db.prepare('UPDATE plans SET status=?,updated_at=? WHERE plan_id=? AND status=?').run(
        'RUNNING',
        updatedAt,
        planId,
        'FAILED',
      );
      if (Number(planResult.changes) !== 1) throw new StaleStateError('PLAN_RECOVERY_STALE');
      this.events.appendInTransaction(makeEvent(workItemId, 'WORK_ITEM', 'WORK_ITEM_STATUS_CHANGED', {
        planId, from: item.status, to: 'READY', recovery: true,
      }));
      this.events.appendInTransaction(makeEvent(workItemId, 'WORK_ITEM', 'WORK_ITEM_STATUS_CHANGED', {
        planId, from: 'READY', to: 'RUNNING', recovery: true,
      }));
      this.events.appendInTransaction(makeEvent(planId, 'PLAN', 'PLAN_STATUS_CHANGED', {
        from: 'FAILED', to: 'RUNNING', recovery: true, workItemId,
      }));
      return { plan: this.getPlan(planId), workItem: this.getWorkItem(workItemId) };
    });
  }

  acceptWorkItemRevision(workItemId: string, revision: string): MutationResult<WorkItem> {
    failClosed(revision.trim().length > 0, 'WORK_ITEM_ACCEPTED_REVISION_REQUIRED');
    return withTransaction(this.db, () => {
      const current = this.getWorkItem(workItemId);
      if (current.status === 'SUCCEEDED') {
        if (current.exactAcceptedRevision === revision) return { status: 'existing', value: current };
        throw new V4Error('WORK_ITEM_ACCEPTED_REVISION_IMMUTABLE');
      }
      if (current.status !== 'RUNNING') throw new V4Error('WORK_ITEM_NOT_RUNNING');
      const plan = this.getPlan(current.planId);
      if (plan.currentRevision !== revision) throw new V4Error('WORK_ITEM_REVISION_NOT_PLAN_CURRENT');
      const updated = transitionWorkItem(current, 'SUCCEEDED', iso());
      const result = this.db.prepare('UPDATE work_items SET status=?,exact_accepted_revision=?,updated_at=? WHERE work_item_id=? AND status=? AND exact_accepted_revision IS NULL').run(
        'SUCCEEDED', revision, updated.updatedAt, workItemId, 'RUNNING',
      );
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.getWorkItem(workItemId), reason: 'STALE_STATUS' };
      this.events.appendInTransaction(makeEvent(workItemId, 'WORK_ITEM', 'WORK_ITEM_REVISION_ACCEPTED', { planId: current.planId, revision }));
      return { status: 'updated', value: this.getWorkItem(workItemId) };
    });
  }

  rejectCompletedWorkRemoval(oldVersionId: string, proposedKeys: readonly string[]): void {
    const rows = this.db.prepare('SELECT item_key FROM work_items WHERE graph_version_id=? AND status=?').all(oldVersionId, 'SUCCEEDED') as unknown as Array<{ item_key: string }>;
    const keys = new Set(proposedKeys);
    for (const row of rows) if (!keys.has(row.item_key)) throw new V4Error('COMPLETED_WORK_REMOVAL_REJECTED');
  }
}

interface ExecutionRow {
  execution_id: string; idempotency_key: string; plan_id: string; work_item_id: string | null; phase: ExecutionPhase; parent_execution_id: string | null; attempt: number; route: string;
  source_revision: string | null; objective: string; status: ExecutionStatus; result_revision: string | null; result_summary: string | null;
  error_code: string | null; retryable: number | null; created_at: string; updated_at: string;
}
function executionFrom(row: ExecutionRow): Execution {
  return { identity: { executionId: row.execution_id, planId: row.plan_id, workItemId: row.work_item_id ?? undefined,
      phase: row.phase, parentExecutionId: row.parent_execution_id ?? undefined, attempt: row.attempt, route: row.route, sourceRevision: row.source_revision ?? undefined },
    idempotencyKey: row.idempotency_key, objective: row.objective, status: row.status,
    resultRevision: row.result_revision ?? undefined, resultSummary: row.result_summary ?? undefined,
    errorCode: row.error_code ?? undefined, retryable: row.retryable === null ? undefined : Boolean(row.retryable),
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export class ExecutionRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}

  create(input: { executionId?: string; idempotencyKey: string; identity: ExecutionIdentity; objective: string }): MutationResult<Execution> {
    const requestedId = input.executionId ?? input.identity.executionId;
    failClosed(requestedId === input.identity.executionId, 'EXECUTION_ID_MISMATCH');
    failClosed(input.idempotencyKey.trim().length > 0 && input.objective.trim().length > 0, 'EXECUTION_INPUT_INVALID');
    validateExecutionIdentity(input.identity);
    return withTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM executions WHERE idempotency_key=?').get(input.idempotencyKey) as ExecutionRow | undefined;
      if (existing) {
        const same = existing.execution_id === requestedId
          && existing.plan_id === input.identity.planId
          && existing.work_item_id === (input.identity.workItemId ?? null)
          && existing.phase === input.identity.phase
          && existing.parent_execution_id === (input.identity.parentExecutionId ?? null)
          && existing.attempt === input.identity.attempt
          && existing.route === input.identity.route
          && existing.source_revision === (input.identity.sourceRevision ?? null)
          && existing.objective === input.objective;
        if (!same) throw new DuplicateKeyError(input.idempotencyKey);
        return { status: 'existing', value: executionFrom(existing) };
      }
      const idConflict = this.db.prepare('SELECT idempotency_key FROM executions WHERE execution_id=?').get(requestedId) as { idempotency_key: string } | undefined;
      if (idConflict) throw new DuplicateKeyError(requestedId);
      const plan = this.db.prepare('SELECT plan_id FROM plans WHERE plan_id=?').get(input.identity.planId) as { plan_id: string } | undefined;
      if (!plan) throw new V4Error('PLAN_NOT_FOUND');
      if (input.identity.workItemId) {
        const workItem = this.db.prepare('SELECT plan_id FROM work_items WHERE work_item_id=?').get(input.identity.workItemId) as { plan_id: string } | undefined;
        if (!workItem || workItem.plan_id !== input.identity.planId) throw new V4Error('EXECUTION_WORK_ITEM_MISMATCH');
      }
      if (input.identity.phase === 'IMPLEMENT' && input.identity.parentExecutionId) {
        const parent = this.get(input.identity.parentExecutionId);
        if (parent.identity.planId !== input.identity.planId || parent.identity.workItemId !== input.identity.workItemId || parent.identity.phase !== 'IMPLEMENT') {
          throw new V4Error('EXECUTION_PARENT_INVALID');
        }
        if (parent.status !== 'FAILED' && parent.status !== 'BLOCKED' && parent.status !== 'CANCELLED') throw new V4Error('EXECUTION_PARENT_INVALID');
        if (parent.identity.sourceRevision !== input.identity.sourceRevision) throw new V4Error('EXECUTION_PARENT_REVISION_MISMATCH');
      }
      if (input.identity.phase === 'REVIEW' || input.identity.phase === 'IMPLEMENT_FIX') {
        if (!input.identity.parentExecutionId) throw new V4Error('EXECUTION_PARENT_REQUIRED');
        const parent = this.get(input.identity.parentExecutionId);
        if (parent.identity.planId !== input.identity.planId || parent.identity.workItemId !== input.identity.workItemId) throw new V4Error('EXECUTION_PARENT_INVALID');
        if (parent.status !== 'SUCCEEDED' || !parent.resultRevision || parent.resultRevision !== input.identity.sourceRevision) {
          throw new V4Error('EXECUTION_PARENT_REVISION_MISMATCH');
        }
        if (input.identity.phase === 'IMPLEMENT_FIX' && parent.identity.phase === 'REVIEW') throw new V4Error('EXECUTION_PARENT_INVALID');
      }
      const createdAt = iso();
      this.db.prepare('INSERT INTO executions(execution_id,idempotency_key,plan_id,work_item_id,phase,parent_execution_id,attempt,route,source_revision,objective,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        input.executionId ?? input.identity.executionId, input.idempotencyKey, input.identity.planId, input.identity.workItemId ?? null,
        input.identity.phase, input.identity.parentExecutionId ?? null, input.identity.attempt, input.identity.route, input.identity.sourceRevision ?? null, input.objective, 'QUEUED', createdAt, createdAt);
      this.events.appendInTransaction(makeEvent(input.identity.executionId, 'EXECUTION', 'EXECUTION_CREATED', {
        planId: input.identity.planId, workItemId: input.identity.workItemId ?? null, phase: input.identity.phase,
        parentExecutionId: input.identity.parentExecutionId ?? null, attempt: input.identity.attempt,
      }));
      return { status: 'created', value: this.get(input.identity.executionId) };
    });
  }

  get(executionId: string): Execution {
    const row = this.db.prepare('SELECT * FROM executions WHERE execution_id=?').get(executionId) as ExecutionRow | undefined;
    if (!row) throw new V4Error('EXECUTION_NOT_FOUND');
    return executionFrom(row);
  }

  findByIdempotencyKey(key: string): Execution | undefined {
    const row = this.db.prepare('SELECT * FROM executions WHERE idempotency_key=?').get(key) as ExecutionRow | undefined;
    return row ? executionFrom(row) : undefined;
  }


  list(input: { planId?: string; status?: ExecutionStatus; limit?: number } = {}): Execution[] {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.planId) {
      clauses.push('plan_id=?');
      parameters.push(input.planId);
    }
    if (input.status) {
      clauses.push('status=?');
      parameters.push(input.status);
    }
    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db
      .prepare('SELECT * FROM executions' + where + ' ORDER BY updated_at DESC,execution_id LIMIT ?')
      .all(...parameters, limit) as unknown as ExecutionRow[];
    return rows.map(executionFrom);
  }

  listByPlan(planId: string): Execution[] {
    const rows = this.db.prepare('SELECT * FROM executions WHERE plan_id=? ORDER BY created_at,execution_id').all(planId) as unknown as ExecutionRow[];
    return rows.map(executionFrom);
  }

  listByWorkItem(workItemId: string): Execution[] {
    const rows = this.db.prepare('SELECT * FROM executions WHERE work_item_id=? ORDER BY attempt,created_at').all(workItemId) as unknown as ExecutionRow[];
    return rows.map(executionFrom);
  }

  listByStatuses(statuses: readonly ExecutionStatus[], limit = 100): Execution[] {
    failClosed(statuses.length > 0, 'EXECUTION_STATUSES_REQUIRED');
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db.prepare('SELECT * FROM executions WHERE status IN (' + placeholders + ') ORDER BY updated_at LIMIT ?').all(...statuses, safeLimit) as unknown as ExecutionRow[];
    return rows.map(executionFrom);
  }

  claimLease(executionId: string, ownerId: string, ttlMs: number, at = Date.now()): MutationResult<Lease> {
    this.get(executionId);
    return new LeaseRepository(this.db, this.events).claim('EXECUTION', executionId, ownerId, ttlMs, at);
  }

  renewLease(executionId: string, ownerId: string, leaseToken: string, ttlMs: number, at = Date.now()): MutationResult<Lease> {
    return new LeaseRepository(this.db, this.events).renew('EXECUTION', executionId, ownerId, leaseToken, ttlMs, at);
  }

  releaseLease(executionId: string, ownerId: string, leaseToken: string): MutationResult<void> {
    return new LeaseRepository(this.db, this.events).release('EXECUTION', executionId, ownerId, leaseToken);
  }

  updateStatus(executionId: string, next: ExecutionStatus): MutationResult<Execution> {
    return withTransaction(this.db, () => {
      const current = this.get(executionId);
      if (current.status === next) return { status: 'existing', value: current };
      const updated = transitionExecution(current, next, iso());
      this.db.prepare('UPDATE executions SET status=?,updated_at=? WHERE execution_id=?').run(next, updated.updatedAt, executionId);
      this.events.appendInTransaction(makeEvent(executionId, 'EXECUTION', 'EXECUTION_STATUS_CHANGED', { planId: current.identity.planId, from: current.status, to: next }));
      if (next === 'CANCELLED')
        scheduleSupervisorWakeForPlan(this.db, current.identity.planId, 'TERMINAL_RESULT');
      return { status: 'updated', value: this.get(executionId) };
    });
  }

  compareAndSetStatus(executionId: string, expected: ExecutionStatus, next: ExecutionStatus): MutationResult<Execution> {
    return withTransaction(this.db, () => {
      const current = this.get(executionId);
      if (current.status !== expected) return { status: 'rejected', value: current, reason: 'STALE_STATUS' };
      if (expected === next) return { status: 'existing', value: current };
      transitionExecution(current, next, iso());
      const result = this.db.prepare('UPDATE executions SET status=?,updated_at=? WHERE execution_id=? AND status=?').run(next, iso(), executionId, expected);
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.get(executionId), reason: 'STALE_STATUS' };
      this.events.appendInTransaction(makeEvent(executionId, 'EXECUTION', 'EXECUTION_STATUS_CHANGED', { planId: current.identity.planId, from: expected, to: next }));
      if (next === 'CANCELLED')
        scheduleSupervisorWakeForPlan(this.db, current.identity.planId, 'TERMINAL_RESULT');
      return { status: 'updated', value: this.get(executionId) };
    });
  }

  recordResult(executionId: string, input: { status: 'SUCCEEDED' | 'FAILED' | 'BLOCKED'; resultRevision?: string; resultSummary?: string; errorCode?: string; retryable?: boolean }): MutationResult<Execution> {
    return withTransaction(this.db, () => {
      const current = this.get(executionId);
      if (input.status === 'SUCCEEDED') failClosed(Boolean(input.resultRevision), 'EXECUTION_RESULT_REVISION_REQUIRED');
      if (current.status === input.status) {
        const same = current.resultRevision === input.resultRevision
          && current.resultSummary === input.resultSummary
          && current.errorCode === input.errorCode
          && current.retryable === input.retryable;
        if (same) return { status: 'existing', value: current };
        throw new V4Error('EXECUTION_RESULT_IMMUTABLE');
      }
      const updated = transitionExecution(current, input.status, iso());
      this.db.prepare('UPDATE executions SET status=?,result_revision=?,result_summary=?,error_code=?,retryable=?,updated_at=? WHERE execution_id=?').run(
        input.status, input.resultRevision ?? null, input.resultSummary ?? null, input.errorCode ?? null,
        input.retryable === undefined ? null : Number(input.retryable), updated.updatedAt, executionId);
      this.events.appendInTransaction(makeEvent(executionId, 'EXECUTION', 'EXECUTION_RESULT_RECORDED', { status: input.status, resultRevision: input.resultRevision ?? null, errorCode: input.errorCode ?? null }));
      scheduleSupervisorWakeForPlan(this.db, current.identity.planId, 'TERMINAL_RESULT');
      return { status: 'updated', value: this.get(executionId) };
    });
  }
}

interface ReviewRow {
  review_id: string; idempotency_key: string; plan_id: string; work_item_id: string | null; implementation_execution_id: string;
  reviewer_execution_id: string | null; source_revision: string; reviewed_sha: string; status: ReviewStatus; verdict: Review['verdict'] | null;
  findings: string | null; created_at: string; updated_at: string;
}
function reviewFrom(row: ReviewRow): Review {
  return { reviewId: row.review_id, planId: row.plan_id, workItemId: row.work_item_id ?? undefined,
    implementationExecutionId: row.implementation_execution_id, reviewerExecutionId: row.reviewer_execution_id ?? undefined,
    sourceRevision: row.source_revision, reviewedSha: row.reviewed_sha, status: row.status,
    verdict: row.verdict ?? undefined, findings: row.findings ? decode<string[]>(row.findings) : undefined,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

interface ReviewExecutionBindingRow {
  plan_id: string;
  work_item_id: string | null;
  source_revision: string | null;
  status: ExecutionStatus;
  result_revision: string | null;
  phase: string | null;
  provider_status: string | null;
  provider_session_id: string | null;
}

function reviewerBinding(db: DatabaseSync, executionId: string): ReviewExecutionBindingRow | undefined {
  return db.prepare(`SELECT executions.plan_id,executions.work_item_id,executions.source_revision,executions.status,executions.result_revision,
    execution_sessions.phase,execution_sessions.provider_status,execution_sessions.provider_session_id
    FROM executions LEFT JOIN execution_sessions ON execution_sessions.execution_id=executions.execution_id
    WHERE executions.execution_id=?`).get(executionId) as ReviewExecutionBindingRow | undefined;
}

function assertReviewerBinding(db: DatabaseSync, review: Pick<Review, 'planId' | 'workItemId' | 'implementationExecutionId' | 'sourceRevision'>, reviewerExecutionId: string): ReviewExecutionBindingRow {
  if (reviewerExecutionId === review.implementationExecutionId) throw new V4Error('REVIEWER_NOT_INDEPENDENT');
  const reviewer = reviewerBinding(db, reviewerExecutionId);
  if (!reviewer
    || reviewer.plan_id !== review.planId
    || reviewer.work_item_id !== (review.workItemId ?? null)
    || reviewer.source_revision !== review.sourceRevision) {
    throw new V4Error('REVIEWER_EXECUTION_INVALID');
  }
  if (reviewer.phase !== 'REVIEW' || !reviewer.provider_session_id) throw new V4Error('REVIEWER_SESSION_INVALID');
  const implementation = reviewerBinding(db, review.implementationExecutionId);
  if (implementation?.provider_session_id && implementation.provider_session_id === reviewer.provider_session_id) {
    throw new V4Error('REVIEWER_NOT_INDEPENDENT');
  }
  return reviewer;
}

function assertReviewCompletion(db: DatabaseSync, review: Review): void {
  if (!review.reviewerExecutionId) throw new V4Error('REVIEWER_EXECUTION_REQUIRED');
  const reviewer = assertReviewerBinding(db, review, review.reviewerExecutionId);
  if (reviewer.status !== 'SUCCEEDED' || reviewer.result_revision !== review.sourceRevision || reviewer.provider_status !== 'SUCCEEDED') {
    throw new V4Error('REVIEWER_EXECUTION_NOT_SUCCEEDED');
  }
  const implementation = reviewerBinding(db, review.implementationExecutionId);
  if (!implementation
    || (implementation.phase !== 'IMPLEMENT' && implementation.phase !== 'IMPLEMENT_FIX')
    || implementation.provider_status !== 'SUCCEEDED'
    || !implementation.provider_session_id) {
    throw new V4Error('IMPLEMENTATION_SESSION_NOT_SUCCEEDED');
  }
}

export class ReviewRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}

  create(input: { reviewId?: string; idempotencyKey: string; planId: string; workItemId?: string; implementationExecutionId: string; sourceRevision: string; reviewerExecutionId?: string }): MutationResult<Review> {
    validateReviewLineage({ implementationExecutionId: input.implementationExecutionId, sourceRevision: input.sourceRevision, reviewedSha: input.sourceRevision });
    return withTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM reviews WHERE idempotency_key=?').get(input.idempotencyKey) as ReviewRow | undefined;
      if (existing) {
        const same = existing.plan_id === input.planId
          && existing.work_item_id === (input.workItemId ?? null)
          && existing.implementation_execution_id === input.implementationExecutionId
          && existing.source_revision === input.sourceRevision
          && (input.reviewerExecutionId === undefined || existing.reviewer_execution_id === input.reviewerExecutionId);
        if (!same) throw new DuplicateKeyError(input.idempotencyKey);
        return { status: 'existing', value: reviewFrom(existing) };
      }
      const execution = this.db.prepare('SELECT plan_id,work_item_id,source_revision,status,result_revision FROM executions WHERE execution_id=?').get(input.implementationExecutionId) as { plan_id: string; work_item_id: string | null; source_revision: string | null; status: ExecutionStatus; result_revision: string | null } | undefined;
      if (!execution) throw new V4Error('IMPLEMENTATION_EXECUTION_NOT_FOUND');
      if (execution.plan_id !== input.planId) throw new V4Error('REVIEW_PLAN_MISMATCH');
      if (execution.status !== 'SUCCEEDED' || !execution.result_revision) throw new V4Error('IMPLEMENTATION_EXECUTION_NOT_SUCCEEDED');
      if (execution.work_item_id !== (input.workItemId ?? null)) throw new V4Error('REVIEW_WORK_ITEM_MISMATCH');
      if (input.workItemId) {
        const workItem = this.db.prepare('SELECT plan_id FROM work_items WHERE work_item_id=?').get(input.workItemId) as { plan_id: string } | undefined;
        if (!workItem || workItem.plan_id !== input.planId) throw new V4Error('REVIEW_WORK_ITEM_MISMATCH');
      }
      if (execution.result_revision !== input.sourceRevision) throw new V4Error('REVIEW_SOURCE_NOT_IMPLEMENTATION_RESULT');
      if (input.reviewerExecutionId) {
        assertReviewerBinding(this.db, {
          planId: input.planId,
          workItemId: input.workItemId,
          implementationExecutionId: input.implementationExecutionId,
          sourceRevision: input.sourceRevision,
        }, input.reviewerExecutionId);
      }
      const reviewId = input.reviewId ?? id('review');
      const createdAt = iso();
      this.db.prepare('INSERT INTO reviews(review_id,idempotency_key,plan_id,work_item_id,implementation_execution_id,reviewer_execution_id,source_revision,reviewed_sha,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        reviewId, input.idempotencyKey, input.planId, input.workItemId ?? null, input.implementationExecutionId, input.reviewerExecutionId ?? null, input.sourceRevision, input.sourceRevision, 'PENDING', createdAt, createdAt);
      this.events.appendInTransaction(makeEvent(reviewId, 'REVIEW', 'REVIEW_CREATED', { planId: input.planId, implementationExecutionId: input.implementationExecutionId, sourceRevision: input.sourceRevision }));
      return { status: 'created', value: this.getById(reviewId) };
    });
  }

  getById(reviewId: string): Review {
    const row = this.db.prepare('SELECT * FROM reviews WHERE review_id=?').get(reviewId) as ReviewRow | undefined;
    if (!row) throw new V4Error('REVIEW_NOT_FOUND');
    return reviewFrom(row);
  }

  listByPlan(planId: string): Review[] {
    const rows = this.db.prepare('SELECT * FROM reviews WHERE plan_id=? ORDER BY created_at').all(planId) as unknown as ReviewRow[];
    return rows.map(reviewFrom);
  }


  listByWorkItem(workItemId: string): Review[] {
    const rows = this.db.prepare('SELECT * FROM reviews WHERE work_item_id=? ORDER BY created_at').all(workItemId) as unknown as ReviewRow[];
    return rows.map(reviewFrom);
  }

  findByImplementationExecution(implementationExecutionId: string): Review | undefined {
    const row = this.db.prepare('SELECT * FROM reviews WHERE implementation_execution_id=? ORDER BY created_at DESC LIMIT 1').get(implementationExecutionId) as ReviewRow | undefined;
    return row ? reviewFrom(row) : undefined;
  }

  findByReviewerExecution(reviewerExecutionId: string): Review | undefined {
    const row = this.db.prepare('SELECT * FROM reviews WHERE reviewer_execution_id=? ORDER BY created_at DESC LIMIT 1').get(reviewerExecutionId) as ReviewRow | undefined;
    return row ? reviewFrom(row) : undefined;
  }

  attachReviewerExecution(reviewId: string, reviewerExecutionId: string): MutationResult<Review> {
    failClosed(reviewerExecutionId.trim().length > 0, 'REVIEWER_EXECUTION_REQUIRED');
    return withTransaction(this.db, () => {
      const current = this.getById(reviewId);
      if (current.reviewerExecutionId === reviewerExecutionId) return { status: 'existing', value: current };
      if (current.reviewerExecutionId) throw new V4Error('REVIEWER_EXECUTION_IMMUTABLE');
      assertReviewerBinding(this.db, current, reviewerExecutionId);
      const updatedAt = iso();
      const result = this.db.prepare('UPDATE reviews SET reviewer_execution_id=?,updated_at=? WHERE review_id=? AND reviewer_execution_id IS NULL').run(reviewerExecutionId, updatedAt, reviewId);
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.getById(reviewId), reason: 'STALE_REVIEWER_EXECUTION' };
      this.events.appendInTransaction(makeEvent(reviewId, 'REVIEW', 'REVIEWER_EXECUTION_ATTACHED', { reviewerExecutionId, implementationExecutionId: current.implementationExecutionId }));
      return { status: 'updated', value: this.getById(reviewId) };
    });
  }

  updateStatus(reviewId: string, next: ReviewStatus): MutationResult<Review> {
    return withTransaction(this.db, () => {
      const current = this.getById(reviewId);
      if (current.status === next) return { status: 'existing', value: current };
      const updated = transitionReview(current, next, iso());
      this.db.prepare('UPDATE reviews SET status=?,updated_at=? WHERE review_id=?').run(next, updated.updatedAt, reviewId);
      this.events.appendInTransaction(makeEvent(reviewId, 'REVIEW', 'REVIEW_STATUS_CHANGED', { planId: current.planId, from: current.status, to: next }));
      return { status: 'updated', value: this.getById(reviewId) };
    });
  }

  recordVerdict(reviewId: string, verdict: 'PASS' | 'FAIL' | 'INVALID', findings: string[] = []): MutationResult<Review> {
    return withTransaction(this.db, () => {
      const current = this.getById(reviewId);
      assertReviewCompletion(this.db, current);
      const next: ReviewStatus = verdict === 'PASS' ? 'PASSED' : verdict === 'INVALID' ? 'STALE' : 'FAILED';
      const sameFindings = JSON.stringify(current.findings ?? []) === JSON.stringify(findings);
      if (current.status === next) {
        if (current.verdict === verdict && sameFindings) return { status: 'existing', value: current };
        throw new V4Error('REVIEW_VERDICT_IMMUTABLE');
      }
      transitionReview(current, next, iso());
      const updatedAt = iso();
      this.db.prepare('UPDATE reviews SET status=?,verdict=?,findings=?,updated_at=? WHERE review_id=?').run(next, verdict, encode(findings), updatedAt, reviewId);
      this.events.appendInTransaction(makeEvent(reviewId, 'REVIEW', 'REVIEW_VERDICT_RECORDED', { verdict, reviewedSha: current.reviewedSha }));
      return { status: 'updated', value: this.getById(reviewId) };
    });
  }
}

interface SupervisorRow {
  supervisor_id: string; plan_id: string; conversation_id: string | null; status: SupervisorStatus; observation_cursor: number;
  projection_digest: string; policy_id: string; budget_id: string; last_decision_at: string | null; next_wake_at: string;
  created_at: string; updated_at: string;
}
interface LeaseRow {
  aggregate_type: Lease['aggregateType']; aggregate_id: string; owner_id: string; lease_token: string; claimed_at: number; expires_at: number;
}
function leaseFrom(row: LeaseRow): Lease {
  return { aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, ownerId: row.owner_id, leaseToken: row.lease_token, claimedAt: row.claimed_at, expiresAt: row.expires_at };
}
function supervisorFrom(row: SupervisorRow, lease?: Lease): Supervisor {
  return { supervisorId: row.supervisor_id, planId: row.plan_id, conversationId: row.conversation_id ?? undefined, status: row.status,
    observationCursor: row.observation_cursor, projectionDigest: row.projection_digest, policyId: row.policy_id, budgetId: row.budget_id,
    lease, lastDecisionAt: row.last_decision_at ?? undefined, nextWakeAt: row.next_wake_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class SupervisorRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}

  create(input: { supervisorId?: string; planId: string; policyId?: string; budgetId?: string; nextWakeAt?: string }): MutationResult<Supervisor> {
    return withTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM supervisors WHERE plan_id=?').get(input.planId) as SupervisorRow | undefined;
      if (existing) return { status: 'existing', value: this.getById(existing.supervisor_id) };
      const createdAt = iso();
      const supervisor: Supervisor = { supervisorId: input.supervisorId ?? id('supervisor'), planId: input.planId, status: 'CREATED',
        observationCursor: 0, projectionDigest: '', policyId: input.policyId ?? 'default', budgetId: input.budgetId ?? 'default',
        nextWakeAt: input.nextWakeAt ?? createdAt, createdAt, updatedAt: createdAt };
      validateSupervisor(supervisor);
      this.db.prepare('INSERT INTO supervisors(supervisor_id,plan_id,status,observation_cursor,projection_digest,policy_id,budget_id,next_wake_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        supervisor.supervisorId, supervisor.planId, supervisor.status, 0, '', supervisor.policyId, supervisor.budgetId, supervisor.nextWakeAt, createdAt, createdAt);
      this.events.appendInTransaction(makeEvent(supervisor.supervisorId, 'SUPERVISOR', 'SUPERVISOR_CREATED', { planId: input.planId }));
      return { status: 'created', value: supervisor };
    });
  }

  getById(supervisorId: string): Supervisor {
    const row = this.db.prepare('SELECT * FROM supervisors WHERE supervisor_id=?').get(supervisorId) as SupervisorRow | undefined;
    if (!row) throw new V4Error('SUPERVISOR_NOT_FOUND');
    const lease = this.db.prepare('SELECT * FROM leases WHERE aggregate_type=? AND aggregate_id=?').get('SUPERVISOR', supervisorId) as LeaseRow | undefined;
    return supervisorFrom(row, lease ? leaseFrom(lease) : undefined);
  }

  getByPlanId(planId: string): Supervisor | undefined {
    const row = this.db.prepare('SELECT * FROM supervisors WHERE plan_id=?').get(planId) as SupervisorRow | undefined;
    return row ? this.getById(row.supervisor_id) : undefined;
  }

  deferWake(supervisorId: string, nextWakeAt: string): MutationResult<Supervisor> {
    const updatedAt = new Date().toISOString();
    const result = this.db.prepare('UPDATE supervisors SET next_wake_at = ?, updated_at = ? WHERE supervisor_id = ?').run(nextWakeAt, updatedAt, supervisorId);
    if (result.changes !== 1) throw new V4Error('SUPERVISOR_NOT_FOUND');
    return { status: 'updated', value: this.getById(supervisorId) };
  }

  updateStatus(supervisorId: string, next: SupervisorStatus): MutationResult<Supervisor> {
    return withTransaction(this.db, () => {
      const current = this.getById(supervisorId);
      if (current.status === next) return { status: 'existing', value: current };
      const updated = transitionSupervisor(current, next, iso());
      this.db.prepare('UPDATE supervisors SET status=?,updated_at=? WHERE supervisor_id=?').run(next, updated.updatedAt, supervisorId);
      this.events.appendInTransaction(makeEvent(supervisorId, 'SUPERVISOR', 'SUPERVISOR_STATUS_CHANGED', { planId: current.planId, from: current.status, to: next }));
      return { status: 'updated', value: this.getById(supervisorId) };
    });
  }

  compareAndSetStatus(supervisorId: string, expected: SupervisorStatus, next: SupervisorStatus): MutationResult<Supervisor> {
    return withTransaction(this.db, () => {
      const current = this.getById(supervisorId);
      if (current.status !== expected) return { status: 'rejected', value: current, reason: 'STALE_STATUS' };
      if (expected === next) return { status: 'existing', value: current };
      transitionSupervisor(current, next, iso());
      const updatedAt = iso();
      const result = this.db.prepare('UPDATE supervisors SET status=?,updated_at=? WHERE supervisor_id=? AND status=?').run(next, updatedAt, supervisorId, expected);
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.getById(supervisorId), reason: 'STALE_STATUS' };
      this.events.appendInTransaction(makeEvent(supervisorId, 'SUPERVISOR', 'SUPERVISOR_STATUS_CHANGED', { planId: current.planId, from: expected, to: next }));
      return { status: 'updated', value: this.getById(supervisorId) };
    });
  }

  claimLease(supervisorId: string, ownerId: string, ttlMs: number, at = Date.now()): MutationResult<Lease> {
    failClosed(ttlMs > 0, 'LEASE_TTL_INVALID');
    return new LeaseRepository(this.db, this.events).claim('SUPERVISOR', supervisorId, ownerId, ttlMs, at);
  }

  renewLease(supervisorId: string, ownerId: string, leaseToken: string, ttlMs: number, at = Date.now()): MutationResult<Lease> {
    return new LeaseRepository(this.db, this.events).renew('SUPERVISOR', supervisorId, ownerId, leaseToken, ttlMs, at);
  }

  releaseLease(supervisorId: string, ownerId: string, leaseToken: string): MutationResult<void> {
    return new LeaseRepository(this.db, this.events).release('SUPERVISOR', supervisorId, ownerId, leaseToken);
  }

  attachConversation(supervisorId: string, conversationId: string): MutationResult<Supervisor> {
    return withTransaction(this.db, () => {
      const current = this.getById(supervisorId);
      failClosed(conversationId.trim().length > 0, 'SUPERVISOR_CONVERSATION_REQUIRED');
      if (current.conversationId === conversationId) return { status: 'existing', value: current };
      if (current.status === 'COMPLETED' || current.status === 'CANCELLED') throw new V4Error('SUPERVISOR_TERMINAL');
      if (current.conversationId && current.conversationId !== conversationId) throw new V4Error('SUPERVISOR_CONVERSATION_IMMUTABLE');
      const updatedAt = iso();
      this.db.prepare('UPDATE supervisors SET conversation_id=?,updated_at=? WHERE supervisor_id=?').run(conversationId, updatedAt, supervisorId);
      this.events.appendInTransaction(makeEvent(supervisorId, 'SUPERVISOR', 'SUPERVISOR_CONVERSATION_ATTACHED', { conversationId }));
      return { status: 'updated', value: this.getById(supervisorId) };
    });
  }

  replaceConversation(supervisorId: string, expectedConversationId: string | undefined, conversationId: string, reason: string): MutationResult<Supervisor> {
    failClosed(conversationId.trim().length > 0, 'SUPERVISOR_CONVERSATION_REQUIRED');
    failClosed(reason.trim().length > 0, 'SUPERVISOR_CONVERSATION_REPLACEMENT_REASON_REQUIRED');
    return withTransaction(this.db, () => {
      const current = this.getById(supervisorId);
      if (current.conversationId === conversationId) return { status: 'existing', value: current };
      if (current.conversationId !== expectedConversationId) return { status: 'rejected', value: current, reason: 'STALE_CONVERSATION' };
      if (current.status === 'COMPLETED' || current.status === 'CANCELLED') throw new V4Error('SUPERVISOR_TERMINAL');
      const updatedAt = iso();
      const result = expectedConversationId === undefined
        ? this.db.prepare('UPDATE supervisors SET conversation_id=?,updated_at=? WHERE supervisor_id=? AND conversation_id IS NULL').run(conversationId, updatedAt, supervisorId)
        : this.db.prepare('UPDATE supervisors SET conversation_id=?,updated_at=? WHERE supervisor_id=? AND conversation_id=?').run(conversationId, updatedAt, supervisorId, expectedConversationId);
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.getById(supervisorId), reason: 'STALE_CONVERSATION' };
      this.events.appendInTransaction(makeEvent(supervisorId, 'SUPERVISOR', 'SUPERVISOR_CONVERSATION_REPLACED', { from: expectedConversationId ?? null, to: conversationId, reason }));
      return { status: 'updated', value: this.getById(supervisorId) };
    });
  }

  advanceObservation(supervisorId: string, cursor: number, digest: string, nextWakeAt: string): MutationResult<Supervisor> {
    return withTransaction(this.db, () => {
      const current = this.getById(supervisorId);
      failClosed(Number.isInteger(cursor) && cursor >= 0, 'SUPERVISOR_CURSOR_INVALID');
      failClosed(digest.trim().length > 0, 'SUPERVISOR_DIGEST_REQUIRED');
      if (cursor < current.observationCursor) return { status: 'rejected', value: current, reason: 'STALE_CURSOR' };
      if (cursor === current.observationCursor) {
        if (digest === current.projectionDigest) return { status: 'existing', value: current };
        throw new V4Error('PROJECTION_DIGEST_CONFLICT');
      }
      const updatedAt = iso();
      this.db.prepare('UPDATE supervisors SET observation_cursor=?,projection_digest=?,next_wake_at=?,last_decision_at=?,updated_at=? WHERE supervisor_id=? AND observation_cursor<=?').run(
        cursor, digest, nextWakeAt, updatedAt, updatedAt, supervisorId, cursor);
      this.events.appendInTransaction(makeEvent(supervisorId, 'SUPERVISOR', 'SUPERVISOR_OBSERVATION_ADVANCED', { cursor, projectionDigest: digest }));
      return { status: 'updated', value: this.getById(supervisorId) };
    });
  }

  listDue(at = iso()): Supervisor[] {
    const rows = this.db.prepare("SELECT * FROM supervisors WHERE status NOT IN ('COMPLETED','CANCELLED') AND next_wake_at<=? ORDER BY next_wake_at").all(at) as unknown as SupervisorRow[];
    return rows.map((row) => this.getById(row.supervisor_id));
  }

  listStale(cutoff = new Date(Date.now() - 300000).toISOString()): Supervisor[] {
    const rows = this.db.prepare("SELECT * FROM supervisors WHERE status NOT IN ('COMPLETED','CANCELLED') AND updated_at<? ORDER BY updated_at").all(cutoff) as unknown as SupervisorRow[];
    return rows.map((row) => this.getById(row.supervisor_id));
  }
}

export class LeaseRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}

  claim(aggregateType: Lease['aggregateType'], aggregateId: string, ownerId: string, ttlMs: number, at = Date.now()): MutationResult<Lease> {
    failClosed(ttlMs > 0 && ownerId.length > 0, 'LEASE_INPUT_INVALID');
    return withTransaction(this.db, () => {
      const current = this.db.prepare('SELECT * FROM leases WHERE aggregate_type=? AND aggregate_id=?').get(aggregateType, aggregateId) as LeaseRow | undefined;
      if (current && current.expires_at > at) {
        if (current.owner_id === ownerId) return { status: 'existing', value: leaseFrom(current) };
        return { status: 'rejected', value: leaseFrom(current), reason: 'LEASE_HELD' };
      }
      const lease: Lease = { aggregateType, aggregateId, ownerId, leaseToken: randomUUID(), claimedAt: at, expiresAt: at + ttlMs };
      this.db.prepare('INSERT INTO leases(aggregate_type,aggregate_id,owner_id,lease_token,claimed_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(aggregate_type,aggregate_id) DO UPDATE SET owner_id=excluded.owner_id,lease_token=excluded.lease_token,claimed_at=excluded.claimed_at,expires_at=excluded.expires_at').run(
        lease.aggregateType, lease.aggregateId, lease.ownerId, lease.leaseToken, lease.claimedAt, lease.expiresAt);
      this.events.appendInTransaction(makeEvent(aggregateId, aggregateType, aggregateType + '_LEASE_CLAIMED', { ownerId, expiresAt: lease.expiresAt }));
      return { status: current ? 'updated' : 'created', value: lease };
    });
  }

  renew(aggregateType: Lease['aggregateType'], aggregateId: string, ownerId: string, leaseToken: string, ttlMs: number, at = Date.now()): MutationResult<Lease> {
    failClosed(ttlMs > 0, 'LEASE_TTL_INVALID');
    return withTransaction(this.db, () => {
      const current = this.db.prepare('SELECT * FROM leases WHERE aggregate_type=? AND aggregate_id=?').get(aggregateType, aggregateId) as LeaseRow | undefined;
      if (!current || current.owner_id !== ownerId || current.lease_token !== leaseToken || current.expires_at <= at) return { status: 'rejected', value: current ? leaseFrom(current) : undefined, reason: 'LEASE_STALE' };
      const expiresAt = at + ttlMs;
      this.db.prepare('UPDATE leases SET expires_at=? WHERE aggregate_type=? AND aggregate_id=? AND owner_id=? AND lease_token=?').run(expiresAt, aggregateType, aggregateId, ownerId, leaseToken);
      this.events.appendInTransaction(makeEvent(aggregateId, aggregateType, aggregateType + '_LEASE_RENEWED', { ownerId, expiresAt }));
      return { status: 'updated', value: { ...leaseFrom(current), expiresAt } };
    });
  }

  release(aggregateType: Lease['aggregateType'], aggregateId: string, ownerId: string, leaseToken: string): MutationResult<void> {
    return withTransaction(this.db, () => {
      const result = this.db.prepare('DELETE FROM leases WHERE aggregate_type=? AND aggregate_id=? AND owner_id=? AND lease_token=?').run(aggregateType, aggregateId, ownerId, leaseToken);
      if (Number(result.changes) !== 1) return { status: 'rejected', reason: 'LEASE_STALE' };
      this.events.appendInTransaction(makeEvent(aggregateId, aggregateType, aggregateType + '_LEASE_RELEASED', { ownerId }));
      return { status: 'updated' };
    });
  }
}

interface DecisionRow {
  decision_id: string; supervisor_id: string; plan_id: string; version: number; observation_cursor: number;
  projection_digest: string; idempotency_key: string; precondition_snapshot: string; action_payload: string;
  validator_result: string | null; created_at: string;
}
export class DecisionRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}

  append(decision: SupervisorDecision): MutationResult<SupervisorDecision> {
    validateActionShape(decision.action);
    failClosed(decision.version === 1, 'DECISION_VERSION_UNSUPPORTED');
    failClosed(decision.action.planId === decision.planId && decision.action.supervisorId === decision.supervisorId, 'DECISION_ACTION_CONTEXT_MISMATCH');
    failClosed(decision.action.observationCursor === decision.observationCursor && decision.action.projectionDigest === decision.projectionDigest, 'DECISION_ACTION_OBSERVATION_MISMATCH');
    failClosed(decision.action.idempotencyKey === decision.idempotencyKey, 'DECISION_ACTION_IDEMPOTENCY_MISMATCH');
    assertSafeEventPayload({ preconditionSnapshot: decision.preconditionSnapshot, action: decision.action });
    return withTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM supervisor_decisions WHERE idempotency_key=?').get(decision.idempotencyKey) as DecisionRow | undefined;
      if (existing) {
        const durable = this.fromRow(existing);
        const same = durable.planId === decision.planId
          && durable.supervisorId === decision.supervisorId
          && durable.version === decision.version
          && durable.observationCursor === decision.observationCursor
          && durable.projectionDigest === decision.projectionDigest
          && encode(durable.preconditionSnapshot) === encode(decision.preconditionSnapshot)
          && durable.action.type === decision.action.type
          && encode(durable.action.payload) === encode(decision.action.payload);
        if (!same) throw new DuplicateKeyError(decision.idempotencyKey);
        return { status: 'existing', value: durable };
      }
      this.db.prepare('INSERT INTO supervisor_decisions(decision_id,supervisor_id,plan_id,version,observation_cursor,projection_digest,idempotency_key,precondition_snapshot,action_payload,validator_result,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        decision.decisionId, decision.supervisorId, decision.planId, decision.version, decision.observationCursor, decision.projectionDigest,
        decision.idempotencyKey, encode(decision.preconditionSnapshot), encode(decision.action), decision.validatorResult ? encode(decision.validatorResult) : null, decision.createdAt);
      this.events.appendInTransaction(makeEvent(decision.decisionId, 'DECISION', 'SUPERVISOR_DECISION_APPENDED', { supervisorId: decision.supervisorId, planId: decision.planId, observationCursor: decision.observationCursor, actionType: decision.action.type }));
      return { status: 'created', value: decision };
    });
  }

  getById(decisionId: string): SupervisorDecision {
    const row = this.db.prepare('SELECT * FROM supervisor_decisions WHERE decision_id=?').get(decisionId) as DecisionRow | undefined;
    if (!row) throw new V4Error('DECISION_NOT_FOUND');
    return this.fromRow(row);
  }

  listBySupervisor(supervisorId: string): SupervisorDecision[] {
    const rows = this.db.prepare('SELECT * FROM supervisor_decisions WHERE supervisor_id=? ORDER BY created_at,decision_id').all(supervisorId) as unknown as DecisionRow[];
    return rows.map((row) => this.fromRow(row));
  }

  listAfterCursor(supervisorId: string, cursor: number, limit = 100): SupervisorDecision[] {
    const rows = this.db.prepare('SELECT * FROM supervisor_decisions WHERE supervisor_id=? AND observation_cursor>? ORDER BY observation_cursor,created_at LIMIT ?').all(supervisorId, cursor, limit) as unknown as DecisionRow[];
    return rows.map((row) => this.fromRow(row));
  }

  findByIdempotencyKey(key: string): SupervisorDecision | undefined {
    const row = this.db.prepare('SELECT * FROM supervisor_decisions WHERE idempotency_key=?').get(key) as DecisionRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  private fromRow(row: DecisionRow): SupervisorDecision {
    return { decisionId: row.decision_id, version: 1, planId: row.plan_id, supervisorId: row.supervisor_id,
      observationCursor: row.observation_cursor, projectionDigest: row.projection_digest, idempotencyKey: row.idempotency_key,
      preconditionSnapshot: decode<Record<string, unknown>>(row.precondition_snapshot),
      action: decode<SupervisorAction>(row.action_payload),
      validatorResult: row.validator_result ? decode<SupervisorDecision['validatorResult']>(row.validator_result) : undefined,
      createdAt: row.created_at };
  }
}

interface ActionRow {
  action_id: string; supervisor_id: string; plan_id: string; version: number; type: SupervisorAction['type']; idempotency_key: string;
  observation_cursor: number; projection_digest: string; precondition_snapshot: string; payload: string; status: ActionStatus;
  validation: string | null; result: string | null; execution_id: string | null; child_plan_id: string | null; pull_request_id: string | null;
  created_at: string; updated_at: string;
}
function actionFrom(row: ActionRow): SupervisorAction {
  const result = row.result ? decode<NonNullable<SupervisorAction['result']>>(row.result) : undefined;
  if (row.execution_id && result && !result.linkedExecutionId) result.linkedExecutionId = row.execution_id;
  if (row.child_plan_id && result && !result.linkedPlanId) result.linkedPlanId = row.child_plan_id;
  if (row.pull_request_id && result && !result.pullRequestId) result.pullRequestId = row.pull_request_id;
  return { actionId: row.action_id, version: 1, type: row.type, planId: row.plan_id, supervisorId: row.supervisor_id,
    observationCursor: row.observation_cursor, projectionDigest: row.projection_digest, idempotencyKey: row.idempotency_key,
    preconditionSnapshot: decode<Record<string, unknown>>(row.precondition_snapshot), payload: decode<SupervisorAction['payload']>(row.payload),
    status: row.status, validation: row.validation ? decode<SupervisorAction['validation']>(row.validation) : undefined,
    result, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class ActionRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}

  create(action: SupervisorAction): MutationResult<SupervisorAction> {
    validateActionShape(action);
    assertSafeEventPayload({ preconditionSnapshot: action.preconditionSnapshot, payload: action.payload });
    return withTransaction(this.db, () => {
      const existing = this.findByIdempotencyKey(action.idempotencyKey);
      if (existing) {
        const same = existing.planId === action.planId
          && existing.supervisorId === action.supervisorId
          && existing.observationCursor === action.observationCursor
          && existing.projectionDigest === action.projectionDigest
          && existing.type === action.type
          && encode(existing.preconditionSnapshot) === encode(action.preconditionSnapshot)
          && encode(existing.payload) === encode(action.payload);
        if (!same) throw new DuplicateKeyError(action.idempotencyKey);
        return { status: 'existing', value: existing };
      }
      this.db.prepare('INSERT INTO supervisor_actions(action_id,supervisor_id,plan_id,version,type,idempotency_key,observation_cursor,projection_digest,precondition_snapshot,payload,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        action.actionId, action.supervisorId, action.planId, action.version, action.type, action.idempotencyKey, action.observationCursor, action.projectionDigest,
        encode(action.preconditionSnapshot), encode(action.payload), action.status, action.createdAt, action.updatedAt);
      this.events.appendInTransaction(makeEvent(action.actionId, 'ACTION', 'SUPERVISOR_ACTION_CREATED', { planId: action.planId, supervisorId: action.supervisorId, type: action.type }));
      return { status: 'created', value: action };
    });
  }

  getById(actionId: string): SupervisorAction {
    const row = this.db.prepare('SELECT * FROM supervisor_actions WHERE action_id=?').get(actionId) as ActionRow | undefined;
    if (!row) throw new V4Error('ACTION_NOT_FOUND');
    return actionFrom(row);
  }

  findByIdempotencyKey(key: string): SupervisorAction | undefined {
    const row = this.db.prepare('SELECT * FROM supervisor_actions WHERE idempotency_key=?').get(key) as ActionRow | undefined;
    return row ? actionFrom(row) : undefined;
  }

  compareAndSetStatus(actionId: string, expected: ActionStatus, next: ActionStatus): MutationResult<SupervisorAction> {
    return withTransaction(this.db, () => {
      const current = this.getById(actionId);
      if (current.status !== expected) return { status: 'rejected', value: current, reason: 'STALE_STATUS' };
      if (expected === next) return { status: 'existing', value: current };
      transitionAction(current, next, iso());
      const result = this.db.prepare('UPDATE supervisor_actions SET status=?,updated_at=? WHERE action_id=? AND status=?').run(next, iso(), actionId, expected);
      if (Number(result.changes) !== 1) return { status: 'rejected', value: this.getById(actionId), reason: 'STALE_STATUS' };
      this.events.appendInTransaction(makeEvent(actionId, 'ACTION', 'SUPERVISOR_ACTION_STATUS_CHANGED', { from: expected, to: next }));
      return { status: 'updated', value: this.getById(actionId) };
    });
  }

  recordValidation(actionId: string, validation: NonNullable<SupervisorAction['validation']>): MutationResult<SupervisorAction> {
    return withTransaction(this.db, () => {
      const current = this.getById(actionId);
      if (current.validation) {
        if (encode(current.validation) === encode(validation)) return { status: 'existing', value: current };
        throw new V4Error('ACTION_VALIDATION_IMMUTABLE');
      }
      if (current.status !== 'PROPOSED' && current.status !== 'VALIDATING') throw new V4Error('ACTION_VALIDATION_STATE_INVALID');
      let transitioned = current;
      if (transitioned.status === 'PROPOSED') {
        transitioned = transitionAction(transitioned, 'VALIDATING', iso());
        this.db.prepare('UPDATE supervisor_actions SET status=?,updated_at=? WHERE action_id=?').run('VALIDATING', transitioned.updatedAt, actionId);
        this.events.appendInTransaction(makeEvent(actionId, 'ACTION', 'SUPERVISOR_ACTION_STATUS_CHANGED', { from: 'PROPOSED', to: 'VALIDATING' }));
      }
      const next = validation.accepted ? 'ACCEPTED' : 'REJECTED';
      const final = transitionAction(transitioned, next, iso());
      const updatedAt = final.updatedAt;
      this.db.prepare('UPDATE supervisor_actions SET status=?,validation=?,updated_at=? WHERE action_id=?').run(next, encode(validation), updatedAt, actionId);
      this.events.appendInTransaction(makeEvent(actionId, 'ACTION', 'SUPERVISOR_ACTION_VALIDATED', { accepted: validation.accepted, code: validation.code }));
      return { status: 'updated', value: this.getById(actionId) };
    });
  }

  attachExecution(actionId: string, executionId: string): MutationResult<SupervisorAction> {
    return this.attach(actionId, 'execution_id', executionId, 'ACTION_EXECUTION_ATTACHED');
  }
  attachPlan(actionId: string, planId: string): MutationResult<SupervisorAction> {
    return this.attach(actionId, 'child_plan_id', planId, 'ACTION_PLAN_ATTACHED');
  }
  attachPullRequest(actionId: string, pullRequestId: string): MutationResult<SupervisorAction> {
    return this.attach(actionId, 'pull_request_id', pullRequestId, 'ACTION_PULL_REQUEST_ATTACHED');
  }

  private attach(actionId: string, column: 'execution_id' | 'child_plan_id' | 'pull_request_id', value: string, eventType: string): MutationResult<SupervisorAction> {
    return withTransaction(this.db, () => {
      const current = this.getById(actionId);
      failClosed(value.trim().length > 0, 'ACTION_LINK_REQUIRED');
      const row = this.db.prepare('SELECT ' + column + ' AS value FROM supervisor_actions WHERE action_id=?').get(actionId) as { value: string | null } | undefined;
      const linked = row?.value ?? undefined;
      if (linked === value) return { status: 'existing', value: current };
      if (linked) throw new V4Error('DURABLE_EVIDENCE_IMMUTABLE');
      this.db.prepare('UPDATE supervisor_actions SET ' + column + '=?,updated_at=? WHERE action_id=?').run(value, iso(), actionId);
      this.events.appendInTransaction(makeEvent(actionId, 'ACTION', eventType, { value }));
      return { status: 'updated', value: this.getById(actionId) };
    });
  }

  recordSuccess(actionId: string, result: NonNullable<SupervisorAction['result']>): MutationResult<SupervisorAction> {
    return this.finish(actionId, 'SUCCEEDED', result);
  }
  recordFailure(actionId: string, result: NonNullable<SupervisorAction['result']>): MutationResult<SupervisorAction> {
    return this.finish(actionId, 'FAILED', result);
  }
  recordRejection(actionId: string, validation: NonNullable<SupervisorAction['validation']>): MutationResult<SupervisorAction> {
    return this.recordValidation(actionId, { ...validation, accepted: false });
  }

  private finish(actionId: string, nextStatus: 'SUCCEEDED' | 'FAILED', result: NonNullable<SupervisorAction['result']>): MutationResult<SupervisorAction> {
    return withTransaction(this.db, () => {
      const current = this.getById(actionId);
      if (current.status === nextStatus) {
        if (encode(current.result) === encode(result)) return { status: 'existing', value: current };
        throw new V4Error('ACTION_RESULT_IMMUTABLE');
      }
      let transitioned = current;
      if (transitioned.status === 'ACCEPTED' || transitioned.status === 'FAILED') {
        const from = transitioned.status;
        transitioned = transitionAction(transitioned, 'EXECUTING', iso());
        this.db.prepare('UPDATE supervisor_actions SET status=?,updated_at=? WHERE action_id=?').run('EXECUTING', transitioned.updatedAt, actionId);
        this.events.appendInTransaction(makeEvent(actionId, 'ACTION', 'SUPERVISOR_ACTION_STATUS_CHANGED', { from, to: 'EXECUTING' }));
      }
      transitioned = transitionAction(transitioned, nextStatus, iso());
      this.db.prepare('UPDATE supervisor_actions SET status=?,result=?,updated_at=? WHERE action_id=?').run(nextStatus, encode(result), transitioned.updatedAt, actionId);
      this.events.appendInTransaction(makeEvent(actionId, 'ACTION', 'SUPERVISOR_ACTION_FINISHED', { status: nextStatus, code: result.code }));
      return { status: 'updated', value: this.getById(actionId) };
    });
  }
}

export class ResourceRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}
  observe(observation: ResourceObservation): MutationResult<ResourceObservation> {
    validateResourceObservation(observation);
    assertSafeEventPayload(observation);
    return withTransaction(this.db, () => {
      this.db.prepare('INSERT INTO resources(resource_id,kind,status,capabilities,quota_remaining,observation,observed_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET kind=excluded.kind,status=excluded.status,capabilities=excluded.capabilities,quota_remaining=excluded.quota_remaining,observation=excluded.observation,observed_at=excluded.observed_at,updated_at=excluded.updated_at').run(
        observation.resourceId, observation.kind, observation.status, encode(observation.capabilities), observation.quotaRemaining ?? null, encode(observation), observation.observedAt, iso());
      this.events.appendInTransaction(makeEvent(observation.resourceId, 'RESOURCE', 'RESOURCE_OBSERVED', { kind: observation.kind, status: observation.status, observedAt: observation.observedAt }));
      return { status: 'updated', value: observation };
    });
  }
  get(resourceId: string): ResourceObservation | undefined {
    const row = this.db.prepare('SELECT observation FROM resources WHERE resource_id=?').get(resourceId) as { observation: string } | undefined;
    return row ? decode<ResourceObservation>(row.observation) : undefined;
  }
}

export interface PlanRelationshipRepository {
  createParentChild(input: { relationshipId?: string; parentPlanId: string; childPlanId: string; kind: 'SYSTEM_REPAIR' | 'INFRASTRUCTURE_REPAIR' | 'FOLLOW_UP' }): MutationResult<{ relationshipId: string; parentPlanId: string; childPlanId: string; kind: string }>;
  getParent(childPlanId: string): string | undefined;
  getChildren(parentPlanId: string): string[];
  rejectSelfCycle(parentPlanId: string, childPlanId: string): void;
  rejectDuplicateRelationship(parentPlanId: string, childPlanId: string, kind: string): void;
}

export class RelationshipRepository implements PlanRelationshipRepository {
  constructor(readonly db: DatabaseSync, readonly events = new EventStore(db)) {}
  createParentChild(input: { relationshipId?: string; parentPlanId: string; childPlanId: string; kind: 'SYSTEM_REPAIR' | 'INFRASTRUCTURE_REPAIR' | 'FOLLOW_UP' }): MutationResult<{ relationshipId: string; parentPlanId: string; childPlanId: string; kind: string }> {
    return withTransaction(this.db, () => {
      this.rejectSelfCycle(input.parentPlanId, input.childPlanId);
      this.rejectDuplicateRelationship(input.parentPlanId, input.childPlanId, input.kind);
      const parent = this.db.prepare('SELECT plan_id FROM plans WHERE plan_id=?').get(input.parentPlanId);
      const child = this.db.prepare('SELECT plan_id FROM plans WHERE plan_id=?').get(input.childPlanId);
      if (!parent || !child) throw new V4Error('PLAN_NOT_FOUND');
      const rel = { relationshipId: input.relationshipId ?? id('relationship'), parentPlanId: input.parentPlanId, childPlanId: input.childPlanId, kind: input.kind };
      this.db.prepare('INSERT INTO plan_relationships(relationship_id,parent_plan_id,child_plan_id,kind,created_at) VALUES(?,?,?,?,?)').run(rel.relationshipId, rel.parentPlanId, rel.childPlanId, rel.kind, iso());
      this.events.appendInTransaction(makeEvent(rel.relationshipId, 'RELATIONSHIP', 'PARENT_CHILD_CREATED', rel));
      return { status: 'created', value: rel };
    });
  }
  getParent(childPlanId: string): string | undefined {
    const row = this.db.prepare('SELECT parent_plan_id FROM plan_relationships WHERE child_plan_id=?').get(childPlanId) as { parent_plan_id: string } | undefined;
    return row?.parent_plan_id;
  }
  getChildren(parentPlanId: string): string[] {
    const rows = this.db.prepare('SELECT child_plan_id FROM plan_relationships WHERE parent_plan_id=? ORDER BY created_at').all(parentPlanId) as unknown as Array<{ child_plan_id: string }>;
    return rows.map((row) => row.child_plan_id);
  }
  rejectSelfCycle(parentPlanId: string, childPlanId: string): void {
    if (parentPlanId === childPlanId) throw new V4Error('PARENT_CHILD_SELF_CYCLE');
    const seen = new Set<string>();
    const visit = (planId: string): void => {
      if (planId === parentPlanId) throw new V4Error('PARENT_CHILD_CYCLE');
      if (seen.has(planId)) return;
      seen.add(planId);
      for (const child of this.getChildren(planId)) visit(child);
    };
    visit(childPlanId);
  }
  rejectDuplicateRelationship(parentPlanId: string, childPlanId: string, kind: string): void {
    const row = this.db.prepare('SELECT relationship_id FROM plan_relationships WHERE parent_plan_id=? AND child_plan_id=? AND kind=?').get(parentPlanId, childPlanId, kind);
    if (row) throw new DuplicateKeyError(parentPlanId + ':' + childPlanId + ':' + kind);
  }
}

export interface V4Repositories {
  plans: PlanRepository; executions: ExecutionRepository; reviews: ReviewRepository; supervisors: SupervisorRepository;
  sessions: ExecutionSessionRepository; evidence: ExecutionEvidenceRepository;
  decisions: DecisionRepository; actions: ActionRepository; resources: ResourceRepository; relationships: RelationshipRepository;
  events: EventStore;
}

export function createRepositories(db: DatabaseSync): V4Repositories {
  const events = new EventStore(db);
  return { plans: new PlanRepository(db, events), executions: new ExecutionRepository(db, events), reviews: new ReviewRepository(db, events),
    supervisors: new SupervisorRepository(db, events), sessions: new ExecutionSessionRepository(db, events), evidence: new ExecutionEvidenceRepository(db, events),
    decisions: new DecisionRepository(db, events), actions: new ActionRepository(db, events),
    resources: new ResourceRepository(db, events), relationships: new RelationshipRepository(db, events), events };
}
