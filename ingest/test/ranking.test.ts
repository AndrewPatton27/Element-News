import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importance, pageTop, rankScore, sortLatest, sortTop, type RankInput } from '../src/ranking.ts';
import type { FeedPage } from '../../contract/types.ts';

const NOW = Date.parse('2026-10-17T21:00:00Z');
function card(id: string, event_type: string, kind: string, ageH: number, n: number): RankInput {
  return {
    id, kind: 'summary', event_type,
    sort_at: new Date(NOW - ageH * 3600_000).toISOString(),
    sources: Array.from({ length: n }, (_, i) => ({ name: `Outlet ${i}`, kind })),
  };
}

// The six worked-example cards from the ranking design.
const SIX = [
  card('A', 'fed', 'government', 6, 14),
  card('B', 'earnings', 'filing', 20 / 60, 6),
  card('C', 'macro_release', 'government', 26, 3),
  card('D', 'insider', 'filing', 1, 1),
  card('E', 'exec_change', 'filing', 3, 2),
  card('F', 'deal', 'filing', 12, 8),
];

test('importance matches the worked example', () => {
  const got = Object.fromEntries(SIX.map((c) => [c.id, Math.round(importance(c) * 100) / 100]));
  assert.deepEqual(got, { A: 16.6, B: 7.24, C: 12.75, D: 2, E: 3.52, F: 6.08 });
});

test("'top' order is A, B, E, F, D, C", () => {
  const order = sortTop(SIX).map((c) => c.id).join('');
  console.log('  top order:', order, '| latest order:', sortLatest(SIX).map((c) => c.id).join(''));
  assert.equal(order, 'ABEFDC');
});

test("'latest' order is B, D, E, A, F, C", () => {
  assert.equal(sortLatest(SIX).map((c) => c.id).join(''), 'BDEAFC');
});

test('order does not change as time passes (all cards shifted by the same amount)', () => {
  const later = SIX.map((c) => ({ ...c, sort_at: new Date(Date.parse(c.sort_at) - 7 * 3600_000).toISOString() }));
  assert.equal(sortTop(later).map((c) => c.id).join(''), 'ABEFDC');
});

test('keyset paging over 25 cards with limit 10: every card once, 3 pages', () => {
  const cards = Array.from({ length: 25 }, (_, i) =>
    card(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, i % 3 ? 'insider' : 'earnings', 'filing', i, 1));
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const p: { items: RankInput[]; next_cursor: string | null } = pageTop(cards, cursor, 10);
    seen.push(...p.items.map((c) => c.id));
    cursor = p.next_cursor;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);
});

test('limit is clamped to 10..30', () => {
  const cards = Array.from({ length: 40 }, (_, i) => card(`id${String(i).padStart(3, '0')}`, 'deal', 'filing', i, 1));
  assert.equal(pageTop(cards, null, 1).items.length, 10);
  assert.equal(pageTop(cards, null, 100).items.length, 30);
});

test('contract fixtures are in ranked order with matching importance and cursor', () => {
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${f}`, import.meta.url), 'utf8')) as FeedPage;
  const p1 = read('feed.page1.json');
  const p2 = read('feed.page2.json');
  const all = [...p1.items, ...p2.items];
  for (const c of all) {
    assert.equal(c.importance, Math.round(importance(c) * 1000) / 1000, c.headline);
  }
  assert.deepEqual(sortTop(all).map((c) => c.id), all.map((c) => c.id));
  const last = p1.items[p1.items.length - 1];
  assert.equal(p1.next_cursor, `${rankScore(last).toFixed(6)}|${last.id}`);
});

test("'latest' sorts by published_at, not by a bumped sort_at; ties id desc", () => {
  const mk = (id: string, pub: string, sort: string): RankInput => ({ id, kind: 'summary', event_type: 'deal', sort_at: sort, published_at: pub, sources: [] });
  const out = sortLatest([mk('a', '2026-10-17T00:00:00Z', '2026-10-20T00:00:00Z'), mk('b', '2026-10-18T00:00:00Z', '2026-10-18T00:00:00Z'), mk('c', '2026-10-18T00:00:00Z', '2026-10-18T00:00:00Z')]);
  assert.deepEqual(out.map((c) => c.id), ['c', 'b', 'a']);
});
