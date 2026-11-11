// Search rules. Pure: no React imports, so node --test runs it (lib/__tests__/searchLogic.test.ts).
//
// The Search screen waits 300 ms after the last keystroke, only searches from 2
// characters (the database function enforces the same), remembers the last few
// searches on this device, and when the box is empty offers topics and companies
// to try.

import type { BlurbCard, Category } from '../../contract/types.ts';

export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 80; // api.search cuts the query here too
export const RECENT_MAX = 6;
export const RECENT_KEY = 'element.recent-searches';

// "Try a company" chips from the design. Element shows news about them, never prices.
export const SUGGESTED_TICKERS = ['AAPL', 'MSFT', 'BA'] as const;

// Trim, collapse runs of spaces and cap the length.
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX_CHARS).trim();
}

export function canSearch(raw: string): boolean {
  return normalizeQuery(raw).length >= SEARCH_MIN_CHARS;
}

// What the screen shows for the text in the box.
export type SearchTarget =
  | { kind: 'idle' } // empty box: recent searches and suggestions
  | { kind: 'short' } // 1 character: ask for one more
  | { kind: 'query'; q: string }
  | { kind: 'category'; slug: string; name: string }; // a "Browse by category" tile

export function searchTarget(raw: string, category: { slug: string; name: string } | null): SearchTarget {
  if (category) return { kind: 'category', slug: category.slug, name: category.name };
  const q = normalizeQuery(raw);
  if (q.length === 0) return { kind: 'idle' };
  if (q.length < SEARCH_MIN_CHARS) return { kind: 'short' };
  return { kind: 'query', q };
}

// One key per list of results: a change of key starts a new list and ignores late answers.
export function searchKey(t: SearchTarget): string | null {
  if (t.kind === 'query') return `search|${t.q.toLocaleLowerCase()}`;
  if (t.kind === 'category') return `browse|${t.slug}`;
  return null;
}

// ---- Recent searches ----

// Newest first, no duplicates (ignoring case), capped. Queries too short to search are ignored.
export function addRecent(list: string[], raw: string, max = RECENT_MAX): string[] {
  const q = normalizeQuery(raw);
  if (q.length < SEARCH_MIN_CHARS) return list;
  const lower = q.toLocaleLowerCase();
  return [q, ...list.filter((r) => r.toLocaleLowerCase() !== lower)].slice(0, max);
}

export function removeRecent(list: string[], q: string): string[] {
  return list.filter((r) => r !== q);
}

// Storage holds JSON text; anything unreadable counts as "no recent searches".
export function parseRecents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const x: unknown = JSON.parse(raw);
    if (!Array.isArray(x)) return [];
    const out: string[] = [];
    for (const v of x) {
      if (typeof v !== 'string') continue;
      const q = normalizeQuery(v);
      if (q.length >= SEARCH_MIN_CHARS && !out.some((o) => o.toLocaleLowerCase() === q.toLocaleLowerCase())) out.push(q);
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function serializeRecents(list: string[]): string {
  return JSON.stringify(list.slice(0, RECENT_MAX));
}

// ---- Matching and ranking (mock mode; mirrors api.search: matching from v4,
// 20261019030000_search_v4.sql, order key from v5, 20261114000000_search_v5.sql) ----
//
// Each query term contributes its best evidence score; weak metadata and ambiguous short synonyms
// cannot dominate. Order: visible match first, then relevance (visible matches count fully,
// detail-only matches x0.2) blended with a small capped ranking prior (Trending freshness and, when
// signed in, the reader's topic taste); see searchOrderKey below.

export const SEARCH_MAX_TERMS = 6; // settings.md: search_max_terms
export const SEARCH_TERM_BONUS = 1.3; // settings.md: search_term_bonus
export const SEARCH_TYPO_MIN_LEN = 5; // settings.md: search_typo_min_len
export const SEARCH_PREFIX_MIN_LEN = 3; // settings.md: search_prefix_min_len
// Detail-only evidence counts at 0.2 x its quality, below the weakest visible evidence (0.25),
// so a headline/summary/topic match always ranks above a detail-only one (c_detail_weight in SQL).
export const SEARCH_DETAIL_WEIGHT = 0.2; // settings.md: search_detail_weight (v4)
export const SEARCH_MIN_QUALITY = 0.5; // settings.md: search_min_quality
const TRENDING_HALF_LIFE_HOURS = 8; // rank_params.half_life_hours

// v9 (M9c #3): question filler is dropped too, so "is the economy ok" searches "economy".
const STOPWORDS = new Set(
  ('the a an and or of to in on for at by with is are was were be it its as from that this what how why who about into ' +
    'ok okay doing going now today my me do does should can will you your we our there any am ' +
    // v10 (M9c fix3): more question filler ("how much is gas", "how long until rates drop")
    'much many long get tell show mean means whats').split(' '),
);
// v9: words that only describe the thing searched ("gas prices", "savings account"): dropped when another word
// remains, so the card does not have to say "prices" or "account" (core.search_modifiers in SQL).
export const SEARCH_MODIFIERS = new Set(['price', 'prices', 'cost', 'costs', 'account', 'accounts']);

// Same groups as core.search_synonyms.
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['fed', 'federal reserve', 'fomc'],
  ['rate', 'rates', 'interest', 'savings', 'apy'],
  ['inflation', 'cpi', 'prices'],
  ['jobs', 'employment', 'unemployment', 'payrolls'],
  ['oil', 'crude', 'wti', 'gas', 'gasoline', 'diesel', 'fuel', 'petrol'],
  ['stocks', 'equities', 'markets'],
  ['quake', 'earthquake', 'tremor'],
  ['recall', 'recalls'],
  ['gdp', 'growth', 'economy'],
  ['deal', 'merger', 'acquisition'],
];

// Lowercase, punctuation to spaces, cap 80, words of 2+ letters, no stopwords, no repeats, at most 6.
export function searchTerms(raw: string): string[] {
  const norm = raw.slice(0, SEARCH_MAX_CHARS).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (norm.length < SEARCH_MIN_CHARS) return [];
  const out: string[] = [];
  for (const w of norm.split(' ')) {
    if (w.length >= 2 && !STOPWORDS.has(w) && !out.includes(w)) out.push(w);
    if (out.length === SEARCH_MAX_TERMS) break;
  }
  const core = out.filter((w) => !SEARCH_MODIFIERS.has(w));
  return core.length ? core : out;
}

// ---- v9: aliases and generic-query demotion (mirrors 20261137000200_search_v9.sql) ----
//
// An alias is a whole query (its words after stop words and modifiers) that names a topic. Cards whose headline
// matches the alias pattern, or that carry one of its macro series, get +SEARCH_ALIAS_TIER, so "CPI" opens with
// the CPI data card. Insider-trade (Form 4) and filing cards lose SEARCH_FILING_PENALTY when the query names no
// company: "gas prices" is not a question about a director's share sale.
export const SEARCH_ALIAS_TIER = 5; // core.search_aliases tier (c_alias_tier in SQL)
export const SEARCH_FILING_PENALTY = 5; // c_filing_penalty in SQL
const FED_RE = /\b(fed|federal reserve|fomc|rates?|treasury|yield|mortgage)\b/;
const OIL_RE = /\b(gas|gasoline|oil|crude|wti|diesel|fuel)\b/;
const HOUSING_RE = /\b(rents?|housing|shelter|mortgages?|home prices?|homes?|house prices?)\b/;
const HOUSING_SERIES = ['CUSR0000SEHA', 'HOUST', 'MORTGAGE30US', 'CSUSHPINSA'];
const JOBS_RE = /\b(jobs?|unemployment|payrolls?|employment|labor)\b/;
const INFL_RE = /\b(cpi|consumer prices?|consumer price index|inflation)\b/;
const ECON_RE = /\b(economy|economic|gdp|growth|inflation|jobs|unemployment|payrolls|recession|fed|federal reserve|interest rates?)\b/;
export const SEARCH_ALIASES: Record<string, { re: RegExp; series: string[] }> = {
  cpi: { re: INFL_RE, series: ['CPIAUCSL'] },
  economy: { re: ECON_RE, series: ['GDP', 'UNRATE', 'PAYEMS', 'CPIAUCSL'] },
  gdp: { re: /\b(gdp|economy|growth)\b/, series: ['GDP'] },
  jobs: { re: JOBS_RE, series: ['UNRATE', 'PAYEMS'] },
  unemployment: { re: JOBS_RE, series: ['UNRATE', 'PAYEMS'] },
  gas: { re: OIL_RE, series: ['DCOILWTICO', 'GASREGW'] },
  gasoline: { re: OIL_RE, series: ['DCOILWTICO', 'GASREGW'] },
  diesel: { re: OIL_RE, series: ['DCOILWTICO', 'GASREGW'] },
  fuel: { re: OIL_RE, series: ['DCOILWTICO', 'GASREGW'] },
  'diesel fuel': { re: OIL_RE, series: ['DCOILWTICO', 'GASREGW'] },
  oil: { re: OIL_RE, series: ['DCOILWTICO', 'GASREGW'] },
  savings: { re: FED_RE, series: ['DFF', 'DGS2', 'DGS10'] },
  'savings interest': { re: FED_RE, series: ['DFF', 'DGS2', 'DGS10'] },
  'savings rates': { re: FED_RE, series: ['DFF', 'DGS2', 'DGS10'] },
  apy: { re: FED_RE, series: ['DFF', 'DGS2', 'DGS10'] },
  rates: { re: FED_RE, series: ['DFF', 'DGS10'] },
  'interest rates': { re: FED_RE, series: ['DFF', 'DGS10'] },
  // v10: everyday cost-of-living words. "rent and gas costs" finds housing and energy cards.
  rent: { re: HOUSING_RE, series: HOUSING_SERIES },
  rents: { re: HOUSING_RE, series: HOUSING_SERIES },
  shelter: { re: HOUSING_RE, series: HOUSING_SERIES },
  mortgage: { re: HOUSING_RE, series: HOUSING_SERIES },
  mortgages: { re: HOUSING_RE, series: HOUSING_SERIES },
};

export function aliasFor(terms: string[]): { re: RegExp; series: string[] } | null {
  return SEARCH_ALIASES[terms.join(' ')] ?? null;
}

/** v10: a query made only of alias words ("rent and gas costs") matches a card that fits ANY of them. Null otherwise. */
export function termAliases(terms: string[]): Map<string, { re: RegExp; series: string[] }> | null {
  if (terms.length === 0 || aliasFor(terms) || !terms.every((t) => SEARCH_ALIASES[t])) return null;
  return new Map(terms.map((t) => [t, SEARCH_ALIASES[t]]));
}

export function matchesAlias(card: BlurbCard, alias: { re: RegExp; series: string[] }): boolean {
  return alias.re.test(clean([card.headline])) || card.macro.some((m) => alias.series.includes(m.series_id));
}

/** Form 4 insider trades and filing-sourced cards (8-K, 10-Q, ...): the kinds a general question should not lead with. */
export function isFilingLike(card: BlurbCard): boolean {
  return card.event_type === 'insider' || card.sources.some((x) => x.kind === 'filing');
}

/** True when a query word is a ticker or a word of a company name on some card: the query is about a company. */
export function namesCompany(cards: BlurbCard[], terms: string[]): boolean {
  return terms.some((t) => cards.some((c) => c.tickers.some((k) => k.symbol.toLocaleLowerCase() === t || clean([k.name]).split(' ').includes(t))));
}

// A rough English stem (the database uses Postgres's english stemmer).
export function stem(word: string): string {
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (word.endsWith(suf) && word.length - suf.length >= 3) return word.slice(0, -suf.length);
  }
  return word;
}

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Typo: same first letter, length within 2, edit distance <= 1 (<= 2 from 8 letters).
export function isTypo(term: string, word: string): boolean {
  if (term.length < SEARCH_TYPO_MIN_LEN || word === term || word[0] !== term[0]) return false;
  if (Math.abs(word.length - term.length) > 2) return false;
  return editDistance(term, word) <= (term.length >= 8 ? 2 : 1);
}

function alternatives(term: string): string[] {
  const group = SYNONYM_GROUPS.find((g) => g.some((w) => w === term || w === `${term}s` || `${w}s` === term));
  return group ? [term, ...group.filter((w) => w !== term)] : [term];
}

function wordMatches(alt: string, words: string[], allowPrefix: boolean): boolean {
  const s = stem(alt);
  return words.some((w) => w === alt || stem(w) === s || (allowPrefix && alt.length >= SEARCH_PREFIX_MIN_LEN && stem(w).startsWith(s)));
}

// Best evidence for one term in one text (no metadata): exact 1, stem/prefix 0.8, synonym 0.6, typo 0.5.
function textQuality(term: string, card: BlurbCard, content: string): number {
  const upper = term.toLocaleUpperCase();
  const words = content.split(' ');
  let best = card.tickers.some((t) => t.symbol === upper) || card.macro.some((m) => m.series_id === upper) ? 1 : 0;
  const fedQuery = ['fed', 'federal', 'federl'].includes(term);
  if (words.includes(term) && !fedQuery) best = Math.max(best, 1);
  if (term === 'fed' && words.includes('fed')) best = Math.max(best, 0.5);
  if ((term === 'federal' || term === 'fed') && content.includes('federal reserve')) best = Math.max(best, 1);
  for (const alt of alternatives(term)) {
    if (alt === term || (fedQuery && !['federal reserve', 'fomc'].includes(alt))) continue;
    if (alt.includes(' ') ? ` ${content} `.includes(` ${alt} `) : words.includes(alt)) best = Math.max(best, 0.6);
  }
  const s = stem(term);
  if (!fedQuery && words.some((w) => stem(w) === s || (term.length >= SEARCH_PREFIX_MIN_LEN && stem(w).startsWith(s)))) best = Math.max(best, 0.8);
  if (words.some((w) => isTypo(term, w) && (!fedQuery || content.includes('federal reserve')))) best = Math.max(best, 0.5);
  return best;
}

const clean = (parts: (string | undefined | null)[]) =>
  parts.filter(Boolean).join(' ').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// What the card shows without opening it: headline, summary, ticker chips and number chips.
function visibleText(card: BlurbCard): string {
  return clean([card.headline, card.body, ...card.tickers.map((t) => `${t.symbol} ${t.name}`), ...card.macro.map((m) => `${m.series_id} ${m.label}`)]);
}

// v4: `gate` is the v3 quality (best match anywhere, used for the 0.5 cutoff); `rank` counts a match
// found only in the in-depth detail at SEARCH_DETAIL_WEIGHT, so visible matches rank first.
export function termScores(term: string, card: BlurbCard): { gate: number; rank: number; visible: boolean } {
  const vis = visibleText(card);
  const all = clean([vis, card.detail?.paragraphs.join(' '), card.detail?.key_points.join(' ')]);
  const qVis = textQuality(term, card, vis);
  const qAll = textQuality(term, card, all);
  const meta = clean([card.category, card.event_type?.replace(/_/g, ' '), ...card.sources.map((x) => x.name)]).split(' ');
  const qMeta = meta.includes(term) ? 0.25 : 0;
  return { gate: Math.max(qAll, qMeta), rank: Math.max(qVis, SEARCH_DETAIL_WEIGHT * qAll, qMeta), visible: qVis > 0 || qMeta > 0 };
}

function termQuality(term: string, card: BlurbCard): number {
  return termScores(term, card).gate;
}

// Everything a search looks at, lowercased with punctuation removed.
export function searchText(card: BlurbCard): string {
  return [
    card.headline, card.body, card.detail?.paragraphs.join(' '), card.detail?.key_points.join(' '),
    card.category, card.event_type?.replace(/_/g, ' '),
    ...card.tickers.map((t) => `${t.symbol} ${t.name}`), ...card.sources.map((s) => s.name),
    ...card.macro.map((m) => `${m.series_id} ${m.label}`),
  ].filter(Boolean).join(' ').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// How many query words the card matches (0 = not a result).
export function matchedTermCount(card: BlurbCard, terms: string[]): number {
  return terms.filter((t) => termQuality(t, card) > 0).length;
}

export function matchQuality(card: BlurbCard, terms: string[]): number {
  return terms.reduce((sum, term) => sum + termQuality(term, card), 0);
}

// Trending score in hours (+8 h = twice as important), plus log2(1.3) half-lives per extra matched word.
export function searchScore(trendingHours: number, matched: number): number {
  return trendingHours + TRENDING_HALF_LIFE_HOURS * Math.log2(SEARCH_TERM_BONUS) * Math.max(0, matched - 1);
}

// ---- v5 order key (mirrors 20261114000000_search_v5.sql) ----
//
// key = 10 x visible + (1 - w) x relevance / words + w x prior, higher first, rounded to 9 places.
// The prior (0..1) can move a card by at most w, so a card more than w / (1 - w) (0.18) ahead on
// per-word relevance always ranks first, and a visible match always beats a detail-only one.
export const SEARCH_PRIOR_WEIGHT = 0.15; // settings.md: search_prior_weight (core.rank_params)
export const SEARCH_PRIOR_AFFINITY_SHARE = 0.5; // settings.md: search_prior_affinity_share
export const SEARCH_VISIBLE_TIER = 10;
const AFFINITY_CAP_HOURS = 4; // rank_params.affinity_cap_hours

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Trending key (hours) relative to now as 0..1: x / (1 + x), x = 2^((key - now) / half-life). */
export function rankPrior(trendHours: number, nowHours: number, halfLife: number = TRENDING_HALF_LIFE_HOURS): number {
  if (!Number.isFinite(trendHours) || !Number.isFinite(nowHours)) return 0;
  const x = 2 ** clamp((trendHours - nowHours) / Math.max(halfLife, 0.5), -40, 40);
  return x / (1 + x);
}

/** Reader taste in hours (core.taste_hours) as 0..1; 0.5 is neutral. */
export function affinityPrior(tasteHours: number, capHours: number = AFFINITY_CAP_HOURS): number {
  return (clamp((Number.isFinite(tasteHours) ? tasteHours : 0) / Math.max(capHours, 0.01), -1, 1) + 1) / 2;
}

export function searchOrderKey(
  o: { visible: boolean; relevance: number; terms: number; rankPart: number; affinity?: number | null; bonus?: number },
  weight: number = SEARCH_PRIOR_WEIGHT,
  affinityShare: number = SEARCH_PRIOR_AFFINITY_SHARE,
): number {
  const w = clamp(weight, 0, 0.5);
  const a = clamp(affinityShare, 0, 1);
  const rel = Math.min(Math.round(o.relevance * 10000) / 10000 / Math.max(o.terms, 1), 1);
  const prior = o.affinity === null || o.affinity === undefined ? o.rankPart : (1 - a) * o.rankPart + a * o.affinity;
  return Math.round(((o.visible ? SEARCH_VISIBLE_TIER : 0) + (o.bonus ?? 0) + (1 - w) * rel + w * prior) * 1e9) / 1e9;
}

export interface SearchRankOptions {
  nowHours?: number; // the frozen clock (SQL: the cursor's as-of time)
  tasteHours?: ((c: BlurbCard) => number) | null; // signed in: the reader's taste per card; null for guests
  weight?: number;
  affinityShare?: number;
}

// Matching cards in the v5 order; ties: importance, newest, id desc (same as SQL).
export function rankSearch(cards: BlurbCard[], raw: string, trendingHours: (c: BlurbCard) => number, opts: SearchRankOptions = {}): BlurbCard[] {
  const terms = searchTerms(raw);
  if (terms.length === 0) return [];
  const now = opts.nowHours ?? Date.now() / 3_600_000;
  const alias = aliasFor(terms);
  const termAl = termAliases(terms);
  const generic = alias !== null || termAl !== null || !namesCompany(cards, terms);
  return cards
    .map((c) => {
      const s = terms.map((t) => {
        const x = termScores(t, c);
        const ta = termAl?.get(t) ?? alias;
        // v10: a card that fits the word's alias (headline or macro series) counts as a visible synonym-level match
        if (ta && matchesAlias(c, ta)) return { gate: Math.max(x.gate, 0.6), rank: Math.max(x.rank, 0.6), visible: true };
        return x;
      });
      const anyHit = s.some((x) => x.gate > 0);
      return { c, q: s.reduce((a, x) => a + x.gate, 0), rq: s.reduce((a, x) => a + x.rank, 0), vis: s.some((x) => x.visible && x.gate > 0), all: termAl ? anyHit : s.every((x) => x.gate > 0) };
    })
    // v8/v9: every query word must match, not only enough of them ("Beige Book" is not "bookings")
    .filter((x) => x.q >= SEARCH_MIN_QUALITY && x.all)
    .map((x) => ({
      c: x.c,
      k: searchOrderKey(
        {
          visible: x.vis, relevance: x.rq, terms: terms.length, rankPart: rankPrior(trendingHours(x.c), now), affinity: opts.tasteHours ? affinityPrior(opts.tasteHours(x.c)) : null,
          bonus: ((alias && matchesAlias(x.c, alias)) || (termAl && [...termAl.values()].some((a) => matchesAlias(x.c, a))) ? SEARCH_ALIAS_TIER : 0) - (generic && isFilingLike(x.c) ? SEARCH_FILING_PENALTY : 0),
        },
        opts.weight,
        opts.affinityShare,
      ),
    }))
    .sort((a, b) => b.k - a.k || (b.c.importance ?? 1) - (a.c.importance ?? 1)
      || Date.parse(b.c.sort_at) - Date.parse(a.c.sort_at) || (a.c.id < b.c.id ? 1 : a.c.id > b.c.id ? -1 : 0))
    .map((x) => x.c);
}

// ---- Suggestions and wording ----

// "Browse by category": every topic the app has cards for, in the server's order.
export function suggestedTopics(categories: Category[], hidden: string[] = []): Category[] {
  return categories.filter((c) => !hidden.includes(c.slug));
}

export function resultCountText(count: number, done: boolean): string {
  if (count === 0) return 'No results';
  const n = `${count}${done ? '' : '+'}`;
  return `${n} ${count === 1 && done ? 'result' : 'results'}`;
}

export function emptyResultsMessage(t: SearchTarget): string {
  if (t.kind === 'category') return `No ${t.name} cards yet. Check back soon.`;
  if (t.kind === 'query') return `Nothing found for “${t.q}”. Try a company name, a ticker or a topic.`;
  return '';
}
