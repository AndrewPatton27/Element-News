// A-12 finer topics, tagged on the device from a card's own words (the server mirror of these rules is
// core.topic_tags_of in supabase/migrations/20261135000100_topic_tags.sql; keep the two lists in step).
//
// Six macro topics (Rates, Housing, Trade, Labor, Banks, Retirement) are chips once the `topics` flag is on.
// Two lanes are opt-in only (D-121): Crypto and Tech/AI. A lane card
//  - is hidden everywhere in the feed unless the reader opted in to that lane;
//  - once opted in shows in Latest and For you, and in Trending only when it is macro-material (it is also
//    tagged with a macro topic, or its category is economy / policy);
//  - only counts when its primary source is public domain or a company filing (regulator text), never a link-out.
// Pure: no React imports.

import type { BlurbCard, Category } from '../../contract/types.ts';

export type FineTopic = 'rates' | 'housing' | 'trade' | 'labor' | 'banks' | 'retirement' | 'crypto' | 'tech-ai';
export const MACRO_FINE: readonly FineTopic[] = ['rates', 'housing', 'trade', 'labor', 'banks', 'retirement'];
export const LANE_TOPICS: readonly FineTopic[] = ['crypto', 'tech-ai'];
export const FINE_TOPICS: readonly FineTopic[] = [...MACRO_FINE, ...LANE_TOPICS];

export const FINE_NAMES: Record<FineTopic, string> = {
  rates: 'Rates',
  housing: 'Housing',
  trade: 'Trade',
  labor: 'Labor',
  banks: 'Banks',
  retirement: 'Retirement',
  crypto: 'Crypto',
  'tech-ai': 'Tech/AI',
};

/** The category a fine topic belongs to; used to seed follows (the server only knows categories). */
export const FINE_PARENT: Record<FineTopic, string> = {
  rates: 'economy',
  housing: 'economy',
  trade: 'economy',
  labor: 'economy',
  banks: 'markets',
  retirement: 'personal-finance',
  crypto: 'markets',
  'tech-ai': 'tech',
};

const RULES: Record<FineTopic, RegExp> = {
  rates: /\b(the fed|treasury yields?|10-?year|2-?year|yield curve|fed funds|federal reserve|fomc|interest rates?|rate (cut|hike|decision)s?|basis points?|bond yields?)\b/i,
  housing: /\b(housing|mortgages?|home (sales|prices?|buyers?)|existing-home|new-home|housing starts|rents?|case-shiller|homeowners?|foreclosures?)\b/i,
  trade: /\b(tariffs?|trade (deficit|surplus|war|deal|talks)|imports?|exports?|customs|trade balance)\b/i,
  labor: /\b(jobs? report|payrolls?|unemployment|jobless|labor (market|force|department)|wages?|job openings|jolts|layoffs?|hiring|employment)\b/i,
  banks: /\b(banks?|banking|lenders?|fdic|deposits?|credit unions?)\b/i,
  retirement: /\b(401\s?\(?k\)?|ira|retirement|social security|pensions?|medicare|annuit(y|ies))\b/i,
  crypto: /\b(bitcoin|crypto(currenc(y|ies))?|ethereum|stablecoins?|digital assets?)\b/i,
  'tech-ai': /(\bAI\b|artificial intelligence|semiconductors?|\bchips?\b|data cent(er|re)s?|machine learning)/,
};

const MACRO_CATEGORIES = new Set(['economy', 'policy']);

/** The card's text the rules read: headline, body, key points and the series labels of a data card. */
export function cardText(card: BlurbCard): string {
  const kp = card.detail?.key_points ?? [];
  return [card.headline, card.body ?? '', ...kp, ...(card.macro ?? []).map((m) => m.label)].join(' . ');
}

/** Series ids that pin a data card to a topic regardless of wording. */
const SERIES: Record<string, FineTopic> = {
  DGS10: 'rates',
  DGS2: 'rates',
  DFF: 'rates',
  T10Y2Y: 'rates',
  MORTGAGE30US: 'housing',
  HOUST: 'housing',
  UNRATE: 'labor',
  PAYEMS: 'labor',
  ICSA: 'labor',
  JTSJOL: 'labor',
};

export function fineTopicsOf(card: BlurbCard): FineTopic[] {
  const text = cardText(card);
  const out = new Set<FineTopic>();
  for (const t of FINE_TOPICS) if (RULES[t].test(text)) out.add(t);
  for (const m of card.macro ?? []) {
    const t = SERIES[m.series_id];
    if (t) out.add(t);
  }
  // A recall is not a macro topic hit.
  if (card.category === 'safety') MACRO_FINE.forEach((t) => out.delete(t));
  return FINE_TOPICS.filter((t) => out.has(t));
}

export function isFineTopic(slug: string | null | undefined): slug is FineTopic {
  return !!slug && (FINE_TOPICS as readonly string[]).includes(slug);
}

/** A lane card only counts when regulator-grade: public domain or a filing, never a link-out. */
export function laneEligible(card: BlurbCard): boolean {
  const primary = card.sources.find((s) => s.is_primary) ?? card.sources[0];
  return !!primary && (primary.license_class === 'public_domain' || primary.license_class === 'company_filing');
}

const isLane = (t: FineTopic) => (LANE_TOPICS as readonly string[]).includes(t);

export function isMacroMaterial(card: BlurbCard, tags: FineTopic[] = fineTopicsOf(card)): boolean {
  return tags.some((t) => !isLane(t)) || MACRO_CATEGORIES.has(card.category);
}

/**
 * Should the feed show this card? `tab` is the feed tab, `optIn` the lanes the reader switched on.
 * Cards with no lane tag always pass. A macro-material lane card may show in Trending for everyone;
 * otherwise a lane card needs the opt-in and regulator-grade sources, and never shows in Trending.
 */
export function laneVisible(card: BlurbCard, tab: 'top' | 'latest' | 'for_you', optIn: readonly string[]): boolean {
  const tags = fineTopicsOf(card);
  const lanes = tags.filter(isLane);
  if (lanes.length === 0) return true;
  const macro = isMacroMaterial(card, tags.filter((t) => !isLane(t)));
  if (macro && tab === 'top') return true;
  if (tab === 'top') return false;
  return lanes.some((l) => optIn.includes(l)) && laneEligible(card);
}

/** Cards for a fine-topic chip; lane chips only count regulator-grade cards. */
export function matchesFine(card: BlurbCard, topic: FineTopic): boolean {
  if (!fineTopicsOf(card).includes(topic)) return false;
  return isLane(topic) ? laneEligible(card) : true;
}

/** The extra chips: the six macro topics always, a lane only when opted in. Same shape as api.categories rows. */
export function fineChips(optIn: readonly string[]): Category[] {
  return FINE_TOPICS.filter((t) => !isLane(t) || optIn.includes(t)).map((t, i) => ({
    slug: t as unknown as Category['slug'],
    name: FINE_NAMES[t],
    sort_order: 100 + i,
  }));
}
