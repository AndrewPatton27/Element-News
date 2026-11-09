// Macro/finance focus on the client: recall gate, page cap, mock-mode parity with the SQL, followed-company merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MICRO_CATEGORIES, MICRO_MAX_PER_10, applyMicroFocus, isGated, isMicro, mergeFollowedMicro, microCapOrder } from '../feed/microFocus.ts';
import { mockFeedPage } from '../feed/feedLogic.ts';
import type { BlurbCard } from '../../contract/types.ts';
import page1 from '../../contract/fixtures/feed.page1.json' with { type: 'json' };
import page2 from '../../contract/fixtures/feed.page2.json' with { type: 'json' };

type C = { id: string; category: string; material?: boolean };
const mk = (id: string, category: string, material?: boolean): C => ({ id, category, ...(material === undefined ? {} : { material }) });
const maxIn10 = (cs: C[]) => Math.max(0, ...cs.map((_, i) => cs.slice(i, i + 10).filter(isMicro).length));

test('settings mirror the SQL rows (micro_category:safety = 2, science = 1, micro_max_per_10 = 1)', () => {
  assert.deepEqual(MICRO_CATEGORIES, { safety: 2, science: 1 });
  assert.equal(MICRO_MAX_PER_10, 1);
});

test('gate: recalls without material: true are out; science is never gated', () => {
  assert.equal(isGated(mk('a', 'safety')), true);
  assert.equal(isGated(mk('a', 'safety', false)), true);
  assert.equal(isGated(mk('a', 'safety', true)), false);
  assert.equal(isGated(mk('a', 'science')), false);
  assert.equal(isGated(mk('a', 'economy')), false);
});

test('cap: micro cards ranked first are spread to one per 10, nothing lost, soft at the tail', () => {
  const cards = [mk('u1', 'science'), mk('u2', 'safety', true), mk('u3', 'science'), ...Array.from({ length: 25 }, (_, i) => mk(`m${i}`, 'economy'))];
  const out = microCapOrder(cards);
  assert.equal(out.length, cards.length);
  assert.deepEqual(new Set(out.map((c) => c.id)), new Set(cards.map((c) => c.id)));
  assert.equal(maxIn10(out), 1);
  assert.equal(out[0].id, 'u1', 'the best micro card still leads');
  // only micro cards left: shown anyway (never a short feed)
  const tail = microCapOrder([mk('a', 'economy'), mk('b', 'science'), mk('c', 'science'), mk('d', 'science')]);
  assert.deepEqual(tail.map((c) => c.id), ['a', 'b', 'c', 'd']);
  // history continues across pages
  assert.equal(microCapOrder([mk('s', 'science'), mk('e', 'economy')], 1, [true])[0].id, 'e');
});

test('applyMicroFocus: feeds drop non-material recalls; a topic chip keeps every card in order', () => {
  const cards = [mk('r1', 'safety'), mk('r2', 'safety', true), mk('e1', 'economy'), mk('e2', 'markets')];
  assert.deepEqual(applyMicroFocus(cards, null).map((c) => c.id), ['r2', 'e1', 'e2']);
  assert.deepEqual(applyMicroFocus(cards, 'safety').map((c) => c.id), ['r1', 'r2', 'e1', 'e2']);
});

test('mock mode parity: the fixture recall is left out of Trending and Latest, listed under its chip; paging has no repeats', () => {
  const all = [...(page1.items as unknown as BlurbCard[]), ...(page2.items as unknown as BlurbCard[])];
  const recall = all.find((c) => c.category === 'safety')!;
  assert.ok(recall, 'the fixtures have a recall card');
  for (const mode of ['top', 'latest'] as const) {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p = mockFeedPage(all, { mode, category: null, cursor, limit: 10 });
      seen.push(...p.items.map((c) => c.id));
      cursor = p.next_cursor;
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length, `${mode}: no repeats`);
    assert.equal(seen.length, all.length - 1, `${mode}: every card but the recall`);
    assert.ok(!seen.includes(recall.id));
    assert.ok(maxIn10(seen.map((id) => all.find((c) => c.id === id)! as C)) <= 1, `${mode}: page cap`);
  }
  assert.deepEqual(mockFeedPage(all, { mode: 'top', category: 'safety', cursor: null, limit: 10 }).items.map((c) => c.id), [recall.id]);
});

test('mergeFollowedMicro: followed recalls at slots 2, 12, 22; prefix-stable as pages append; no duplicates', () => {
  const feed = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}` }));
  const extra = [{ id: 'x1' }, { id: 'x2' }, { id: 'f3' }, { id: 'x1' }, { id: 'x3' }];
  const out = mergeFollowedMicro(feed, extra);
  assert.deepEqual([out[2].id, out[12].id, out[22].id], ['x1', 'x2', 'x3']);
  assert.equal(out.length, 28);
  assert.equal(new Set(out.map((c) => c.id)).size, 28, 'f3 already in the feed and the repeated x1 are skipped');
  const short = mergeFollowedMicro(feed.slice(0, 10), extra);
  assert.deepEqual(short.map((c) => c.id), out.slice(0, short.length).map((c) => c.id), 'appending pages never moves a placed card');
  assert.deepEqual(mergeFollowedMicro([], extra).map((c) => c.id), [], 'an empty feed stays empty (slot 2 is never reached)');
  assert.deepEqual(mergeFollowedMicro(feed, []).map((c) => c.id), feed.map((c) => c.id));
});
