// CPSC recalls (saferproducts.gov JSON API, no key) -> RawItem, category safety / recall.
// The AI sees only Title + Description + Hazards + Remedies from the JSON; no page is downloaded
// and Images are never read (rule 9). License: PARTLY verified (US government work, 17 U.S.C. 105;
// the CPSC policy page could not be read on 2026-10-17). Public-domain copy limit (25 words).
// Inputs: the Recall JSON list. Outputs: selected recalls and RawItems (safety / recall) or skip reasons.

import { config } from '../config.ts';
import type { RawItem } from '../types.ts';

export interface CpscRecall {
  RecallID?: number;
  RecallNumber?: string;
  RecallDate?: string;               // "2026-10-15T00:00:00"
  Title?: string;
  Description?: string;
  URL?: string;
  Hazards?: { Name?: string }[];
  Remedies?: { Name?: string }[];
  Products?: { Name?: string; NumberOfUnits?: string }[];
  Injuries?: { Name?: string }[];
  Manufacturers?: { Name?: string }[];
  Importers?: { Name?: string }[];
  Distributors?: { Name?: string }[];
  Retailers?: { Name?: string }[];
}

/** Deterministic "material" verdict for a recall (see config.cpsc.materialMinUnits and the notes there). */
export interface RecallMaterial {
  material: boolean;
  /** Stable codes, logged and stored (core.card_material.reasons): units_<n>, value_usd_<n>, deaths, serious_injuries, stop_sale, watch_company_<T>; 'minor' when none. */
  reasons: string[];
  /** Watch-list tickers of the recalling firm (same key as core.companies.ticker). */
  tickers: string[];
  units: number;
  value_usd: number;
}

/** Units in one NumberOfUnits text: the first number ("About 42,860 (In addition, about 340 ...)" -> 42860; "1.2 million" -> 1200000). */
export function parseUnits(text: string | undefined): number {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(million|thousand)?/i.exec(text ?? '');
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  const mult = /million/i.test(m[2] ?? '') ? 1_000_000 : /thousand/i.test(m[2] ?? '') ? 1_000 : 1;
  return Math.round(n * mult);
}

/** Highest dollar price in the retailer text ("for between $44 and $56" -> 56), 0 when none. */
export function maxPrice(text: string): number {
  let best = 0;
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/** Injuries text without its "No injuries have been reported." style sentences. */
function reportedHarm(text: string): string {
  return text.split(/(?<=[.;])\s+/).filter((s) => !/^\s*(no|none)\b/i.test(s) && !/\bno (injuries|deaths|incidents)\b/i.test(s)).join(' ');
}

const DEATH = /\b(deaths?|died|fatal(?:ity|ities)?|killed)\b/i;
const SERIOUS = /\b(serious(?:ly)? injur\w*|hospitali[sz]\w*|fractur\w*|amputat\w*|concussions?|head injur\w*|(?:second|third)[- ]degree burns?|emergency room|surgery)\b/i;
const STOP_SALE = /\bstop[- ]sale\b|\bstop(?:ped)? selling\b/i;

/** The recalling firm's text: title before " Recall", manufacturers, importers, distributors (not retailers). */
function firmText(r: CpscRecall): string {
  const title = (r.Title ?? '').split(/\s+Recall/i)[0] ?? '';
  return [title, ...[...(r.Manufacturers ?? []), ...(r.Importers ?? []), ...(r.Distributors ?? [])].map((x) => x.Name ?? '')].join(' | ');
}

/** Material recall (shown in the feeds) or not (Recalls & Safety topic, company page and search only). Pure. */
export function classifyRecall(r: CpscRecall, c = config.cpsc): RecallMaterial {
  const units = (r.Products ?? []).reduce((n, p) => n + parseUnits(p.NumberOfUnits), 0);
  const price = maxPrice((r.Retailers ?? []).map((x) => x.Name ?? '').join(' '));
  const value = Math.round(units * price);
  const harm = reportedHarm((r.Injuries ?? []).map((x) => x.Name ?? '').join(' '));
  const firm = firmText(r);
  const tickers = [...new Set(c.watchNames.filter(([pat]) => new RegExp(`\\b(?:${pat})\\b`, 'i').test(firm)).map(([, t]) => t))].slice(0, 5);
  const reasons: string[] = [];
  if (units >= c.materialMinUnits) reasons.push(`units_${units}`);
  if (value >= c.materialMinValueUsd) reasons.push(`value_usd_${value}`);
  if (DEATH.test(harm)) reasons.push('deaths');
  if (SERIOUS.test(harm)) reasons.push('serious_injuries');
  if (STOP_SALE.test([r.Title, r.Description, ...(r.Remedies ?? []).map((x) => x.Name)].join(' '))) reasons.push('stop_sale');
  if (c.watchCompanyMaterial) for (const t of tickers) reasons.push(`watch_company_${t}`);
  return { material: reasons.length > 0, reasons: reasons.length ? reasons : ['minor'], tickers, units, value_usd: value };
}

/** Recalls API URL starting `lookbackDays` before `now`. */
export function cpscUrl(now: Date, lookbackDays: number = config.cpsc.lookbackDays): string {
  const start = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  return config.cpsc.url.replace('{start}', start);
}

/** Parses the recall list (entries without a Title are dropped); throws on non-JSON or a non-list. */
export function parseCpscJson(text: string): CpscRecall[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error('cpsc: response is not JSON'); }
  if (!Array.isArray(j)) throw new Error('cpsc: expected a list of recalls');
  return j.filter((r): r is CpscRecall => !!r && typeof (r as CpscRecall).Title === 'string');
}

const recallTime = (r: CpscRecall) => Date.parse(`${(r.RecallDate ?? '').slice(0, 10)}T00:00:00Z`);

/**
 * Recalls inside the lookback, newest first. With `maxPerRun` (default: none) only the first N are kept.
 * The live run does NOT cap here: the cap of config.cpsc.maxPerRun counts only NEW recalls, so
 * processItems applies it after its already-handled check (see runCpsc).
 */
export function selectRecalls(list: CpscRecall[], now: Date, maxPerRun: number = Infinity): CpscRecall[] {
  const oldest = now.getTime() - config.cpsc.lookbackDays * 86_400_000;
  return list
    .filter((r) => Number.isFinite(recallTime(r)) && recallTime(r) >= oldest)
    .sort((a, b) => recallTime(b) - recallTime(a))
    .slice(0, maxPerRun);
}

const tidy = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export type CpscSkipReason = 'bad_url' | 'no_text';

/** Recall -> RawItem (AI text = title, description, hazards, remedies), or a skip reason (non-cpsc.gov URL, no title). */
export function cpscToItem(r: CpscRecall, now: Date): { item: RawItem } | { skip: CpscSkipReason } {
  let url: URL;
  try { url = new URL(tidy(r.URL)); } catch { return { skip: 'bad_url' }; }
  if (url.protocol !== 'https:' || !/(^|\.)cpsc\.gov$/.test(url.hostname)) return { skip: 'bad_url' };
  const title = tidy(r.Title);
  const hazards = (r.Hazards ?? []).map((h) => tidy(h.Name)).filter(Boolean);
  const remedies = (r.Remedies ?? []).map((h) => tidy(h.Name)).filter(Boolean);
  const text = [title, tidy(r.Description), hazards.length ? `Hazards: ${hazards.join(' ')}` : '', remedies.length ? `Remedies: ${remedies.join(' ')}` : '']
    .filter(Boolean).join('\n');
  if (!title) return { skip: 'no_text' };
  const t = recallTime(r);
  return {
    item: {
      source: 'cpsc',
      external_id: String(r.RecallNumber ?? r.RecallID ?? url.pathname),
      url: url.toString(),
      title,
      published_at: new Date(Math.min(Number.isFinite(t) ? t : now.getTime(), now.getTime())).toISOString(),
      license_class: 'public_domain',
      category: config.cpsc.category,
      event_type: config.cpsc.eventType,
      tickers: [],
      source_name: config.cpsc.sourceName,
      source_kind: 'government',
      doc_label: 'Recall',
      summary_text: text.slice(0, config.sourceTextMaxChars),    // the ONLY text the AI sees
      attribution: config.cpsc.attribution,
      material: (({ material, reasons, tickers }) => ({ material, reasons, tickers }))(classifyRecall(r)),
    },
  };
}
