import type { BlurbCard } from '../contract/types.ts';

export interface FeedOrders { latest: BlurbCard[]; trending: BlurbCard[]; forYou: BlurbCard[] }

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
