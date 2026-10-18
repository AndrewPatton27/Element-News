// Loads the feed page by page for one mode + category. Switching either resets
// the list and cursor; late responses for an old filter are dropped by the reducer.
// Paging looks at the list the reader can SEE (hidden topics and sources removed): a page
// that filters down to nothing keeps fetching, a bounded number of times (lib/feedLogic).

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { Api } from './api.ts';
import type { AccountApi } from './account.ts';
import { rerankQueue, shouldFetchAhead } from './queueLogic.ts';
import type { LocalPrefs } from './localPrefs.ts';
import { isInvalidCursor, rawDetail, userMessage } from './errors.ts';
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
            if (query.mode === 'for_you' && query.user && account) return account.feedForYou(c, 10);
            // Signed out: the same public call Trending makes; ranking happens here on the device.
            const mode = query.mode === 'for_you' ? 'top' : query.mode;
            const page = await api.feed({ mode, category: query.category, cursor: c, limit: 10 });
            const rank = rankRef.current;
            return query.mode === 'for_you' && rank ? { ...page, items: rank(page.items) } : page;
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
    dispatch({ type: 'rerank', key, items: rerankQueue(stateRef.current.items, signals, seenCount, signedIn) });
  }, [key]);

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
