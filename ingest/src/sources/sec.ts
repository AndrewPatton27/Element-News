// SEC EDGAR: current 8-K Atom feed -> RawItem, plus the filing's primary document.
// Feed shape: one <entry> per filing; items are in <summary> as escaped HTML
// ("<br>Item 2.02: Results of Operations ..."). Also the data.sec.gov per-company submissions
// JSON, the watch list, item -> category rules, the routine-5.02 filter and the filing text.
// Inputs: feed/JSON/HTML text from SEC. Outputs: Sec8kEntry lists, RawItems or skip reasons,
// classifications and plain filing text. No network calls here.

import type { CategorySlug, EventType, Exchange } from '../../../contract/types.ts';
import { config } from '../config.ts';
import { attr, blocks, decodeEntities, htmlToText, tagText } from '../html.ts';
import type { RawItem, TickerRef } from '../types.ts';
import { AI_CATEGORY_SLUGS } from '../validate.ts';

export interface Sec8kEntry {
  form: string;                      // "8-K" or "8-K/A"
  company_raw: string;               // "COSTCO WHOLESALE CORP /NEW"
  cik: string;                       // "0000909832"
  url: string;                       // filing index page
  filed: string | null;              // "2026-10-16"
  accession: string;
  updated: string;                   // ISO (acceptance time)
  items: { number: string; title: string }[];
  summary_text: string;              // plain text of <summary>
}

/** Parses the current 8-K Atom feed into entries (company, CIK, index URL, items, accession). Non-8-K titles are dropped. */
export function parseSec8kAtom(xml: string): Sec8kEntry[] {
  const out: Sec8kEntry[] = [];
  for (const e of blocks(xml, 'entry')) {
    const title = tagText(e, 'title') ?? '';
    const m = /^(8-K(?:\/A)?)\s+-\s+(.+?)\s+\((\d{10})\)\s+\(Filer\)\s*$/.exec(title);
    if (!m) continue;
    const url = attr(e, 'link', 'href', (t) => /rel="alternate"/.test(t)) ?? '';
    const summaryHtml = tagText(e, 'summary') ?? '';          // entities decoded once -> real HTML
    const summary_text = decodeEntities(summaryHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();
    const items = [...summary_text.matchAll(/Item (\d\.\d\d):\s*([^\n]+)/g)].map((x) => ({ number: x[1], title: x[2].trim() }));
    const idText = tagText(e, 'id') ?? '';
    out.push({
      form: attr(e, 'category', 'term') ?? m[1],
      company_raw: m[2],
      cik: m[3],
      url,
      filed: /Filed:\s*(\d{4}-\d{2}-\d{2})/.exec(summary_text)?.[1] ?? null,
      accession: /accession-number=([\d-]+)/.exec(idText)?.[1] ?? /AccNo:\s*([\d-]+)/.exec(summary_text)?.[1] ?? '',
      updated: new Date(tagText(e, 'updated') ?? '').toISOString(),
      items,
      summary_text,
    });
  }
  return out;
}

// ---- company names and tickers ------------------------------------------------

const KEEP_UPPER = new Set(['LLC', 'LP', 'LLP', 'PLC', 'NV', 'SA', 'AG', 'SE', 'II', 'III', 'IV', 'USA', 'US', 'REIT', 'ETF', 'AT&T', 'IBM']);

/** "COSTCO WHOLESALE CORP /NEW" -> "Costco Wholesale Corp". Mixed-case names are kept. */
export function displayCompanyName(raw: string): string {
  const name = raw.replace(/\s+\/[A-Z]{2,5}\/?\s*$/g, '').replace(/\s+\/[A-Z]{2,5}\/?\s*$/g, '').trim();
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export type TickerMap = Map<string, TickerRef>;   // key: 10-digit CIK

const EXCHANGES: Record<string, Exchange> = { nasdaq: 'Nasdaq', nyse: 'NYSE', 'nyse american': 'NYSE American', cboe: 'Cboe' };

/**
 * Parses SEC's company_tickers_exchange.json ({fields:[cik,name,ticker,exchange], data:[...]}).
 * Keeps only listed exchanges (NYSE, Nasdaq, NYSE American, Cboe); first ticker per CIK wins.
 */
export function parseTickerExchangeJson(json: string): TickerMap {
  const doc = JSON.parse(json) as { fields: string[]; data: unknown[][] };
  const f = (n: string) => doc.fields.indexOf(n);
  const [ci, ni, ti, ei] = [f('cik'), f('name'), f('ticker'), f('exchange')];
  const map: TickerMap = new Map();
  for (const row of doc.data) {
    const exch = EXCHANGES[String(row[ei] ?? '').toLowerCase()];
    if (!exch) continue;
    const cik = String(row[ci]).padStart(10, '0');
    if (!map.has(cik)) map.set(cik, { symbol: String(row[ti]), name: displayCompanyName(String(row[ni])), exchange: exch });
  }
  return map;
}

// ---- items -> category / event --------------------------------------------------
// Category and event_type of an SEC card come from the 8-K item numbers, in code, so the
// same kind of filing always lands in the same place. The AI's choice is only a tiebreak
// for filings whose items do not decide it (see resolveSecClassification).

/** Most newsworthy item first. The first item in this list that a filing has decides its class. */
export const ITEM_PRIORITY = ['1.03', '2.02', '4.02', '4.01', '1.05', '2.01', '5.02', '1.01', '2.03', '2.04', '1.02', '3.01', '2.05', '2.06', '7.01', '8.01'];

/**
 * Items that decide category and event_type on their own. Event types stay inside the set
 * core.rank_event_weights knows (earnings, deal, exec_change, ...); null = the 'default' weight.
 * Items not listed here (2.06, 7.01, 8.01) do not decide: the AI's choice is the tiebreak.
 */
export const ITEM_CLASS: Record<string, { category: CategorySlug; event_type: EventType | null }> = {
  '1.03': { category: 'markets', event_type: null },          // bankruptcy or receivership
  '2.02': { category: 'earnings', event_type: 'earnings' },   // results of operations
  '4.02': { category: 'earnings', event_type: 'earnings' },   // non-reliance (restatement)
  '4.01': { category: 'earnings', event_type: 'earnings' },   // auditor change
  '1.05': { category: 'tech', event_type: null },             // cybersecurity incident (no own event weight)
  '2.01': { category: 'deals', event_type: 'deal' },          // acquisition or sale completed
  '5.02': { category: 'markets', event_type: 'exec_change' }, // officer or director change
  '1.01': { category: 'deals', event_type: 'deal' },          // material agreement
  '2.03': { category: 'deals', event_type: 'deal' },          // direct financial obligation or major commitment
  '2.04': { category: 'markets', event_type: null },          // acceleration or increase of a direct obligation
  '1.02': { category: 'deals', event_type: 'deal' },          // agreement ended
  '3.01': { category: 'markets', event_type: null },          // delisting / listing-rule notice
  '2.05': { category: 'markets', event_type: null },          // layoffs / restructuring costs ('default' weight)
};

/** Used when no item decides and the AI gave nothing usable. */
const UNDECIDED = { category: 'markets' as CategorySlug, event_type: null };

/** The most newsworthy item number in `items` (by ITEM_PRIORITY), or null if none is tracked there. */
export function primaryItem(items: { number: string }[]): string | null {
  const nums = new Set(items.map((i) => i.number));
  return ITEM_PRIORITY.find((n) => nums.has(n)) ?? null;
}

export interface SecClass {
  category: CategorySlug;
  event_type: EventType | null;
  decided_by: string | null;         // the item number that decided, or null (AI tiebreak)
}

/** Category and event_type from the 8-K item numbers alone. */
export function classifySecItems(items: { number: string }[]): SecClass {
  const nums = new Set(items.map((i) => i.number));
  const decider = ITEM_PRIORITY.find((n) => nums.has(n) && ITEM_CLASS[n]);
  return decider ? { ...ITEM_CLASS[decider], decided_by: decider } : { ...UNDECIDED, decided_by: null };
}

/**
 * Final category and event_type for an SEC card. The items decide when they can; otherwise
 * the AI's category is used if it is one of the 9 contract slugs, and its event_type only if
 * it is one of config.secAiEventTypes. Anything else falls back to markets / null.
 */
export function resolveSecClassification(
  items: { number: string }[],
  draft: { category: string; event_type: string | null },
): SecClass {
  const c = classifySecItems(items);
  if (c.decided_by) return c;
  const category = (AI_CATEGORY_SLUGS as readonly string[]).includes(draft.category) ? (draft.category as CategorySlug) : UNDECIDED.category;
  const event_type = draft.event_type && (config.secAiEventTypes as readonly string[]).includes(draft.event_type)
    ? (draft.event_type as EventType) : null;
  return { category, event_type, decided_by: null };
}

export type SecSkipReason = 'amendment' | 'not_listed' | 'low_value' | 'no_tracked_item' | 'not_watched' | 'not_watch_item';

/**
 * Low-value check: a filing whose tracked items are all in config.sec8kLowValueItems
 * (Reg FD, other events, exhibits) and that has no substantive item. Untracked items
 * (for example 5.07 shareholder votes) do not count as substantive.
 */
export function isLowValueFiling(items: { number: string }[]): boolean {
  const low = config.sec8kLowValueItems as readonly string[];
  const tracked = config.sec8kItems as readonly string[];
  const substantive = items.some((i) => tracked.includes(i.number) && !low.includes(i.number));
  return !substantive && items.some((i) => low.includes(i.number));
}

/**
 * Feed entry -> RawItem, or the reason it is not a card candidate: amendment, not listed on
 * a major exchange (when a ticker map is given), low value (only 7.01/8.01/9.01), or no
 * tracked item. Runs before any page fetch or AI call.
 */
export function classifySecEntry(
  e: Sec8kEntry,
  tickers: TickerMap | null,
  opts: { watch?: WatchMap } = {},
): { item: RawItem } | { skip: SecSkipReason } {
  // Watch list first (cheapest): only household-name companies become cards.
  if (opts.watch && !opts.watch.has(e.cik)) return { skip: 'not_watched' };
  if (e.form !== '8-K') return { skip: 'amendment' };
  const t = opts.watch?.get(e.cik) ?? tickers?.get(e.cik) ?? null;
  if (tickers && !t) return { skip: 'not_listed' };
  if (isLowValueFiling(e.items)) return { skip: 'low_value' };
  if (opts.watch && !hasWatchItem(e.items)) return { skip: 'not_watch_item' };
  const tracked = e.items.filter((i) => (config.sec8kItems as readonly string[]).includes(i.number));
  if (!primaryItem(tracked)) return { skip: 'no_tracked_item' };
  const cls = classifySecItems(e.items);
  const company = t?.name ?? displayCompanyName(e.company_raw);
  const sorted = [...e.items].sort((a, b) => {
    const pa = ITEM_PRIORITY.indexOf(a.number), pb = ITEM_PRIORITY.indexOf(b.number);
    return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
  });
  return {
    item: {
      source: 'sec_8k',
      external_id: e.accession,
      url: e.url,
      title: `${company} 8-K`,
      published_at: e.updated,
      license_class: 'company_filing',
      category: cls.category,
      event_type: cls.event_type,
      tickers: t ? [t] : [],
      source_name: 'SEC',
      source_kind: 'filing',
      doc_label: 'Form 8-K',
      company,
      items: sorted,
      summary_text: `${company} Form 8-K. ${e.summary_text}`,
    },
  };
}

/** Feed entry -> RawItem, or null if it is not a card candidate (see classifySecEntry). */
export function secEntryToItem(e: Sec8kEntry, tickers: TickerMap | null): RawItem | null {
  const r = classifySecEntry(e, tickers);
  return 'item' in r ? r.item : null;
}

// ---- watch list (household-name companies) ------------------------------------------

export type WatchMap = Map<string, TickerRef>;   // key: 10-digit CIK; symbol = the watch-list ticker

/**
 * Resolves watch-list tickers to CIKs from SEC's company_tickers_exchange.json. Looks up every
 * row (not only the first ticker per CIK), so a company whose first row is another share class
 * still resolves. Tickers not in the list are returned in `missing` (logged by the caller, never a crash).
 */
export function resolveWatchList(json: string, watch: readonly string[] = config.watchCompanies): { map: WatchMap; missing: string[] } {
  const doc = JSON.parse(json) as { fields: string[]; data: unknown[][] };
  const f = (n: string) => doc.fields.indexOf(n);
  const [ci, ni, ti, ei] = [f('cik'), f('name'), f('ticker'), f('exchange')];
  const byTicker = new Map<string, unknown[]>();
  for (const row of doc.data) {
    const sym = String(row[ti] ?? '').toUpperCase();
    if (sym && !byTicker.has(sym)) byTicker.set(sym, row);
  }
  const map: WatchMap = new Map();
  const missing: string[] = [];
  for (const sym of watch) {
    const row = byTicker.get(sym.toUpperCase());
    if (!row) { missing.push(sym); continue; }
    const cik = String(row[ci]).padStart(10, '0');
    if (!map.has(cik)) {
      map.set(cik, { symbol: sym.toUpperCase(), name: displayCompanyName(String(row[ni])), exchange: EXCHANGES[String(row[ei] ?? '').toLowerCase()] ?? null });
    }
  }
  return { map, missing };
}

/** true if the filing has at least one item that may become a card for a watch-list company. */
function hasWatchItem(items: { number: string }[]): boolean {
  const w = config.watchItems as readonly string[];
  return items.some((i) => w.includes(i.number));
}

/** Official 8-K item titles by number (the submissions JSON only lists the numbers). */
export const ITEM_TITLE_BY_NUMBER: Record<string, string> = {
  '1.01': 'Entry into a Material Definitive Agreement',
  '1.02': 'Termination of a Material Definitive Agreement',
  '1.03': 'Bankruptcy or Receivership',
  '1.05': 'Material Cybersecurity Incidents',
  '2.01': 'Completion of Acquisition or Disposition of Assets',
  '2.02': 'Results of Operations and Financial Condition',
  '2.03': 'Creation of a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement of a Registrant',
  '2.05': 'Costs Associated with Exit or Disposal Activities',
  '2.06': 'Material Impairments',
  '3.01': 'Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing',
  '4.01': "Changes in Registrant's Certifying Accountant",
  '4.02': 'Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review',
  '5.02': 'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers',
  '5.07': 'Submission of Matters to a Vote of Security Holders',
  '7.01': 'Regulation FD Disclosure',
  '8.01': 'Other Events',
  '9.01': 'Financial Statements and Exhibits',
};

/**
 * data.sec.gov submissions JSON -> 8-K entries filed within `lookbackDays` of `now`, in the same
 * shape as the Atom feed entries (so both paths share classifySecEntry). The index URL matches the
 * Atom feed's link, so the same filing from both paths dedupes on accession and URL.
 */
export function parseSubmissionsJson(text: string, now: Date, lookbackDays: number = config.secLookbackDays): Sec8kEntry[] {
  const j = JSON.parse(text) as {
    cik?: string | number; name?: string;
    filings?: { recent?: Record<string, unknown[]> };
  };
  const r = j.filings?.recent;
  if (!r || !Array.isArray(r.form)) throw new Error('submissions: no filings.recent list');
  const cik = String(j.cik ?? '').padStart(10, '0');
  const cikInt = String(Number(cik));
  const oldest = now.getTime() - lookbackDays * 86_400_000;
  const out: Sec8kEntry[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = String(r.form[i]);
    if (form !== '8-K' && form !== '8-K/A') continue;
    const filed = String(r.filingDate?.[i] ?? '');
    const accepted = String(r.acceptanceDateTime?.[i] ?? '');
    const t = Date.parse(accepted || `${filed}T00:00:00Z`);
    if (!Number.isFinite(t) || t < oldest || t > now.getTime() + 86_400_000) continue;
    const accession = String(r.accessionNumber?.[i] ?? '');
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const items = String(r.items?.[i] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      .map((number) => ({ number, title: ITEM_TITLE_BY_NUMBER[number] ?? `Item ${number}` }));
    out.push({
      form,
      company_raw: String(j.name ?? ''),
      cik,
      url: `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accession.replace(/-/g, '')}/${accession}-index.htm`,
      filed: filed || null,
      accession,
      updated: new Date(t).toISOString(),
      items,
      summary_text: [`Filed: ${filed} AccNo: ${accession}`, ...items.map((x) => `Item ${x.number}: ${x.title}`)].join('\n'),
    });
  }
  return out;
}

/** Merges feed and per-company entries: unique by accession, first seen wins (the Atom feed goes first). */
export function mergeSecEntries(lists: Sec8kEntry[][]): Sec8kEntry[] {
  const seen = new Map<string, Sec8kEntry>();
  for (const list of lists) for (const e of list) {
    const k = e.accession || e.url;
    if (!seen.has(k)) seen.set(k, e);
  }
  return [...seen.values()];
}

/** The Item 5.02 section of the filing text (up to the next "Item n.nn"), or null if not found. */
function item502Section(text: string): string | null {
  const m = /Item\s*5\.02\b[\s\S]*?(?=Item\s*\d\.\d\d\b|$)/i.exec(text);
  if (!m) return null;
  // The section usually starts with the long official item title; drop it so its words do not count.
  return m[0].replace(/Departure of Directors or Certain Officers[^.]*?Certain Officers\.?/i, ' ');
}

/**
 * A filing whose only card item is 5.02 is "routine" (skip it) unless one sentence of its Item 5.02
 * text names a top role (CEO, CFO, chair, president; not vice president) together with a change word
 * (resigns, retires, appointed, steps down, successor, ...). Director-only changes and pay plans
 * ("named executive officers", bonus criteria) are routine. Filings with any other card item are never routine.
 */
export function isRoutine502(items: { number: string }[], text: string): boolean {
  const w = config.watchItems as readonly string[];
  const cardItems = new Set(items.map((i) => i.number).filter((n) => w.includes(n)));
  if (!(cardItems.size === 1 && cardItems.has('5.02'))) return false;
  // Every "Item 5.02" section in the text (the feed summary lists the title, the filing has the body).
  const sections: string[] = [];
  const re = /Item\s*5\.02\b/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const sec = item502Section(text.slice(m.index));
    if (sec) sections.push(sec);
  }
  const body = (sections.length ? sections.join(' ') : text).replace(/named executive officers?/gi, ' ')
    .replace(/\b(?:chair\w*|member) of (?:the |its )?[\w ,&-]{0,40}?committee/gi, ' ');   // committee roles are routine
  const sentences = body.split(/(?<=[.;!?])\s+/);
  return !sentences.some((x) => config.topRolePattern.test(x) && config.roleChangePattern.test(x));
}

// ---- filing index page -> primary document ------------------------------------------

/**
 * Finds the primary 8-K document on a filing index page. Prefers the row whose
 * Type column is "8-K"; falls back to the first .htm document that is not the index.
 * Inline XBRL viewer links (/ix?doc=/Archives/...) are unwrapped.
 */
export function findPrimaryDocUrl(indexHtml: string, indexUrl: string): string | null {
  const rows = blocks(indexHtml, 'tr');
  const docHref = (row: string) => {
    const m = /href="([^"]+\.htm[l]?)"/i.exec(row);
    if (!m) return null;
    const href = m[1].replace(/^\/ix\?doc=/, '');
    if (/-index\.htm/i.test(href)) return null;
    return new URL(href, indexUrl).toString();
  };
  for (const r of rows) {
    if (/<td[^>]*>\s*8-K\s*<\/td>/i.test(r)) {
      const u = docHref(r);
      if (u) return u;
    }
  }
  for (const r of rows) {
    const u = docHref(r);
    if (u && /\/Archives\//.test(u)) return u;
  }
  return null;
}

/** Primary document HTML -> plain text, capped for the AI. */
export function filingText(html: string): string {
  return htmlToText(html, config.sourceTextMaxChars);
}

/**
 * Finds the earnings press-release exhibit (EX-99.1, then EX-99.01, then EX-99; config.secExhibit.types)
 * on a filing index page: the row whose Type column is that exhibit type and whose document is an
 * .htm/.html page. Only a www.sec.gov /Archives/ URL is accepted. Returns null if there is none.
 * Other exhibits (EX-99.2 slides, EX-10 contracts, XBRL files) are never picked.
 */
export function findExhibitUrl(indexHtml: string, indexUrl: string, types: readonly string[] = config.secExhibit.types): string | null {
  const rows = blocks(indexHtml, 'tr');
  const typeOf = (row: string) => /<td[^>]*>\s*(EX-[0-9A-Z.]+)\s*<\/td>/i.exec(row)?.[1]?.toUpperCase() ?? null;
  for (const want of types) {
    for (const r of rows) {
      if (typeOf(r) !== want.toUpperCase()) continue;
      const m = /href="([^"]+\.htm[l]?)"/i.exec(r);
      if (!m) continue;
      let u: URL;
      try { u = new URL(m[1].replace(/^\/ix\?doc=/, ''), indexUrl); } catch { continue; }
      if (u.protocol === 'https:' && u.hostname === 'www.sec.gov' && u.pathname.startsWith('/Archives/')) return u.toString();
    }
  }
  return null;
}
