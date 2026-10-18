// Federal Register documents API (JSON) -> RawItem. Final rules only.
// The AI sees only the document's `abstract` (agency-written summary inside the JSON).
// No page is ever downloaded: www.federalregister.gov is on the API host list only.
// Reuse is permitted (1 CFR 2.6); treated like public-domain Fed/BLS text (25-word copy limit).
// Inputs: documents.json API responses. Outputs: FrDoc lists and RawItems (policy) or skip reasons.

import { config } from '../config.ts';
import type { RawItem } from '../types.ts';

export interface FrAgency {
  name?: string | null;
  raw_name?: string | null;
  parent_id?: number | null;
}

export interface FrDoc {
  document_number: string;
  title: string;
  abstract: string | null;
  html_url: string;
  publication_date: string;          // YYYY-MM-DD; can be a future (scheduled) issue date
  type?: string;
  agencies?: FrAgency[];
}

export type FedRegSkipReason = 'no_abstract' | 'bad_url' | 'not_a_rule';

/** Parses one API response. Throws on HTML (bot challenge) or a missing results list. */
export function parseFedRegJson(text: string): FrDoc[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('federal register: response is not JSON (bot challenge or outage?)');
  }
  const results = (j as { results?: unknown })?.results;
  if (!Array.isArray(results)) {
    // An empty search returns {count: 0} with no results key.
    if ((j as { count?: unknown })?.count === 0) return [];
    throw new Error('federal register: no results list in response');
  }
  return results.filter((r): r is FrDoc =>
    !!r && typeof r.document_number === 'string' && typeof r.title === 'string' &&
    typeof r.html_url === 'string' && typeof r.publication_date === 'string');
}

const dayMs = 86_400_000;
const pubTime = (d: FrDoc) => Date.parse(`${d.publication_date}T00:00:00Z`);

/** Merges the query results: dedupe on document_number, drop items older than maxAgeDays, newest first. */
export function mergeFedRegDocs(lists: FrDoc[][], now: Date, maxAgeDays: number = config.fedRegister.maxAgeDays): FrDoc[] {
  const seen = new Map<string, FrDoc>();
  for (const list of lists) for (const d of list) if (!seen.has(d.document_number)) seen.set(d.document_number, d);
  const oldest = now.getTime() - maxAgeDays * dayMs;
  return [...seen.values()]
    .filter((d) => Number.isFinite(pubTime(d)) && pubTime(d) >= oldest)
    .sort((a, b) => pubTime(b) - pubTime(a));
}

/** Most specific agency: the first sub-agency (has a parent), else the first agency. */
export function agencyName(d: FrDoc): string | null {
  const named = (d.agencies ?? []).map((a) => ({ name: (a.name ?? a.raw_name ?? '').trim(), child: a.parent_id != null }))
    .filter((a) => a.name);
  return (named.find((a) => a.child) ?? named[0])?.name ?? null;
}

/** publication_date as ISO, clamped to `now` (scheduled issues carry a future date). */
export function clampedPublishedAt(d: FrDoc, now: Date): string {
  const t = pubTime(d);
  return new Date(Math.min(t, now.getTime())).toISOString();
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** true for an FAA airworthiness directive (the title says "Airworthiness Directive(s)"). */
export const isAirworthinessDirective = (title: string | null | undefined): boolean => /\bairworthiness directives?\b/i.test(title ?? '');

/** Document -> RawItem (AI text = abstract only, agency credit line), or a skip reason (not a rule, no abstract, bad URL). */
export function fedRegDocToItem(d: FrDoc, now: Date): { item: RawItem } | { skip: FedRegSkipReason } {
  if (d.type && d.type !== 'Rule') return { skip: 'not_a_rule' };
  const abstract = tidy(d.abstract ?? '');
  if (!abstract) return { skip: 'no_abstract' };                // corrections and many notices have none
  let url: URL;
  try { url = new URL(d.html_url); } catch { return { skip: 'bad_url' }; }
  if (url.protocol !== 'https:' || url.hostname !== 'www.federalregister.gov') return { skip: 'bad_url' };
  const agency = agencyName(d);
  return {
    item: {
      source: 'fedreg',
      external_id: d.document_number,
      url: url.toString(),
      title: tidy(d.title),                                   // input for the template headline only
      published_at: clampedPublishedAt(d, now),
      license_class: 'public_domain',
      category: config.fedRegister.category,
      event_type: null,
      tickers: [],
      source_name: 'Federal Register',
      source_kind: 'government',
      doc_label: 'Final rule',
      agency: agency ?? undefined,
      summary_text: abstract.slice(0, config.sourceTextMaxChars),   // the ONLY text the AI sees
      attribution: agency ? `${config.fedRegister.attributionPrefix}, ${agency}` : config.fedRegister.attributionPrefix,
    },
  };
}
