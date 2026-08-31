export class V4Error extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message = code, details?: unknown) {
    super(message);
    this.name = 'V4Error';
    this.code = code;
    this.details = details;
  }
}

export class InvalidTransitionError extends V4Error {
  constructor(entity: string, from: string, to: string) {
    super('INVALID_STATE_TRANSITION', entity + ': ' + from + ' -> ' + to);
  }
}

export class StaleStateError extends V4Error {
  constructor(message = 'Durable state is stale') {
    super('STALE_STATE', message);
  }
}

export class DuplicateKeyError extends V4Error {
  constructor(key: string) {
    super('DUPLICATE_KEY', 'Duplicate durable key: ' + key);
  }
}

export class DataResetRequiredError extends V4Error {
  constructor(file: string) {
    super(
      'V4_DATA_RESET_REQUIRED',
      'Existing non-V4 database detected at ' + file +
        '. Set PIXEL_V4_ALLOW_DATA_RESET=true for an explicit destructive rebuild.',
    );
  }
}

export function assertNever(value: never): never {
  throw new V4Error('UNEXPECTED_VARIANT', 'Unexpected variant: ' + String(value));
}

export function failClosed(condition: unknown, code: string, message = code): asserts condition {
  if (!condition) throw new V4Error(code, message);
}
