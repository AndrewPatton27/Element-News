import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebaseCards } from '../feed/rebase.ts';
import { card } from './helpers.ts';
import { createMockFeatureApi } from '../api/api.mockFeatures.ts';

test('rebaseCards puts the newest card one hour old and keeps gaps', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const a = card({ id: 'a', sort_at: '2026-10-17T12:00:00Z' });
  const b = card({ id: 'b', sort_at: '2026-10-17T06:00:00Z' });
  const [ra, rb] = rebaseCards([a, b], now);
  assert.equal(Date.parse(ra!.sort_at), now - 3_600_000);
  assert.equal(Date.parse(ra!.sort_at) - Date.parse(rb!.sort_at), 6 * 3_600_000);
  assert.equal(ra!.sources[0]!.published_at, new Date(now - 3_600_000).toISOString());
  assert.deepEqual(rebaseCards([], now), []);
});

test('rebased fixtures always fill the daily brief window, whatever today is', async () => {
  const cards = rebaseCards([
    card({ id: 'c1' }),
    card({ id: 'c2', category: 'markets', sort_at: '2026-10-17T10:00:00Z' }),
    card({ id: 'c3', category: 'economy', sort_at: '2026-10-17T08:00:00Z' }),
  ]);
  const daily = await createMockFeatureApi(cards, [], []).dailyBrief();
  assert.ok(daily.headline_cards.length > 0);
});
