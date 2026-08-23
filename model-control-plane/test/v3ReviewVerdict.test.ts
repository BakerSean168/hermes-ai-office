import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewVerdict } from '../src/v3/reviewVerdict.js';

test('review verdict accepts current PASS/FAIL and historical explicit verdict forms', () => {
  assert.equal(reviewVerdict('PASS\nNo blocking findings.'), 'APPROVED');
  assert.equal(reviewVerdict('FAIL\nA blocking defect remains.'), 'BLOCKING');
  assert.equal(reviewVerdict('APPROVED: historical reviewer found no issue'), 'APPROVED');
  assert.equal(reviewVerdict('APPROVED – historical reviewer found no issue'), 'APPROVED');
  assert.equal(reviewVerdict('BLOCKED: historical focused finding'), 'BLOCKING');
  assert.equal(reviewVerdict('BLOCKED — High severity implementation defect.'), 'BLOCKING');
  assert.equal(reviewVerdict('REJECTED - historical reviewer rejected the change'), 'BLOCKING');
  assert.equal(reviewVerdict('CHANGES REQUESTED: address the regression'), 'BLOCKING');
});

test('review verdict is first-line deterministic and fails closed on narrative ambiguity', () => {
  assert.equal(reviewVerdict('Review complete.\nPASS'), 'UNKNOWN');
  assert.equal(reviewVerdict('PASS looks good overall.'), 'UNKNOWN');
  assert.equal(reviewVerdict('FAIL: new reviews must use an exact verdict line'), 'UNKNOWN');
  assert.equal(reviewVerdict('**FAIL**'), 'UNKNOWN');
  assert.equal(reviewVerdict('Looks good overall.'), 'UNKNOWN');
  assert.equal(reviewVerdict(''), 'UNKNOWN');
});
