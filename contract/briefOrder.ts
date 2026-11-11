// Brief ordering rule (D-119, F-01): macro, Fed and government releases come before single-company
// news, which comes before everything else; recalls, space and science come last. Pure and shared by
// the brief prompt (ingest), the brief screen (app) and the tests. Stable: cards in the same tier
// keep the order the server ranked them in.

import type { BlurbCard } from './types.ts';

/** 0 = macro and government, 1 = company news, 2 = other, 3 = recalls, space and science. */
export type BriefTier = 0 | 1 | 2 | 3;

const MACRO_SOURCE = /federal reserve|\bfomc\b|bureau of labor|\bbls\b|bureau of economic|\bbea\b|u\.s\. treasury|department of the treasury|treasury department|census bureau|energy information administration|\beia\b|congressional budget/i;
const MACRO_EVENTS = new Set(['macro_release', 'fed']);
const COMPANY_EVENTS = new Set(['earnings', 'exec_change', 'deal', 'insider']);
const COMPANY_CATEGORIES = new Set(['markets', 'earnings', 'deals', 'insider']);
const MINOR_EVENTS = new Set(['recall', 'science']);
const MINOR_CATEGORIES = new Set(['safety', 'science']);

/** Tier of a topic (category slug) for ordering whole sections. */
export function categoryTier(category: string): BriefTier {
  if (category === 'economy' || category === 'policy') return 0;
  if (COMPANY_CATEGORIES.has(category)) return 1;
  if (MINOR_CATEGORIES.has(category)) return 3;
  return 2;
}

/** Tier of one card. Macro wins over company (a Fed card that names a ticker is still macro). */
export function briefTier(c: Pick<BlurbCard, 'kind' | 'category' | 'event_type' | 'tickers' | 'macro' | 'sources'>): BriefTier {
  const primary = c.sources?.[0]?.name ?? '';
  if (c.kind === 'data' || (c.macro?.length ?? 0) > 0 || (c.event_type && MACRO_EVENTS.has(c.event_type)) || c.category === 'economy' || MACRO_SOURCE.test(primary)) return 0;
  if ((c.event_type && MINOR_EVENTS.has(c.event_type)) || MINOR_CATEGORIES.has(c.category)) return 3;
  if ((c.event_type && COMPANY_EVENTS.has(c.event_type)) || (c.tickers?.length ?? 0) > 0 || COMPANY_CATEGORIES.has(c.category)) return 1;
  return 2;
}

/** Cards sorted macro first, then company, other, recalls/space/science; stable inside a tier. */
export function orderBriefCards<T extends Pick<BlurbCard, 'kind' | 'category' | 'event_type' | 'tickers' | 'macro' | 'sources'>>(cards: readonly T[]): T[] {
  return cards.map((c, i) => ({ c, i, t: briefTier(c) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.c);
}

/** The 3-bullet lead: the first three headlines of the macro-first order, one per story. */
export function briefLeadCards<T extends Pick<BlurbCard, 'id' | 'kind' | 'category' | 'event_type' | 'tickers' | 'macro' | 'sources'>>(cards: readonly T[], n = 3): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of orderBriefCards(cards)) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length === n) break;
  }
  return out;
}
