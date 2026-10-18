import type { BlurbCard } from '../contract/types.ts';
import { cardSourceKey } from './sourceKeys.ts';

export interface FeedOrders { latest: BlurbCard[]; trending: BlurbCard[]; forYou: BlurbCard[] }

/** Promote a selected first card without changing membership or the remaining relative order. */
export function promoteHead(cards: BlurbCard[], headId: string | null | undefined): BlurbCard[] {
  if (!headId) return cards;
  const index = cards.findIndex((card) => card.id === headId);
  return index > 0 ? [cards[index], ...cards.slice(0, index), ...cards.slice(index + 1)] : cards;
}

// Moves only a chosen candidate to the head; every other card keeps its relative order.
// If fewer than three unique ids exist across the lists, distinct heads are impossible.
export function assignFirstCards(latest: BlurbCard[], trending: BlurbCard[], forYou: BlurbCard[]): FeedOrders {
  const unique = (cards: BlurbCard[]) => cards.filter((c, i) => cards.findIndex((x) => x.id === c.id) === i);
  const l = unique(latest), t = unique(trending), f = unique(forYou);
  const promote = (cards: BlurbCard[], excluded: Set<string>) => {
    const i = cards.findIndex((c) => !excluded.has(c.id));
    return i > 0 ? [cards[i], ...cards.slice(0, i), ...cards.slice(i + 1)] : cards;
  };
  const latestId = l[0]?.id;
  const nextTrend = promote(t, new Set(latestId ? [latestId] : []));
  const heads = new Set([latestId, nextTrend[0]?.id].filter((x): x is string => !!x));
  const nextForYou = promote(f, heads);
  return { latest: l, trending: nextTrend, forYou: nextForYou };
}

/** When we published/pulled a card (Latest's only sort key). */
export const pulledAt = (c: BlurbCard): number => Date.parse(c.published_at);

/** The time a card shows in the feed (lib/format.ts cardTime): as_of, or published_at for data cards. */
export const shownTime = (c: BlurbCard): number => Date.parse((c.kind === 'data' ? c.published_at : c.as_of) || c.published_at);

/** Latest = a plain query: newest published_at first, ties by id DESC (same as the SQL tie-break). */
export function sortLatest(cards: BlurbCard[]): BlurbCard[] {
  return [...cards].sort((a, b) => pulledAt(b) - pulledAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Drops later duplicates: same id, or the same primary source link and headline (the server keeps one card per item). */
export function dedupeCards(cards: BlurbCard[]): BlurbCard[] {
  const ids = new Set<string>(), items = new Set<string>();
  return cards.filter((c) => {
    const url = c.kind === 'data' ? '' : c.sources?.[0]?.url ?? '';
    const key = url ? `${url}|${c.headline}` : '';
    if (ids.has(c.id) || (key && items.has(key))) return false;
    ids.add(c.id);
    if (key) items.add(key);
    return true;
  });
}

/** Latest = newest published first. Cards the reader has already reached (index <= position)
 *  stay where they are; everything after them is sorted by published time. */
export function latestOrder(cards: BlurbCard[], position = 0): BlurbCard[] {
  const keep = position > 0 ? Math.min(cards.length, position + 1) : 0;
  return [...cards.slice(0, keep), ...sortLatest(dedupeCards(cards.slice(keep)))];
}

/** FAA-style aircraft orders: Federal Register source AND an aircraft/flight headline. Mirrors the server cap
 *  (ingest/src/ranking.ts, config.ranking.airworthinessImportance). */
export const AIRCRAFT_HEADLINE = /airworth|aircraft|FAA|plane|flight/i;
export const AIRWORTHINESS_CAP = 1.5;
export function isAirworthinessCard(c: BlurbCard): boolean {
  return cardSourceKey(c) === 'fedreg' && AIRCRAFT_HEADLINE.test(c.headline);
}

/** Trending score: hours of the time the card shows + 8 * log2(importance), importance of aircraft orders capped. */
export function trendingScore(c: BlurbCard): number {
  let imp = c.importance && c.importance > 0 ? c.importance : 1;
  if (isAirworthinessCard(c)) imp = Math.min(imp, AIRWORTHINESS_CAP);
  return shownTime(c) / 3_600_000 + 8 * Math.log2(imp);
}

/** Trending order for one fetched page: score desc, id desc, then at most `maxRun` cards in a row from the
 *  same source or the same category (the next card that breaks the run moves up; deterministic). */
export function trendingOrder(cards: BlurbCard[], maxRun = 2): BlurbCard[] {
  const left = [...cards].sort((a, b) => trendingScore(b) - trendingScore(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const out: BlurbCard[] = [];
  const src = (c: BlurbCard) => cardSourceKey(c) ?? `name:${c.sources?.[0]?.name ?? c.id}`;
  const run = (key: (c: BlurbCard) => string, c: BlurbCard) => {
    let n = 0;
    for (let i = out.length - 1; i >= 0 && key(out[i]) === key(c); i--) n++;
    return n;
  };
  while (left.length) {
    let i = left.findIndex((c) => run(src, c) < maxRun && run((x) => x.category, c) < maxRun);
    if (i < 0) i = 0;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}
