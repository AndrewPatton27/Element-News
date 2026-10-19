import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageIdMap, displayedSlot, shadowArgs, shadowContext, surfaceForTab, isUnknownArgsError } from '../ml/shadowLog.ts';
import { parseFeedPage } from '../shared/types.ts';
import { ACCOUNT_RPC } from '../account/account.ts';

const cards = ['a', 'b', 'c'].map((id) => ({ id }));

test('parseFeedPage keeps page_id and tolerates its absence or junk', async () => {
  const fx = (await import('../../contract/fixtures/feed.page1.json', { with: { type: 'json' } })).default as { items: unknown[] };
  const base = { items: fx.items, next_cursor: null };
  assert.equal(parseFeedPage({ ...base, page_id: 'p1' }).page_id, 'p1');
  assert.equal('page_id' in parseFeedPage(base), false);
  assert.equal('page_id' in parseFeedPage({ ...base, page_id: 5 }), false);
  assert.equal('page_id' in parseFeedPage({ ...base, page_id: '' }), false);
  assert.doesNotThrow(() => parseFeedPage({ ...base, extra: { x: 1 } }));
});

test('surfaceForTab maps tabs and nothing else', () => {
  assert.equal(surfaceForTab('top'), 'trending');
  assert.equal(surfaceForTab('latest'), 'latest');
  assert.equal(surfaceForTab('for_you'), 'for_you');
  assert.equal(surfaceForTab('x'), null);
});

test('displayedSlot is the position in the displayed list', () => {
  assert.equal(displayedSlot(cards, 'c'), 2);
  assert.equal(displayedSlot([cards[2], cards[0]], 'a'), 1);
  assert.equal(displayedSlot(cards, 'zzz'), null);
  const big = Array.from({ length: 600 }, (_, i) => ({ id: String(i) }));
  assert.equal(displayedSlot(big, '499'), 499);
  assert.equal(displayedSlot(big, '500'), null);
});

test('page id map keeps the first page per surface and ignores pages without id', () => {
  const m = createPageIdMap();
  m.note('trending', { items: cards });
  assert.equal(m.get('trending', 'a'), undefined);
  m.note('trending', { items: cards, page_id: 'p1' });
  m.note('trending', { items: cards, page_id: 'p2' });
  m.note('for_you', { items: cards, page_id: 'p3' });
  m.note(null, { items: cards, page_id: 'p4' });
  assert.equal(m.get('trending', 'b'), 'p1');
  assert.equal(m.get('for_you', 'b'), 'p3');
  assert.equal(m.get('latest', 'b'), undefined);
});

test('page id map is bounded', () => {
  const m = createPageIdMap(2);
  m.note('latest', { items: cards, page_id: 'p' });
  assert.equal(m.get('latest', 'a'), undefined);
  assert.equal(m.get('latest', 'c'), 'p');
});

test('shadowContext uses the displayed order, not the server order', () => {
  const m = createPageIdMap();
  m.note('for_you', { items: cards, page_id: 'p1' });
  const shown = [cards[2], cards[1], cards[0]];
  assert.deepEqual(shadowContext('for_you', shown, 'a', m), { pageId: 'p1', slot: 2, surface: 'for_you' });
  assert.equal(shadowContext('trending', shown, 'a', m), null);
  assert.equal(shadowContext(null, shown, 'a', m), null);
  assert.equal(shadowContext('for_you', [], 'a', m), null);
});

test('shadowArgs is empty without a valid context', () => {
  assert.deepEqual(shadowArgs(null), {});
  assert.deepEqual(shadowArgs({ pageId: '', slot: 1, surface: 'latest' }), {});
  assert.deepEqual(shadowArgs({ pageId: 'p', slot: -1, surface: 'latest' }), {});
  assert.deepEqual(shadowArgs({ pageId: 'p', slot: 500, surface: 'latest' }), {});
  assert.deepEqual(shadowArgs({ pageId: 'p', slot: 1.5, surface: 'latest' }), {});
  assert.deepEqual(shadowArgs({ pageId: 'p', slot: 3, surface: 'search' }), { p_page: 'p', p_slot: 3, p_surface: 'search' });
});

test('track args: only a view carries page, slot and surface; others are unchanged', () => {
  const ctx = { pageId: 'p', slot: 4, surface: 'trending' as const };
  assert.deepEqual(ACCOUNT_RPC.track.args('c', 'view', undefined, ctx), { p_blurb: 'c', p_kind: 'view', p_page: 'p', p_slot: 4, p_surface: 'trending' });
  assert.deepEqual(ACCOUNT_RPC.track.args('c', 'view'), { p_blurb: 'c', p_kind: 'view' });
  assert.deepEqual(ACCOUNT_RPC.track.args('c', 'like', undefined, ctx), { p_blurb: 'c', p_kind: 'like' });
  assert.deepEqual(ACCOUNT_RPC.track.args('c', 'dwell', 900, ctx), { p_blurb: 'c', p_kind: 'dwell', p_ms: 900 });
});

test('unknown-argument errors are recognised', () => {
  assert.equal(isUnknownArgsError(404), true);
  assert.equal(isUnknownArgsError(400), true);
  assert.equal(isUnknownArgsError(500), false);
  assert.equal(isUnknownArgsError(401), false);
});
