// Offline evaluation: Trending, Latest and For you are different pages, and For you (V2) improves on V1.
// V1 is the previous rankForYou, kept here so before/after are computed on the same fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { BlurbCard } from '../../contract/types.ts';
import { diversifyFeed } from '../diversify.ts';
import { localScore } from '../localRank.ts';
import { mockRankScore } from '../feedLogic.ts';
import { cardSourceKey } from '../sourceKeys.ts';
import { capTopics, mergePool, rankForYou, spreadFromTrending } from '../forYouRank.ts';
import { sortLatest, trendingOrder } from '../feedOrder.ts';

type Prefs = Parameters<typeof rankForYou>[1];

function rankForYouV1(pool: BlurbCard[], prefs: Prefs, seenIds: ReadonlySet<string>, trendingFirstId: string | null, trendingTopIds: ReadonlySet<string>): BlurbCard[] {
  const trendPos = new Map(pool.map((c, i) => [c.id, i]));
  const kept = pool.filter((c) => {
    if (prefs.reactions[c.id]?.r === 'dislike') return false;
    if (prefs.hiddenTopics.includes(c.category)) return false;
    const src = cardSourceKey(c);
    return !(src && prefs.hiddenSources.includes(src));
  });
  const used = (c: BlurbCard) => seenIds.has(c.id) || !!prefs.reactions[c.id];
  const sorted = kept.map((c) => ({ c, affinity: localScore(c, prefs) - mockRankScore(c), used: used(c) }))
    .sort((a, b) => Number(a.used) - Number(b.used) || b.affinity - a.affinity || Date.parse(b.c.published_at) - Date.parse(a.c.published_at) || (trendPos.get(a.c.id) ?? 0) - (trendPos.get(b.c.id) ?? 0))
    .map((x) => x.c);
  const out = spreadFromTrending(diversifyFeed(sorted), trendingTopIds);
  if (trendingFirstId && out.length > 1 && out[0].id === trendingFirstId) { const [first, ...rest] = out; return [rest[0], first, ...rest.slice(1)]; }
  return out;
}

const TOPICS = ['markets', 'tech', 'sports', 'money', 'policy', 'science', 'energy', 'world'];
const NOW = Date.parse('2026-10-18T12:00:00Z');
function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function pool(n = 60, seed = 7): BlurbCard[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(NOW - Math.floor(r() * 48 * 60) * 60_000).toISOString();
    return { id: `c${String(i).padStart(2, '0')}`, kind: 'summary', category: TOPICS[Math.floor(r() * 8)], importance: 1 + Math.floor(r() * 8), published_at: t, as_of: t, sort_at: t, headline: `h${i}`, sources: [], tickers: [], macro: [] } as unknown as BlurbCard;
  });
}
const noPrefs: Prefs = { reactions: {}, hiddenTopics: [], hiddenSources: [], follows: { topics: [] } };
const like = (cards: BlurbCard[], topics: string[], n: number): Prefs['reactions'] => {
  const out: Prefs['reactions'] = {};
  topics.forEach((t) => cards.filter((c) => c.category === t).slice(0, n).forEach((c, i) => { out[`old-${c.id}-${i}`] = { r: 'like', topic: t, source: null, at: i } as never; }));
  return out;
};
const PERSONAS: Record<string, { topics: string[]; prefs: (p: BlurbCard[]) => Prefs }> = {
  'sports+money': { topics: ['sports', 'money'], prefs: (p) => ({ ...noPrefs, reactions: like(p, ['sports', 'money'], 3), follows: { topics: ['sports'] } }) },
  tech: { topics: ['tech', 'science'], prefs: (p) => ({ ...noPrefs, reactions: like(p, ['tech', 'science'], 3) }) },
  skimmer: { topics: TOPICS, prefs: (p) => ({ ...noPrefs, reactions: like(p, ['markets'], 1) }) },
  cold: { topics: TOPICS, prefs: () => noPrefs },
};

const ids = (cs: BlurbCard[]) => cs.map((c) => c.id);
const jaccard = (a: BlurbCard[], b: BlurbCard[]) => { const A = new Set(ids(a)), B = new Set(ids(b)); const i = [...A].filter((x) => B.has(x)).length; return i / (A.size + B.size - i || 1); };
const precision = (cs: BlurbCard[], rel: string[]) => cs.filter((c) => rel.includes(c.category)).length / (cs.length || 1);
const ndcg = (cs: BlurbCard[], rel: string[]) => { const g = (xs: BlurbCard[]) => xs.reduce((s, c, i) => s + (rel.includes(c.category) ? 1 : 0) / Math.log2(i + 2), 0); const ideal = [...cs].sort((a, b) => Number(rel.includes(b.category)) - Number(rel.includes(a.category))); return g(cs) / (g(ideal) || 1); };
const maxRun = (cs: BlurbCard[]) => { let m = 0, n = 0; cs.forEach((c, i) => { n = i && cs[i - 1].category === c.category ? n + 1 : 1; m = Math.max(m, n); }); return m; };

/** Production candidate pools: Trending page 1 (top by trendingOrder) and Latest page 1. */
function pages(all: BlurbCard[], depth = 20) {
  const ranked = [...all].sort((a, b) => mockRankScore(b) - mockRankScore(a));
  const top = trendingOrder(ranked.slice(0, 10));
  const latest = sortLatest(all).slice(0, 10);
  // For you candidates: Trending to `depth` cards (page 1 + page 2) plus the Latest page; overlap is measured against the pages the reader sees (10 each).
  const candidates = mergePool(trendingOrder(ranked.slice(0, depth)), latest);
  return { top, latest, candidates, topIds: new Set(top.map((c) => c.id)) };
}

function evaluate(fn: typeof rankForYou, all: BlurbCard[], depth: number) {
  const rows: Record<string, number[]> = {};
  const { top, latest, candidates, topIds } = pages(all, depth);
  for (const [name, p] of Object.entries(PERSONAS)) {
    const prefs = p.prefs(all);
    const fy = fn(candidates, prefs, new Set(), top[0].id, topIds).slice(0, 10);
    rows[name] = [jaccard(fy, top), jaccard(fy, latest), precision(fy, p.topics), ndcg(fy, p.topics), new Set(fy.map((c) => c.category)).size, maxRun(fy)];
  }
  return rows;
}
const DEPTH = 20; // For you pool = Trending 20 + Latest 10 (V1 baseline = the shipped pool: Trending 10 + Latest 10)
const mean = (rows: Record<string, number[]>, k: number) => Object.values(rows).reduce((s, r) => s + r[k], 0) / Object.keys(rows).length;

test('report: V1 vs V2 on 5 seeds x 4 personas (Jaccard vs Trending/Latest, P@10, NDCG@10, topics, max run)', () => {
  const agg = { v1: [0, 0, 0, 0, 0, 0], v2: [0, 0, 0, 0, 0, 0] };
  const seeds = [1, 2, 3, 4, 5];
  for (const seed of seeds) {
    const all = pool(60, seed);
    const a = evaluate(rankForYouV1, all, 10), b = evaluate(rankForYou, all, DEPTH);
    for (let k = 0; k < 6; k++) { agg.v1[k] += mean(a, k) / seeds.length; agg.v2[k] += mean(b, k) / seeds.length; }
  }
  const f = (x: number[]) => x.map((v) => v.toFixed(2)).join(' / ');
  console.log(`[algo] jT / jL / P@10 / NDCG / topics / maxRun\n[algo] V1 ${f(agg.v1)}\n[algo] V2 ${f(agg.v2)}`);
  assert.ok(agg.v2[2] >= agg.v1[2] - 0.02, 'precision must not regress');
  assert.ok(agg.v2[5] <= 2, 'no topic run longer than 2');
});

test('V2 keeps hidden/disliked out, is deterministic, and never repeats a card', () => {
  const all = pool(60, 3), { top, latest, topIds } = pages(all);
  const prefs: Prefs = { ...noPrefs, hiddenTopics: ['energy'], reactions: { [top[0].id]: { r: 'dislike', topic: top[0].category, source: null, at: 1 } as never } };
  const a = rankForYou(mergePool(top, latest), prefs, new Set(), top[0].id, topIds), b = rankForYou(mergePool(top, latest), prefs, new Set(), top[0].id, topIds);
  assert.deepEqual(ids(a), ids(b));
  assert.equal(new Set(ids(a)).size, a.length);
  assert.ok(!a.some((c) => c.category === 'energy' || c.id === top[0].id));
});

test('cold reader: topic round-robin by importance, not Latest order, not Trending first', () => {
  const all = pool(60, 2), { top, latest, topIds } = pages(all);
  const out = rankForYou(mergePool(top, latest), noPrefs, new Set(), top[0].id, topIds);
  assert.notEqual(out[0].id, top[0].id);
  const topics = new Set(out.map((c) => c.category)).size;
  assert.ok(new Set(out.slice(0, 5).map((c) => c.category)).size >= Math.min(4, topics));
  assert.notDeepEqual(ids(out).slice(0, 5), ids(sortLatest(out)).slice(0, 5));
});

test('a seen card does not sink below every unseen card (soft penalty)', () => {
  const hi = { ...pool(1)[0], id: 'big', importance: 8, category: 'markets' } as BlurbCard;
  const lo = { ...pool(1)[0], id: 'small', importance: 1, category: 'tech' } as BlurbCard;
  const old = new Date(NOW - 40 * 3_600_000).toISOString();
  const lo2 = { ...lo, id: 'old', published_at: old, as_of: old, sort_at: old, category: 'sports' } as BlurbCard;
  const out = rankForYou([hi, lo, lo2], noPrefs, new Set(['big']), null);
  assert.deepEqual(ids(out).slice(0, 2), ['big', 'small']);
});

test('diversify is last: no run of the same topic after the Trending spread', () => {
  const all = pool(60, 4), { top, latest, topIds } = pages(all);
  assert.ok(maxRun(rankForYou(mergePool(top, latest), PERSONAS['sports+money'].prefs(all), new Set(), top[0].id, topIds)) <= 2);
});

test('real-shaped fixtures: same cards in, no repeats, hidden respected, report overlap', () => {
  const read = (f: string) => (JSON.parse(readFileSync(new URL(`../../contract/fixtures/${f}`, import.meta.url), 'utf8')).items ?? []) as BlurbCard[];
  const top = trendingOrder(read('feed.page1.json')), latest = sortLatest(read('feed.page2.json').concat(read('feed_for_you.page1.json')));
  const prefs: Prefs = { ...noPrefs, hiddenTopics: [top[top.length - 1].category] };
  const topIds = new Set(top.map((c) => c.id));
  const v1 = rankForYouV1(mergePool(top, latest), prefs, new Set(), top[0]?.id ?? null, topIds), v2 = rankForYou(mergePool(top, latest), prefs, new Set(), top[0]?.id ?? null, topIds);
  console.log(`[algo] real fixtures n=${v2.length}: jaccard vs Trending V1 ${jaccard(v1.slice(0, 10), top).toFixed(2)} V2 ${jaccard(v2.slice(0, 10), top).toFixed(2)}; vs Latest V1 ${jaccard(v1.slice(0, 10), latest).toFixed(2)} V2 ${jaccard(v2.slice(0, 10), latest).toFixed(2)}`);
  assert.deepEqual([...ids(v2)].sort(), [...ids(v1)].sort());
  assert.equal(new Set(ids(v2)).size, v2.length);
  assert.ok(!v2.some((c) => prefs.hiddenTopics.includes(c.category)));
});

test('stage 2: topic cap, old likes fade, explore slot, recent dislike spill', () => {
  const mk = (id: string, cat: string, h: number, imp = 1) => { const t = new Date(NOW - h * 3_600_000).toISOString(); return { id, kind: 'summary', category: cat, importance: imp, published_at: t, as_of: t, sort_at: t, headline: id, sources: [], tickers: [], macro: [] } as unknown as BlurbCard; };
  const many = Array.from({ length: 8 }, (_, i) => mk(`m${i}`, 'markets', i));
  assert.ok(capTopics(many, 10, 3).slice(0, 3).every((c) => c.category === 'markets'));
  const mixed = [...many, mk('t0', 'tech', 9), mk('s0', 'sports', 9)];
  assert.ok(capTopics(mixed, 5, 3).slice(0, 5).filter((c) => c.category === 'markets').length <= 3);
  // an old like is worth less than a fresh one
  const day = 86_400_000;
  const prefOf = (age: number): Prefs => ({ ...noPrefs, reactions: { x: { r: 'like', topic: 'tech', source: null, at: NOW - age } as never } });
  const cards = [mk('tech', 'tech', 5), mk('mk', 'markets', 4)];
  assert.equal(rankForYou(cards, prefOf(0), new Set(), null, new Set(), NOW)[0].id, 'tech');
  assert.equal(rankForYou(cards, prefOf(60 * day), new Set(), null, new Set(), NOW)[0].id, 'mk');
  // explore: with 3 reactions in markets, an unseen new topic card reaches slot 4
  const reactions = Object.fromEntries(['a', 'b', 'c'].map((k) => [k, { r: 'like', topic: 'markets', source: null, at: NOW } as never]));
  const pool2 = [...Array.from({ length: 8 }, (_, i) => mk(`k${i}`, i % 2 ? 'markets' : 'policy', i, 4)), mk('new', 'science', 20)];
  const out = rankForYou(pool2, { ...noPrefs, reactions, follows: { topics: ['markets'] } }, new Set(), null, new Set(), NOW);
  assert.ok(ids(out).indexOf('new') <= 4);
  // a dislike among the last reactions lowers its topic a bit more
  const dis: Prefs = { ...noPrefs, reactions: { d: { r: 'dislike', topic: 'tech', source: null, at: NOW } as never } };
  assert.equal(rankForYou([mk('tech', 'tech', 4), mk('mk', 'markets', 5)], dis, new Set(), null, new Set(), NOW)[0].id, 'mk');
});
