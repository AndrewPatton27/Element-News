// Company rules for the app. Pure: no React imports (lib/__tests__/companyLogic.test.ts).
//
// The server (migration 20261115000000_companies.sql) tags cards with companies and answers
// api.search_companies, api.company_cards, api.companies_directory and api.card_companies. These
// helpers read those answers defensively, group companies by sector for the Companies screen and
// build the "About: Apple" chips. News only: no prices anywhere (rule 9).

import type { BlurbCard } from '../../contract/types.ts';
import { COMPANY_SECTORS, sectorLabel } from '../../contract/companies.ts';
import { companyQueryScore, normalizeCompanyText } from '../../contract/companyMatch.ts';
import { isBlurbCard } from '../shared/types.ts';

export type CompanyMatchKind = 'ticker' | 'name' | 'prefix' | 'typo';

export interface CompanySummary {
  ticker: string;
  name: string;
  short_name: string;
  exchange: string | null;
  sector: string;
  industry: string;
  card_count: number;      // published cards in the last `days` days
  days: number;
  last_card_at?: string | null;
  score?: number;          // search only
  match?: CompanyMatchKind; // search only
}

export interface CompanyPage {
  company: CompanySummary | null; // null = no such company
  items: BlurbCard[];
  next_cursor: string | null;
}

export interface CardCompany {
  ticker: string;
  short_name: string;
  name: string;
  confidence: number;
}

/** Same shape rule as core.companies.ticker. */
const TICKER_RE = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;

/** Route or query text -> a directory ticker ("brk.b" -> "BRK-B"), or null. */
export function normalizeCompanyTicker(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^\$/, '').toUpperCase().replace('.', '-');
  return TICKER_RE.test(t) ? t : null;
}

const str = (x: unknown, max = 120): string | null => (typeof x === 'string' && x.trim() !== '' ? x.trim().slice(0, max) : null);
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
const MATCHES: CompanyMatchKind[] = ['ticker', 'name', 'prefix', 'typo'];

export function parseCompanySummary(x: unknown): CompanySummary | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  const ticker = normalizeCompanyTicker(r.ticker);
  const name = str(r.name, 80);
  if (!ticker || !name) return null;
  const out: CompanySummary = {
    ticker,
    name,
    short_name: str(r.short_name, 40) ?? name,
    exchange: str(r.exchange, 20),
    sector: str(r.sector, 30) ?? 'other',
    industry: str(r.industry, 60) ?? '',
    card_count: Math.trunc(num(r.card_count)),
    days: Math.trunc(num(r.days)) || 30,
  };
  if (typeof r.last_card_at === 'string') out.last_card_at = r.last_card_at;
  if (typeof r.score === 'number') out.score = r.score;
  if (typeof r.match === 'string' && (MATCHES as string[]).includes(r.match)) out.match = r.match as CompanyMatchKind;
  return out;
}

/** A list of companies; bad rows are dropped, duplicates keep the first. */
export function parseCompanyList(x: unknown): CompanySummary[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>();
  const out: CompanySummary[] = [];
  for (const row of x) {
    const c = parseCompanySummary(row);
    if (c && !seen.has(c.ticker)) { seen.add(c.ticker); out.push(c); }
  }
  return out;
}

export function parseCompanyPage(x: unknown): CompanyPage {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { company: null, items: [], next_cursor: null };
  const r = x as Record<string, unknown>;
  return {
    company: parseCompanySummary(r.company),
    items: Array.isArray(r.items) ? r.items.filter(isBlurbCard) : [],
    next_cursor: typeof r.next_cursor === 'string' && r.next_cursor !== '' ? r.next_cursor : null,
  };
}

/** api.card_companies -> card id -> companies (strongest first). */
export function parseCardCompanies(x: unknown): Record<string, CardCompany[]> {
  const out: Record<string, CardCompany[]> = {};
  if (!Array.isArray(x)) return out;
  for (const row of x) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== 'string' || !Array.isArray(r.companies)) continue;
    const list: CardCompany[] = [];
    for (const c of r.companies) {
      const cc = c as Record<string, unknown> | null;
      const ticker = normalizeCompanyTicker(cc?.ticker);
      const name = str(cc?.name, 80);
      if (!ticker || !name) continue;
      list.push({ ticker, name, short_name: str(cc?.short_name, 40) ?? name, confidence: num(cc?.confidence) });
    }
    out[r.id] = list;
  }
  return out;
}

// ---- wording ---------------------------------------------------------------------------------

/** "12 cards in 30 days", "1 card in 30 days", "No cards in the last 30 days" (says what the window is, not that there is no news). */
export function cardCountText(c: Pick<CompanySummary, 'card_count' | 'days'>): string {
  const days = `${c.days} day${c.days === 1 ? '' : 's'}`;
  if (c.card_count <= 0) return `No cards in the last ${days}`;
  return `${c.card_count} card${c.card_count === 1 ? '' : 's'} in ${days}`;
}

/** The search row: "Apple Inc. · AAPL · 12 cards". */
export function companyResultLine(c: CompanySummary): string {
  return [c.name, c.ticker, c.card_count > 0 ? `${c.card_count} card${c.card_count === 1 ? '' : 's'}` : 'No recent cards'].join(' · ');
}

/** "Technology · Consumer electronics". */
export function companyCategoryLine(c: Pick<CompanySummary, 'sector' | 'industry'>): string {
  return [sectorLabel(c.sector), c.industry].filter(Boolean).join(' · ');
}

export function companyHref(ticker: string): `/company/${string}` {
  return `/company/${encodeURIComponent(ticker)}`;
}

// ---- Companies screen ------------------------------------------------------------------------

export interface CompanySection {
  key: string;        // 'following' or the sector slug
  label: string;
  companies: CompanySummary[];
}

const byCountThenName = (a: CompanySummary, b: CompanySummary) =>
  b.card_count - a.card_count || a.short_name.localeCompare(b.short_name, 'en') || (a.ticker < b.ticker ? -1 : 1);

/**
 * Followed companies first (in follow order), then one section per sector in COMPANY_SECTORS order
 * (unknown sectors last), most recent cards first. `onlyWithCards` leaves out companies with no recent
 * cards (followed ones always stay). Empty sections are left out.
 */
export function groupCompanies(list: CompanySummary[], followed: readonly string[], opts: { onlyWithCards?: boolean; query?: string } = {}): CompanySection[] {
  const q = (opts.query ?? '').trim();
  const matches = q ? list.filter((c) => companyFilterScore(q, c) > 0) : list;
  const followSet = new Set(followed.map((t) => t.toUpperCase()));
  const follow = followed
    .map((t) => matches.find((c) => c.ticker === t.toUpperCase()))
    .filter((c): c is CompanySummary => !!c);
  const rest = matches.filter((c) => !followSet.has(c.ticker) && (!opts.onlyWithCards || c.card_count > 0));
  const sections: CompanySection[] = [];
  if (follow.length) sections.push({ key: 'following', label: 'Companies you follow', companies: follow });
  const order = COMPANY_SECTORS.map((s) => s.slug as string);
  const sectors = [...new Set(rest.map((c) => c.sector))].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1);
  });
  for (const s of sectors) sections.push({ key: s, label: sectorLabel(s), companies: rest.filter((c) => c.sector === s).sort(byCountThenName) });
  return sections;
}

/** Local filter on the Companies screen: same scoring as search (ticker, name, prefix, typo), plus "contains". */
export function companyFilterScore(q: string, c: Pick<CompanySummary, 'ticker' | 'name' | 'short_name' | 'industry'>): number {
  const s = companyQueryScore(q, { ticker: c.ticker, name: c.name, short: c.short_name });
  if (s > 0) return s;
  const n = normalizeCompanyText(q);
  return n.length >= 2 && normalizeCompanyText(`${c.name} ${c.short_name} ${c.industry}`).includes(n) ? 0.5 : 0;
}

// ---- "About: Apple" chips --------------------------------------------------------------------

export interface AboutChip {
  ticker: string;
  label: string;          // "About: Apple"
  a11y: string;           // "About Apple. Opens the Apple page."
}

export const MAX_ABOUT_CHIPS = 2;

/**
 * Chips for a card: the server's company tags when known, else the card's own tickers (SEC cards), so
 * a chip shows at once and only its wording sharpens when the tags arrive. At most MAX_ABOUT_CHIPS, distinct.
 */
export function aboutChips(card: Pick<BlurbCard, 'tickers'>, tags: CardCompany[] | undefined): AboutChip[] {
  const fromTags = (tags ?? []).map((t) => ({ ticker: t.ticker, name: t.short_name || t.name }));
  const fromCard = (Array.isArray(card.tickers) ? card.tickers : [])
    .filter((t) => t && typeof t.symbol === 'string' && t.symbol !== '')
    .map((t) => ({ ticker: normalizeCompanyTicker(t.symbol) ?? t.symbol.toUpperCase(), name: typeof t.name === 'string' && t.name ? t.name : t.symbol }));
  const seen = new Set<string>();
  const out: AboutChip[] = [];
  for (const x of tags && tags.length ? fromTags : fromCard) {
    if (seen.has(x.ticker)) continue;
    seen.add(x.ticker);
    out.push({ ticker: x.ticker, label: `About: ${x.name}`, a11y: `About ${x.name}, ticker ${x.ticker}. Opens the ${x.name} page.` });
    if (out.length >= MAX_ABOUT_CHIPS) break;
  }
  return out;
}

// ---- search row merge (for the Search screen owner) ------------------------------------------

/**
 * Companies worth a row above the search results: exact ticker or name matches always, prefix
 * and typo matches only when nothing exact matched. At most `max`.
 */
export function companyRowsFor(results: CompanySummary[], max = 2): CompanySummary[] {
  const exact = results.filter((c) => c.match === 'ticker' || c.match === 'name');
  return (exact.length ? exact : results).slice(0, max);
}

/**
 * Puts a company's own cards first in a search result list (exact company match ranks above text
 * match), keeping both lists' order and dropping repeats.
 */
export function companyCardsFirst(companyCards: BlurbCard[], searchCards: BlurbCard[]): BlurbCard[] {
  const seen = new Set<string>();
  const out: BlurbCard[] = [];
  for (const c of [...companyCards, ...searchCards]) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
  return out;
}
