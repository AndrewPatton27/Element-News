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
    },
  };
}
