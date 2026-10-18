import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePool, rankForYou, sortLatest } from '../forYouRank.ts';
import { forYouProgress } from '../forYouGate.ts';
import { diversifyFeed } from '../diversify.ts';
import type { BlurbCard } from '../../contract/types.ts';

const card = (id: string, category: string, published: string, sortAt = published): BlurbCard =>
  ({ id, category, published_at: published, as_of: published, sort_at: sortAt, kind: 'summary', headline: id, sources: [], tickers: [] }) as unknown as BlurbCard;

const noPrefs = { reactions: {}, hiddenTopics: [], hiddenSources: [], follows: { topics: [] as string[] } };

test('Latest is newest first by published_at (the Truist case)', () => {
  const faa = ['a1', 'a2', 'a3', 'a4'].map((id) => card(id, 'policy', '2026-10-17T23:32:00Z', '2026-10-19T00:00:00Z'));
  const truist = card('truist', 'earnings', '2026-10-18T14:51:00Z', '2026-10-18T14:51:00Z');
  const out = sortLatest([...faa, truist]);
  assert.equal(out[0].id, 'truist');
  // ties: sort_at then id
  assert.deepEqual(out.slice(1).map((c) => c.id), ['a1', 'a2', 'a3', 'a4']);
});

test('mergePool dedupes', () => {
  const a = card('a', 'x', '2026-10-18T10:00:00Z');
  assert.equal(mergePool([a], [a, card('b', 'x', '2026-10-18T09:00:00Z')]).length, 2);
});

const trending = [
  card('t1', 'markets', '2026-10-17T10:00:00Z'),
  card('t2', 'policy', '2026-10-17T09:00:00Z'),
  card('t3', 'economy', '2026-10-17T08:00:00Z'),
];
const latest = [card('n1', 'earnings', '2026-10-18T14:00:00Z'), card('n2', 'tech', '2026-10-18T13:00:00Z'), card('t1', 'markets', '2026-10-17T10:00:00Z')];
const likes = Object.fromEntries(['markets', 'policy', 'economy'].map((t, i) => [`old${i}`, { r: 'like' as const, topic: t, source: null, at: i }]));

test('For you first card differs from Trending first card for a reader with likes in 3 topics', () => {
  const prefs = { ...noPrefs, reactions: likes };
  const out = rankForYou(mergePool(trending, latest), prefs, new Set(), 't1');
  assert.notEqual(out[0].id, 't1');
  assert.equal(new Set(out.map((c) => c.id)).size, out.length);
  // with no signals it is freshness, not Trending's order
  assert.equal(rankForYou(mergePool(trending, latest), noPrefs, new Set(), 't1')[0].id, 'n1');
});

test('seen and reacted cards sink', () => {
  const out = rankForYou(mergePool(trending, latest), { ...noPrefs, reactions: { n2: { r: 'like', topic: 'tech', source: null, at: 1 } } }, new Set(['n1']), null);
  assert.deepEqual(out.slice(-2).map((c) => c.id).sort(), ['n1', 'n2']);
});

test('only one card: the guard does not drop it', () => {
  assert.equal(rankForYou([trending[0]], noPrefs, new Set(), 't1').length, 1);
});

test('gate unchanged and Trending order only goes through diversify', () => {
  assert.equal(forYouProgress({ seen: Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, category: `c${i % 4}` })) }).ready, true);
  assert.equal(forYouProgress({ seen: Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, category: 'c' })) }).ready, false);
  assert.deepEqual(diversifyFeed(trending).map((c) => c.id), ['t1', 't2', 't3']);
});
