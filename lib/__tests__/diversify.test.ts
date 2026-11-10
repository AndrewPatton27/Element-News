import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card } from './helpers.ts';
import { DIVERSIFY_TAIL, diversifyAppend, diversifyFeed, pickTopStories } from '../feed/diversify.ts';
import type { BlurbCard } from '../../contract/types.ts';
import { feedReducer, initialFeedState } from '../feed/feedLogic.ts';

test('Top stories picks distinct categories and excludes shared symbols and story links', () => {
  const items = [
    ...[
      ['faa1', 'policy', 'recall'], ['faa2', 'policy', 'recall'], ['irs', 'economy', 'macro_release'],
      ['quake', 'world', 'world_event'], ['earn', 'earnings', 'earnings'], ['recall', 'safety', 'science'], ['tech', 'tech', 'deal'],
    ].map(([id, category, event_type]) => card({ id, category: category as never, event_type, tickers: [], sources: [{ ...card().sources[0], name: id?.startsWith('faa') ? 'FAA' : id }] })),
  ];
  const picked = pickTopStories(items);
  assert.equal(picked.length, 5);
  assert.equal(new Set(picked.map((x) => x.category)).size, 5);
  assert.ok(!picked.some((x) => x.id === 'faa2'));
});

test('Top stories never repeats source and similar event when categories are exhausted', () => {
  const items = ['one', 'two', 'three'].map((id) => card({ id, category: 'policy', event_type: 'recall', tickers: [], sources: [card({ id }).sources[0]] }));
  assert.equal(pickTopStories(items, 5).length, 1);
});

test('Trending diversification caps category runs and preserves an already mixed order', () => {
  const cards = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => card({ id: String(i), category: i % 2 ? 'world' : 'tech' }));
  assert.deepEqual(diversifyFeed(cards).map((x) => x.id), cards.map((x) => x.id));
  const clustered = ['tech', 'tech', 'tech', 'tech', 'world', 'earnings', 'safety', 'economy'].map((category, i) => card({ id: `c${i}`, category: category as never }));
  const mixed = diversifyFeed(clustered);
  for (let i = 0; i <= mixed.length - 5; i++) {
    const counts = new Map<string, number>();
    for (const item of mixed.slice(i, i + 5)) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    assert.ok(Math.max(...counts.values()) <= 2);
  }
  assert.ok(mixed.every((c) => clustered.findIndex((x) => x.id === c.id) - mixed.findIndex((x) => x.id === c.id) <= 6));
});

// The list-scan version diversifyFeed had before P2-13 (O(n^2)), kept here as the reference.
function referenceDiversify(cards: BlurbCard[], options: { maxRun?: 1 | 2; window?: number } = {}): BlurbCard[] {
  const cap = options.maxRun ?? 2, window = Math.max(cap + 1, Math.trunc(options.window ?? 5));
  const remaining = cards.map((c, index) => ({ card: c, index })), out: BlurbCard[] = [];
  while (remaining.length) {
    const pos = out.length;
    const inWindow = (x: typeof remaining[number]) => out.slice(Math.max(0, pos - window + 1)).filter((c) => c.category === x.card.category).length < cap;
    let i = remaining.findIndex((x) => pos - x.index <= 6 && !(pos && out[pos - 1].category === x.card.category) && inWindow(x));
    if (i < 0) i = remaining.findIndex((x) => inWindow(x) && !(pos && out[pos - 1].category === x.card.category));
    if (i < 0) i = 0;
    out.push(remaining.splice(i, 1)[0].card);
  }
  return out;
}

const TOPICS = ['tech', 'world', 'earnings', 'safety', 'economy', 'policy'] as const;
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function randomFeed(rand: () => number, n: number, topics: number) {
  // runs of the same topic are common in real Trending pages, so make them likely
  let t = 0;
  return Array.from({ length: n }, (_, i) => {
    if (rand() < 0.45) t = Math.floor(rand() * topics);
    return card({ id: `r${i}`, category: TOPICS[t] as never });
  });
}

test('diversifyFeed gives the same order as the old list scan on 600 random feeds (P2-13)', () => {
  const rand = seeded(42);
  for (let run = 0; run < 600; run++) {
    const feed = randomFeed(rand, 1 + Math.floor(rand() * 60), 1 + Math.floor(rand() * TOPICS.length));
    const opts = run % 3 === 0 ? { maxRun: 1 as const } : run % 3 === 1 ? { window: 4 + Math.floor(rand() * 4) } : {};
    assert.deepEqual(diversifyFeed(feed, opts).map((c) => c.id), referenceDiversify(feed, opts).map((c) => c.id), `run ${run}`);
  }
});

test('diversifyFeed and the Trending reducer stay fast on 5000 cards (P2-13)', () => {
  const one = Array.from({ length: 5000 }, (_, i) => card({ id: `s${i}`, category: 'tech' }));
  let t = performance.now();
  assert.deepEqual(diversifyFeed(one).map((c) => c.id), one.map((c) => c.id), 'one topic: order kept');
  assert.ok(performance.now() - t < 500, `one topic took ${performance.now() - t} ms`);
  const mixed = randomFeed(seeded(7), 5000, TOPICS.length);
  t = performance.now();
  const out = diversifyFeed(mixed);
  assert.equal(new Set(out.map((c) => c.id)).size, 5000);
  assert.ok(performance.now() - t < 500, `mixed took ${performance.now() - t} ms`);
  // 500 pages of 10 through the reducer: each page re-mixes only the tail, never the whole list
  t = performance.now();
  let s = initialFeedState('top|all');
  for (let i = 0; i < 5000; i += 10) s = feedReducer(s, { type: 'page', key: 'top|all', page: { items: mixed.slice(i, i + 10), next_cursor: i + 10 < 5000 ? String(i + 10) : null } });
  assert.equal(s.items.length, 5000);
  assert.equal(new Set(s.items.map((c) => c.id)).size, 5000);
  assert.ok(performance.now() - t < 1500, `reducer took ${performance.now() - t} ms`);
});

test('Trending paging re-mixes only the tail: earlier cards keep their places (P2-13)', () => {
  const rand = seeded(3);
  const feed = randomFeed(rand, 200, 4);
  let s = initialFeedState('top|all');
  for (let i = 0; i < 200; i += 10) {
    const before = s.items.slice();
    s = feedReducer(s, { type: 'page', key: 'top|all', page: { items: feed.slice(i, i + 10), next_cursor: String(i + 10) } });
    const frozen = Math.max(0, before.length - DIVERSIFY_TAIL);
    assert.deepEqual(s.items.slice(0, frozen).map((c) => c.id), before.slice(0, frozen).map((c) => c.id), `page ${i / 10}`);
  }
  // the first page alone is the same as diversifying it directly
  const first = feedReducer(initialFeedState('top|all'), { type: 'page', key: 'top|all', page: { items: feed.slice(0, 10), next_cursor: null } });
  assert.deepEqual(first.items.map((c) => c.id), diversifyFeed(feed.slice(0, 10)).map((c) => c.id));
  // diversifyAppend with a context still honours the run cap across the seam
  const a = Array.from({ length: 40 }, (_, i) => card({ id: `a${i}`, category: i % 2 ? 'world' : 'tech' }));
  const b = Array.from({ length: 10 }, (_, i) => card({ id: `b${i}`, category: 'tech' })).concat([card({ id: 'w', category: 'world' })]);
  const merged = diversifyAppend(a, [...a, ...b], 4);
  const seam = merged.slice(a.length - 6, a.length + 2).map((c) => c.category);
  for (let i = 0; i + 1 < seam.length; i++) assert.ok(!(seam[i] === 'tech' && seam[i + 1] === 'tech' && seam[i + 2] === 'tech'), seam.join(','));
});

test('Latest, For you and Following reducer queues retain their original order', () => {
  const pageCards = [card({ id: 'a', category: 'tech' }), card({ id: 'b', category: 'tech' }), card({ id: 'c', category: 'tech' })];
  for (const key of ['latest|all', 'for_you|all|u', 'following|all']) {
    const state = feedReducer(initialFeedState(key), { type: 'page', key, page: { items: pageCards, next_cursor: null } });
    assert.deepEqual(state.items.map((x) => x.id), ['a', 'b', 'c']);
  }
});
