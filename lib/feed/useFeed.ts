// Loads the feed page by page for one mode + category. Switching either resets
// the list and cursor; late responses for an old filter are dropped by the reducer.
// Paging looks at the list the reader can SEE (hidden topics and sources removed): a page
// that filters down to nothing keeps fetching, a bounded number of times (lib/feedLogic).

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Api } from '../api/api.ts';
import type { AccountApi } from '../account/account.ts';
import { pageIds, surfaceForTab } from '../ml/shadowLog.ts';
import { rerankQueue, shouldFetchAhead } from './queueLogic.ts';
import type { LocalPrefs } from '../storage/localPrefs.ts';
import { readLocal } from '../storage/localPrefs.ts';
import { defaultStore } from '../storage/storage.ts';
import { readSeen } from './forYouGate.ts';
import { finishForYou, mergePool, rankForYou } from './forYouRank.ts';
import { assignFirstCards, dedupeCards, sortLatest, trendingOrder } from './feedOrder.ts';
import { isInvalidCursor, rawDetail, userMessage } from '../api/errors.ts';
import {
  feedKey,
  feedReducer,
  initialFeedState,
  loadFeedPages,
  needsRefill,
  shouldLoadMore,
  type CardFilter,
  type FeedQuery,
  type FeedState,
} from './feedLogic.ts';

export interface UseFeed {
  state: FeedState;
  loadMore: () => void;
  retry: () => void;
  rerank: (signals: LocalPrefs, seenCount: number, signedIn?: boolean) => void;
}

const SHOW_ALL: CardFilter = (cards) => cards;

/** First-page heads that keep the three tabs distinct. `refresh` changes on every tab switch,
 *  so the heads are pulled again each time; the last heads stay in use while the new ones load. */
export function useFeedHeads(api: Api, account: AccountApi | undefined, userId: string | null, category: FeedQuery['category'], filter: CardFilter, focused: boolean, refresh: string | number = 0) {
  const [heads, setHeads] = useState<Record<string, { latest: string | null; top: string | null; for_you: string | null }>>({});
  const key = `${category ?? 'all'}|${userId ?? ''}`;
  // One pull per (category, user, tab switch): api/account/filter may change identity on every render.
  const pulled = useRef('');
  const pullKey = `${key}|${refresh}`;
  useEffect(() => {
    if (!focused || pulled.current === pullKey) return;
    pulled.current = pullKey;
    void Promise.all([
      api.feed({ mode: 'top', category, cursor: null, limit: 10 }),
      api.feed({ mode: 'latest', category, cursor: null, limit: 10 }),
      userId && account ? account.feedForYou(null, 10) : Promise.resolve(null),
    ]).then(([top, latest, personal]) => {
      const store = defaultStore();
      let fy = personal?.items ?? rankForYou(mergePool(top.items, latest.items), readLocal(store), new Set(readSeen(store).map((x) => x.id)), trendingOrder(top.items)[0]?.id ?? null, new Set(trendingOrder(top.items).slice(0, 10).map((x) => x.id)));
      if (category) fy = fy.filter((c) => c.category === category);
      const orders = assignFirstCards(filter(sortLatest(latest.items)), filter(trendingOrder(top.items)), filter(fy));
      setHeads((old) => ({ ...old, [key]: { latest: orders.latest[0]?.id ?? null, top: orders.trending[0]?.id ?? null, for_you: orders.forYou[0]?.id ?? null } }));
    }).catch(() => undefined);
  }, [api, account, userId, category, filter, focused, key, refresh, pullKey]);
  return heads[key] ?? null;
}

// `filter` removes what the reader hid (its identity may change on every render).
// `rankPage`: signed out, For you is the public Trending feed re-ordered page by page on this
// device (lib/localRank.ts); earlier pages never move under the reader.
export function useFeed(api: Api, query: FeedQuery, account?: AccountApi, filter: CardFilter = SHOW_ALL, rankPage?: CardFilter, aheadTarget = 3): UseFeed {
  const key = feedKey(query);
  const [state, dispatch] = useReducer(feedReducer, key, initialFeedState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const rankRef = useRef(rankPage);
  rankRef.current = rankPage;
  // The fetch chain now running (one per key at a time). A newer chain makes an older one stop.
  const busy = useRef<{ id: number; key: string } | null>(null);
  const nextId = useRef(0);
  // The last failure was a rejected cursor: retry must start the list again.
  const restart = useRef(false);
  const failures = useRef(0);
  const retryAt = useRef(0);

  const load = useCallback(
    async (k: string, cursor: string | null): Promise<void> => {
      if (busy.current?.key === k) return;
      const id = ++nextId.current;
      busy.current = { id, key: k };
      restart.current = false;
      try {
        await loadFeedPages({
          cursor,
          // From the first page nothing is known yet (the reducer resets in the same tick).
          known: cursor === null ? [] : stateRef.current.items,
          filter: (cards) => filterRef.current(cards),
          fetchPage: async (c) => {
            if (query.mode === 'for_you' && query.user && account) {
              // Server order stays; each page gets the shared post-step (spread from Trending's top stories,
              // diversify last). Trending's top ids are only needed on page 1.
              const [page, top] = await Promise.all([account.feedForYou(c, 10), c ? Promise.resolve(null) : api.feed({ mode: 'top', category: null, cursor: null, limit: 10 }).catch(() => null)]);
              const topItems = trendingOrder(top?.items ?? []);
              pageIds.note('for_you', page);
              return { ...page, items: finishForYou(page.items, new Set(topItems.slice(0, 10).map((x) => x.id)), topItems[0]?.id ?? null) };
            }
            if (query.mode === 'for_you') {
              // Signed out: candidates are Trending (20: its page 1 plus the next 10) plus the Latest page, ranked on this
              // device (lib/forYouRank.ts). The cursor holds both modes' cursors.
              const cur = c ? (JSON.parse(c) as { t: string | null; l: string | null }) : { t: null, l: null };
              const [top, latest] = await Promise.all([
                c && cur.t === null ? Promise.resolve(null) : api.feed({ mode: 'top', category: null, cursor: cur.t, limit: 20 }),
                c && cur.l === null ? Promise.resolve(null) : api.feed({ mode: 'latest', category: null, cursor: cur.l, limit: 10 }),
              ]);
              const store = defaultStore();
              const items = rankForYou(mergePool(top?.items ?? [], latest?.items ?? []), readLocal(store), new Set(readSeen(store).map((x) => x.id)), c ? null : trendingOrder((top?.items ?? []).slice(0, 10))[0]?.id ?? null, c ? new Set() : new Set(trendingOrder((top?.items ?? []).slice(0, 10)).map((x) => x.id)));
              const t = top ? top.next_cursor : null, l = latest ? latest.next_cursor : null;
              return { items, next_cursor: t === null && l === null ? null : JSON.stringify({ t, l }) };
            }
            const page = await api.feed({ mode: query.mode, category: query.category, cursor: c, limit: 10 });
            pageIds.note(surfaceForTab(query.mode), page);
            // Re-order only this fetched page (the server's cursor does not depend on item order); pages
            // already shown are never touched. Latest = published_at desc; Trending = lib/feedOrder.ts trendingOrder.
            const items = query.mode === 'latest' ? sortLatest(dedupeCards(page.items)) : query.mode === 'top' ? trendingOrder(dedupeCards(page.items)) : page.items;
            return { ...page, items };
          },
          onRequest: () => dispatch({ type: 'request', key: k }),
          onPage: (page) => dispatch({ type: 'page', key: k, page }),
          alive: () => busy.current?.id === id,
        });
        failures.current = 0;
        retryAt.current = 0;
      } catch (err) {
        const status = err && typeof err === 'object' ? Number((err as { status?: unknown }).status) : NaN;
        restart.current = isInvalidCursor(status, rawDetail(err));
        if (filterRef.current(stateRef.current.items).length > 0) {
          failures.current += 1;
          const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, failures.current - 1));
          retryAt.current = Date.now() + delay;
          dispatch({ type: 'fail', key: k, error: '' });
          setTimeout(() => {
            if (restart.current) { dispatch({ type: 'reset', key: k }); void load(k, null); }
            else void load(k, stateRef.current.cursor);
          }, delay);
        } else dispatch({ type: 'fail', key: k, error: userMessage(err) });
      } finally {
        if (busy.current?.id === id) busy.current = null;
      }
    },
    [api, account, query.mode, query.category, query.user],
  );

  useEffect(() => {
    // A prior request for this key may still be settling after a quick tab round-trip.
    // Give the newly selected tab its own request instead of letting stale work suppress it.
    busy.current = null;
    dispatch({ type: 'reset', key });
    void load(key, null);
  }, [key, load]);

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (shouldLoadMore(s, key)) void load(key, s.cursor);
  }, [key, load]);

  // A list that filtered down to nothing (everything fetched is hidden) while the server has
  // more: fetch on, without waiting for a scroll that can never happen. Each fetch chain is
  // bounded and ends in a visible card, the end of the feed, or an error, so this cannot loop.
  const visibleCount = filter(state.items).length;
  useEffect(() => {
    if (needsRefill(state, key, visibleCount)) void load(key, state.cursor);
  }, [state, key, visibleCount, load]);

  const retry = useCallback(() => {
    const s = stateRef.current;
    if (restart.current || s.cursor === null) {
      restart.current = false;
      dispatch({ type: 'reset', key });
      void load(key, null);
    } else {
      void load(key, s.cursor);
    }
  }, [key, load]);

  const rerank = useCallback((signals: LocalPrefs, seenCount: number, signedIn = false) => {
    if (query.mode === 'latest') return;
    dispatch({ type: 'rerank', key, items: rerankQueue(stateRef.current.items, signals, seenCount, signedIn) });
  }, [key, query.mode]);

  // Keep the unseen queue filled while there is still a cursor. One chain at a time;
  // load() owns in-flight suppression and existing cursor/error handling.
  const buffered = Math.max(0, visibleCount - 1);
  useEffect(() => {
    if (!shouldFetchAhead(buffered, aheadTarget) || !shouldLoadMore(state, key)) return;
    const wait = Math.max(0, retryAt.current - Date.now());
    if (wait === 0) void load(key, state.cursor);
    else {
      const timer = setTimeout(() => void load(key, stateRef.current.cursor), wait);
      return () => clearTimeout(timer);
    }
  }, [buffered, aheadTarget, state, key, load]);

  return { state, loadMore, retry, rerank };
}
