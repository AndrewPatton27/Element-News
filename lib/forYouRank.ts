// For you candidate ranking (device side). Pure and deterministic. Every term is in HOURS of
// freshness (same unit as feedLogic.mockRankScore: hours + 8 per importance doubling).
//   score = pulledAt hours + 8*log2(importance)      base (freshness from published_at, like Latest)
//         + personal taste (localScore minus its base): follows +24, likes +8/+4, dislikes -8/-4
//         - FY.overlapTop3 / FY.overlapTop10 if the card is one of Trending's top stories (set order = Trending order)
//         - FY.seenPenalty if seen, - FY.reactedPenalty if the reader reacted
// Warm reader: score desc. Cold reader (no follows, < FY.coldReactions reactions): topic
// round-robin, best card of each topic first (importance + freshness inside a topic).
// Then spread from Trending's top stories, the first-card guard, and diversifyFeed LAST.
// All constants are in FY (context/settings.md, rows foryou.*).

import type { BlurbCard } from '../contract/types.ts';
import { diversifyFeed } from './diversify.ts';
import { localScore } from './localRank.ts';
import { mockRankScore } from './feedLogic.ts';
import { pulledAt } from './feedOrder.ts';
import type { LocalPrefs } from './localPrefs.ts';
import { cardSourceKey } from './sourceKeys.ts';

type Prefs = Pick<LocalPrefs, 'reactions' | 'hiddenTopics' | 'hiddenSources'> & { follows: { topics: string[]; sources?: string[]; tickers?: string[] } };

/** Trending first, then Latest, each card once. */
export function mergePool(trending: BlurbCard[], latest: BlurbCard[]): BlurbCard[] {
  const seen = new Set<string>();
  return [...trending, ...latest].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

// Latest helpers live in lib/feedOrder.ts; re-exported so older imports keep working.
export { shownTime, sortLatest } from './feedOrder.ts';

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

/** Every tunable For you constant, in hours unless noted. */
export const FY = { seenPenalty: 12, reactedPenalty: 20, coldReactions: 3, overlapWindow: 5, overlapMax: 2, overlapTop3: 10, overlapTop10: 6 } as const;

const HOUR_MS = 3_600_000;
const base = (c: BlurbCard): number => pulledAt(c) / HOUR_MS + 8 * Math.log2(c.importance && c.importance > 0 ? c.importance : 1);
const idDesc = (a: BlurbCard, b: BlurbCard) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Shared post-step (signed-out and signed-in pages): spread away from Trending's top stories, make the
 *  first card differ from Trending's first, then diversify LAST so no topic run is recreated.
 *  Cards before `reached` stay where they are; only the rest is touched. */
export function finishForYou(cards: BlurbCard[], trendingTopIds: ReadonlySet<string> = new Set(), trendingFirstId: string | null = null, reached = 0): BlurbCard[] {
  const keep = Math.max(0, Math.min(cards.length, reached));
  let rest = spreadFromTrending(cards.slice(keep), trendingTopIds, FY.overlapWindow, FY.overlapMax);
  if (keep === 0 && trendingFirstId && rest.length > 1 && rest[0].id === trendingFirstId) rest = [rest[1], rest[0], ...rest.slice(2)];
  return [...cards.slice(0, keep), ...diversifyFeed(rest)];
}

export function rankForYou(pool: BlurbCard[], prefs: Prefs, seenIds: ReadonlySet<string>, trendingFirstId: string | null, trendingTopIds: ReadonlySet<string> = new Set()): BlurbCard[] {
  const kept = pool.filter((c) => {
    if (prefs.reactions[c.id]?.r === 'dislike') return false;
    if (prefs.hiddenTopics.includes(c.category)) return false;
    const src = cardSourceKey(c);
    return !(src && prefs.hiddenSources.includes(src));
  });
  const trendRank = new Map([...trendingTopIds].map((id, i) => [id, i]));
  const scored = kept.map((c) => {
    const tr = trendRank.get(c.id);
    const overlap = tr === undefined ? 0 : tr < 3 ? FY.overlapTop3 : FY.overlapTop10;
    const reacted = !!prefs.reactions[c.id];
    const penalty = reacted ? FY.reactedPenalty : seenIds.has(c.id) ? FY.seenPenalty : 0;
    return { c, s: base(c) + (localScore(c, prefs) - mockRankScore(c)) - penalty - overlap };
  }).sort((a, b) => b.s - a.s || idDesc(a.c, b.c));
  const f = prefs.follows;
  const cold = !f.topics.length && !f.sources?.length && !f.tickers?.length && Object.keys(prefs.reactions).length < FY.coldReactions;
  let ordered = scored.map((x) => x.c);
  if (cold) {
    // Topic round-robin: all topics' best cards first, then every topic's second, and so on.
    const depth = new Map<string, number>();
    ordered = scored.map((x, i) => { const d = depth.get(x.c.category) ?? 0; depth.set(x.c.category, d + 1); return { c: x.c, d, i }; })
      .sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.c);
  }
  return finishForYou(ordered, trendingTopIds, trendingFirstId);
}
