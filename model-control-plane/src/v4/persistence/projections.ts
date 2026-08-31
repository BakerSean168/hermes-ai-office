import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { V4Error } from '../domain/errors.js';
import type { EventEnvelope } from '../domain/events.js';
import type { PlanStatus } from '../domain/plan.js';
import type { SupervisorStatus } from '../domain/supervisor.js';
import { EventStore } from './eventStore.js';

export interface BoundedSupervisorProjection {
  projectionVersion: 1;
  plan: { planId: string; projectKey: string; objective: string; repositoryPath: string; baseRevision: string; currentRevision: string; status: PlanStatus };
  graph: { graphVersionId?: string; version?: number; items: Array<{ workItemId: string; itemKey: string; title: string; objective: string; status: string; dependencies: string[]; acceptedRevision?: string }> };
  executions: Array<{ executionId: string; workItemId?: string; attempt: number; route: string; status: string; resultRevision?: string; errorCode?: string; retryable?: boolean }>;
  reviews: Array<{ reviewId: string; implementationExecutionId: string; sourceRevision: string; reviewedSha: string; status: string; verdict?: string }>;
  supervisor: { supervisorId: string; status: SupervisorStatus; observationCursor: number; allowedActions: string[] };
  recentEvents: Array<{ cursor: number; type: string; aggregateType: string; aggregateId: string; occurredAt: string }>;
  cursor: number;
  digest: string;
  truncated: boolean;
}

function shorten(value: string, max: number): string { return value.length <= max ? value : value.slice(0, max - 1) + '...'; }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function decodeJson<T>(value: string, code: string): T {
  try { return JSON.parse(value) as T; } catch (error) { throw new V4Error(code, 'Cannot decode projection data', error); }
}

export function buildSupervisorProjection(db: DatabaseSync, supervisorId: string, options: { afterCursor?: number; maxEvents?: number; maxItems?: number } = {}): BoundedSupervisorProjection {
  const maxEvents = Math.max(1, Math.min(options.maxEvents ?? 50, 200));
  const maxItems = Math.max(1, Math.min(options.maxItems ?? 100, 500));
  const supervisor = db.prepare('SELECT * FROM supervisors WHERE supervisor_id=?').get(supervisorId) as {
    supervisor_id: string; plan_id: string; status: SupervisorStatus; observation_cursor: number;
  } | undefined;
  if (!supervisor) throw new V4Error('SUPERVISOR_NOT_FOUND');
  const plan = db.prepare('SELECT * FROM plans WHERE plan_id=?').get(supervisor.plan_id) as {
    plan_id: string; project_key: string; objective: string; repository_path: string; base_revision: string; current_revision: string; status: PlanStatus; active_graph_version_id: string | null;
  } | undefined;
  if (!plan) throw new V4Error('PLAN_NOT_FOUND');
  const graph = plan.active_graph_version_id ? db.prepare('SELECT graph_version_id,version FROM graph_versions WHERE graph_version_id=?').get(plan.active_graph_version_id) as { graph_version_id: string; version: number } | undefined : undefined;
  const items = graph ? db.prepare('SELECT * FROM work_items WHERE graph_version_id=? ORDER BY item_key LIMIT ?').all(graph.graph_version_id, maxItems) as unknown as Array<{ work_item_id: string; item_key: string; title: string; objective: string; status: string; dependencies: string; exact_accepted_revision: string | null }> : [];
  const executions = db.prepare('SELECT * FROM executions WHERE plan_id=? ORDER BY updated_at DESC LIMIT ?').all(plan.plan_id, maxItems) as unknown as Array<{ execution_id: string; work_item_id: string | null; attempt: number; route: string; status: string; result_revision: string | null; error_code: string | null; retryable: number | null }>;
  const reviews = db.prepare('SELECT * FROM reviews WHERE plan_id=? ORDER BY updated_at DESC LIMIT ?').all(plan.plan_id, maxItems) as unknown as Array<{ review_id: string; implementation_execution_id: string; source_revision: string; reviewed_sha: string; status: string; verdict: string | null }>;
  const after = options.afterCursor ?? 0;
  const stored = new EventStore(db).listAfterCursor(after, maxEvents);
  const base = {
    projectionVersion: 1 as const,
    plan: { planId: plan.plan_id, projectKey: plan.project_key, objective: shorten(plan.objective, 4000), repositoryPath: shorten(plan.repository_path, 500), baseRevision: plan.base_revision, currentRevision: plan.current_revision, status: plan.status },
    graph: { graphVersionId: graph?.graph_version_id, version: graph?.version, items: items.map((item) => ({ workItemId: item.work_item_id, itemKey: item.item_key, title: shorten(item.title, 500), objective: shorten(item.objective, 2000), status: item.status, dependencies: decodeJson<string[]>(item.dependencies, 'CORRUPTED_PROJECTION_DATA'), acceptedRevision: item.exact_accepted_revision ?? undefined })) },
    executions: executions.map((item) => ({ executionId: item.execution_id, workItemId: item.work_item_id ?? undefined, attempt: item.attempt, route: item.route, status: item.status, resultRevision: item.result_revision ?? undefined, errorCode: item.error_code ?? undefined, retryable: item.retryable === null ? undefined : Boolean(item.retryable) })),
    reviews: reviews.map((item) => ({ reviewId: item.review_id, implementationExecutionId: item.implementation_execution_id, sourceRevision: item.source_revision, reviewedSha: item.reviewed_sha, status: item.status, verdict: item.verdict ?? undefined })),
    supervisor: { supervisorId: supervisor.supervisor_id, status: supervisor.status, observationCursor: supervisor.observation_cursor, allowedActions: ['NO_ACTION', 'CONTINUE_EXECUTION', 'RETRY_EXECUTION', 'SWITCH_ROUTE', 'REQUEST_REVIEW', 'CREATE_REPAIR', 'REPLAN_REMAINDER', 'CREATE_CHILD_PLAN', 'PAUSE_FOR_RESOURCE', 'PARK_EXTERNAL_GATE', 'ESCALATE'] },
    recentEvents: stored.events.map((item, index) => ({ cursor: after + index + 1, type: item.type, aggregateType: item.aggregateType, aggregateId: item.aggregateId, occurredAt: item.occurredAt })),
    cursor: stored.cursor,
    truncated: items.length >= maxItems || executions.length >= maxItems || reviews.length >= maxItems || stored.events.length >= maxEvents,
  };
  return { ...base, digest: digest(base) };
}

export function rebuildProjectionFromEvents<T>(events: readonly EventEnvelope[], initial: T, reducer: (state: T, event: EventEnvelope) => T): T {
  return events.reduce(reducer, initial);
}
