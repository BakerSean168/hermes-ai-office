import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { DuplicateKeyError, V4Error } from '../domain/errors.js';
import { assertSafeEventPayload, validateEventEnvelope, type EventEnvelope, type EventToAppend } from '../domain/events.js';
import { withTransaction } from './database.js';

interface EventRow {
  event_order: number;
  event_id: string;
  aggregate_id: string;
  aggregate_type: EventEnvelope['aggregateType'];
  sequence: number;
  type: string;
  payload: string;
  occurred_at: string;
  correlation_id: string;
}

function fromRow(row: EventRow): EventEnvelope {
  let payload: unknown;
  try { payload = JSON.parse(row.payload) as unknown; } catch (error) { throw new V4Error('CORRUPTED_EVENT_PAYLOAD', 'Cannot decode event ' + row.event_id, error); }
  const event: EventEnvelope = {
    eventId: row.event_id, aggregateId: row.aggregate_id, aggregateType: row.aggregate_type, sequence: row.sequence,
    type: row.type, payload, occurredAt: row.occurred_at, correlationId: row.correlation_id,
  };
  validateEventEnvelope(event);
  return event;
}

export class EventStore {
  constructor(readonly db: DatabaseSync) {}

  append<T>(event: EventToAppend<T>): EventEnvelope<T> {
    return withTransaction(this.db, () => this.appendInTransaction(event));
  }

  appendInTransaction<T>(event: EventToAppend<T>): EventEnvelope<T> {
    assertSafeEventPayload(event.payload);
    if (this.db.prepare('SELECT event_id FROM events WHERE event_id=?').get(event.eventId)) throw new DuplicateKeyError(event.eventId);
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE aggregate_id=?').get(event.aggregateId) as { sequence: number };
    const sequence = row.sequence + 1;
    if (event.sequence !== undefined && event.sequence !== sequence) throw new V4Error('EVENT_SEQUENCE_CONFLICT');
    const envelope: EventEnvelope<T> = { ...event, sequence };
    validateEventEnvelope(envelope);
    this.db.prepare('INSERT INTO events(event_id,aggregate_id,aggregate_type,sequence,type,payload,occurred_at,correlation_id) VALUES(?,?,?,?,?,?,?,?)').run(
      envelope.eventId, envelope.aggregateId, envelope.aggregateType, envelope.sequence, envelope.type, JSON.stringify(envelope.payload), envelope.occurredAt, envelope.correlationId,
    );
    return envelope;
  }

  appendNew<T>(input: Omit<EventToAppend<T>, 'eventId'> & { eventId?: string }): EventEnvelope<T> {
    return this.append({ ...input, eventId: input.eventId ?? randomUUID() });
  }

  get(eventId: string): EventEnvelope | undefined {
    const row = this.db.prepare('SELECT event_order,event_id,aggregate_id,aggregate_type,sequence,type,payload,occurred_at,correlation_id FROM events WHERE event_id=?').get(eventId) as EventRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listByAggregate(aggregateId: string, afterSequence = 0): EventEnvelope[] {
    const rows = this.db.prepare('SELECT event_order,event_id,aggregate_id,aggregate_type,sequence,type,payload,occurred_at,correlation_id FROM events WHERE aggregate_id=? AND sequence>? ORDER BY sequence').all(aggregateId, afterSequence) as unknown as EventRow[];
    return rows.map(fromRow);
  }

  listAfterCursor(cursor = 0, limit = 500): { cursor: number; events: EventEnvelope[] } {
    const rows = this.db.prepare('SELECT event_order,event_id,aggregate_id,aggregate_type,sequence,type,payload,occurred_at,correlation_id FROM events WHERE event_order>? ORDER BY event_order LIMIT ?').all(cursor, limit) as unknown as EventRow[];
    const last = rows.at(-1);
    return { cursor: last ? last.event_order : cursor, events: rows.map(fromRow) };
  }

  replay<T>(aggregateId: string, initial: T, reducer: (state: T, event: EventEnvelope) => T): T {
    return this.listByAggregate(aggregateId).reduce(reducer, initial);
  }
}
