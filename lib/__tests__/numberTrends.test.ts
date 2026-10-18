import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_NUMBER_TRENDS } from '../numberTrendsSample.ts';
import { parseNumberTrends } from '../types.ts';

test('sample number trends match the interface and the design', () => {
  assert.equal(parseNumberTrends(SAMPLE_NUMBER_TRENDS).length, 4);
  for (const t of SAMPLE_NUMBER_TRENDS) {
    assert.equal(t.points.length, 12);
    assert.ok(!/^FRED$/.test(t.source));
  }
});

test('parseNumberTrends rejects a non-list and bad directions', () => {
  assert.throws(() => parseNumberTrends({}));
  assert.deepEqual(parseNumberTrends([{ ...SAMPLE_NUMBER_TRENDS[0], direction: 'sideways' }]), []);
});
