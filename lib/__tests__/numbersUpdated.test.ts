import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numbersUpdatedLabel } from '../numbers/numbersUpdated.ts';
import type { MacroFact } from '../../contract/types.ts';

const now = new Date('2026-10-19T12:00:00Z');
const fact = (o: Partial<MacroFact>): MacroFact => ({
  series_id: 'X', label: 'X', value: '1', change: null, direction: null, period: null,
  as_of: '2026-10-16', source_name: 's', source_short: 's', source_url: 'https://x.gov', sort_order: 1, ...o,
});

test('all numbers updated uses the oldest refresh', () => {
  const facts = [fact({ updated_at: '2026-10-19T11:30:00Z' }), fact({ updated_at: '2026-10-19T09:00:00Z' })];
  assert.equal(numbersUpdatedLabel(facts, now), 'All numbers updated 3 h ago');
});

test('falls back to the newest observation date when a server omits updated_at', () => {
  const facts = [fact({}), fact({ as_of: '2026-10-17' })];
  assert.equal(numbersUpdatedLabel(facts, now), 'Latest data from Oct 17');
});

test('one missing updated_at also falls back, and an empty list gives no label', () => {
  assert.match(numbersUpdatedLabel([fact({ updated_at: '2026-10-19T11:30:00Z' }), fact({})], now), /^Latest data from/);
  assert.equal(numbersUpdatedLabel([], now), '');
});
