import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewVerdict } from '../src/v3/reviewVerdict.js';

test('review verdict prefers strict first-line PASS or FAIL', () => {
  assert.equal(reviewVerdict('PASS\nNo blocking findings.'), 'APPROVED');
  assert.equal(reviewVerdict('FAIL\nA blocking defect remains.'), 'BLOCKING');
  assert.equal(reviewVerdict('INVALID\nThe claimed problem is not reproducible.'), 'UNKNOWN');
  assert.equal(
    reviewVerdict('INVALID\nThe claimed problem is not reproducible.', { allowInvalid: true }),
    'INVALID',
  );
});

test('review verdict accepts one unique standalone fallback token', () => {
  assert.equal(reviewVerdict('Review complete.\nPASS\nAll criteria verified.'), 'APPROVED');
  assert.equal(reviewVerdict('Verification summary.\nFAIL\nOne blocker remains.'), 'BLOCKING');
  assert.equal(reviewVerdict('Verification summary.\nINVALID\nFalse positive.'), 'UNKNOWN');
  assert.equal(
    reviewVerdict('Verification summary.\nINVALID\nFalse positive.', { allowInvalid: true }),
    'INVALID',
  );
});

test('review verdict fails closed on aliases and ambiguous standalone tokens', () => {
  assert.equal(reviewVerdict('APPROVED: legacy form'), 'UNKNOWN');
  assert.equal(reviewVerdict('BLOCKED: legacy form'), 'UNKNOWN');
  assert.equal(reviewVerdict('CHANGES REQUESTED: legacy form'), 'UNKNOWN');
  assert.equal(reviewVerdict('Review complete.\nPASS\nExample of a blocker:\nFAIL'), 'UNKNOWN');
  assert.equal(reviewVerdict(''), 'UNKNOWN');
});
