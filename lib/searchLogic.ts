// Search rules. Pure: no React imports, so node --test runs it (lib/__tests__/searchLogic.test.ts).
//
// The Search screen waits 300 ms after the last keystroke, only searches from 2
// characters (the database function enforces the same), remembers the last few
// searches on this device, and when the box is empty offers topics and companies
// to try.

import type { BlurbCard, Category } from '../contract/types.ts';

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

// ---- Matching and ranking (mock mode; mirrors api.search v3, 20261018050000_search_v3.sql) ----
//
// Each query term contributes its best evidence score; weak metadata and ambiguous short synonyms
// cannot dominate. Search order keeps the Trending score and existing multi-term bonus.

export const SEARCH_MAX_TERMS = 6; // settings.md: search_max_terms
export const SEARCH_TERM_BONUS = 1.3; // settings.md: search_term_bonus
export const SEARCH_TYPO_MIN_LEN = 5; // settings.md: search_typo_min_len
export const SEARCH_PREFIX_MIN_LEN = 3; // settings.md: search_prefix_min_len
const TRENDING_HALF_LIFE_HOURS = 8; // rank_params.half_life_hours

const STOPWORDS = new Set(
  'the a an and or of to in on for at by with is are was were be it its as from that this what how why who about into'.split(' '),
);

// Same groups as core.search_synonyms.
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['fed', 'federal reserve', 'fomc'],
  ['rate', 'rates', 'interest'],
  ['inflation', 'cpi', 'prices'],
  ['jobs', 'employment', 'unemployment', 'payrolls'],
  ['oil', 'crude', 'wti'],
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
  return out;
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

function termQuality(term: string, card: BlurbCard): number {
  const upper = term.toLocaleUpperCase();
  const content = [card.headline, card.body, card.detail?.paragraphs.join(' '), card.detail?.key_points.join(' '), ...card.tickers.map((t) => `${t.symbol} ${t.name}`), ...card.macro.map((m) => `${m.series_id} ${m.label}`)].filter(Boolean).join(' ').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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
  const meta = [card.category, card.event_type?.replace(/_/g, ' '), ...card.sources.map((x) => x.name)].filter(Boolean).join(' ').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ');
  if (meta.includes(term)) best = Math.max(best, 0.25);
  return best;
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

// Matching cards in Trending order; ties: importance, newest, id desc.
export function rankSearch(cards: BlurbCard[], raw: string, trendingHours: (c: BlurbCard) => number): BlurbCard[] {
  const terms = searchTerms(raw);
  if (terms.length === 0) return [];
  return cards
    .map((c) => ({ c, n: matchedTermCount(c, terms), q: matchQuality(c, terms) }))
    .filter((x) => x.q >= 0.5)
    .map((x) => ({ c: x.c, k: trendingHours(x.c) * (0.5 + x.q / terms.length)
      + TRENDING_HALF_LIFE_HOURS * Math.log2(SEARCH_TERM_BONUS) * Math.max(0, x.n - 1) }))
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
