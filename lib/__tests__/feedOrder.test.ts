import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeCards, isAirworthinessCard, latestOrder, sortLatest, trendingOrder, trendingScore } from '../feed/feedOrder.ts';
import { mockFeedPage, mockRankScore } from '../feed/feedLogic.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlurbCard } from '../../contract/types.ts';

const mk = (id: string, o: Partial<BlurbCard> & Record<string, unknown> = {}): BlurbCard =>
  ({ id, category: 'markets', kind: 'summary', headline: id, published_at: '2026-10-18T10:00:00Z', as_of: '2026-10-18T10:00:00Z', sort_at: '2026-10-18T10:00:00Z', sources: [{ name: 'Reuters', url: `https://example.com/${id}`, is_primary: true }], tickers: [], ...o }) as unknown as BlurbCard;

test('latest equals the input sorted by published_at desc, id desc, exactly', () => {
  const t = ['2026-10-18T10:00:00Z', '2026-10-17T10:00:00Z', '2026-10-18T10:00:00Z', '2026-10-19T01:00:00Z', '2026-10-17T10:00:00Z'];
  const cards = t.map((p, i) => mk('c' + i, { published_at: p, as_of: '2026-01-01T00:00:00Z', sort_at: '2027-01-01T00:00:00Z' }));
  const expected = [...cards].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || (a.id < b.id ? 1 : -1)).map((c) => c.id);
  assert.deepEqual(sortLatest(cards).map((c) => c.id), expected);
  assert.deepEqual(latestOrder(cards).map((c) => c.id), expected);
  assert.deepEqual(mockFeedPage(cards, { mode: 'latest', category: null, cursor: null, limit: 30 }).items.map((c) => c.id), expected);
});

test('bumped sort_at and old as_of do not lead latest', () => {
  const faa = mk('faa', { published_at: '2026-10-17T23:00:00Z', as_of: '2026-10-16T00:00:00Z', sort_at: '2026-10-19T00:00:00Z' });
  const fresh = mk('fresh', { published_at: '2026-10-18T14:00:00Z', sort_at: '2026-10-18T14:00:00Z' });
  assert.equal(sortLatest([faa, fresh])[0].id, 'fresh');
});

test('latestOrder keeps reached cards in place', () => {
  const l = [mk('x', { published_at: '2026-10-17T00:00:00Z' }), mk('y', { published_at: '2026-10-18T00:00:00Z' }), mk('z', { published_at: '2026-10-18T12:00:00Z' })];
  assert.deepEqual(latestOrder(l, 0).map((c) => c.id), ['z', 'y', 'x']);
  assert.deepEqual(latestOrder(l, 1).map((c) => c.id), ['x', 'y', 'z']);
});

test('dedupeCards drops same id and same source link + headline', () => {
  const a = mk('a'), a2 = mk('a2', { sources: a.sources, headline: 'a' });
  assert.deepEqual(dedupeCards([a, mk('a'), a2, mk('b')]).map((c) => c.id), ['a', 'b']);
});

const fedreg = [{ name: 'Federal Register', url: 'https://www.federalregister.gov/x', is_primary: true }];
test('isAirworthinessCard needs Federal Register source AND an aircraft headline', () => {
  assert.equal(isAirworthinessCard(mk('f', { sources: fedreg, headline: 'FAA orders fix for some Boeing 737 planes' } as never)), true);
  assert.equal(isAirworthinessCard(mk('g', { sources: fedreg, headline: 'Treasury updates reporting rule' } as never)), false);
  assert.equal(isAirworthinessCard(mk('h', { headline: 'FAA orders fix for some Boeing 737 planes' })), false);
});

test('airworthiness cap keeps FAA cards out of the top 3', () => {
  const faa = ['f1', 'f2', 'f3'].map((id, i) => mk(id, { sources: fedreg, headline: 'FAA aircraft order ' + id, importance: 20, as_of: `2026-10-18T1${i}:00:00Z` } as never));
  const others = ['o1', 'o2', 'o3'].map((id, i) => mk(id, { category: 'tech' + i, sources: [{ name: ['SEC', 'Reuters', 'NASA'][i], url: 'https://www.sec.gov/' + id, is_primary: true }], importance: 4, as_of: '2026-10-18T09:00:00Z' } as never));
  const top3 = trendingOrder([...faa, ...others]).slice(0, 3).map((c) => c.id);
  assert.ok(top3.every((id) => id.startsWith('o')), top3.join());
});

test('trendingOrder: at most 2 in a row from one source or category', () => {
  const cats = ['markets', 'tech', 'policy', 'economy'], srcs = ['SEC', 'Reuters', 'Federal Reserve Board', 'NASA'];
  // scores fall steadily, with the same category/source in blocks of 3 so plain score order has runs of 3
  const cards = Array.from({ length: 12 }, (_, i) => mk('t' + i, { category: cats[Math.floor(i / 3)], importance: 20 - i, sources: [{ name: srcs[Math.floor(i / 3)], url: 'https://x/' + i, is_primary: true }] } as never));
  const out = trendingOrder(cards);
  assert.equal(out.length, 12);
  const runs = (key: (c: BlurbCard) => string) => { let m = 1, n = 1; for (let i = 1; i < out.length; i++) { n = key(out[i]) === key(out[i - 1]) ? n + 1 : 1; m = Math.max(m, n); } return m; };
  assert.ok(runs((c) => c.category) <= 2, 'category run');
  assert.ok(runs((c) => c.sources[0].name) <= 2, 'source run');
});

test('mockRankScore is unchanged; trendingScore uses the shown time', () => {
  const c = mk('m', { importance: 4, sort_at: '2026-10-18T00:00:00Z', as_of: '2026-10-17T00:00:00Z' } as never);
  assert.equal(mockRankScore(c), Date.parse('2026-10-18T00:00:00Z') / 3_600_000 + 16);
  assert.equal(trendingScore(c), Date.parse('2026-10-17T00:00:00Z') / 3_600_000 + 16);
});

test('overlap@10 of trending vs latest on the sample fixtures is reported and <= 7', () => {
  const dir = join(import.meta.dirname, '..', '..', 'contract', 'fixtures');
  const cards = ['feed.page1.json', 'feed.page2.json'].flatMap((f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { items: BlurbCard[] }).items);
  const top = trendingOrder(dedupeCards(cards)).slice(0, 10).map((c) => c.id);
  const latest = sortLatest(dedupeCards(cards)).slice(0, 10).map((c) => c.id);
  const overlap = top.filter((id) => latest.includes(id)).length;
  console.log(`  overlap@10 trending vs latest: ${overlap} of ${Math.min(10, cards.length)} (fixtures: ${cards.length} cards)`);
  assert.ok(overlap <= 7, `overlap ${overlap}`);
  assert.notEqual(top[0], latest[0]);
});

test('addedLabel shows when the card was added (published_at), not the event time', async () => {
  const { addedLabel } = await import('../shared/format.ts');
  const now = new Date('2026-10-18T12:00:00Z');
  assert.equal(addedLabel({ published_at: '2026-10-18T07:00:00Z' }, now), 'Added 5 h ago');
  assert.equal(addedLabel({ published_at: '2026-10-18T11:59:30Z' }, now), 'Added just now');
  assert.equal(addedLabel({ published_at: 'bad' }, now), '');
});
