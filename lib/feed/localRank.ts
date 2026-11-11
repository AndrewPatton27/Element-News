// "For you" for signed-out readers: re-orders one page of public feed cards on this
// device from the reader's local choices (lib/localPrefs.ts). Nothing is sent anywhere.
// Pure and deterministic (lib/__tests__/localRank.test.ts).
//
// Score, in hours of freshness (same scale as feedLogic.mockRankScore):
//   recency + importance                    base (newer is higher)
//   + 24  topic is a favorite (followed)
//   + 8   per like in the same topic (max 3), + 4 per like from the same source (max 3)
//   - 12  per dislike in the same topic (max 3), - 4 per dislike from the same source (max 3)
//   - 16  per dislike on a card sharing a ticker (max 2), - 12 per dislike in the same series family (max 2)
//   + 6   per like on a card sharing a ticker (max 2; F8 entity affinity, the server's "k:" term)
// A disliked card and its twins (same dedupe key, same headline, linked update) drop out at once.
// Cards the reader disliked and hidden topics/sources drop out. Then a diversity pass
// picks greedily, costing each card 6 hours for every card of its topic among the last 3 picked. Last, the macro/
// finance page cap (microFocus.microCapOrder: at most 1 recall or science card in any 10, soft), the same rule the
// server applies to every For you page; a liked or followed science topic could otherwise stack micro cards on
// top. Following passes { microCap: false } (no cap there, like the server).

import type { BlurbCard } from '../../contract/types.ts';
import { mockRankScore } from './feedLogic.ts';
import type { LocalPrefs } from '../storage/localPrefs.ts';
import { cardSourceKey } from '../sources/sourceKeys.ts';
import { microCapOrder } from './microFocus.ts';
import { cardFamily, dislikeIndex, tickerList } from './cardKeys.ts';

export const RANK = { favorite: 24, likeTopic: 8, likeSource: 4, dislikeTopic: 12, dislikeSource: 4, dislikeEntity: 16, dislikeFamily: 12, likeEntity: 6, maxEntity: 2, maxFamily: 2, maxCount: 3, repeat: 6, window: 3 } as const;

type Prefs = Pick<LocalPrefs, 'reactions' | 'hiddenTopics' | 'hiddenSources'> & { follows: { topics: string[]; sources?: string[]; tickers?: string[] } };

export function localScore(card: BlurbCard, prefs: Prefs): number {
  let likeT = 0, likeS = 0, likeE = 0, disT = 0, disS = 0, disE = 0, disF = 0;
  const src = cardSourceKey(card);
  const tickers = tickerList(card), family = cardFamily(card);
  for (const [id, r] of Object.entries(prefs.reactions)) {
    if (id === card.id) continue;
    const up = r.r === 'like';
    if (r.topic === card.category) up ? likeT++ : disT++;
    if (src && r.source === src) up ? likeS++ : disS++;
    if (tickers.length && r.tickers?.some((t) => tickers.includes(t))) up ? likeE++ : disE++;
    if (!up && family && r.family === family) disF++;
  }
  const m = (n: number) => Math.min(n, RANK.maxCount);
  let s = mockRankScore(card);
  if (prefs.follows.topics.includes(card.category)) s += RANK.favorite;
  if (card.sources.some((source) => prefs.follows.sources?.includes(source.name))) s += RANK.favorite;
  if (card.tickers.some((ticker) => prefs.follows.tickers?.includes(ticker.symbol.toUpperCase()))) s += RANK.favorite;
  s += RANK.likeTopic * m(likeT) + RANK.likeSource * m(likeS) + RANK.likeEntity * Math.min(likeE, RANK.maxEntity);
  s -= RANK.dislikeTopic * m(disT) + RANK.dislikeSource * m(disS) + RANK.dislikeEntity * Math.min(disE, RANK.maxEntity) + RANK.dislikeFamily * Math.min(disF, RANK.maxFamily);
  return s;
}

export function rankLocal(cards: BlurbCard[], prefs: Prefs, opts: { microCap?: boolean } = {}): BlurbCard[] {
  const disliked = dislikeIndex(prefs.reactions);
  const kept = cards.filter((c) => {
    if (disliked(c)) return false;
    if (prefs.hiddenTopics.includes(c.category)) return false;
    const src = cardSourceKey(c);
    return !(src && prefs.hiddenSources.includes(src));
  });
  const pool = kept
    .map((c) => ({ c, s: localScore(c, prefs) }))
    .sort((a, b) => b.s - a.s || (a.c.id < b.c.id ? -1 : 1));
  const out: BlurbCard[] = [];
  while (pool.length) {
    const recent = out.slice(-RANK.window).map((c) => c.category);
    let best = 0;
    let bestScore = -Infinity;
    pool.forEach((x, i) => {
      const v = x.s - RANK.repeat * recent.filter((t) => t === x.c.category).length;
      if (v > bestScore) {
        bestScore = v;
        best = i;
      }
    });
    out.push(pool.splice(best, 1)[0].c);
  }
  return opts.microCap === false ? out : microCapOrder(out);
}
