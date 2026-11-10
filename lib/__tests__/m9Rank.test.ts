// M9 client ranking fixes (F1 re-rank + twin removal, F3 family cap, F4 gate, F5 pool, F6 dislike learning and
// market-relevance gate, F10 re-serve penalty, macro first). Pure logic; the optional last test replays the
// simulated-persona ledger when the context folder exists on this machine (it is git-ignored, so CI skips it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { BlurbCard } from '../../contract/types.ts';
import { FY, isAuthorityCard, mergePool, rankForYou, shapeTop } from '../feed/forYouRank.ts';
import { RANK, localScore } from '../feed/localRank.ts';
import { cardFamily, normHeadline } from '../feed/cardKeys.ts';
import { rerankQueue } from '../feed/queueLogic.ts';
import { fetchExtraPool } from '../feed/forYouPool.ts';
import { EMPTY_LOCAL, readLocal, withReaction, writeLocal, type LocalPrefs } from '../storage/localPrefs.ts';
import { memoryStore } from '../storage/storage.ts';
import { card, dataCard, fact } from './helpers.ts';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const hrs = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const plain = (id: string, category: string, ageH: number, over: Partial<BlurbCard> = {}): BlurbCard =>
  card({ id, headline: `plain headline ${id} today`, category: category as BlurbCard['category'], event_type: null, tickers: [], sources: [], importance: 5, published_at: hrs(ageH), as_of: hrs(ageH), sort_at: hrs(ageH), ...over });
const company = (id: string, ageH: number, symbol = 'NWND', over: Partial<BlurbCard> = {}): BlurbCard =>
  plain(id, 'earnings', ageH, { tickers: [{ symbol, name: symbol, exchange: 'Nasdaq', quote: null }], ...over });
const yieldCard = (id: string, series: string, ageH: number): BlurbCard =>
  dataCard({ id, headline: `${series} Treasury yield moves ${id}`, category: 'economy', macro: [fact({ series_id: series })], importance: 10, published_at: hrs(ageH), as_of: hrs(ageH), sort_at: hrs(ageH) });
const ids = (xs: BlurbCard[]) => xs.map((c) => c.id);
const prefs = (over: Partial<LocalPrefs> = {}): LocalPrefs => ({ ...EMPTY_LOCAL, ...over });
const rank = (pool: BlurbCard[], p: LocalPrefs, seen: string[] = []) => rankForYou(pool, p, new Set(seen), null, new Set(), NOW);

test('F1 a disliked card and its twins (dedupe key, same headline, linked update) leave For you at once', () => {
  const a = plain('a', 'economy', 2, { dedupe_key: 'cpi:2026-10' } as Partial<BlurbCard>);
  const twinKey = plain('b', 'economy', 3, { dedupe_key: 'cpi:2026-10' } as Partial<BlurbCard>);
  const twinHead = plain('c', 'economy', 3, { headline: a.headline });
  const update = plain('d', 'economy', 3, { story_link: { kind: 'update', related_id: 'a', related_headline: 'x' } });
  const other = plain('e', 'economy', 3);
  const p = withReaction(EMPTY_LOCAL, a, 'dislike', NOW);
  assert.deepEqual(ids(rank([a, twinKey, twinHead, update, other], p)), ['e']);
});

test('F1 a dislike re-ranks the rest of the queue after the reader; the two pinned cards stay, twins go, nothing repeats', () => {
  const queue = Array.from({ length: 12 }, (_, i) => plain(`q${i}`, ['economy', 'tech', 'deals'][i % 3], i + 1));
  const twin = plain('twin', 'tech', 5, { headline: queue[4].headline });
  const list = [...queue.slice(0, 8), twin, ...queue.slice(8)];
  const p = withReaction(EMPTY_LOCAL, queue[4], 'dislike', NOW); // q4 sits in the pinned part (index 4 < seenCount + 2)
  const out = rerankQueue(list, p, 3, false, new Set(), { forYou: true, seenStoryIds: new Set() });
  assert.deepEqual(ids(out.slice(0, 5)), ids(list.slice(0, 5)), 'seen + next card stay put');
  assert.ok(!ids(out).slice(5).includes('twin'), 'twin dropped from the tail');
  assert.equal(new Set(ids(out)).size, out.length);
  // a like re-orders the not-yet-reached cards the same way: liked topic first
  const liked = withReaction(EMPTY_LOCAL, plain('prior', 'deals', 1), 'like', NOW);
  const tail = rerankQueue(list, liked, 0, false, new Set(), { forYou: true, seenStoryIds: new Set() }).slice(2);
  assert.ok(tail.slice(0, 3).some((c) => c.category === 'deals'));
});

test('F3 at most 2 Treasury-yield (rates family) cards per 10, however many daily readings are in the pool', () => {
  const yields = ['DGS2', 'DGS5', 'DGS10', 'DGS30', 'DGS2', 'DGS10', 'DFF'].map((s, i) => yieldCard(`y${i}`, s, i));
  const others = Array.from({ length: 14 }, (_, i) => plain(`o${i}`, ['economy', 'tech', 'policy', 'energy', 'markets'][i % 5], 8 + i));
  const out = rank([...yields, ...others], prefs());
  for (let s = 0; s <= 4; s++) assert.ok(out.slice(s, s + 10).filter((c) => cardFamily(c) === 'g:rates').length <= FY.familyCap, `window ${s}`);
  assert.equal(cardFamily(yieldCard('x', 'DGS10', 1)), 'g:rates');
  assert.equal(cardFamily(dataCard({ headline: 'Payrolls', macro: [fact({ series_id: 'PAYEMS' })] })), 's:PAYEMS');
});

test('macro first: at most 1 company card per 3 top slots, cards of followed companies exempt', () => {
  const cos = Array.from({ length: 6 }, (_, i) => company(`co${i}`, i, `T${i}`, { category: i % 2 ? 'deals' : 'earnings' }));
  const macro = Array.from({ length: 6 }, (_, i) => plain(`m${i}`, ['economy', 'policy', 'energy'][i % 3], 10 + i));
  const out = rank([...cos, ...macro], prefs());
  const top9 = out.slice(0, 9);
  for (let s = 0; s + 3 <= top9.length; s++) assert.ok(top9.slice(s, s + 3).filter((c) => c.category === 'earnings').length <= 1, `slots ${s}-${s + 2}`);
  const followed = shapeTop([cos[0], cos[1], macro[0], macro[1]], new Set(['T0', 'T1']));
  assert.deepEqual(ids(followed.slice(0, 2)), ['co0', 'co1'], 'followed companies are not capped');
});

test('macro first: a BLS / BEA / Fed / Treasury card gets the authority boost over an equal card', () => {
  const src = (name: string) => [{ ...card().sources[0], name }];
  const bls = plain('bls', 'economy', 8, { sources: src('U.S. Bureau of Labor Statistics') });
  const news = plain('news', 'tech', 2, { sources: src('Some Outlet') });
  assert.ok(isAuthorityCard(bls) && !isAuthorityCard(news));
  assert.ok(!isAuthorityCard(yieldCard('y', 'DGS10', 1)), 'daily yields are not boosted (they already flood)');
  assert.equal(rank([news, bls], prefs())[0].id, 'bls'); // 6 h older, but +8 h authority
});

test('F6 stronger dislike learning: topic 12, plus ticker and series-family penalties', () => {
  assert.equal(RANK.dislikeTopic, 12);
  const x = company('x', 1, 'COUR');
  const p = withReaction(EMPTY_LOCAL, x, 'dislike', NOW);
  const sameTicker = company('y', 1, 'COUR', { category: 'deals', headline: 'another cour story here' });
  const noTicker = plain('z', 'deals', 1);
  assert.equal(localScore(noTicker, p) - localScore(noTicker, EMPTY_LOCAL), 0);
  assert.equal(localScore(sameTicker, p) - localScore(sameTicker, EMPTY_LOCAL), -RANK.dislikeEntity);
  const yp = withReaction(EMPTY_LOCAL, yieldCard('y1', 'DGS2', 1), 'dislike', NOW);
  const y2 = yieldCard('y2', 'DGS10', 1);
  assert.equal(localScore(y2, yp) - localScore(y2, EMPTY_LOCAL), -RANK.dislikeFamily - RANK.dislikeTopic - RANK.dislikeSource); // series family + topic + source (fred)
});

test('F6 two NASA dislikes: no Science card is shown unless followed; a net-disliked topic goes to the end', () => {
  const space = (i: number) => plain(`s${i}`, 'science', 1 + i, { headline: `NASA mission number ${i} update` });
  const rest = Array.from({ length: 12 }, (_, i) => plain(`r${i}`, ['economy', 'tech', 'policy', 'energy'][i % 4], 2 + i));
  let p = withReaction(EMPTY_LOCAL, plain('dis1', 'science', 1), 'dislike', NOW);
  p = withReaction(p, plain('dis2', 'economy', 1), 'dislike', NOW + 1);
  p = withReaction(p, plain('dis3', 'economy', 1), 'dislike', NOW + 2);
  const out = rank([...rest, space(1), space(2), space(3)], p);
  assert.ok(!ids(out.slice(0, 10)).some((id) => id.startsWith('s')), 'no science card in the top 10');
  assert.ok(!ids(out).some((id) => id.startsWith('s')), 'off-market science (no ticker, no macro) is gated entirely');
  // economy is net -2: its cards sink to the end while 10+ others exist
  assert.ok(out.slice(0, 8).every((c) => c.category !== 'economy'));
  // followed science is allowed back
  assert.ok(rank([...rest, space(1)], { ...p, follows: { topics: ['science'], sources: [], tickers: [] } }).some((c) => c.id === 's1'));
});

test('F6 market-relevance gate: Science/World without ticker or macro need a follow or 2 net likes; with a number they pass', () => {
  const quake = plain('quake', 'world', 1);
  const space = plain('space', 'science', 1);
  const moon = plain('moon', 'science', 1, { tickers: [{ symbol: 'LMT', name: 'Lockheed', exchange: 'NYSE', quote: null }] });
  const eco = plain('eco', 'economy', 5);
  assert.deepEqual(ids(rank([quake, space, moon, eco], prefs())).sort(), ['eco', 'moon']);
  assert.ok(rank([quake, eco], prefs({ follows: { topics: ['world'], sources: [], tickers: [] } })).some((c) => c.id === 'quake'));
  let liked = withReaction(EMPTY_LOCAL, plain('l1', 'science', 1), 'like', NOW);
  liked = withReaction(liked, plain('l2', 'science', 1), 'like', NOW + 1);
  assert.ok(rank([space, eco], liked).some((c) => c.id === 'space'));
});

test('F10 a seen card is penalised 24 h and a liked card 72 h so they are not handed straight back', () => {
  assert.equal(FY.seenPenalty, 24);
  assert.equal(FY.reactedPenalty, 72);
  const fresh = plain('fresh', 'economy', 20), seen = plain('seen', 'tech', 1), liked = plain('liked', 'policy', 1);
  const p = withReaction(EMPTY_LOCAL, liked, 'like', NOW);
  const out = rank([liked, seen, fresh], p, ['seen']);
  assert.equal(out[0].id, 'fresh');
});

test('F5 the extra pool is at most 2 cached GETs: following feed only with follows, Economy unless followed or hidden', async () => {
  const calls: string[] = [];
  const page = (id: string) => ({ items: [plain(id, 'economy', 1)], next_cursor: null });
  const api = {
    feed: async (r: { category?: string | null }) => { calls.push(`feed:${r.category}`); return page('e1'); },
    followingFeed: async (f: { topics: string[] }) => { calls.push(`following:${f.topics.join(',')}`); return page('f1'); },
  };
  const none = { topics: [], sources: [], tickers: [] };
  assert.deepEqual((await fetchExtraPool(api, none, [], 1)).map((x) => ids(x)), [['e1']]);
  assert.deepEqual(calls, ['feed:economy']);
  calls.length = 0;
  const warm = { topics: ['tech'], sources: [], tickers: ['MSFT'] };
  assert.equal((await fetchExtraPool(api, warm, [], 1)).length, 2);
  await fetchExtraPool(api, warm, [], 2); // inside the cache window: no new requests
  assert.deepEqual(calls, ['following:tech', 'feed:economy']);
  calls.length = 0;
  assert.equal((await fetchExtraPool(api, { ...warm, topics: ['economy'] }, [], 1)).length, 1); // economy followed: following feed covers it
  assert.equal((await fetchExtraPool(api, none, ['economy'], 1)).length, 0);
  const failing = { feed: async () => { throw new Error('down'); }, followingFeed: async () => { throw new Error('down'); } };
  assert.deepEqual(await fetchExtraPool(failing, warm, [], 1), [[], []]);
  // the merged pool dedupes by id and by headline
  const a = plain('a', 'economy', 1, { sources: card().sources });
  const pool = mergePool([a], [a, plain('b', 'tech', 1, { headline: a.headline, sources: card().sources })], [plain('c', 'policy', 1)]);
  assert.deepEqual(ids(pool), ['a', 'c'], 'same id, and same headline + source link, count once');
});

test('reactions remember the card keys on this device, and old stored reactions still load', () => {
  const store = memoryStore();
  const c = company('k', 1, 'COUR', { dedupe_key: 'coursera:2026' } as Partial<BlurbCard>);
  writeLocal(store, withReaction(EMPTY_LOCAL, c, 'dislike', NOW));
  const r = readLocal(store).reactions.k;
  assert.deepEqual([r.head, r.key, r.tickers], [normHeadline(c.headline), 'coursera:2026', ['COUR']]);
  store.set('element.local-prefs', JSON.stringify({ reactions: { old: { r: 'like', topic: 'tech', source: null, at: 5 } } }));
  assert.equal(readLocal(store).reactions.old.head, undefined);
  assert.equal(readLocal(store).reactions.old.r, 'like');
});

// ---- ledger replay (optional: the context folder is git-ignored) ----
const LEDGERS = new URL('../../../../../context/sample-users/run/ledger/', import.meta.url);
const CAT: Record<string, string> = { Business: 'markets', Economy: 'economy', Earnings: 'earnings', Deals: 'deals', Energy: 'energy', Government: 'policy', 'Science & Space': 'science', 'Recalls & Safety': 'safety', World: 'world' };
interface Row { headline: string; category: string | null; action: string }
const hasLedger = existsSync(new URL('P01.json', LEDGERS));

test('ledger replay (P01..P18 headlines as the pool): disliked headlines and science gone, rates family capped, macro first', { skip: !hasLedger && 'sample-user ledgers not on this machine' }, () => {
  const rows = new Map<string, Row[]>();
  const pool = new Map<string, BlurbCard>();
  for (let n = 1; n <= 18; n++) {
    const id = `P${String(n).padStart(2, '0')}`;
    const acts: Row[] = JSON.parse(readFileSync(new URL(`${id}.json`, LEDGERS), 'utf8')).actions;
    rows.set(id, acts);
    for (const a of acts) {
      const cat = a.category ? CAT[a.category] : undefined;
      if (!cat || pool.has(a.headline) || !['like', 'dislike', 'view', 'dwell', 'open_detail', 'share'].includes(a.action)) continue;
      const yieldy = /treasury|yield/i.test(a.headline);
      const base = plain(`L${pool.size}`, cat, 2 + (pool.size % 40), { headline: a.headline, importance: 4 + (pool.size % 7) });
      pool.set(a.headline, yieldy ? { ...base, kind: 'data', macro: [fact({ series_id: 'DGS10' })] } : base);
    }
  }
  const cards = [...pool.values()];
  assert.ok(cards.length >= 40, `ledger pool has ${cards.length} headlines`);
  const rated: Record<string, { nasa: number; rates: number; disliked: number }> = {};
  for (const [persona, acts] of rows) {
    let p = EMPTY_LOCAL;
    let t = NOW;
    const topics: string[] = [];
    for (const a of acts) {
      const c = pool.get(a.headline);
      if (a.action === 'follow_topic' && a.headline in CAT) topics.push(CAT[a.headline]);
      if (c && (a.action === 'like' || a.action === 'dislike')) p = withReaction(p, c, a.action, (t += 1000));
    }
    p = { ...p, follows: { topics, sources: [], tickers: [] } };
    const out = rank(cards, p);
    const top10 = out.slice(0, 10);
    const dislikedHeads = new Set(Object.values(p.reactions).filter((r) => r.r === 'dislike').map((r) => r.head));
    rated[persona] = { nasa: top10.filter((c) => c.category === 'science').length, rates: top10.filter((c) => cardFamily(c) === 'g:rates').length, disliked: out.filter((c) => dislikedHeads.has(normHeadline(c.headline))).length };
    assert.equal(rated[persona].disliked, 0, `${persona}: no disliked headline comes back`);
    assert.ok(rated[persona].rates <= FY.familyCap, `${persona}: rates family capped in the top 10`);
    assert.equal(new Set(ids(out)).size, out.length);
    if (!topics.includes('science')) assert.equal(rated[persona].nasa, 0, `${persona}: no off-market science in the top 10 unless followed or liked`);
  }
  console.log(`[m9] ledger replay over ${cards.length} headlines: max rates in top 10 = ${Math.max(...Object.values(rated).map((r) => r.rates))}, science in top 10 = ${Object.values(rated).reduce((s, r) => s + r.nasa, 0)}`);
});
