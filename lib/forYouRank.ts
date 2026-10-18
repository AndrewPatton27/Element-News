// For you candidate ranking (device side). Pure and deterministic.
// Pool = Trending page + Latest page (deduped). Order:
//   1. cards the reader has not seen or reacted to, before ones they have
//   2. personal affinity (likes, dislikes, followed topics/sources/tickers) high to low
//   3. freshness (published_at, newest first)
//   4. trending position, as the last tie-break
// Then diversifyFeed, then a guard so the first card differs from Trending's first card
// whenever another card exists.

import type { BlurbCard } from '../contract/types.ts';
import { diversifyFeed } from './diversify.ts';
import { localScore } from './localRank.ts';
import { mockRankScore } from './feedLogic.ts';
import type { LocalPrefs } from './localPrefs.ts';
import { cardSourceKey } from './sourceKeys.ts';

type Prefs = Pick<LocalPrefs, 'reactions' | 'hiddenTopics' | 'hiddenSources'> & { follows: { topics: string[]; sources?: string[]; tickers?: string[] } };

/** Trending first, then Latest, each card once. */
export function mergePool(trending: BlurbCard[], latest: BlurbCard[]): BlurbCard[] {
  const seen = new Set<string>();
  return [...trending, ...latest].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Newest first by published_at; ties by id. */
export function sortLatest(cards: BlurbCard[]): BlurbCard[] {
  return [...cards].sort(
    (a, b) =>
      Date.parse(b.published_at) - Date.parse(a.published_at) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Keeps For you from opening as a copy of Trending: in the first `window` slots at most
 *  `maxShared` cards may come from Trending's top stories; the rest move down, in order. */
export function spreadFromTrending(cards: BlurbCard[], trendingTopIds: ReadonlySet<string>, window = 5, maxShared = 2): BlurbCard[] {
  if (trendingTopIds.size === 0) return cards;
  const head: BlurbCard[] = [];
  const held: BlurbCard[] = [];
  const rest: BlurbCard[] = [];
  let shared = 0;
  for (const c of cards) {
    if (head.length >= window) { rest.push(c); continue; }
    if (trendingTopIds.has(c.id)) {
      if (shared >= maxShared) { held.push(c); continue; }
      shared += 1;
    }
    head.push(c);
  }
  return [...head, ...held, ...rest];
}

export function rankForYou(pool: BlurbCard[], prefs: Prefs, seenIds: ReadonlySet<string>, trendingFirstId: string | null, trendingTopIds: ReadonlySet<string> = new Set()): BlurbCard[] {
  const trendPos = new Map(pool.map((c, i) => [c.id, i]));
  const kept = pool.filter((c) => {
    if (prefs.reactions[c.id]?.r === 'dislike') return false;
    if (prefs.hiddenTopics.includes(c.category)) return false;
    const src = cardSourceKey(c);
    return !(src && prefs.hiddenSources.includes(src));
  });
  const used = (c: BlurbCard) => seenIds.has(c.id) || !!prefs.reactions[c.id];
  const sorted = kept
    .map((c) => ({ c, affinity: localScore(c, prefs) - mockRankScore(c), used: used(c) }))
    .sort(
      (a, b) =>
        Number(a.used) - Number(b.used) ||
        b.affinity - a.affinity ||
        Date.parse(b.c.published_at) - Date.parse(a.c.published_at) ||
        (trendPos.get(a.c.id) ?? 0) - (trendPos.get(b.c.id) ?? 0),
    )
    .map((x) => x.c);
  const out = spreadFromTrending(diversifyFeed(sorted), trendingTopIds);
  if (trendingFirstId && out.length > 1 && out[0].id === trendingFirstId) {
    const [first, ...rest] = out;
    return [rest[0], first, ...rest.slice(1)];
  }
  return out;
}
