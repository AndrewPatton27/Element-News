// Extra candidates for the signed-out For you pool (M9 F5). Before: Trending 20 + Latest 10, so For you was
// Trending re-ordered. Now page 1 also gets
//   - ONE api.followingFeed call (newest cards of every followed topic, company and source), only when the reader follows something;
//   - ONE api.feed top page of Economy (10 cards) unless Economy is hidden or followed (macro first: BLS, BEA, Fed cards
//     that are weeks older than Trending's window still reach the pool).
// So at most 2 extra public GETs, shared by the feed and the tab heads through a short cache (EXTRA_POOL_TTL_MS).
// Both calls are public and cacheable; failures are swallowed (the pool is then just Trending + Latest).

import type { Api } from '../api/api.ts';
import type { BlurbCard } from '../../contract/types.ts';
import type { Follows } from '../following/followingLogic.ts';

export const EXTRA_POOL_TTL_MS = 60_000;
export const EXTRA_FOLLOWING_LIMIT = 20;
export const EXTRA_ECONOMY_LIMIT = 10;

const cache = new WeakMap<object, Map<string, { at: number; pending: Promise<BlurbCard[][]> }>>();

export function extraPoolKey(follows: Follows, hiddenTopics: readonly string[]): string {
  return JSON.stringify([follows.topics, follows.sources, follows.tickers, hiddenTopics.includes('economy')]);
}

export function fetchExtraPool(api: Pick<Api, 'feed' | 'followingFeed'>, follows: Follows, hiddenTopics: readonly string[], now: number = Date.now()): Promise<BlurbCard[][]> {
  const key = extraPoolKey(follows, hiddenTopics);
  let byKey = cache.get(api);
  if (!byKey) cache.set(api, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit && now - hit.at < EXTRA_POOL_TTL_MS) return hit.pending;
  const calls: Promise<BlurbCard[]>[] = [];
  if (follows.topics.length + follows.sources.length + follows.tickers.length > 0) {
    calls.push(api.followingFeed({ topics: follows.topics, sources: follows.sources, tickers: follows.tickers, cursor: null, limit: EXTRA_FOLLOWING_LIMIT }).then((p) => p.items, () => []));
  }
  if (!follows.topics.includes('economy') && !hiddenTopics.includes('economy')) {
    calls.push(api.feed({ mode: 'top', category: 'economy', cursor: null, limit: EXTRA_ECONOMY_LIMIT }).then((p) => p.items, () => []));
  }
  const pending = Promise.all(calls);
  byKey.set(key, { at: now, pending });
  return pending;
}
