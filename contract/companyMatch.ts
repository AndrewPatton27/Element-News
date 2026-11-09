// Which companies a card is about. Pure and deterministic: the same text always gives the same
// tags. This is the TypeScript twin of core.match_companies in
// supabase/migrations/20261115000000_companies.sql (the database runs it in a trigger when a card is
// published or revised; the app's sample mode and the ingest tests run this one). Change both together:
// ingest/test/companies.test.ts and supabase/tests/companies_check.sql hold the same cases.
//
// Evidence, strongest first (one method per company, the first that applies):
//   filing       1.00  the card's own tickers (from SEC metadata, resolved by CIK) and an SEC filing source
//   card_ticker  0.95  the card's own tickers (validated against the source text at ingest)
//   ticker_text  0.90  "$AAPL" or "(Nasdaq: AAPL)" in the text
//   bare_ticker  0.85  a bare ALL-CAPS ticker for tickers that are not words (AAPL yes, COST no)
//   alias        0.80  an unambiguous name ("Microsoft", "Apple Inc"), exact case, whole words
//   context_cue  0.75  an ambiguous name ("Apple") plus one of the company's cue words ("iPhone")
//   context_biz  0.60  an ambiguous name plus a business word (shares, earnings, CEO, ...)
// A company's negative phrase ("apple pie", "Harrison Ford") vetoes its name matches (not tickers).
// An ambiguous name right after a capitalised word mid-sentence ("actor Harrison Ford") does not count.
// Kept: confidence >= minConfidence (0.60), at most maxPerCard (3), strongest first, then ticker.

import { COMPANIES, tickerInText, type CompanyEntry } from './companies.ts';

export type TagMethod = 'filing' | 'card_ticker' | 'ticker_text' | 'bare_ticker' | 'alias' | 'context_cue' | 'context_biz';

export const TAG_CONFIDENCE: Record<TagMethod, number> = {
  filing: 1, card_ticker: 0.95, ticker_text: 0.9, bare_ticker: 0.85, alias: 0.8, context_cue: 0.75, context_biz: 0.6,
};

/** Defaults; the database reads the same values from core.company_params. */
export const TAG_DEFAULTS = { minConfidence: 0.6, maxPerCard: 3 };

/** Business words that let an ambiguous name count (case-insensitive, whole words). */
export const BUSINESS_WORDS = [
  'shares', 'stock', 'stocks', 'investors', 'earnings', 'revenue', 'profit', 'profits', 'quarter', 'quarterly', 'sales',
  'CEO', 'chief executive', 'company', 'retailer', 'automaker', 'airline', 'customers', 'layoffs', 'deal', 'acquisition',
  'merger', 'lawsuit', 'antitrust', 'regulators', 'recall', 'recalls', 'recalled', 'billion', 'million', 'Inc', 'Corp',
  'analysts', 'Wall Street', 'outlook', 'forecast', 'subscribers',
];

const L = '(^|[^A-Za-z0-9])';
const R = '($|[^A-Za-z0-9])';

/** Escapes regex metacharacters the same way the SQL helper core.company_re_escape does. */
export function reEscape(s: string): string {
  return s.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');
}

/** Longest first, so both regex engines prefer the longer name. Empty list -> null. */
function alternation(list: readonly string[] | undefined): string | null {
  const xs = [...new Set((list ?? []).map((s) => s.trim()).filter(Boolean))].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return xs.length ? `(${xs.map(reEscape).join('|')})` : null;
}

export interface CompiledCompany {
  ticker: string;
  tickerRe: RegExp;
  bareRe: RegExp | null;
  strongRe: RegExp | null;
  contextRe: RegExp | null;
  stripRe: RegExp | null;
  cueRe: RegExp | null;
  negativeRe: RegExp | null;
}

/** Regex sources for one entry (the SQL trigger on core.companies builds the same strings). */
export function companyPatterns(e: CompanyEntry) {
  const alt = (xs?: readonly string[]) => alternation(xs);
  const tick = reEscape(e.ticker);
  const strong = alt(e.aliases), context = alt(e.context), cues = alt(e.cues), negatives = alt(e.negatives);
  return {
    ticker: `(\\$|(NYSE American|NYSE|NASDAQ|Nasdaq|Cboe): ?)${tick}${R}`,
    bare: tickerInText(e) ? `(^|[^A-Za-z0-9$])${tick}${R}` : null,
    strong: strong ? `${L}${strong}${R}` : null,
    context: context ? `${L}${context}${R}` : null,
    strip: context ? `([A-Za-z0-9,;)] )[A-Z][a-z]+ ${context}${R}` : null,
    cue: cues ? `${L}${cues}${R}` : null,
    negative: negatives ? `${L}${negatives}${R}` : null,
  };
}

export function compileCompanies(entries: readonly CompanyEntry[] = COMPANIES): CompiledCompany[] {
  return entries.map((e) => {
    const p = companyPatterns(e);
    return {
      ticker: e.ticker,
      tickerRe: new RegExp(p.ticker),
      bareRe: p.bare ? new RegExp(p.bare) : null,
      strongRe: p.strong ? new RegExp(p.strong) : null,
      contextRe: p.context ? new RegExp(p.context) : null,
      stripRe: p.strip ? new RegExp(p.strip, 'g') : null,
      cueRe: p.cue ? new RegExp(p.cue) : null,
      negativeRe: p.negative ? new RegExp(p.negative, 'i') : null,
    };
  });
}

const BIZ_RE = new RegExp(`${L}${alternation(BUSINESS_WORDS)}${R}`, 'i');

export interface TagInput {
  headline: string;
  body?: string | null;
  tickers?: readonly { symbol: string }[];
  filing?: boolean;     // the card's primary source is an SEC filing
}

export interface CompanyTag {
  ticker: string;
  method: TagMethod;
  confidence: number;
}

/** Curly apostrophes -> straight, as in the SQL (translate). */
export function tagText(input: Pick<TagInput, 'headline' | 'body'>): string {
  return `${input.headline ?? ''} ${input.body ?? ''}`.replace(/[’‘]/g, "'");
}

/** The one method that applies to company `c` for this text, or null. */
function methodFor(c: CompiledCompany, text: string, tickers: Set<string>, filing: boolean, biz: boolean): TagMethod | null {
  if (tickers.has(c.ticker)) return filing ? 'filing' : 'card_ticker';
  if (c.tickerRe.test(text)) return 'ticker_text';
  if (c.bareRe && c.bareRe.test(text)) return 'bare_ticker';
  if (c.negativeRe && c.negativeRe.test(text)) return null;
  if (c.strongRe && c.strongRe.test(text)) return 'alias';
  if (c.contextRe && c.stripRe) {
    const stripped = text.replace(c.stripRe, '$1 ');
    if (c.contextRe.test(stripped)) {
      if (c.cueRe && c.cueRe.test(text)) return 'context_cue';
      if (biz) return 'context_biz';
    }
  }
  return null;
}

let defaultCompiled: CompiledCompany[] | null = null;

/** Companies a card is about, strongest first. */
export function matchCompanies(
  input: TagInput,
  compiled: CompiledCompany[] = (defaultCompiled ??= compileCompanies()),
  opts: { minConfidence?: number; maxPerCard?: number } = {},
): CompanyTag[] {
  const min = opts.minConfidence ?? TAG_DEFAULTS.minConfidence;
  const max = opts.maxPerCard ?? TAG_DEFAULTS.maxPerCard;
  const text = tagText(input);
  const tickers = new Set((input.tickers ?? []).map((t) => String(t.symbol ?? '').toUpperCase()));
  const biz = BIZ_RE.test(text);
  const out: CompanyTag[] = [];
  for (const c of compiled) {
    const method = methodFor(c, text, tickers, !!input.filing, biz);
    if (method && TAG_CONFIDENCE[method] >= min) out.push({ ticker: c.ticker, method, confidence: TAG_CONFIDENCE[method] });
  }
  return out.sort((a, b) => b.confidence - a.confidence || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0)).slice(0, max);
}

// ---- search helpers (same rules as core.company_norm / core.trigrams) -------------------------

/** Lower case, curly apostrophes and every non-letter/digit run -> one space, trimmed. */
export function normalizeCompanyText(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[’‘']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** pg_trgm-style trigrams of each word ("  w", " wo", ..., "rd "), distinct, sorted. */
export function trigrams(s: string): string[] {
  const out = new Set<string>();
  for (const w of normalizeCompanyText(s).split(' ')) {
    if (!w) continue;
    const padded = `  ${w} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return [...out].sort();
}

/** |A n B| / |A u B| of the two trigram sets (0 when either is empty). */
export function trigramSimilarity(a: string, b: string): number {
  const x = new Set(trigrams(a)), y = new Set(trigrams(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

/** The words a company can be searched by: ticker, names and aliases, normalized and distinct. */
export function searchTerms(e: Pick<CompanyEntry, 'ticker' | 'name' | 'short' | 'aliases' | 'context'>): string[] {
  const all = [e.ticker, e.name, e.short, ...(e.aliases ?? []), ...(e.context ?? [])].map(normalizeCompanyText).filter(Boolean);
  return [...new Set(all)].sort();
}

export const SEARCH_SCORES = { ticker: 1, exact: 0.95, prefix: 0.8, fuzzyBase: 0.4, fuzzySpan: 0.35, fuzzyMin: 0.35 };

/**
 * How well query `q` names company `e`, 0..1 (0 = not a match): exact ticker 1, exact name or alias 0.95,
 * a name starting with the query (2+ characters) 0.8, else a typo match 0.4 + 0.35 x trigram similarity
 * (4+ characters, similarity >= 0.35). Same as api.search_companies.
 */
export function companyQueryScore(q: string, e: Pick<CompanyEntry, 'ticker' | 'name' | 'short' | 'aliases' | 'context'>): number {
  const raw = String(q ?? '').trim().replace(/^\$/, '');
  const norm = normalizeCompanyText(raw);
  if (!norm) return 0;
  const up = raw.toUpperCase();
  if (e.ticker === up || e.ticker.replace('-', '.') === up) return SEARCH_SCORES.ticker;
  const terms = searchTerms(e);
  if (terms.includes(norm)) return SEARCH_SCORES.exact;
  if (norm.length >= 2 && terms.some((t) => t.startsWith(norm))) return SEARCH_SCORES.prefix;
  if (norm.length >= 4) {
    const best = Math.max(0, ...terms.map((t) => trigramSimilarity(norm, t)));
    if (best >= SEARCH_SCORES.fuzzyMin) return Math.round((SEARCH_SCORES.fuzzyBase + SEARCH_SCORES.fuzzySpan * best) * 1000) / 1000;
  }
  return 0;
}
