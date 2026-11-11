// M9b offline fixtures from the simulated persona ledgers (algorithm-findings F, step 5). No accounts, no network.
// The ledgers are private study data and are NOT in the repo: the test looks for
// context/sample-users/run/ledger/P01..P18.json above the working directory (or ELEMENT_LEDGER_DIR). Without them a
// small built-in fixture (3 synthetic personas) runs instead, so CI still checks the same rules.
//
// Two rankers are checked on every persona, after replaying all of its reactions, follows and views:
//   client  rankForYou (lib/feed/forYouRank.ts), the signed-out ranker, with the reader's prefs as the device keeps them;
//   server  a TypeScript mirror of the v5 For you score with the M9b terms (migration 20261126000000), used to compare
//           foryou_personal_scale 3 vs 6 (D-116). The mirror's learned topic affinity is an APPROXIMATION of
//           core.user_affinity (same weights and caps, simpler confidence); treat its numbers as directional.
// Metrics on the top 10 (series repeats and Jaccard on the top 20): liked-topic share, hated-topic share, macro share,
// same-series repeats, Jaccard with Trending. Set M9B_REPORT=1 to print the per-persona table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { BlurbCard } from '../../contract/types.ts';
import { rankForYou, freshBase, isAuthorityCard } from '../feed/forYouRank.ts';
import { cardFamily, isKeySeries, reactionKeys, tickerList } from '../feed/cardKeys.ts';
import { localReason, reasonText, cardReason } from '../feed/reasonLine.ts';
import { latestDimmed } from '../feed/latestDim.ts';

type Action = { headline: string; category: string | null; tab: string; action: string; dwell_ms: number | null };
type Ledger = { persona: string; actions: Action[] };

const NOW = Date.parse('2026-11-10T12:00:00Z');
const H = 3_600_000;

// ---------------------------------------------------------------- data
function findLedgerDir(): string | null {
  if (process.env.M9B_MINI) return null; // force the built-in fixture (what CI runs)
  if (process.env.ELEMENT_LEDGER_DIR && fs.existsSync(process.env.ELEMENT_LEDGER_DIR)) return process.env.ELEMENT_LEDGER_DIR;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'context', 'sample-users', 'run', 'ledger');
    if (fs.existsSync(path.join(p, 'P01.json'))) return p;
    dir = path.dirname(dir);
  }
  return null;
}

const MINI: Ledger[] = [
  { persona: 'M1', actions: [
    { headline: 'Economy', category: null, tab: 'foryou', action: 'follow_topic', dwell_ms: null },
    { headline: 'Consumer prices up 3.7% from a year earlier in September', category: 'Economy', tab: 'top', action: 'like', dwell_ms: 6000 },
    { headline: 'Nonfarm payroll jobs rise to 159.3M in October', category: 'Economy', tab: 'top', action: 'like', dwell_ms: 5000 },
    { headline: 'NASA awards contracts for Moon Base transportation and science projects', category: 'Science & Space', tab: 'top', action: 'dislike', dwell_ms: 1000 },
    { headline: 'Nasa seeks new astronaut class for lunar and mars missions', category: 'Science & Space', tab: 'top', action: 'dislike', dwell_ms: 900 },
    { headline: 'Lucid reports third quarter 2026 revenue of $350 million', category: 'Earnings', tab: 'top', action: 'dislike', dwell_ms: 1200 },
    { headline: '10-year Treasury yield falls to 4.84%', category: 'Business', tab: 'top', action: 'like', dwell_ms: 3000 },
  ] },
  { persona: 'M2', actions: [
    { headline: 'Microsoft', category: null, tab: 'search', action: 'follow_company', dwell_ms: null },
    { headline: 'Alphabet reports third quarter 2026 financial results', category: 'Earnings', tab: 'top', action: 'like', dwell_ms: 5000 },
    { headline: 'Apple reports record third-quarter revenue and earnings', category: 'Earnings', tab: 'top', action: 'like', dwell_ms: 5000 },
    { headline: 'Magnitude 7.0 earthquake hits Japan region', category: null, tab: 'top', action: 'dislike', dwell_ms: 900 },
    { headline: 'FAA orders Airbus A350 plane inspections', category: 'Government', tab: 'top', action: 'dislike', dwell_ms: 900 },
  ] },
  { persona: 'M3', actions: [
    { headline: 'Energy', category: null, tab: 'foryou', action: 'follow_topic', dwell_ms: null },
    { headline: 'Average regular gas price falls to $4.15 in the week of Nov 2', category: 'Energy', tab: 'top', action: 'like', dwell_ms: 6000 },
    { headline: 'Unemployment rate falls to 4.1% in October', category: 'Economy', tab: 'top', action: 'like', dwell_ms: 6000 },
    { headline: 'Meta announces massive preferred stock and common stock offerings', category: null, tab: 'top', action: 'dislike', dwell_ms: 1000 },
    { headline: 'Coursera adopts stockholder rights plan after a stake reaches 14.7%', category: null, tab: 'top', action: 'dislike', dwell_ms: 1000 },
  ] },
];
// headlines the mini corpus needs beyond the personas' own
const MINI_EXTRA = ['U.S. trade deficit shrinks to $105.0 billion in September', 'Take-Two Interactive posts second-quarter results and updates outlook',
  'Housing starts fall to 1.22M (annual rate) in September', 'Microsoft reports $92.3 billion in quarterly revenue', 'Wingstop reports $185.1 million in third quarter revenue',
  'NASA unveils X-70 Fractal experimental aircraft', '2-year Treasury yield falls to 4.46%', '5-year Treasury yield falls to 4.59%', 'DoorDash agrees to combine with Instacart in a multi-billion dollar deal',
  'Truist Financial posts third quarter 2026 results', 'Fed raises federal funds rate target range', 'Primark recalls children\'s 101 Dalmatians coin purses'];

const SLUG: Record<string, string> = { Economy: 'economy', Business: 'markets', Earnings: 'earnings', Deals: 'deals', Government: 'policy', 'Science & Space': 'science', Energy: 'energy', 'Recalls & Safety': 'safety', World: 'world', Technology: 'tech' };
const TICKER: [RegExp, string][] = [[/^Take-Two/, 'TTWO'], [/^Coursera/, 'COUR'], [/^Lucid/, 'LCID'], [/^Nelnet/, 'NNI'], [/^e\.l\.f\./, 'ELF'], [/^Match Group/, 'MTCH'], [/^Carnival/, 'CCL'], [/^3M/, 'MMM'], [/^Microsoft/, 'MSFT'], [/^Etsy/, 'ETSY'], [/^Wingstop/, 'WING'], [/^DoorDash/, 'DASH'], [/^Meta/, 'META'], [/^Alphabet/, 'GOOGL'], [/^Boeing/, 'BA'], [/^SoFi/, 'SOFI'], [/^Lam Research/, 'LRCX'], [/^Zillow/, 'Z'], [/^Truist/, 'TFC'], [/^Schwab/, 'SCHW'], [/^U\.S\. Bancorp/, 'USB'], [/^PNC/, 'PNC'], [/^Norwegian/, 'NCLH'], [/^Gilead/, 'GILD'], [/^T-Mobile/, 'TMUS'], [/^Apple/, 'AAPL'], [/^Hershey/, 'HSY'], [/^Target/, 'TGT'], [/^Five Below/, 'FIVE'], [/^Deckers/, 'DECK'], [/^Nvidia/, 'NVDA'], [/^Walmart/, 'WMT'], [/^Coinbase/, 'COIN'], [/^Goldman/, 'GS'], [/^JPM|^JPMorgan/, 'JPM'], [/^Google/, 'GOOGL']];
const SERIES: [RegExp, string, string][] = [[/2-year Treasury yield/, 'DGS2', 'U.S. Treasury'], [/5-year Treasury yield/, 'DGS5', 'U.S. Treasury'], [/10-year Treasury yield/, 'DGS10', 'U.S. Treasury'],
  [/interest rate on Treasury notes/, 'AVGTNOTE', 'U.S. Treasury'], [/trade deficit/, 'BOPGSTB', 'Bureau of Economic Analysis'], [/gas price/, 'GASREGW', 'U.S. Energy Information Administration'],
  [/Nonfarm payroll/, 'PAYEMS', 'Bureau of Labor Statistics'], [/Unemployment rate/, 'UNRATE', 'Bureau of Labor Statistics'], [/Housing starts/, 'HOUST', 'Census Bureau'],
  [/Consumer prices|CPI inflation/, 'CPIAUCSL', 'Bureau of Labor Statistics'], [/economy grew/, 'GDPC1', 'Bureau of Economic Analysis'], [/federal funds rate/, 'DFEDTARU', 'Federal Reserve Board']];

function inferCategory(h: string): string {
  if (SERIES.some(([re]) => re.test(h))) return /gas price/.test(h) ? 'energy' : 'economy';
  if (/earthquake/i.test(h)) return 'world';
  if (/NASA|Nasa|astronaut|Moon/.test(h)) return 'science';
  if (/FAA|safety rules|Airbus|Boeing 757/.test(h)) return 'policy';
  if (/recall/i.test(h)) return 'safety';
  if (/reports|results|revenue|earnings|net income|sales growth/i.test(h)) return 'earnings';
  if (/combine|agrees to|settlement|offering|deal/i.test(h)) return 'deals';
  return 'markets';
}
function hash(s: string): number { let x = 2166136261; for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return (x >>> 0) / 2 ** 32; }

/** One card per distinct headline. Data cards keep every reading (the client family cap must thin them). */
function buildCorpus(ledgers: Ledger[], extra: string[] = []): BlurbCard[] {
  const cat = new Map<string, string>();
  const order: string[] = [];
  for (const l of ledgers) for (const a of l.actions) {
    if (a.action.startsWith('follow') || a.action === 'unlike') continue;
    if (!cat.has(a.headline)) order.push(a.headline);
    if (a.category && SLUG[a.category] && !cat.get(a.headline)) cat.set(a.headline, SLUG[a.category]);
    else if (!cat.has(a.headline)) cat.set(a.headline, '');
  }
  for (const h of extra) if (!cat.has(h)) { order.push(h); cat.set(h, ''); }
  return order.map((h, i) => {
    const s = SERIES.find(([re]) => re.test(h));
    const tk = TICKER.find(([re]) => re.test(h));
    // F2 retag (data cards are Economy/Energy); FAA directives stay Government here (worst case for macro share)
    const category = s ? inferCategory(h) : cat.get(h) || inferCategory(h);
    const release = s ? NOW - (2 + hash(h) * 70) * H : NOW - (3 + hash(h) * 140) * H;
    // a data card's sort_at is its period: daily series a day back, monthly about 35 days, GDP a quarter (prod rule)
    const lag = !s ? 0 : /^DGS|GASREGW|DFEDTARU/.test(s[1]) ? 24 : s[1] === 'GDPC1' ? 90 * 24 : 35 * 24;
    const id = `c${String(i).padStart(3, '0')}`;
    const importance = s ? 10 : category === 'earnings' ? 6 : category === 'science' || category === 'safety' ? 1.5 : category === 'world' ? 2 : 4;
    return {
      id, kind: s ? 'data' : 'summary', headline: h, body: null, category, event_type: s ? 'macro_release' : null,
      as_of: new Date(release - lag * H).toISOString(), sort_at: new Date(release - lag * H).toISOString(),
      published_at: new Date(release + (s ? 0 : 1) * H).toISOString(),
      sources: [{ name: s ? s[2] : tk ? 'SEC' : category === 'science' ? 'NASA' : 'Federal Register', url: `https://example.invalid/${id}`, kind: 'government' }],
      source_count: 1, tickers: tk ? [{ symbol: tk[1], name: tk[1], exchange: null }] : [],
      macro: s ? [{ series_id: s[1], label: s[1], value: '1', change: null, direction: null, as_of: '2026-10-01', source_name: s[2], source_short: s[2], source_url: 'https://example.invalid' }] : [],
      ai: { generated: false, label: null }, attribution: null, image: null, is_saved: false, share_path: `/b/${id}`, importance,
      dedupe_key: s ? `${s[1]}:${i}` : `n:${id}`,
    } as unknown as BlurbCard;
  });
}

/** Series supersede (20261122000200): only the newest reading of each data series is live. */
function liveOnly(cards: BlurbCard[]): BlurbCard[] {
  const last = new Map<string, string>();
  for (const c of cards) if (c.kind === 'data') last.set(c.macro[0].series_id, c.id);
  return cards.filter((c) => c.kind !== 'data' || last.get(c.macro[0].series_id) === c.id);
}

type Reader = { follows: { topics: string[]; tickers: string[]; sources: string[] }; reactions: Record<string, any>; seen: Set<string>; dwell: Map<string, number>; detail: Set<string> };
function replay(l: Ledger, byHead: Map<string, BlurbCard>): Reader {
  const r: Reader = { follows: { topics: [], tickers: [], sources: [] }, reactions: {}, seen: new Set(), dwell: new Map(), detail: new Set() };
  l.actions.forEach((a, i) => {
    const at = NOW - (l.actions.length - i) * 60_000;
    if (a.action === 'follow_topic') { const s = SLUG[a.headline]; if (s && !r.follows.topics.includes(s)) r.follows.topics.push(s); return; }
    if (a.action === 'follow_company') { const t = TICKER.find(([re]) => re.test(a.headline)); if (t && !r.follows.tickers.includes(t[1])) r.follows.tickers.push(t[1]); return; }
    const c = byHead.get(a.headline); if (!c) return;
    r.seen.add(c.id);
    if (a.action === 'like' || a.action === 'dislike') r.reactions[c.id] = { r: a.action, topic: c.category, source: null, at, ...reactionKeys(c) };
    if (a.action === 'unlike') delete r.reactions[c.id];
    if (a.action === 'share' && !r.reactions[c.id]) r.reactions[c.id] = { r: 'like', topic: c.category, source: null, at, ...reactionKeys(c) }; // F9: a share counts as a like
    if (a.action === 'open_detail' || a.action === 'open_source') r.detail.add(c.id);
    if (a.dwell_ms) r.dwell.set(c.id, Math.max(r.dwell.get(c.id) ?? 0, a.dwell_ms));
  });
  return r;
}

// ---------------------------------------------------------------- server mirror (v5 + M9b)
const SV = { h: 8, hlEconomy: 24, hlKey: 72, cap: 4, neg: 2, fh: 2, ftop: 6, fco: 24, tk: 4, tkcap: 8, auth: 6, seenView: 24, seenRead: 100, step: 0.75 };
const AUTH_SOURCES = /Bureau of Labor Statistics|Bureau of Economic Analysis|Federal Reserve|Treasury/;
function serverRank(pool: BlurbCard[], r: Reader, scale: number, m9b = true): BlurbCard[] {
  const s = new Map<string, number>(), n = new Map<string, number>(), tks = new Map<string, number>();
  const add = (cat: string, w: number) => { s.set(cat, (s.get(cat) ?? 0) + w); n.set(cat, (n.get(cat) ?? 0) + 1); };
  const byId = new Map(pool.map((c) => [c.id, c]));
  for (const [id, x] of Object.entries(r.reactions)) { const c = byId.get(id); if (!c) continue; add(c.category, x.r === 'like' ? 1 : -1); for (const t of tickerList(c)) tks.set(t, (tks.get(t) ?? 0) + (x.r === 'like' ? 1 : -1)); }
  for (const id of r.detail) { const c = byId.get(id); if (c) add(c.category, 0.5); }
  for (const [id, ms] of r.dwell) { const c = byId.get(id); if (c) add(c.category, ms >= 8000 ? 0.25 : ms <= 1500 ? -0.15 : 0); }
  const taste = (cat: string) => {
    const sum = s.get(cat) ?? 0, cnt = n.get(cat) ?? 0; if (!cnt) return 0;
    const conf = cnt / (cnt + 2), hrs = SV.cap * Math.tanh(sum / 2);
    return hrs >= 0 ? conf * hrs : Math.max(conf * hrs * SV.neg, -SV.cap);
  };
  const disliked = new Set(Object.entries(r.reactions).filter(([, x]) => x.r === 'dislike').map(([id]) => id));
  const scored = pool.filter((c) => !disliked.has(c.id)).map((c) => {
    const key = isKeySeries(c);
    const at = c.kind === 'data' && m9b ? Date.parse(c.published_at) : Date.parse(c.sort_at);
    const hl = m9b ? (key ? SV.hlKey : c.category === 'economy' ? SV.hlEconomy : SV.h) : SV.h;
    const age = Math.max(0, (NOW - at) / H);
    let v = at / H + 8 * Math.log2(c.importance ?? 1) - age * (SV.h / hl - 1);
    v += scale * ((r.follows.topics.includes(c.category) ? SV.fh : 0) + taste(c.category));
    if (m9b) {
      if (r.follows.topics.includes(c.category)) v += SV.ftop;
      const t = tickerList(c);
      if (t.some((x) => r.follows.tickers.includes(x))) v += SV.fco;
      v += Math.max(-SV.tkcap, Math.min(SV.tkcap, SV.tk * t.reduce((a, x) => a + (tks.get(x) ?? 0), 0)));
      if (key || (c.kind !== 'data' && c.sources.some((x) => AUTH_SOURCES.test(x.name)))) v += SV.auth;
    }
    if (r.seen.has(c.id)) v -= r.detail.has(c.id) || (r.dwell.get(c.id) ?? 0) >= 8000 ? SV.seenRead : SV.seenView;
    return { c, v };
  }).sort((a, b) => b.v - a.v || (a.c.id < b.c.id ? 1 : -1));
  const k = new Map<string, number>();
  const stepped = scored.map(({ c, v }) => { const i = k.get(c.category) ?? 0; k.set(c.category, i + 1); return { c, v: v - SV.step * i }; })
    .sort((a, b) => b.v - a.v || (a.c.id < b.c.id ? 1 : -1)).map((x) => x.c);
  return m9b ? companyCap(stepped, new Set(r.follows.tickers)) : stepped;
}
/** core.fy_post's caps: at most 2 cards of one series family in any 10, and 1 single-company card in any 3 of the first 9. */
function companyCap(cards: BlurbCard[], followed: Set<string>): BlurbCard[] {
  const isCo = (c: BlurbCard) => c.kind !== 'data' && !c.macro.length && (tickerList(c).length > 0 || ['earnings', 'deals'].includes(c.category)) && !tickerList(c).some((t) => followed.has(t));
  const left = [...cards], out: BlurbCard[] = [];
  while (left.length) {
    const famOk = (c: BlurbCard) => { const f = c.kind === 'data' ? cardFamily(c) : ''; return !f || out.slice(-9).filter((x) => x.kind === 'data' && cardFamily(x) === f).length < 2; };
    const coOk = (c: BlurbCard) => !(out.length < 9 && isCo(c)) || out.slice(-2).filter(isCo).length < 1;
    let i = left.findIndex((c) => famOk(c) && coOk(c));
    if (i < 0) i = left.findIndex(famOk);
    if (i < 0) i = 0;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}

// ---------------------------------------------------------------- metrics
const isMacro = (c: BlurbCard) => c.kind === 'data' || c.category === 'economy' || c.category === 'energy' || isAuthorityCard(c);
function tastes(l: Ledger, byHead: Map<string, BlurbCard>) {
  const net = new Map<string, number>();
  for (const a of l.actions) { const c = byHead.get(a.headline); if (!c) continue; if (a.action === 'like' || a.action === 'share') net.set(c.category, (net.get(c.category) ?? 0) + 1); if (a.action === 'dislike') net.set(c.category, (net.get(c.category) ?? 0) - 1); }
  for (const a of l.actions) if (a.action === 'follow_topic' && SLUG[a.headline]) net.set(SLUG[a.headline], (net.get(SLUG[a.headline]) ?? 0) + 2);
  return { liked: new Set([...net].filter(([, v]) => v > 0).map(([k]) => k)), hated: new Set([...net].filter(([, v]) => v < 0).map(([k]) => k)) };
}
function metrics(list: BlurbCard[], trending: BlurbCard[], t: { liked: Set<string>; hated: Set<string> }) {
  const top = list.slice(0, 10), top20 = list.slice(0, 20), tr = new Set(trending.slice(0, 20).map((c) => c.id));
  const ser = new Map<string, number>();
  for (const c of top20) { const id = c.macro?.[0]?.series_id; if (id) ser.set(id, (ser.get(id) ?? 0) + 1); }
  const inter = top20.filter((c) => tr.has(c.id)).length;
  return {
    liked: top.filter((c) => t.liked.has(c.category)).length / Math.max(top.length, 1),
    hated: top.filter((c) => t.hated.has(c.category)).length / Math.max(top.length, 1),
    macro: top.filter(isMacro).length / Math.max(top.length, 1),
    // repeats = cards beyond the first of one data series in the top 20; rates = Treasury-yield family cards in the top 10
    repeats: [...ser.values()].reduce((a, v) => a + Math.max(0, v - 1), 0),
    rates: top.filter((c) => cardFamily(c) === 'g:rates').length,
    jaccard: inter / (top20.length + tr.size - inter || 1),
  };
}
const MACRO_PERSONAS = new Set(['P02', 'P06', 'P09', 'P12', 'P13', 'P14', 'P16', 'P17', 'M1', 'M3']);

const dir = findLedgerDir();
const ledgers: Ledger[] = dir ? fs.readdirSync(dir).filter((f) => /^P\d+\.json$/.test(f)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : MINI;
const allReadings = buildCorpus(ledgers, MINI_EXTRA);
const corpus = liveOnly(allReadings);
const byHead = new Map(allReadings.map((c) => [c.headline, c]));
const cold = { follows: { topics: [], tickers: [], sources: [] }, reactions: {}, seen: new Set<string>(), dwell: new Map(), detail: new Set<string>() } as Reader;
// Trending as guests get it today: rank_score from sort_at + importance, no personal terms (no M9b terms: api.feed is unchanged)
const trendingOrder = serverRank(corpus, cold, 0, false);

const rows = ledgers.map((l) => {
  const r = replay(l, byHead), t = tastes(l, byHead);
  const prefs = { reactions: r.reactions, hiddenTopics: [], hiddenSources: [], follows: r.follows };
  const client = rankForYou(corpus, prefs, r.seen, trendingOrder[0].id, new Set(trendingOrder.slice(0, 10).map((c) => c.id)), NOW);
  // the reader-visible list: reacted cards sink (penalty) but stay; metrics use what is shown first
  const tr = metrics(trendingOrder, trendingOrder, t);
  return {
    p: l.persona, t, r, prefs,
    trending: tr,
    client: metrics(client, trendingOrder, t), clientList: client,
    before: metrics(serverRank(corpus, r, 3, false), trendingOrder, t),
    s3: metrics(serverRank(corpus, r, 3), trendingOrder, t),
    s6: metrics(serverRank(corpus, r, 6), trendingOrder, t),
  };
});
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const avg = (k: 'trending' | 'client' | 'before' | 's3' | 's6', m: keyof ReturnType<typeof metrics>, only?: Set<string>) =>
  Number(mean(rows.filter((x) => !only || only.has(x.p)).map((x) => x[k][m])).toFixed(3));

if (process.env.M9B_REPORT) {
  const f = (m: ReturnType<typeof metrics>) => `${m.liked.toFixed(2)}/${m.hated.toFixed(2)}/${m.macro.toFixed(2)}/${m.repeats}/${m.rates}/${m.jaccard.toFixed(2)}`;
  console.log(`ledgers: ${dir ? `${ledgers.length} from ${dir}` : 'built-in mini fixture'}, corpus ${corpus.length} cards`);
  console.log('persona | trending | client | server before | server s3 | server s6   (liked/hated/macro/repeats/rates/jaccard)');
  for (const x of rows) console.log(`${x.p} | ${f(x.trending)} | ${f(x.client)} | ${f(x.before)} | ${f(x.s3)} | ${f(x.s6)}`);
  for (const k of ['trending', 'client', 'before', 's3', 's6'] as const)
    console.log(`MEAN ${k}: liked ${avg(k, 'liked')} hated ${avg(k, 'hated')} macro ${avg(k, 'macro')} (macro personas ${avg(k, 'macro', MACRO_PERSONAS)}) repeats ${avg(k, 'repeats')} rates ${avg(k, 'rates')} jaccard ${avg(k, 'jaccard')}`);
}

// ---------------------------------------------------------------- assertions
test('ledger fixtures: client For you beats Trending on liked and hated topic share', () => {
  assert.ok(avg('client', 'liked') > avg('trending', 'liked'), `liked ${avg('client', 'liked')} vs trending ${avg('trending', 'liked')}`);
  assert.ok(avg('client', 'hated') < avg('trending', 'hated'), `hated ${avg('client', 'hated')} vs trending ${avg('trending', 'hated')}`);
});

test('ledger fixtures: macro share >= 0.5 for macro personas (client and server s3)', () => {
  for (const x of rows.filter((x) => MACRO_PERSONAS.has(x.p))) {
    assert.ok(x.client.macro >= 0.5, `${x.p} client macro ${x.client.macro}`);
    assert.ok(x.s3.macro >= 0.5, `${x.p} server macro ${x.s3.macro}`);
  }
});

test('ledger fixtures: at most 1 same-series repeat in the top 20, and at most 2 yield cards in the top 10', () => {
  for (const x of rows) {
    assert.ok(x.client.repeats <= 1 && x.s3.repeats <= 1, `${x.p} repeats client ${x.client.repeats} server ${x.s3.repeats}`);
    assert.ok(x.client.rates <= 2 && x.s3.rates <= 2, `${x.p} yield cards in top 10: client ${x.client.rates} server ${x.s3.rates}`);
  }
  // before supersede (every reading still live): the device family cap alone keeps one series from flooding
  for (const x of rows) {
    const all = rankForYou(allReadings, x.prefs, x.r.seen, null, new Set(), NOW);
    assert.ok(metrics(all, trendingOrder, x.t).rates <= 2, `${x.p} all readings: yield cards in top 10 ${metrics(all, trendingOrder, x.t).rates}`);
  }
});

test('ledger fixtures: warm For you is not Trending (Jaccard of the top 20 < 0.5)', { skip: corpus.length < 40 ? 'mini fixture: a top 20 is most of the corpus' : false }, () => {
  // the fixture corpus is small (about 55 live cards, so a top 20 is over a third of it): the mean must be < 0.5,
  // and no warm persona above 0.6
  const warm = rows.filter((x) => Object.keys(x.r.reactions).length >= 5 || x.r.follows.topics.length);
  assert.ok(mean(warm.map((x) => x.client.jaccard)) < 0.5, `mean client jaccard ${mean(warm.map((x) => x.client.jaccard))}`);
  assert.ok(mean(warm.map((x) => x.s3.jaccard)) < 0.5, `mean server jaccard ${mean(warm.map((x) => x.s3.jaccard))}`);
  for (const x of warm) assert.ok(x.client.jaccard < 0.6, `${x.p} client jaccard ${x.client.jaccard}`);
  assert.ok(avg('s3', 'jaccard') <= avg('before', 'jaccard') + 0.05, 'M9b terms must not make the server closer to Trending');
});

test('ledger fixtures: server M9b terms keep liked share up and hated share down vs before', () => {
  assert.ok(avg('s3', 'liked') >= avg('before', 'liked') - 0.02, `liked ${avg('s3', 'liked')} vs before ${avg('before', 'liked')}`);
  assert.ok(avg('s3', 'hated') <= avg('before', 'hated') + 0.02, `hated ${avg('s3', 'hated')} vs before ${avg('before', 'hated')}`);
  assert.ok(avg('s3', 'macro', MACRO_PERSONAS) >= avg('before', 'macro', MACRO_PERSONAS), 'macro share must not drop for macro personas');
});

test('scale 3 vs 6 (D-116): both rank; the comparison is reported, not asserted', () => {
  assert.ok(Number.isFinite(avg('s6', 'liked')) && Number.isFinite(avg('s3', 'liked')));
});

// ---------------------------------------------------------------- reason line and Latest dim (unit)
test('reason: each For you card gets a reason from the reader\'s own choices; text is a short plain phrase', () => {
  for (const x of rows) for (const c of x.clientList.slice(0, 10)) {
    const r = localReason(c, x.prefs);
    assert.ok(r.code);
    const s = reasonText(r);
    if (s) assert.ok(s.length <= 48 && !/[<>]/.test(s), s);
  }
  const msft = corpus.find((c) => tickerList(c).includes('MSFT'))!;
  assert.deepEqual(localReason(msft, { reactions: {}, follows: { topics: [], tickers: ['msft'] } }), { code: 'follow_company', arg: 'MSFT' });
  assert.equal(reasonText({ code: 'follow_topic', arg: 'economy' }), 'Because you follow Economy');
  assert.equal(reasonText({ code: 'top_story', arg: null }), null);
  assert.deepEqual(cardReason({ reason: { code: 'liked_company', arg: 'AAPL' } }), { code: 'liked_company', arg: 'AAPL' });
  assert.equal(cardReason({ reason: { code: 'something_else', arg: 'x' } }), null);
  assert.equal(cardReason({}), null);
});

test('Latest dims disliked cards and their twins, keeps the order', () => {
  const [a, b] = corpus;
  const twin = { ...b, id: 'twin', dedupe_key: (b as any).dedupe_key } as BlurbCard;
  const dim = latestDimmed([a, b, twin], { [b.id]: { r: 'dislike', topic: b.category, source: null, at: 1, ...reactionKeys(b) } });
  assert.deepEqual([...dim].sort(), [b.id, 'twin'].sort());
  assert.ok(latestDimmed([{ ...a, my_reaction: 'dislike' } as BlurbCard], {}).has(a.id));
});

test('release time: a data card counts from its release, a news card from its source time', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const data = { ...corpus.find((c) => c.kind === 'data')!, sort_at: '2026-10-01T00:00:00Z', published_at: '2026-11-10T10:00:00Z' } as BlurbCard;
  const news = { ...corpus.find((c) => c.kind !== 'data')!, category: 'markets', importance: 10, sort_at: '2026-11-04T10:00:00Z', as_of: '2026-11-04T10:00:00Z', published_at: '2026-11-10T10:00:00Z' } as BlurbCard;
  const fresh = { ...news, id: 'fresh', sort_at: '2026-11-10T09:00:00Z', as_of: '2026-11-10T09:00:00Z' } as BlurbCard;
  assert.ok(freshBase(fresh, now) > freshBase(news, now), 'a re-ingested 6-day-old story must not look fresh (A-15)');
  assert.ok(freshBase(data, now) > freshBase(news, now), 'a data card released today is fresh even though its period is October');
});
