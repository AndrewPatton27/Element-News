// Company data for the app: one interface, a Supabase version (the api.* RPCs of migration
// 20261115000000_companies.sql) and a sample version over the fixture cards (same rules, same shapes).
// No React imports, so node --test runs both.

import type { BlurbCard } from '../../contract/types.ts';
import { compileCompanies, companyQueryScore, matchCompanies, type CompiledCompany } from '../../contract/companyMatch.ts';
import type { CompanyEntry } from '../../contract/companies.ts';
import { parseCardCompanies, parseCompanyList, parseCompanyPage, normalizeCompanyTicker, type CardCompany, type CompanyPage, type CompanySummary } from './companyLogic.ts';

export interface CompanyApi {
  /** Companies a query names, best first (exact ticker, then name, prefix, typo). [] when unavailable. */
  search(q: string, limit?: number): Promise<CompanySummary[]>;
  /** One company's cards, newest first. Throws on a server error (the screen shows retry). */
  cards(ticker: string, cursor?: string | null, limit?: number): Promise<CompanyPage>;
  /** Every company with its recent card count. [] when unavailable. */
  directory(): Promise<CompanySummary[]>;
  /** Company tags of up to 50 cards, by card id. {} when unavailable. */
  tags(cardIds: string[]): Promise<Record<string, CardCompany[]>>;
}

/** Same caps as core.company_params (context/settings.md). */
export const COMPANY_LIMITS = { searchMax: 10, cardsPageMax: 30, batchIds: 50, recentDays: 30 };

const clamp = (v: number | undefined, fallback: number, max: number) => Math.max(1, Math.min(max, Number.isFinite(v) ? Math.trunc(v as number) : fallback));

/** `rpc(name, body)` posts to /rest/v1/rpc/<name> and returns the JSON (throws ApiError on HTTP errors). */
export function createSupabaseCompanyApi(rpc: (name: string, body: Record<string, unknown>) => Promise<unknown>): CompanyApi {
  const safe = async <T>(p: Promise<unknown>, parse: (x: unknown) => T, empty: T): Promise<T> => {
    try { return parse(await p); } catch { return empty; }
  };
  return {
    search: (q, limit) => {
      const query = String(q ?? '').trim().slice(0, 80);
      if (!query) return Promise.resolve([]);
      return safe(rpc('search_companies', { p_q: query, p_limit: clamp(limit, 5, COMPANY_LIMITS.searchMax) }), parseCompanyList, []);
    },
    async cards(ticker, cursor, limit) {
      const t = normalizeCompanyTicker(ticker);
      if (!t) return { company: null, items: [], next_cursor: null };
      return parseCompanyPage(await rpc('company_cards', { p_ticker: t, p_cursor: cursor ?? null, p_limit: clamp(limit, 20, COMPANY_LIMITS.cardsPageMax) }));
    },
    directory: () => safe(rpc('companies_directory', {}), parseCompanyList, []),
    tags: (ids) => {
      const list = [...new Set(ids.filter((x) => typeof x === 'string' && x !== ''))].slice(0, COMPANY_LIMITS.batchIds);
      if (!list.length) return Promise.resolve({});
      return safe(rpc('card_companies', { p_ids: list }), parseCardCompanies, {});
    },
  };
}

// ---- sample mode -------------------------------------------------------------------------------

/**
 * Sample directory: the fictional companies on the fixture cards ([SAMPLE] data). Each has its ticker
 * and full name as aliases; "Northwind" and "Contoso" are ambiguous on purpose (Northwind Island is a
 * place, so it must not tag Northwind Corp), to show the same false-positive guard as the real one.
 */
export const SAMPLE_COMPANIES: CompanyEntry[] = [
  { ticker: 'NWND', name: 'Northwind Corp', short: 'Northwind', sector: 'retail', industry: 'Stores', aliases: ['Northwind Corp'], context: ['Northwind'], cues: ['retailer'], negatives: ['Northwind Island'] },
  { ticker: 'LTWR', name: 'Litware Software', short: 'Litware', sector: 'tech', industry: 'Software', aliases: ['Litware'] },
  { ticker: 'ADTB', name: 'Adatum Bank', short: 'Adatum', sector: 'finance', industry: 'Banks', aliases: ['Adatum Bank', 'Adatum'] },
  { ticker: 'WGFN', name: 'Woodgrove Financial', short: 'Woodgrove', sector: 'finance', industry: 'Banks', aliases: ['Woodgrove Financial', 'Woodgrove'] },
  { ticker: 'FBRK', name: 'Fabrikam Robotics', short: 'Fabrikam', sector: 'industrials', industry: 'Robotics', aliases: ['Fabrikam'] },
  { ticker: 'TSPA', name: 'Tailspin Air', short: 'Tailspin Air', sector: 'travel', industry: 'Airlines', aliases: ['Tailspin Air'] },
  { ticker: 'FCOF', name: 'Fourth Coffee', short: 'Fourth Coffee', sector: 'restaurants', industry: 'Coffee shops', aliases: ['Fourth Coffee'] },
  { ticker: 'ALSH', name: 'Alpine Ski House', short: 'Alpine Ski House', sector: 'travel', industry: 'Resorts', aliases: ['Alpine Ski House'] },
  { ticker: 'CTSE', name: 'Contoso Energy', short: 'Contoso', sector: 'energy', industry: 'Power', aliases: ['Contoso Energy'], context: ['Contoso'], cues: ['solar', 'energy'] },
  { ticker: 'RELC', name: 'Relecloud Energy', short: 'Relecloud', sector: 'energy', industry: 'Power', aliases: ['Relecloud'] },
  { ticker: 'TREY', name: 'Trey Research', short: 'Trey Research', sector: 'tech', industry: 'Research', aliases: ['Trey Research'] },
  { ticker: 'WTFD', name: 'Wingtip Foods', short: 'Wingtip Foods', sector: 'consumer', industry: 'Packaged food', aliases: ['Wingtip Foods'] },
  { ticker: 'BYAL', name: 'Blue Yonder Airlines', short: 'Blue Yonder', sector: 'travel', industry: 'Airlines', aliases: ['Blue Yonder Airlines'] },
  { ticker: 'COHO', name: 'Coho Vineyard', short: 'Coho Vineyard', sector: 'consumer', industry: 'Wine', aliases: ['Coho Vineyard'] },
  { ticker: 'LUCP', name: 'Lucerne Publishing', short: 'Lucerne', sector: 'media', industry: 'Publishing', aliases: ['Lucerne Publishing'] },
  { ticker: 'VANA', name: 'VanArsdel', short: 'VanArsdel', sector: 'retail', industry: 'Stores', aliases: ['VanArsdel'] },
  { ticker: 'MGTV', name: "Margie's Travel", short: "Margie's Travel", sector: 'travel', industry: 'Online travel', aliases: ["Margie's Travel"] },
  { ticker: 'HMGI', name: 'Humongous Insurance', short: 'Humongous', sector: 'finance', industry: 'Insurance', aliases: ['Humongous Insurance'] },
  { ticker: 'PRSW', name: 'Proseware', short: 'Proseware', sector: 'tech', industry: 'Software', aliases: ['Proseware'] },
];

const RECENT_MS = COMPANY_LIMITS.recentDays * 86_400_000;

/** Tags every sample card once with the same matcher the server mirrors. */
export function tagSampleCards(cards: BlurbCard[], compiled: CompiledCompany[] = compileCompanies(SAMPLE_COMPANIES)): Map<string, CardCompany[]> {
  const byTicker = new Map(SAMPLE_COMPANIES.map((c) => [c.ticker, c]));
  const out = new Map<string, CardCompany[]>();
  for (const card of cards) {
    const filing = card.sources.some((s) => s.is_primary && s.kind === 'filing');
    const tags = matchCompanies({ headline: card.headline, body: card.body, tickers: card.tickers, filing }, compiled);
    out.set(card.id, tags.map((t) => {
      const c = byTicker.get(t.ticker)!;
      return { ticker: t.ticker, short_name: c.short, name: c.name, confidence: t.confidence };
    }));
  }
  return out;
}

export function createMockCompanyApi(cards: BlurbCard[], now: () => number = Date.now): CompanyApi & { tagsNow(ids: string[]): Record<string, CardCompany[]> } {
  const tags = tagSampleCards(cards);
  const visible = cards.filter((c) => c.kind !== 'link_out');
  const cardsOf = (ticker: string) =>
    visible.filter((c) => (tags.get(c.id) ?? []).some((t) => t.ticker === ticker))
      .sort((a, b) => Date.parse(b.sort_at) - Date.parse(a.sort_at) || (a.id < b.id ? 1 : -1));
  const summary = (e: CompanyEntry): CompanySummary => {
    const recent = cardsOf(e.ticker).filter((c) => Date.parse(c.sort_at) >= now() - RECENT_MS);
    return {
      ticker: e.ticker, name: e.name, short_name: e.short, exchange: null, sector: e.sector, industry: e.industry,
      card_count: recent.length, days: COMPANY_LIMITS.recentDays, last_card_at: recent[0]?.sort_at ?? null,
    };
  };
  const tagsNow = (ids: string[]) => {
    const out: Record<string, CardCompany[]> = {};
    for (const id of ids.slice(0, COMPANY_LIMITS.batchIds)) { const t = tags.get(id); if (t && t.length) out[id] = t; }
    return out;
  };
  return {
    tagsNow,
    async search(q, limit) {
      const lim = clamp(limit, 5, COMPANY_LIMITS.searchMax);
      return SAMPLE_COMPANIES
        .map((e) => ({ e, score: companyQueryScore(q, e) }))
        .filter((x) => x.score > 0)
        .map(({ e, score }) => ({ ...summary(e), score, match: (score === 1 ? 'ticker' : score === 0.95 ? 'name' : score === 0.8 ? 'prefix' : 'typo') as CompanySummary['match'] }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.card_count - a.card_count || (a.ticker < b.ticker ? -1 : 1))
        .slice(0, lim);
    },
    async cards(ticker, cursor, limit) {
      const t = normalizeCompanyTicker(ticker);
      const e = SAMPLE_COMPANIES.find((c) => c.ticker === t);
      if (!e) return { company: null, items: [], next_cursor: null };
      const list = cardsOf(e.ticker);
      const start = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
      const lim = clamp(limit, 20, COMPANY_LIMITS.cardsPageMax);
      const items = list.slice(start, start + lim);
      return { company: summary(e), items, next_cursor: start + items.length < list.length ? String(start + items.length) : null };
    },
    async directory() {
      return SAMPLE_COMPANIES.map(summary);
    },
    async tags(ids) {
      return tagsNow(ids);
    },
  };
}
