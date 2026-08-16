import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface CommandOutcome<T = unknown> {
  statusCode: number;
  body: T;
}

export interface IdempotentOutcome<T = unknown> extends CommandOutcome<T> {
  replayed: boolean;
}

interface StoredResponse {
  state: 'IN_PROGRESS' | 'COMPLETED';
  statusCode?: number;
  body?: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

export function commandRequestHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value ?? null)))
    .digest('hex');
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{2,95}$/.test(message) ? message : 'IDEMPOTENT_COMMAND_FAILED';
}

function parseStored(value: unknown): StoredResponse {
  if (typeof value !== 'string') return { state: 'IN_PROGRESS' };
  try {
    const parsed = JSON.parse(value) as Partial<StoredResponse>;
    return parsed.state === 'COMPLETED'
      ? {
          state: 'COMPLETED',
          statusCode: Number(parsed.statusCode ?? 500),
          body: parsed.body,
        }
      : { state: 'IN_PROGRESS' };
  } catch {
    return { state: 'IN_PROGRESS' };
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('IDEMPOTENCY_CONFLICT');
  }
}

export class IdempotencyInProgressError extends Error {
  constructor() {
    super('IDEMPOTENCY_IN_PROGRESS');
  }
}

export class IdempotencyService {
  readonly #db: DatabaseSync;
  readonly #inFlight = new Map<string, Promise<IdempotentOutcome>>();
  readonly #ttlMs: number;

  constructor(db: DatabaseSync, options: { ttlMs?: number } = {}) {
    this.#db = db;
    this.#ttlMs = Math.max(60_000, options.ttlMs ?? 24 * 60 * 60 * 1_000);
  }

  async execute<T>(input: {
    key?: string;
    commandType: string;
    request: unknown;
    operation: () => Promise<CommandOutcome<T>> | CommandOutcome<T>;
  }): Promise<IdempotentOutcome<T>> {
    const key = input.key?.trim();
    if (!key) {
      const result = await input.operation();
      return { ...result, replayed: false };
    }
    if (key.length > 200) throw new Error('IDEMPOTENCY_KEY_TOO_LONG');

    const active = this.#inFlight.get(key);
    if (active) {
      await active;
      return (await this.#executeOwned({ ...input, key })) as IdempotentOutcome<T>;
    }

    const task = this.#executeOwned({ ...input, key });
    this.#inFlight.set(key, task as Promise<IdempotentOutcome>);
    try {
      return (await task) as IdempotentOutcome<T>;
    } finally {
      if (this.#inFlight.get(key) === task) this.#inFlight.delete(key);
    }
  }

  async #executeOwned<T>(input: {
    key: string;
    commandType: string;
    request: unknown;
    operation: () => Promise<CommandOutcome<T>> | CommandOutcome<T>;
  }): Promise<IdempotentOutcome<T>> {
    const requestHash = commandRequestHash(input.request);
    const timestamp = Date.now();
    this.#db.prepare('DELETE FROM v2_idempotency_keys WHERE expires_at<=?').run(timestamp);

    const existing = this.#db
      .prepare(
        `SELECT command_type,request_hash,response_json,expires_at
         FROM v2_idempotency_keys WHERE idempotency_key=?`,
      )
      .get(input.key) as
      | {
          command_type: string;
          request_hash: string;
          response_json: string;
          expires_at: number;
        }
      | undefined;
    if (existing) {
      if (existing.command_type !== input.commandType || existing.request_hash !== requestHash) {
        throw new IdempotencyConflictError();
      }
      const stored = parseStored(existing.response_json);
      if (stored.state === 'IN_PROGRESS') throw new IdempotencyInProgressError();
      return {
        statusCode: Number(stored.statusCode ?? 500),
        body: stored.body as T,
        replayed: true,
      };
    }

    try {
      this.#db
        .prepare(
          `INSERT INTO v2_idempotency_keys(idempotency_key,command_type,request_hash,response_json,created_at,expires_at)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(
          input.key,
          input.commandType,
          requestHash,
          JSON.stringify({ state: 'IN_PROGRESS' }),
          timestamp,
          timestamp + this.#ttlMs,
        );
    } catch (error) {
      if (String(error).includes('UNIQUE')) return this.#executeOwned(input);
      throw error;
    }

    let result: CommandOutcome<T>;
    try {
      result = await input.operation();
    } catch (error) {
      result = {
        statusCode: 500,
        body: { error: { code: safeErrorCode(error) } } as T,
      };
    }
    this.#db.prepare('UPDATE v2_idempotency_keys SET response_json=? WHERE idempotency_key=?').run(
      JSON.stringify({
        state: 'COMPLETED',
        statusCode: result.statusCode,
        body: result.body,
      }),
      input.key,
    );
    return { ...result, replayed: false };
  }
}
