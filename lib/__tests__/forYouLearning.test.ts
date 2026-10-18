// Does For you improve over time? 8 sessions per persona through the real device path:
// rankForYou -> top 10 shown -> recordSeen -> persona likes/dislikes (withReaction, writeLocal) -> next session readLocal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { BlurbCard } from '../../contract/types.ts';
import { mergePool, rankForYou, FY } from '../forYouRank.ts';
import { readLocal, writeLocal, withReaction, MAX_LOCAL_REACTIONS, EMPTY_LOCAL } from '../localPrefs.ts';
import { readSeen, recordSeen } from '../forYouGate.ts';
import { memoryStore } from '../storage.ts';
import { rerankQueue } from '../queueLogic.ts';
import { mockRankScore } from '../feedLogic.ts';
import { sortLatest, trendingOrder } from '../feedOrder.ts';

const TOPICS = ['markets', 'tech', 'sports', 'money', 'policy', 'science', 'energy', 'world'];
const T0 = Date.parse('2026-10-18T12:00:00Z');
const H = 3_600_000;
function rng(seed: number) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
const mk = (id: string, cat: string, ageH: number, imp: number, now: number): BlurbCard => { const t = new Date(now - ageH * H).toISOString(); return { id, kind: 'summary', category: cat, importance: imp, published_at: t, as_of: t, sort_at: t, headline: id, sources: [], tickers: [], macro: [] } as unknown as BlurbCard; };
function freshPool(session: number, seed: number, now: number, n = 60): BlurbCard[] {
  const r = rng(seed * 100 + session);
  return Array.from({ length: n }, (_, i) => mk(`s${session}-${seed}-${i}`, TOPICS[Math.floor(r() * 8)], r() * 36, 1 + Math.floor(r() * 8), now));
}

interface Persona { name: string; taste: (session: number) => string[]; like: number; dislike: number }
const PERSONAS: Persona[] = [
  { name: 'sports+money', taste: () => ['sports', 'money'], like: 0.8, dislike: 0.5 },
  { name: 'tech', taste: () => ['tech', 'science'], like: 0.8, dislike: 0.5 },
  { name: 'skimmer', taste: () => ['markets', 'tech', 'policy', 'world'], like: 0.5, dislike: 0.2 },
  { name: 'shifter', taste: (s) => (s <= 4 ? ['sports', 'money'] : ['science', 'energy']), like: 0.8, dislike: 0.5 },
];

const precision = (cs: BlurbCard[], rel: string[]) => cs.filter((c) => rel.includes(c.category)).length / (cs.length || 1);
const ndcg = (cs: BlurbCard[], rel: string[]) => { const g = (xs: BlurbCard[]) => xs.reduce((s, c, i) => s + (rel.includes(c.category) ? 1 : 0) / Math.log2(i + 2), 0); const ideal = [...cs].sort((a, b) => Number(rel.includes(b.category)) - Number(rel.includes(a.category))); return g(cs) / (g(ideal) || 1); };
const maxRun = (cs: BlurbCard[]) => { let m = 0, n = 0; cs.forEach((c, i) => { n = i && cs[i - 1].category === c.category ? n + 1 : 1; m = Math.max(m, n); }); return m; };

type Row = { p: number; ndcg: number; distinct: number; run: number };
/** One persona, one seed, 8 sessions. `candidates(session, now)` gives the day's pool; `taste` may come from the fixtures. */
function simulate(persona: Persona, seed: number, candidates: (session: number, now: number, seed: number) => BlurbCard[], tasteOf = persona.taste): Row[] {
  const store = memoryStore();
  const r = rng(seed * 7919 + persona.name.length);
  const rows: Row[] = [];
  for (let s = 1; s <= 8; s++) {
    const now = T0 + s * 12 * H;
    const all = candidates(s, now, seed);
    const ranked = [...all].sort((a, b) => mockRankScore(b) - mockRankScore(a));
    const top = trendingOrder(ranked.slice(0, 20)), latest = sortLatest(all).slice(0, 10);
    const topPage = trendingOrder(ranked.slice(0, 10));
    const shown = rankForYou(mergePool(top, latest), readLocal(store), new Set(readSeen(store).map((x) => x.id)), topPage[0].id, new Set(topPage.map((c) => c.id)), now).slice(0, 10);
    const rel = tasteOf(s);
    rows.push({ p: precision(shown, rel), ndcg: ndcg(shown, rel), distinct: new Set(shown.map((c) => c.category)).size, run: maxRun(shown) });
    let prefs = readLocal(store);
    shown.forEach((c, i) => {
      recordSeen(store, { id: c.id, category: c.category }, now);
      const likes = rel.includes(c.category) !== (r() < 0.1); // 10% noise flips what the persona thinks of the card
      if (likes ? r() < persona.like : r() < persona.dislike) prefs = withReaction(prefs, c, likes ? 'like' : 'dislike', now + i * 1000);
    });
    writeLocal(store, prefs);
  }
  return rows;
}

const SEEDS = Array.from({ length: 16 }, (_, i) => i + 1);
function curve(persona: Persona, candidates: (s: number, now: number, seed: number) => BlurbCard[], tasteOf?: (s: number) => string[]): Row[] {
  const runs = SEEDS.map((sd) => simulate(persona, sd, candidates, tasteOf));
  return Array.from({ length: 8 }, (_, i) => ({
    p: runs.reduce((a, x) => a + x[i].p, 0) / runs.length, ndcg: runs.reduce((a, x) => a + x[i].ndcg, 0) / runs.length,
    distinct: Math.min(...runs.map((x) => x[i].distinct)), run: Math.max(...runs.map((x) => x[i].run)),
  }));
}
const table = (title: string, rows: Row[]) => console.log(`[learn] ${title}\n[learn] session: ${rows.map((_, i) => i + 1).join('    ')}\n[learn] P@10:   ${rows.map((x) => x.p.toFixed(2)).join('  ')}\n[learn] NDCG:   ${rows.map((x) => x.ndcg.toFixed(2)).join('  ')}\n[learn] topics(min): ${rows.map((x) => x.distinct).join(' ')}  maxRun(max): ${rows.map((x) => x.run).join(' ')}`);
const nonDecreasing = (xs: number[]) => { let dips = 0; for (let i = 1; i < xs.length; i++) { const d = xs[i - 1] - xs[i]; if (d > 0.05) return false; if (d > 0) dips++; } return dips <= 1 || xs.slice(1).every((x, i) => xs[i] - x <= 0.05); };

test('learning curve on the synthetic pool: stable personas improve, the shifter recovers, no collapse', () => {
  for (const persona of PERSONAS) {
    const rows = curve(persona, (s, now, seed) => freshPool(s, seed, now));
    table(`${persona.name} (60 new cards per session, mean of ${SEEDS.length} seeds)`, rows);
    assert.ok(rows.every((x) => x.distinct >= 4), `${persona.name}: at least 4 topics in every session`);
    assert.ok(rows.every((x) => x.run <= 2), `${persona.name}: no topic run above 2`);
    if (persona.name === 'shifter') {
      const rec = (rows[5].p + rows[6].p + rows[7].p) / 3;
      assert.ok(rec >= rows[4].p + 0.1, `shifter recovers: ${rec.toFixed(2)} vs session 5 ${rows[4].p.toFixed(2)}`);
    } else {
      assert.ok(rows[7].p >= rows[0].p + 0.15, `${persona.name}: session 8 ${rows[7].p.toFixed(2)} >= session 1 ${rows[0].p.toFixed(2)} + 0.15`);
      assert.ok(nonDecreasing(rows.map((x) => x.p)), `${persona.name}: curve non-decreasing within noise`);
    }
  }
});

test('learning curve on the real-shaped fixtures (same 30 cards each session, ranks change)', () => {
  const read = (f: string) => (JSON.parse(readFileSync(new URL(`../../contract/fixtures/${f}`, import.meta.url), 'utf8')).items ?? []) as BlurbCard[];
  const base = [...read('feed.page1.json'), ...read('feed.page2.json'), ...read('feed_for_you.page1.json')].filter((c, i, a) => a.findIndex((x) => x.id === c.id) === i);
  const counts = new Map<string, number>();
  base.forEach((c) => counts.set(c.category, (counts.get(c.category) ?? 0) + 1));
  const cats = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((x) => x[0]);
  assert.ok(cats.length >= 4, 'fixtures have at least 4 topics');
  const persona: Persona = { name: 'fixture reader', taste: () => cats.slice(1, 3), like: 0.8, dislike: 0.5 };
  // Each session the same cards, newly published (ids change so the seen list does not hide them).
  const rows = curve(persona, (s, now) => base.map((c, i) => ({ ...c, id: `${c.id}#${s}`, published_at: new Date(now - (i % 30) * H).toISOString(), as_of: new Date(now - (i % 30) * H).toISOString(), sort_at: new Date(now - (i % 30) * H).toISOString() }) as BlurbCard));
  table(`fixture reader (topics ${cats.slice(1, 3).join('+')}, n=${base.length})`, rows);
  assert.ok(rows[7].p >= rows[0].p, 'real fixtures: session 8 is not worse than session 1');
  assert.ok(rows.every((x) => x.distinct >= Math.min(4, cats.length)));
});

test('in session: one dislike lowers that topic among not-yet-reached cards, one like raises it, reached cards never move', () => {
  const now = T0;
  const queue = freshPool(1, 9, now, 24).sort((a, b) => mockRankScore(b) - mockRankScore(a));
  const X = queue[10].category;
  const pos = (q: BlurbCard[], tail: number) => { const t = q.slice(tail).filter((c) => c.category === X); return t.reduce((s, c) => s + q.indexOf(c), 0) / (t.length || 1); };
  const seenCount = 3, tail = seenCount + 2;
  const flip = (card: BlurbCard, r: 'like' | 'dislike') => withReaction(EMPTY_LOCAL, card, r, now);
  const base = rerankQueue(queue, EMPTY_LOCAL, seenCount);
  const xCard = queue.find((c) => c.category === X)!;
  const down = rerankQueue(queue, flip(xCard, 'dislike'), seenCount);
  const up = rerankQueue(queue, flip(xCard, 'like'), seenCount);
  assert.deepEqual(down.slice(0, tail).map((c) => c.id), queue.slice(0, tail).map((c) => c.id));
  assert.deepEqual(up.slice(0, tail).map((c) => c.id), queue.slice(0, tail).map((c) => c.id));
  assert.ok(pos(down, tail) > pos(base, tail), `dislike pushes ${X} later (${pos(base, tail).toFixed(1)} -> ${pos(down, tail).toFixed(1)})`);
  assert.ok(pos(up, tail) < pos(base, tail), `like pulls ${X} earlier (${pos(base, tail).toFixed(1)} -> ${pos(up, tail).toFixed(1)})`);
  assert.equal(new Set(up.map((c) => c.id)).size, queue.length);
});

test('persistence: past 200 reactions only the oldest drop, and decay never erases a fresh like', () => {
  let p = EMPTY_LOCAL;
  const cards = freshPool(1, 3, T0, 230);
  cards.forEach((c, i) => { p = withReaction(p, c, 'like', T0 + i); });
  const keep = Object.keys(p.reactions);
  assert.equal(keep.length, MAX_LOCAL_REACTIONS);
  assert.ok(!keep.includes(cards[0].id) && keep.includes(cards[229].id));
  // a like from just now still counts at (almost) full weight; one from 60 days ago is mostly gone
  const a = mk('a', 'tech', 3, 2, T0), b = mk('b', 'markets', 2, 2, T0);
  const fresh = { ...EMPTY_LOCAL, reactions: { x: { r: 'like' as const, topic: 'tech', source: null, at: T0 } } };
  const old = { ...EMPTY_LOCAL, reactions: { x: { r: 'like' as const, topic: 'tech', source: null, at: T0 - 60 * 86_400_000 } } };
  assert.equal(rankForYou([a, b], fresh, new Set(), null, new Set(), T0)[0].id, 'a');
  assert.equal(rankForYou([a, b], old, new Set(), null, new Set(), T0)[0].id, 'b');
  assert.ok(FY.likeHalfLifeDays >= 7);
});
