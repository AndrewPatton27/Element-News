// Feed state and paging rules. Pure: no React imports, so node --test runs it.

import type { BlurbCard, CategorySlug, FeedMode, FeedPage } from '../contract/types.ts';
import { isBlurbCard } from './types.ts';
import { diversifyFeed } from './diversify.ts';

// The feed tabs. 'for_you' is the signed-in personal feed (api.feed_for_you).
export type FeedTab = FeedMode | 'for_you';

export interface FeedQuery {
  mode: FeedTab;
  user?: string | null; // for_you depends on who is signed in
  category: CategorySlug | null;
}

export interface FeedState {
  key: string; // which mode+category the items belong to
  items: BlurbCard[];
  cursor: string | null; // next_cursor of the last page
  done: boolean; // server said there is nothing more
  loading: boolean;
  error: string | null;
}

export type FeedAction =
  | { type: 'reset'; key: string }
  | { type: 'request'; key: string }
  | { type: 'page'; key: string; page: FeedPage }
  | { type: 'rerank'; key: string; items: BlurbCard[] }
  | { type: 'fail'; key: string; error: string };

export function feedKey(q: FeedQuery): string {
  return `${q.mode}|${q.category ?? 'all'}${q.mode === 'for_you' ? `|${q.user ?? ''}` : ''}`;
}

export function initialFeedState(key: string): FeedState {
  return { key, items: [], cursor: null, done: false, loading: false, error: null };
}

// Appends a page: drops cards already shown (by id) and cards that fail the guard.
export function appendPage(items: BlurbCard[], page: FeedPage): BlurbCard[] {
  const seen = new Set(items.map((c) => c.id));
  const next = items.slice();
  for (const card of page.items) {
    if (!isBlurbCard(card) || seen.has(card.id)) continue;
    seen.add(card.id);
    next.push(card);
  }
  return next;
}

// Changing mode or category starts a fresh list and cursor. Responses for an old
// key (a slow request that lands after the user switched filters) are ignored.
export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  if (action.type === 'reset') return initialFeedState(action.key);
  if (action.key !== state.key) return state;
  switch (action.type) {
    case 'request':
      return { ...state, loading: true, error: null };
    case 'page':
      return {
        ...state,
        items: state.key.startsWith('top|') ? diversifyFeed(appendPage(state.items, action.page)) : appendPage(state.items, action.page),
        cursor: action.page.next_cursor,
        done: action.page.next_cursor === null,
        loading: false,
      };
    case 'rerank':
      return { ...state, items: action.items };
    case 'fail':
      return { ...state, loading: false, error: action.error };
  }
}

export function canLoadMore(state: FeedState): boolean {
  return !state.loading && !state.done && state.error === null;
}

// ---- Loading pages against the VISIBLE list ----
//
// Hidden topics and sources are also filtered on the device, so a fetched page can add
// nothing the reader can see. The rules below keep fetching (bounded) in that case, and
// always stop when the server's cursor is null or repeats, so a loop is impossible.

export const MAX_EMPTY_HOPS = 3; // extra pages fetched in one go when a page adds nothing visible

export type CardFilter = (cards: BlurbCard[]) => BlurbCard[];

// accept: keep the page as it is. hop: keep it, then fetch the next one. end: keep the cards
// but treat the feed as finished (cursor dropped).
export type PageDecision = 'accept' | 'hop' | 'end';

export function decidePage(p: {
  visibleNew: number; // cards from this page the reader can see (new, valid, not hidden)
  nextCursor: string | null;
  seenCursors: ReadonlySet<string>; // every cursor already requested in this chain
  hops: number; // extra pages already fetched in this chain
  maxHops?: number;
}): PageDecision {
  if (p.nextCursor === null) return 'accept'; // the reducer marks the feed done
  if (p.seenCursors.has(p.nextCursor)) return 'end'; // repeated cursor: the server is not moving
  if (p.visibleNew > 0) return 'accept';
  return p.hops >= (p.maxHops ?? MAX_EMPTY_HOPS) ? 'end' : 'hop';
}

export interface LoadPagesOptions {
  fetchPage: (cursor: string | null) => Promise<FeedPage>;
  filter: CardFilter; // hides topics and sources the reader switched off
  known: BlurbCard[]; // cards already in the list ([] when starting from the first page)
  cursor: string | null; // where to start
  onRequest: () => void;
  onPage: (page: FeedPage) => void;
  alive?: () => boolean; // false once the query changed: stop fetching
  maxHops?: number;
}

// Fetches a page; if it adds nothing visible, up to maxHops more. Resolves when it has
// something to show, the feed ended, or the query changed. A failed fetch throws (the
// pages already handed to onPage stay).
export async function loadFeedPages(o: LoadPagesOptions): Promise<void> {
  let cursor = o.cursor;
  let known = o.known;
  const seen = new Set<string>(cursor === null ? [] : [cursor]);
  for (let hops = 0; ; hops++) {
    if (o.alive && !o.alive()) return;
    o.onRequest();
    const page = await o.fetchPage(cursor);
    if (o.alive && !o.alive()) return;
    const after = appendPage(known, page);
    const visibleNew = o.filter(after).length - o.filter(known).length;
    const decision = decidePage({ visibleNew, nextCursor: page.next_cursor, seenCursors: seen, hops, maxHops: o.maxHops });
    known = after;
    if (decision === 'end') {
      o.onPage({ items: page.items, next_cursor: null });
      return;
    }
    o.onPage(page);
    if (decision === 'accept' || page.next_cursor === null) return;
    cursor = page.next_cursor;
    seen.add(cursor);
  }
}

// Whether the end-of-list should ask for more: the reader has scrolled to the end of what
// they can see, a next page exists, and nothing is loading or failed. `visibleCount` is the
// FILTERED list length, so a list that filtered down to nothing keeps asking (bounded by
// loadFeedPages) instead of sitting on a spinner.
export function shouldLoadMore(state: FeedState, key: string): boolean {
  return state.key === key && canLoadMore(state) && state.cursor !== null;
}

// A filtered-to-empty list with more pages on the server needs a fetch without any scroll.
export function needsRefill(state: FeedState, key: string, visibleCount: number): boolean {
  return visibleCount === 0 && shouldLoadMore(state, key);
}

// ---- Mock paging (used by the mock API with the sample fixtures) ----

export interface MockFeedParams extends FeedQuery {
  cursor: string | null;
  limit: number;
}

export function clampLimit(limit: number | undefined): number {
  const n = Number.isFinite(limit) ? Math.trunc(limit as number) : 20;
  return Math.min(30, Math.max(10, n));
}

const HOUR_MS = 3_600_000;

// Same shape as the stored ranking score: newer is higher, and doubling importance
// is worth one 8-hour half-life.
export function mockRankScore(card: BlurbCard): number {
  const hours = Date.parse(card.sort_at) / HOUR_MS;
  const importance = card.importance && card.importance > 0 ? card.importance : 1;
  return hours + 8 * Math.log2(importance);
}

function byDescThenId(score: (c: BlurbCard) => number) {
  return (a: BlurbCard, b: BlurbCard) => score(b) - score(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

// Cursor is a plain offset string in mock mode; the real API's cursor is opaque.
export function mockFeedPage(all: BlurbCard[], p: MockFeedParams): FeedPage {
  const limit = clampLimit(p.limit);
  const filtered = all.filter((c) => p.category === null || c.category === p.category);
  const sorted = filtered.slice().sort(p.mode === 'latest'
    ? (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    : byDescThenId(mockRankScore));
  const offset = p.cursor ? Math.max(0, parseInt(p.cursor, 10) || 0) : 0;
  const items = sorted.slice(offset, offset + limit);
  const end = offset + items.length;
  return { items, next_cursor: end < sorted.length ? String(end) : null };
}
