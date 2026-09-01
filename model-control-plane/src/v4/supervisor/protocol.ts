import { randomUUID } from 'node:crypto';

import { assertSafeEventPayload } from '../domain/events.js';
import { V4Error } from '../domain/errors.js';
import { validateActionShape, type SupervisorAction, type SupervisorActionPayload, type SupervisorActionType } from '../domain/action.js';
import type { SupervisorDecision } from '../domain/supervisor.js';

export const SUPERVISOR_PROTOCOL_VERSION = 1 as const;
const MAX_BYTES = 32_000;
const MAX_STRING = 8_000;
const ACTION_TYPES: readonly SupervisorActionType[] = [
  'NO_ACTION', 'CREATE_EXECUTION', 'CONTINUE_EXECUTION', 'RETRY_EXECUTION', 'SWITCH_ROUTE', 'REQUEST_REVIEW',
  'CREATE_REPAIR', 'REPLAN_REMAINDER', 'CREATE_CHILD_PLAN', 'PAUSE_FOR_RESOURCE',
  'PARK_EXTERNAL_GATE', 'ESCALATE',
];

function skipWhitespace(input: string, index: number): number {
  while (index < input.length && /\s/.test(input[index] ?? '')) index++;
  return index;
}

function skipString(input: string, index: number): number {
  index++;
  while (index < input.length) {
    if (input[index] === '\\') index += 2;
    else if (input[index] === '"') return index + 1;
    else index++;
  }
  throw new V4Error('DECISION_JSON_INVALID');
}

function skipValue(input: string, index: number): number {
  index = skipWhitespace(input, index);
  if (input[index] === '"') return skipString(input, index);
  if (input[index] === '{') {
    index++;
    const keys = new Set<string>();
    index = skipWhitespace(input, index);
    if (input[index] === '}') return index + 1;
    while (index < input.length) {
      index = skipWhitespace(input, index);
      if (input[index] !== '"') throw new V4Error('DECISION_JSON_INVALID');
      const start = index;
      index = skipString(input, index);
      const key = JSON.parse(input.slice(start, index)) as string;
      if (keys.has(key)) throw new V4Error('DECISION_DUPLICATE_KEY', 'Duplicate JSON key: ' + key);
      keys.add(key);
      index = skipWhitespace(input, index);
      if (input[index] !== ':') throw new V4Error('DECISION_JSON_INVALID');
      index = skipValue(input, index + 1);
      index = skipWhitespace(input, index);
      if (input[index] === '}') return index + 1;
      if (input[index] !== ',') throw new V4Error('DECISION_JSON_INVALID');
      index++;
    }
    throw new V4Error('DECISION_JSON_INVALID');
  }
  if (input[index] === '[') {
    index++;
    index = skipWhitespace(input, index);
    if (input[index] === ']') return index + 1;
    while (index < input.length) {
      index = skipValue(input, index);
      index = skipWhitespace(input, index);
      if (input[index] === ']') return index + 1;
      if (input[index] !== ',') throw new V4Error('DECISION_JSON_INVALID');
      index++;
    }
    throw new V4Error('DECISION_JSON_INVALID');
  }
  const start = index;
  while (index < input.length && !/[,\]}]/.test(input[index] ?? '')) index++;
  if (index === start) throw new V4Error('DECISION_JSON_INVALID');
  return index;
}

function assertNoDuplicateKeys(input: string): void {
  const end = skipValue(input, 0);
  if (skipWhitespace(input, end) !== input.length) throw new V4Error('DECISION_JSON_INVALID');
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new V4Error(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string, max = MAX_STRING): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new V4Error(code);
  return value;
}

function isActionType(value: unknown): value is SupervisorActionType {
  return typeof value === 'string' && ACTION_TYPES.includes(value as SupervisorActionType);
}

function parsePayload(type: SupervisorActionType, value: unknown): SupervisorActionPayload {
  const payload = asRecord(value, 'ACTION_PAYLOAD_REQUIRED');
  if (payload.type !== type) throw new V4Error('ACTION_PAYLOAD_TYPE_MISMATCH');
  switch (type) {
    case 'NO_ACTION': return { type, reason: text(payload.reason, 'ACTION_REASON_REQUIRED') };
    case 'CREATE_EXECUTION': return { type, workItemId: text(payload.workItemId, 'WORK_ITEM_ID_REQUIRED', 200), route: text(payload.route, 'ACTION_ROUTE_REQUIRED', 200) };
    case 'CONTINUE_EXECUTION': return { type, executionId: text(payload.executionId, 'EXECUTION_ID_REQUIRED', 200) };
    case 'RETRY_EXECUTION': return { type, executionId: text(payload.executionId, 'EXECUTION_ID_REQUIRED', 200), reason: text(payload.reason, 'ACTION_REASON_REQUIRED') };
    case 'SWITCH_ROUTE': return { type, executionId: text(payload.executionId, 'EXECUTION_ID_REQUIRED', 200), route: text(payload.route, 'ACTION_ROUTE_REQUIRED', 200) };
    case 'REQUEST_REVIEW': return { type, executionId: text(payload.executionId, 'EXECUTION_ID_REQUIRED', 200), reviewerRoute: text(payload.reviewerRoute, 'REVIEW_ROUTE_REQUIRED', 200) };
    case 'CREATE_REPAIR': {
      const refs = payload.findingRefs;
      if (!Array.isArray(refs) || refs.length > 20 || !refs.every((ref) => typeof ref === 'string' && ref.length <= 300)) throw new V4Error('REPAIR_FINDINGS_INVALID');
      return { type, workItemId: text(payload.workItemId, 'WORK_ITEM_ID_REQUIRED', 200), baseExecutionId: text(payload.baseExecutionId, 'EXECUTION_ID_REQUIRED', 200), findingRefs: refs };
    }
    case 'REPLAN_REMAINDER': {
      if (!Array.isArray(payload.workItems) || payload.workItems.length > 100) throw new V4Error('REPLAN_ITEMS_INVALID');
      const workItems = payload.workItems.map((item) => {
        const value = asRecord(item, 'REPLAN_ITEM_INVALID');
        const dependencies = value.dependencies;
        const acceptanceCriteria = value.acceptanceCriteria;
        if (!Array.isArray(dependencies) || !dependencies.every((entry) => typeof entry === 'string' && entry.length <= 200)) throw new V4Error('REPLAN_DEPENDENCIES_INVALID');
        if (!Array.isArray(acceptanceCriteria) || !acceptanceCriteria.every((entry) => typeof entry === 'string' && entry.length <= 2000)) throw new V4Error('REPLAN_ACCEPTANCE_INVALID');
        return { itemKey: text(value.itemKey, 'REPLAN_ITEM_KEY_REQUIRED', 200), title: text(value.title, 'REPLAN_TITLE_REQUIRED', 500), objective: text(value.objective, 'REPLAN_OBJECTIVE_REQUIRED', 4000), dependencies, acceptanceCriteria };
      });
      return { type, reason: text(payload.reason, 'REPLAN_REASON_REQUIRED'), workItems };
    }
    case 'CREATE_CHILD_PLAN':
      if (payload.relation !== 'SYSTEM_REPAIR' && payload.relation !== 'INFRASTRUCTURE_REPAIR' && payload.relation !== 'FOLLOW_UP') throw new V4Error('CHILD_RELATION_INVALID');
      return { type, childPlanId: text(payload.childPlanId, 'CHILD_PLAN_ID_REQUIRED', 200), repositoryPath: text(payload.repositoryPath, 'CHILD_REPOSITORY_REQUIRED', 500), objective: text(payload.objective, 'CHILD_OBJECTIVE_REQUIRED', 4000), relation: payload.relation };
    case 'PAUSE_FOR_RESOURCE': return { type, resourceId: text(payload.resourceId, 'RESOURCE_ID_REQUIRED', 200), reason: text(payload.reason, 'ACTION_REASON_REQUIRED') };
    case 'PARK_EXTERNAL_GATE':
      if (payload.gate !== 'NATIVE_MACHINE' && payload.gate !== 'SECRET' && payload.gate !== 'HUMAN' && payload.gate !== 'POLICY') throw new V4Error('EXTERNAL_GATE_INVALID');
      return { type, gate: payload.gate, reason: text(payload.reason, 'ACTION_REASON_REQUIRED') };
    case 'ESCALATE':
      if (payload.severity !== 'LOW' && payload.severity !== 'MEDIUM' && payload.severity !== 'HIGH') throw new V4Error('ESCALATION_SEVERITY_INVALID');
      return { type, reason: text(payload.reason, 'ACTION_REASON_REQUIRED'), severity: payload.severity };
  }
}

export function parseSupervisorDecision(raw: string, now = new Date().toISOString()): SupervisorDecision {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new V4Error('DECISION_TOO_LARGE');
  assertNoDuplicateKeys(raw);
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch (error) { throw new V4Error('DECISION_JSON_INVALID', 'Decision must be one JSON object', error); }
  const root = asRecord(parsed, 'DECISION_OBJECT_REQUIRED');
  assertSafeEventPayload(root);
  if (root.version !== SUPERVISOR_PROTOCOL_VERSION && root.version !== 'PIXEL_SUPERVISOR_DECISION_V1') throw new V4Error('DECISION_VERSION_UNSUPPORTED', 'version=' + typeof root.version + ':' + String(root.version).slice(0, 40) + ';keys=' + Object.keys(root).sort().join(','));
  const planId = text(root.planId, 'DECISION_PLAN_REQUIRED', 200);
  const supervisorId = text(root.supervisorId, 'DECISION_SUPERVISOR_REQUIRED', 200);
  if (typeof root.observationCursor !== 'number' || !Number.isInteger(root.observationCursor) || root.observationCursor < 0) throw new V4Error('DECISION_CURSOR_INVALID');
  const projectionDigest = text(root.projectionDigest, 'DECISION_DIGEST_REQUIRED', 200);
  const idempotencyKey = text(root.idempotencyKey, 'DECISION_IDEMPOTENCY_REQUIRED', 500);
  const preconditionSnapshot = asRecord(root.preconditionSnapshot ?? {}, 'DECISION_PRECONDITION_INVALID');
  const actionRoot = asRecord(root.action, 'ACTION_REQUIRED');
  if (!isActionType(actionRoot.type)) throw new V4Error('ACTION_TYPE_UNSUPPORTED');
  const action: SupervisorAction = {
    actionId: typeof actionRoot.actionId === 'string' && actionRoot.actionId.length > 0 ? actionRoot.actionId : randomUUID(),
    version: 1,
    type: actionRoot.type,
    planId,
    supervisorId,
    observationCursor: root.observationCursor,
    projectionDigest,
    idempotencyKey,
    preconditionSnapshot,
    payload: parsePayload(actionRoot.type, actionRoot.payload),
    status: 'PROPOSED',
    createdAt: now,
    updatedAt: now,
  };
  validateActionShape(action);
  return { decisionId: typeof root.decisionId === 'string' && root.decisionId.length > 0 ? root.decisionId : randomUUID(), version: 1, planId, supervisorId, observationCursor: root.observationCursor, projectionDigest, idempotencyKey, preconditionSnapshot, action, createdAt: now };
}
