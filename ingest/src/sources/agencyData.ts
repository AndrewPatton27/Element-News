// Shared builder for the template data cards of the agency sources (EIA, Census, Treasury auctions, FOMC calendar).
// No AI and no page text: every word comes from a fixed template plus numbers the agency published.
// Inputs: an AgencyCardInput. Outputs: a PublishPayload (kind 'data') citing the agency by name (rule 8).

import type { CategorySlug } from '../../../contract/types.ts';
import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> 'Nov 6'. */
export function shortDate(d: string): string {
  const [, m, day] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${day}`;
}

/** Number with thousands separators and fixed decimals ("3,912.5"). */
export function fmt(n: number, decimals = 0): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Agency values arrive as strings, "null", "" or "NA": a finite number or null. */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/,/g, '');
  if (t === '' || /^(null|na|n\/a|\(x\)|-)$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface AgencyCardInput {
  dedupeKey: string;
  headline: string;
  body: string;
  category: CategorySlug;
  asOf: string;                        // ISO
  agencyName: string;                  // "U.S. Energy Information Administration"
  agencyUrl: string;                   // the agency page we cite
  docLabel: string;                    // "Weekly Petroleum Status Report"
  attribution: string;                 // credit line on the card
  paragraphs: string[];
  keyPoints: string[];
}

export function buildAgencyDataCard(i: AgencyCardInput): PublishPayload {
  return {
    dedupe_key: i.dedupeKey,
    kind: 'data',
    headline: i.headline.slice(0, config.headlineMaxChars),
    body: i.body,
    category: i.category,
    event_type: 'macro_release',
    ai_generated: false,
    tickers: [],
    macro: [],
    as_of: i.asOf,
    sort_at: i.asOf,
    model: null,
    prompt_version: config.templateVersion,
    attribution: i.attribution,
    detail: { paragraphs: i.paragraphs, key_points: i.keyPoints },
    sources: [{
      name: i.agencyName, kind: 'government', doc_label: i.docLabel, url: i.agencyUrl,
      published_at: i.asOf, license_class: 'public_domain', attribution: i.attribution, is_primary: true,
    }],
  };
}
