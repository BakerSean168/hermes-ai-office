import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewVerdict } from '../src/v3/reviewVerdict.js';

test('review verdict accepts only strict first-line PASS or FAIL', () => {
  assert.equal(reviewVerdict('PASS\nNo blocking findings.'), 'APPROVED');
  assert.equal(reviewVerdict('FAIL\nA blocking defect remains.'), 'BLOCKING');
});

test('review verdict fails closed on legacy aliases and narrative ambiguity', () => {
  assert.equal(reviewVerdict('APPROVED: legacy form'), 'UNKNOWN');
  assert.equal(reviewVerdict('BLOCKED: legacy form'), 'UNKNOWN');
  assert.equal(reviewVerdict('CHANGES REQUESTED: legacy form'), 'UNKNOWN');
  assert.equal(reviewVerdict('Review complete.\nPASS'), 'UNKNOWN');
  assert.equal(reviewVerdict(''), 'UNKNOWN');
});
