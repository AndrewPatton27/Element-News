import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card } from './helpers.ts';
import { diversifyFeed, pickTopStories } from '../diversify.ts';
import { feedReducer, initialFeedState } from '../feedLogic.ts';

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

test('Latest, For you and Following reducer queues retain their original order', () => {
  const pageCards = [card({ id: 'a', category: 'tech' }), card({ id: 'b', category: 'tech' }), card({ id: 'c', category: 'tech' })];
  for (const key of ['latest|all', 'for_you|all|u', 'following|all']) {
    const state = feedReducer(initialFeedState(key), { type: 'page', key, page: { items: pageCards, next_cursor: null } });
    assert.deepEqual(state.items.map((x) => x.id), ['a', 'b', 'c']);
  }
});
