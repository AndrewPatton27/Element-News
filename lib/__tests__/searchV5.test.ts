// Search v5 order key, mock mirror of 20261114000000_search_v5.sql (supabase/tests/search_v5_check.sql
// runs the same cases against the database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_PRIOR_WEIGHT, affinityPrior, rankPrior, rankSearch, searchOrderKey } from '../search/searchLogic.ts';
import { card } from './helpers.ts';
import type { BlurbCard } from '../../contract/types.ts';

const NOW = 500_000; // hours since 1970, frozen
const trendOf = new Map<string, number>();
const trend = (c: BlurbCard) => trendOf.get(c.id) ?? NOW;
function mk(id: string, headline: string, body: string, t: number, over: Partial<BlurbCard> = {}): BlurbCard {
  trendOf.set(id, t);
  return card({ id, headline, body, tickers: [], importance: 2, sources: [{ ...card().sources[0], name: 'SV5 Source' }], ...over });
}
const strong = mk('strong', 'Quixor plant closes', 'Workers were told on Monday.', NOW - 40);
const weak = mk('weak', 'Quixorama festival sells out', 'Tickets went fast.', NOW + 60);
const vis = mk('vis', 'Port traffic slows', 'Glimmora shipments fell.', NOW - 30);
const deep = mk('deep', 'Retailer posts results', 'Sales rose.', NOW + 60, { category: 'markets', detail: { key_points: ['Sales rose.'], paragraphs: ['Glimmora demand drove the quarter.'] } });
const fresh = mk('fresh', 'Vantrel merger approved', 'Details follow.', NOW + 8);
const stale = mk('stale', 'Vantrel merger delayed', 'Details follow.', NOW - 16, { sort_at: '2026-10-16T12:00:00Z' });
const econ = mk('econ', 'Zelquin outlook raised', 'Details follow.', NOW + 3, { category: 'economy' });
const tech = mk('tech', 'Zelquin outlook cut', 'Details follow.', NOW + 1, { category: 'tech' });
const pool = [weak, strong, deep, vis, stale, fresh, tech, econ];
const order = (q: string, taste?: (c: BlurbCard) => number) => rankSearch(pool, q, trend, { nowHours: NOW, tasteHours: taste ?? null }).map((c) => c.id);
const followsTech = (c: BlurbCard) => (c.category === 'tech' ? 2 : 0); // core.taste_hours: +2 h for a followed topic

test('priors are bounded 0..1 and monotonic', () => {
  assert.equal(rankPrior(NOW, NOW), 0.5);
  assert.ok(rankPrior(NOW + 8, NOW) > rankPrior(NOW, NOW));
  assert.ok(rankPrior(NOW - 1e6, NOW) >= 0 && rankPrior(NOW + 1e6, NOW) <= 1);
  assert.equal(rankPrior(Number.NaN, NOW), 0);
  assert.equal(affinityPrior(0), 0.5);
  assert.equal(affinityPrior(100), 1);
  assert.equal(affinityPrior(-100), 0);
});

test('the prior moves the key by at most the weight; visible tier on top', () => {
  const base = { visible: true, relevance: 1, terms: 1 };
  const lo = searchOrderKey({ ...base, rankPart: 0 });
  const hi = searchOrderKey({ ...base, rankPart: 1 });
  assert.ok(Math.abs(hi - lo - SEARCH_PRIOR_WEIGHT) < 1e-9);
  assert.ok(searchOrderKey({ visible: false, relevance: 1, terms: 1, rankPart: 1 }) < searchOrderKey({ visible: true, relevance: 0.25, terms: 1, rankPart: 0 }));
  // exact (1.0) beats stem (0.8) on one word whatever the priors
  assert.ok(searchOrderKey({ ...base, rankPart: 0, affinity: 0 }) > searchOrderKey({ ...base, relevance: 0.8, rankPart: 1, affinity: 1 }));
});

test('a strong text match beats a hot weak one; visible beats detail-only', () => {
  assert.deepEqual(order('quixor'), ['strong', 'weak']);
  assert.deepEqual(order('glimmora'), ['vis', 'deep']);
});

test('equal matches follow the prior: fresher first; signed in, the followed topic first', () => {
  assert.deepEqual(order('vantrel'), ['fresh', 'stale']);
  assert.deepEqual(order('zelquin'), ['econ', 'tech']);
  assert.deepEqual(order('zelquin', followsTech), ['tech', 'econ']);
  assert.deepEqual(order('quixor', () => 4), ['strong', 'weak'], 'affinity never lifts a weaker match');
});

test('deterministic, and weight 0 is plain relevance then importance, newest, id', () => {
  assert.deepEqual(order('vantrel zelquin quixor glimmora'), order('vantrel zelquin quixor glimmora'));
  const plain = rankSearch(pool, 'vantrel', trend, { nowHours: NOW, weight: 0 }).map((c) => c.id);
  assert.deepEqual(plain, ['fresh', 'stale']);
});
