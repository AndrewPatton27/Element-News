import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendPage, canLoadMore, clampLimit, feedKey, feedReducer, initialFeedState, mockFeedPage } from '../feed/feedLogic.ts';
import { card, dataCard } from './helpers.ts';

test('appendPage dedupes by id and drops invalid cards', () => {
  const a = card({ id: 'a' });
  const b = card({ id: 'b' });
  const linkOut = card({ id: 'l', kind: 'link_out' });
  const noSource = card({ id: 'n', sources: [] });
  const out = appendPage([a], { items: [a, b, linkOut, noSource], next_cursor: null });
  assert.deepEqual(
    out.map((c) => c.id),
    ['a', 'b'],
  );
});

test('reducer: pages append, end detected, filter change resets, stale responses ignored', () => {
  const k1 = feedKey({ mode: 'top', category: null });
  const k2 = feedKey({ mode: 'latest', category: 'tech' });
  let s = initialFeedState(k1);
  s = feedReducer(s, { type: 'request', key: k1 });
  assert.equal(canLoadMore(s), false);
  s = feedReducer(s, { type: 'page', key: k1, page: { items: [card({ id: 'a' })], next_cursor: '1' } });
  assert.equal(s.items.length, 1);
  assert.equal(s.done, false);
  assert.equal(canLoadMore(s), true);
  s = feedReducer(s, { type: 'page', key: k1, page: { items: [card({ id: 'b' })], next_cursor: null } });
  assert.equal(s.done, true);
  assert.equal(canLoadMore(s), false);

  s = feedReducer(s, { type: 'reset', key: k2 });
  assert.deepEqual(s.items, []);
  s = feedReducer(s, { type: 'page', key: k1, page: { items: [card({ id: 'z' })], next_cursor: null } });
  assert.deepEqual(s.items, [], 'late page for the old filter is ignored');

  s = feedReducer(s, { type: 'fail', key: k2, error: 'boom' });
  assert.equal(s.error, 'boom');
  assert.equal(canLoadMore(s), false);
});

test('clampLimit keeps 10..30, default 20', () => {
  assert.equal(clampLimit(undefined), 20);
  assert.equal(clampLimit(5), 10);
  assert.equal(clampLimit(99), 30);
  assert.equal(clampLimit(15), 15);
});

function many(n: number) {
  return Array.from({ length: n }, (_, i) =>
    card({
      id: `id${String(i).padStart(2, '0')}`,
      category: i % 3 === 0 ? 'tech' : 'earnings',
      sort_at: new Date(Date.UTC(2026, 9, 17, 0, i)).toISOString(),
      importance: (i % 5) + 1,
    }),
  );
}

test('mock paging: no repeats, no gaps, cursor ends with null', () => {
  const all = many(25);
  for (const mode of ['top', 'latest'] as const) {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = mockFeedPage(all, { mode, category: null, cursor, limit: 10 });
      seen.push(...page.items.map((c) => c.id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor !== null && pages < 10);
    assert.equal(pages, 3, mode);
    assert.equal(new Set(seen).size, 25, mode);
  }
});

test('mock latest is published_at newest first; category filter applies', () => {
  const all = many(25);
  const page = mockFeedPage(all, { mode: 'latest', category: null, cursor: null, limit: 30 });
  const times = page.items.map((c) => Date.parse(c.published_at));
  assert.deepEqual(
    times,
    times.slice().sort((a, b) => b - a),
  );
  const tech = mockFeedPage(all, { mode: 'top', category: 'tech', cursor: null, limit: 30 });
  assert.ok(tech.items.length > 0 && tech.items.every((c) => c.category === 'tech'));
});

test('mock top: doubling importance equals 8 hours of recency', () => {
  const older = dataCard({ id: 'old', sort_at: '2026-10-17T00:00:00Z', importance: 8 });
  const newer = card({ id: 'new', sort_at: '2026-10-17T07:00:00Z', importance: 4 });
  const page = mockFeedPage([newer, older], { mode: 'top', category: null, cursor: null, limit: 10 });
  assert.deepEqual(
    page.items.map((c) => c.id),
    ['old', 'new'],
  );
});
