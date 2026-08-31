import { V4Error, failClosed } from './errors.js';

export const AGGREGATE_TYPES = [
  'PLAN', 'WORK_ITEM', 'EXECUTION', 'REVIEW', 'SUPERVISOR', 'DECISION',
  'ACTION', 'RESOURCE', 'DELIVERY', 'RELATIONSHIP', 'MAINTENANCE', 'EXTERNAL_CHANGE',
] as const;

export type AggregateType = (typeof AGGREGATE_TYPES)[number];

export interface EventEnvelope<TPayload = unknown> {
  eventId: string;
  aggregateId: string;
  aggregateType: AggregateType;
  sequence: number;
  type: string;
  payload: TPayload;
  occurredAt: string;
  correlationId: string;
}

export interface EventToAppend<TPayload = unknown>
  extends Omit<EventEnvelope<TPayload>, 'sequence'> {
  sequence?: number;
}

const FORBIDDEN_PAYLOAD_KEY = /(password|secret|credential|authorization|raw[_-]?headers|bearer|access[_-]?token|private[_-]?key|api[_-]?key|auth[_-]?token|(^|[_-])token$)/i;

function assertPayloadValue(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new V4Error('UNSAFE_EVENT_PAYLOAD', 'Unsupported event payload value at ' + path);
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new V4Error('UNSAFE_EVENT_PAYLOAD', 'Cyclic event payload at ' + path);
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertPayloadValue(item, path + '[' + index + ']', seen));
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_PAYLOAD_KEY.test(key)) {
          throw new V4Error('UNSAFE_EVENT_PAYLOAD', 'Forbidden event payload key at ' + path + '.' + key);
        }
        assertPayloadValue(child, path + '.' + key, seen);
      }
    }
    seen.delete(value);
  }
}

export function assertSafeEventPayload(value: unknown): void {
  assertPayloadValue(value, 'payload');
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new V4Error('UNSAFE_EVENT_PAYLOAD', 'Event payload is not JSON serializable', error);
  }
}

export function validateEventEnvelope(event: EventEnvelope): void {
  failClosed(typeof event.eventId === 'string' && event.eventId.length > 0, 'EVENT_ID_REQUIRED');
  failClosed(typeof event.aggregateId === 'string' && event.aggregateId.length > 0, 'AGGREGATE_ID_REQUIRED');
  failClosed(AGGREGATE_TYPES.includes(event.aggregateType), 'AGGREGATE_TYPE_INVALID');
  failClosed(Number.isInteger(event.sequence) && event.sequence > 0, 'EVENT_SEQUENCE_INVALID');
  failClosed(typeof event.type === 'string' && event.type.length > 0, 'EVENT_TYPE_REQUIRED');
  failClosed(typeof event.occurredAt === 'string' && event.occurredAt.length > 0, 'EVENT_TIME_REQUIRED');
  failClosed(typeof event.correlationId === 'string' && event.correlationId.length > 0, 'CORRELATION_ID_REQUIRED');
  assertSafeEventPayload(event.payload);
}
