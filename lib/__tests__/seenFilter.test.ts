import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BlurbCard, FeedPage } from '../../contract/types.ts';
import { isSeenCard, releaseSeen, reorderUnseen, seenHops, seenTail, seenTimes, splitSeen, withDeviceSeen, SEEN_EXCLUDE_DAYS, type SeenContext } from '../feed/seenFilter.ts';
import { feedReducer, initialFeedState, loadFeedPages, mockFeedPage, type LoadPagesOptions } from '../feed/feedLogic.ts';
import { latestOrder } from '../feed/feedOrder.ts';
import { rerankQueue } from '../feed/queueLogic.ts';
import { EMPTY_LOCAL } from '../storage/localPrefs.ts';
import { MAX_SEEN, recordSeen } from '../feed/forYouGate.ts';
import { parseFeedPage } from '../shared/types.ts';
import { card } from './helpers.ts';
import { memoryStore } from '../storage/storage.ts';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 3_600_000;
const mk = (n: number, over: Partial<BlurbCard> = {}) =>
  card({ id: `c${String(n).padStart(3, '0')}`, headline: `Story ${n}`, published_at: new Date(NOW - n * HOUR).toISOString(), sort_at: new Date(NOW - n * HOUR).toISOString(), as_of: new Date(NOW - n * HOUR).toISOString(), ...over });
const ctx = (ids: string[], over: Partial<SeenContext> = {}): SeenContext => ({
  seen: ids.map((id) => ({ id, category: 'x', at: NOW - HOUR })),
  liked: new Set(),
  followed: new Set(),
  now: NOW,
  ...over,
});

test('a seen card is left out; unseen ones stay in order', () => {
  const cards = [mk(1), mk(2), mk(3), mk(4)];
  const { fresh, seen } = splitSeen(cards, ctx(['c002', 'c004']));
  assert.deepEqual(fresh.map((c) => c.id), ['c001', 'c003']);
  assert.deepEqual(seen.map((c) => c.id), ['c002', 'c004']);
});

test('a followed story and an updated story may come back; a liked card stays seen', () => {
  const at = seenTimes(ctx(['c001', 'c002', 'c003', 'c004']).seen);
  const c = ctx(['c001', 'c002', 'c003', 'c004'], { liked: new Set(['c001']), followed: new Set(['c002']) });
  assert.equal(isSeenCard(mk(1), c, at), true); // liked: counts as seen (SEEN_LIKED_COMEBACK = false)
  assert.equal(isSeenCard(mk(2), c, at), false);
  assert.equal(isSeenCard(mk(3, { updated_at: new Date(NOW - 10 * 60_000).toISOString(), revision: 2 }), c, at), false); // updated after it was seen
  assert.equal(isSeenCard(mk(4, { updated_at: new Date(NOW - 5 * HOUR).toISOString(), revision: 2 }), c, at), true); // updated before it was seen
});

test('seen entries older than the window no longer count', () => {
  const old = { seen: [{ id: 'c001', category: 'x', at: NOW - (SEEN_EXCLUDE_DAYS + 1) * 86_400_000 }] };
  assert.equal(splitSeen([mk(1)], ctx([], old)).fresh.length, 1);
  assert.equal(splitSeen([mk(1)], ctx([], { seen: [{ id: 'c001', category: 'x', at: NOW - 1000 }] })).fresh.length, 0);
});

test('the seen tail is newest first, each card once; releaseSeen only runs at the end of the feed', () => {
  const stash = new Map([mk(5), mk(2), mk(9)].map((c) => [c.id, c] as const));
  assert.deepEqual(seenTail(stash).map((c) => c.id), ['c002', 'c005', 'c009']);
  const mid: FeedPage = { items: [mk(1)], next_cursor: 'x' };
  assert.equal(releaseSeen(mid, stash), mid);
  assert.equal(stash.size, 3);
  const end = releaseSeen({ items: [mk(1)], next_cursor: null }, stash);
  assert.deepEqual(end.items.map((c) => c.id), ['c001', 'c002', 'c005', 'c009']);
  assert.equal(end.seen_from, 1);
  assert.equal(stash.size, 0);
  assert.equal(releaseSeen({ items: [], next_cursor: null }, stash).seen_from, undefined); // nothing held: unchanged
});

test('reorderUnseen reorders only the part before seen_from and recomputes it', () => {
  const page: FeedPage = { items: [mk(3), mk(1), mk(2), mk(7), mk(6)], next_cursor: null, seen_from: 3 };
  const byId = (xs: BlurbCard[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const out = reorderUnseen(page, byId);
  assert.deepEqual(out.items.map((c) => c.id), ['c001', 'c002', 'c003', 'c007', 'c006']);
  assert.equal(out.seen_from, 3);
  const dedup = reorderUnseen(page, (xs) => xs.slice(0, 2));
  assert.equal(dedup.seen_from, 2);
  assert.deepEqual(reorderUnseen({ items: [mk(2), mk(1)], next_cursor: null }, byId).items.map((c) => c.id), ['c001', 'c002']);
});

test('the hop budget covers every seen card the list can hold, and is bounded', () => {
  assert.equal(seenHops(0, 10), 3);
  assert.equal(seenHops(300, 10), 33);
  assert.equal(seenHops(100000, 10), 40);
});

// Whole-feed run over the mock paging (sample mode and guests): 25 cards, the reader has seen some of them.
async function scroll(seenIds: string[], total = 25, pageSize = 10) {
  const all = Array.from({ length: total }, (_, i) => mk(i + 1, { importance: 5 }));
  const stash = new Map<string, BlurbCard>();
  let state = initialFeedState('latest|all');
  const run = withDeviceSeen({
    cursor: null,
    known: [],
    filter: (c) => c,
    fetchPage: async (c) => mockFeedPage(all, { mode: 'latest', category: null, cursor: c, limit: pageSize }),
    onRequest: () => undefined,
    onPage: (page) => { state = feedReducer(state, { type: 'page', key: state.key, page }); },
  }, stash, () => ctx(seenIds), pageSize);
  await loadFeedPages(run);
  for (let i = 0; i < 30 && !state.done; i++) await loadFeedPages({ ...run, cursor: state.cursor, known: state.items });
  return { state, all, stash };
}

test('guest and sample feed: no seen card until the end, then they come back newest first with seen_from; nothing lost, no repeats', async () => {
  const seen = ['c002', 'c004', 'c006', 'c008', 'c010', 'c012', 'c014', 'c016'];
  const { state } = await scroll(seen);
  const ids = state.items.map((c) => c.id);
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25);
  assert.equal(state.done, true);
  assert.deepEqual(ids.slice(0, 17).filter((id) => seen.includes(id)), []);
  assert.deepEqual(ids.slice(17), seen);
  assert.deepEqual(state.seenIds, seen);
});

test('guest feed with everything seen is never empty', async () => {
  const everything = Array.from({ length: 25 }, (_, i) => `c${String(i + 1).padStart(3, '0')}`);
  const { state } = await scroll(everything);
  assert.equal(state.items.length, 25);
  assert.equal(state.items[0].id, 'c001');
  assert.equal(state.seenIds.length, 25);
});

test('with nothing seen the feed is exactly as before', async () => {
  const { state } = await scroll([]);
  assert.equal(state.items.length, 25);
  assert.deepEqual(state.seenIds, []);
});

test('the reducer records re-shown ids from seen_from', () => {
  let s = initialFeedState('top|all');
  s = feedReducer(s, { type: 'page', key: 'top|all', page: { items: [mk(1), mk(2), mk(3)], next_cursor: null, seen_from: 1 } });
  assert.deepEqual(s.seenIds, ['c002', 'c003']);
  s = feedReducer(s, { type: 'page', key: 'top|all', page: { items: [mk(4)], next_cursor: null } });
  assert.deepEqual(s.seenIds, ['c002', 'c003']);
});

test('the server page field seen_from is read; bad values are dropped', () => {
  const items = [mk(1)];
  assert.equal(parseFeedPage({ items, next_cursor: null, seen_from: 0 }).seen_from, 0);
  assert.equal(parseFeedPage({ items, next_cursor: null, seen_from: 2 }).seen_from, 2);
  assert.equal(parseFeedPage({ items, next_cursor: null, seen_from: -1 }).seen_from, undefined);
  assert.equal(parseFeedPage({ items, next_cursor: null, seen_from: 'a' }).seen_from, undefined);
  assert.equal(parseFeedPage({ items, next_cursor: null }).seen_from, undefined);
});

test('re-ranking and Latest keep the re-shown cards last', () => {
  const queue = [mk(1), mk(2), mk(3), mk(4), mk(5)];
  const last = new Set(['c003']);
  const out = rerankQueue(queue, EMPTY_LOCAL, 0, false, last);
  assert.equal(out[out.length - 1].id, 'c003');
  assert.equal(rerankQueue(queue, EMPTY_LOCAL, 0, true, last).at(-1)?.id, 'c003');
  const lat = latestOrder([mk(5), mk(1), mk(9), mk(2)], 0, new Set(['c001']));
  assert.deepEqual(lat.map((c) => c.id), ['c002', 'c005', 'c009', 'c001']);
});

test('the on-device seen list is capped and drops the oldest', () => {
  const store = memoryStore();
  assert.ok(MAX_SEEN <= 300);
  for (let i = 0; i < MAX_SEEN + 40; i++) recordSeen(store, { id: `s${i}`, category: 'x' }, i);
  const list = JSON.parse(store.get('element.seen-stories') ?? '[]') as { id: string }[];
  assert.equal(list.length, MAX_SEEN);
  assert.equal(list[0].id, 's40');
});
