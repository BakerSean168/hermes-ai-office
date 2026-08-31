import assert from 'node:assert/strict';
import test from 'node:test';

import { V4Error } from '../src/v4/domain/errors.js';
import { assertSafeEventPayload } from '../src/v4/domain/events.js';

test('event payload safety rejects credential-like fields and cyclic values', () => {
  assert.throws(() => assertSafeEventPayload({ token: 'provider-token' }), (error: unknown) => error instanceof V4Error && error.code === 'UNSAFE_EVENT_PAYLOAD');
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => assertSafeEventPayload(cyclic), (error: unknown) => error instanceof V4Error && error.code === 'UNSAFE_EVENT_PAYLOAD');
});
