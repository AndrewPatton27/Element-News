// Loads a list of cards page by page for one key (a search, a category, a set of
// follows). Same rules as the feed (useFeed): a new key starts a new list, late
// answers for an old key are dropped, and paging looks at the list the reader can
// SEE (hidden topics and sources removed). With key null nothing is fetched.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { FeedPage } from '../../contract/types.ts';
import { FEED_PAGE_SIZE } from '../api/config.ts';
import { isInvalidCursor, rawDetail, userMessage } from '../api/errors.ts';
import {
  feedReducer,
  initialFeedState,
  loadFeedPages,
  needsRefill,
  shouldLoadMore,
  type CardFilter,
  type FeedState,
} from './feedLogic.ts';

export interface UsePagedCards {
  state: FeedState;
  loadMore: () => void;
  retry: () => void;
}

const SHOW_ALL: CardFilter = (cards) => cards;
const NONE = '';

export function usePagedCards(
  key: string | null,
  fetchPage: (cursor: string | null, limit: number) => Promise<FeedPage>,
  filter: CardFilter = SHOW_ALL,
): UsePagedCards {
  const k = key ?? NONE;
  const [state, dispatch] = useReducer(feedReducer, k, initialFeedState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const busy = useRef<{ id: number; key: string } | null>(null);
  const nextId = useRef(0);
  const restart = useRef(false);

  const load = useCallback(async (loadKey: string, cursor: string | null): Promise<void> => {
    if (busy.current?.key === loadKey) return;
    const id = ++nextId.current;
    busy.current = { id, key: loadKey };
    restart.current = false;
    try {
      await loadFeedPages({
        cursor,
        known: cursor === null ? [] : stateRef.current.items,
        filter: (cards) => filterRef.current(cards),
        fetchPage: (c) => fetchRef.current(c, FEED_PAGE_SIZE),
        onRequest: () => dispatch({ type: 'request', key: loadKey }),
        onPage: (page) => dispatch({ type: 'page', key: loadKey, page }),
        alive: () => busy.current?.id === id,
      });
    } catch (err) {
      const status = err && typeof err === 'object' ? Number((err as { status?: unknown }).status) : NaN;
      restart.current = isInvalidCursor(status, rawDetail(err));
      dispatch({ type: 'fail', key: loadKey, error: userMessage(err) });
    } finally {
      if (busy.current?.id === id) busy.current = null;
    }
  }, []);

  useEffect(() => {
    // A new key stops the running chain (if any): its id no longer matches busy.
    busy.current = null;
    dispatch({ type: 'reset', key: k });
    if (key !== null) void load(k, null);
  }, [k, key, load]);

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (key !== null && shouldLoadMore(s, k)) void load(k, s.cursor);
  }, [k, key, load]);

  // A list that filtered down to nothing while the server has more: fetch on (bounded).
  const visibleCount = filter(state.items).length;
  useEffect(() => {
    if (key !== null && needsRefill(state, k, visibleCount)) void load(k, state.cursor);
  }, [state, k, key, visibleCount, load]);

  const retry = useCallback(() => {
    if (key === null) return;
    const s = stateRef.current;
    if (restart.current || s.cursor === null) {
      restart.current = false;
      dispatch({ type: 'reset', key: k });
      void load(k, null);
    } else {
      void load(k, s.cursor);
    }
  }, [k, key, load]);

  // For the one render between a key change and the reset, show "loading", not the old list.
  const shown = state.key === k ? state : { ...initialFeedState(k), loading: key !== null };
  return { state: shown, loadMore, retry };
}
