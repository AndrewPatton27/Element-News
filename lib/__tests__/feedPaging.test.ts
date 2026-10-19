import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BlurbCard, FeedPage } from '../../contract/types.ts';
import { MAX_EMPTY_HOPS, decidePage, initialFeedState, loadFeedPages, needsRefill, shouldLoadMore, type FeedState } from '../feed/feedLogic.ts';
import { withoutHidden } from '../account/accountLogic.ts';
import { card } from './helpers.ts';

const page = (ids: string[], next: string | null, category = 'world'): FeedPage => ({
  items: ids.map((id) => card({ id, category: category as BlurbCard['category'] })),
  next_cursor: next,
});
const hide = (slugs: string[]) => (cards: BlurbCard[]) => withoutHidden(cards, slugs);
const show = (cards: BlurbCard[]) => cards;

function harness(pages: Record<string, FeedPage | Error>, opts: { filter?: (c: BlurbCard[]) => BlurbCard[]; known?: BlurbCard[]; cursor?: string | null; maxHops?: number } = {}) {
  const requested: (string | null)[] = [];
  const delivered: FeedPage[] = [];
  let requests = 0;
  const run = () =>
    loadFeedPages({
      cursor: opts.cursor ?? null,
      known: opts.known ?? [],
      filter: opts.filter ?? show,
      maxHops: opts.maxHops,
      fetchPage: async (c) => {
        requested.push(c);
        if (requested.length > 50) throw new Error('runaway loop');
        const p = pages[c ?? ''];
        if (!p) throw new Error(`no page for ${c}`);
        if (p instanceof Error) throw p;
        return p;
      },
      onRequest: () => void requests++,
      onPage: (p) => void delivered.push(p),
    });
  return { run, requested, delivered, requests: () => requests };
}

test('decidePage: null cursor accepts, repeated cursor ends, visible cards accept, empty pages hop up to the cap', () => {
  const none = new Set<string>();
  assert.equal(decidePage({ visibleNew: 0, nextCursor: null, seenCursors: none, hops: 0 }), 'accept');
  assert.equal(decidePage({ visibleNew: 3, nextCursor: 'b', seenCursors: none, hops: 0 }), 'accept');
  assert.equal(decidePage({ visibleNew: 0, nextCursor: 'b', seenCursors: none, hops: 0 }), 'hop');
  assert.equal(decidePage({ visibleNew: 0, nextCursor: 'b', seenCursors: none, hops: MAX_EMPTY_HOPS - 1 }), 'hop');
  assert.equal(decidePage({ visibleNew: 0, nextCursor: 'b', seenCursors: none, hops: MAX_EMPTY_HOPS }), 'end');
  assert.equal(decidePage({ visibleNew: 0, nextCursor: 'a', seenCursors: new Set(['a']), hops: 0 }), 'end', 'repeat of an earlier cursor');
  assert.equal(decidePage({ visibleNew: 5, nextCursor: 'a', seenCursors: new Set(['a']), hops: 0 }), 'end', 'a repeat ends even with new cards');
});

test('a normal page is delivered once with its cursor', async () => {
  const h = harness({ '': page(['a', 'b'], 'p2') });
  await h.run();
  assert.deepEqual(h.requested, [null]);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].next_cursor, 'p2');
});

test('a page that is entirely hidden keeps fetching until something is visible', async () => {
  const h = harness(
    { '': page(['a', 'b'], 'p2', 'tech'), p2: page(['c', 'd'], 'p3', 'tech'), p3: page(['e'], 'p4', 'world') },
    { filter: hide(['tech']) },
  );
  await h.run();
  assert.deepEqual(h.requested, [null, 'p2', 'p3']);
  assert.equal(h.delivered.length, 3, 'hidden pages are still kept (an undo can bring them back)');
  assert.equal(h.delivered[2].next_cursor, 'p4');
  assert.equal(h.requests(), 3);
});

test('the hop count is bounded: all-hidden pages end the feed instead of looping', async () => {
  const pages: Record<string, FeedPage> = { '': page(['a'], 'p1', 'tech') };
  for (let i = 1; i < 20; i++) pages[`p${i}`] = page([`x${i}`], `p${i + 1}`, 'tech');
  const h = harness(pages, { filter: hide(['tech']) });
  await h.run();
  assert.equal(h.requested.length, MAX_EMPTY_HOPS + 1);
  assert.equal(h.delivered.at(-1)?.next_cursor, null, 'ends as done');
});

test('a repeating cursor stops the chain at once', async () => {
  const h = harness({ '': page(['a'], 'same', 'tech'), same: page(['b'], 'same', 'tech') }, { filter: hide(['tech']) });
  await h.run();
  assert.deepEqual(h.requested, [null, 'same']);
  assert.equal(h.delivered.at(-1)?.next_cursor, null);
});

test('a next_cursor equal to the starting cursor ends the feed (loadMore case), keeping the cards', async () => {
  const h = harness({ p2: page(['c'], 'p2', 'world') }, { cursor: 'p2' });
  await h.run();
  assert.deepEqual(h.requested, ['p2']);
  assert.equal(h.delivered[0].next_cursor, null);
  assert.equal(h.delivered[0].items.length, 1);
});

test('a null cursor ends the chain even if the last page is empty or hidden', async () => {
  const h = harness({ '': page(['a'], 'p2', 'tech'), p2: page(['b'], null, 'tech') }, { filter: hide(['tech']) });
  await h.run();
  assert.deepEqual(h.requested, [null, 'p2']);
  assert.equal(h.delivered.at(-1)?.next_cursor, null);
  const empty = harness({ '': { items: [], next_cursor: null } });
  await empty.run();
  assert.equal(empty.requested.length, 1);
});

test('empty server pages and duplicate-only pages count as "nothing visible" and hop', async () => {
  const a = card({ id: 'a' });
  const h = harness(
    { p1: { items: [], next_cursor: 'p2' }, p2: { items: [a], next_cursor: 'p3' }, p3: page(['z'], null) },
    { cursor: 'p1', known: [a] },
  );
  await h.run();
  assert.deepEqual(h.requested, ['p1', 'p2', 'p3'], 'duplicates add nothing visible, so it fetches on');
});

test('a failure rejects and keeps the pages already delivered', async () => {
  const h = harness({ '': page(['a'], 'p2', 'tech'), p2: new Error('down') }, { filter: hide(['tech']) });
  await assert.rejects(h.run(), /down/);
  assert.equal(h.delivered.length, 1);
});

test('alive() stops the chain when the query changed', async () => {
  let alive = true;
  const requested: (string | null)[] = [];
  await loadFeedPages({
    cursor: null,
    known: [],
    filter: hide(['tech']),
    fetchPage: async (c) => {
      requested.push(c);
      alive = false; // the reader switched category while this was in flight
      return page(['a'], 'p2', 'tech');
    },
    onRequest: () => undefined,
    onPage: () => assert.fail('a stale page must not be delivered'),
    alive: () => alive,
  });
  assert.deepEqual(requested, [null]);
});

const state = (over: Partial<FeedState> = {}): FeedState => ({ ...initialFeedState('k'), ...over });

test('shouldLoadMore: needs a cursor, no loading, no error, not done, same key', () => {
  assert.equal(shouldLoadMore(state({ cursor: 'p2' }), 'k'), true);
  assert.equal(shouldLoadMore(state({ cursor: null }), 'k'), false, 'nothing fetched yet');
  assert.equal(shouldLoadMore(state({ cursor: 'p2', done: true }), 'k'), false);
  assert.equal(shouldLoadMore(state({ cursor: 'p2', loading: true }), 'k'), false);
  assert.equal(shouldLoadMore(state({ cursor: 'p2', error: 'x' }), 'k'), false);
  assert.equal(shouldLoadMore(state({ cursor: 'p2' }), 'other'), false);
});

test('shouldLoadMore does not depend on the unfiltered item count', () => {
  // all fetched cards are hidden, but the server has more: still allowed to load
  const hiddenOnly = state({ items: [card({ id: 'a', category: 'tech' })], cursor: 'p2' });
  assert.equal(shouldLoadMore(hiddenOnly, 'k'), true);
});

test('needsRefill: only when the visible list is empty and more exists', () => {
  const s = state({ items: [card({ id: 'a', category: 'tech' })], cursor: 'p2' });
  assert.equal(needsRefill(s, 'k', 0), true);
  assert.equal(needsRefill(s, 'k', 1), false);
  assert.equal(needsRefill({ ...s, done: true }, 'k', 0), false, 'end of feed: show the empty state');
  assert.equal(needsRefill({ ...s, error: 'x' }, 'k', 0), false, 'an error shows retry, never loops');
  assert.equal(needsRefill({ ...s, loading: true }, 'k', 0), false);
});
