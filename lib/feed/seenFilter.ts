// Seen-card exclusion, device side (guests, and sample mode so it behaves like the real back end).
// Signed-in readers on the real back end get the same behaviour from the server (migration
// 20261113000000_seen_exclusion.sql); this file is only used when the server cannot do it.
//
// "Seen" = the story the reader kept on screen for FOR_YOU_SEEN_MS (lib/forYouGate.ts recordSeen, the existing
// device-side definition; the server's is the 'view' event). The list is capped (MAX_SEEN newest ids, oldest
// dropped) and entries older than SEEN_EXCLUDE_DAYS no longer count: a seen card can come back after that, or
// after the cap pushes it out. That is the intended trade-off (cheap and bounded; a rare repeat is fine).
//
// A seen card may still show when the reader follows its story, or the story was updated after the reader saw it
// (card.updated_at later than the time it was seen). A liked card counts as seen (SEEN_LIKED_COMEBACK = false, the
// mirror of core.rank_params seen_liked_comeback = 0, migration 20261120000300_seen_liked.sql): liked cards that came
// back climbed to the top of For you and made it stale.
//
// Never an empty feed: seen cards that were left out are kept (bounded) and appended last, newest first,
// when the feed runs out of unseen ones; the page then says where the re-shown cards start (seen_from).
// Pure: no React, no storage (the caller passes the lists), so node --test runs it.

import type { BlurbCard, FeedPage } from '../../contract/types.ts';
import type { SeenStory } from './forYouGate.ts';
import { sortLatest } from './feedOrder.ts';
import type { LoadPagesOptions } from './feedLogic.ts';

export const SEEN_EXCLUDE_DAYS = 14; // same value as core.rank_params seen_exclude_days
export const SEEN_LIKED_COMEBACK = false; // same as core.rank_params seen_liked_comeback = 0
const DAY_MS = 86_400_000;

export interface SeenContext {
  seen: readonly SeenStory[];
  liked: ReadonlySet<string>; // cards the reader liked
  followed: ReadonlySet<string>; // story ids the reader follows
  now: number;
}

/** True when the card should be left out of the unseen stream. */
export function isSeenCard(card: BlurbCard, ctx: SeenContext, at: ReadonlyMap<string, number>): boolean {
  const when = at.get(card.id);
  if (when === undefined) return false;
  if (ctx.now - when > SEEN_EXCLUDE_DAYS * DAY_MS) return false; // aged out of the window
  if ((SEEN_LIKED_COMEBACK && ctx.liked.has(card.id)) || ctx.followed.has(card.id)) return false;
  const updated = card.updated_at ? Date.parse(card.updated_at) : NaN;
  return !(Number.isFinite(updated) && updated > when);
}

export function seenTimes(seen: readonly SeenStory[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of seen) m.set(s.id, Math.max(s.at, m.get(s.id) ?? 0));
  return m;
}

/** Splits cards into the unseen ones (kept in order) and the seen ones (kept in order). */
export function splitSeen(cards: readonly BlurbCard[], ctx: SeenContext): { fresh: BlurbCard[]; seen: BlurbCard[] } {
  const at = seenTimes(ctx.seen);
  const fresh: BlurbCard[] = [];
  const seen: BlurbCard[] = [];
  for (const c of cards) (isSeenCard(c, ctx, at) ? seen : fresh).push(c);
  return { fresh, seen };
}

/** The held-back seen cards as a tail: newest first, each once. */
export function seenTail(stash: ReadonlyMap<string, BlurbCard>): BlurbCard[] {
  return sortLatest([...stash.values()]);
}

/** How many empty pages in a row a device-filtered feed may skip before it gives up: enough to get past
 *  every seen card the list can hold. */
export function seenHops(seenCount: number, pageSize: number): number {
  return Math.min(40, Math.ceil(Math.max(0, seenCount) / Math.max(1, pageSize)) + 3);
}

/** Puts the held-back seen cards after a finished feed's last page. `stash` is emptied. */
export function releaseSeen(page: FeedPage, stash: Map<string, BlurbCard>): FeedPage {
  if (page.next_cursor !== null || stash.size === 0 || typeof page.seen_from === 'number') return page;
  const have = new Set(page.items.map((c) => c.id));
  const tail = seenTail(stash).filter((c) => !have.has(c.id));
  stash.clear();
  if (tail.length === 0) return page;
  return { ...page, items: [...page.items, ...tail], seen_from: page.items.length };
}

/** Reorders only the unseen part of a page (before seen_from); the re-shown cards stay last, in order.
 *  seen_from is recomputed, because `order` may drop cards (duplicates). */
export function reorderUnseen(page: FeedPage, order: (cards: BlurbCard[]) => BlurbCard[]): FeedPage {
  if (typeof page.seen_from !== 'number') return { ...page, items: order(page.items) };
  const cut = Math.max(0, Math.min(page.items.length, page.seen_from));
  const head = order(page.items.slice(0, cut));
  return { ...page, items: [...head, ...page.items.slice(cut)], seen_from: head.length };
}

/** Wraps a feed chain's options so seen cards are left out on this device: they are held in `stash` (bounded by
 *  the seen list), and appended last, newest first, with seen_from set, once the feed ends. */
export function withDeviceSeen(o: LoadPagesOptions, stash: Map<string, BlurbCard>, ctx: () => SeenContext, pageSize = 10): LoadPagesOptions {
  return {
    ...o,
    maxHops: seenHops(ctx().seen.length, pageSize),
    fetchPage: async (c) => {
      const page = await o.fetchPage(c);
      if (c === null) stash.clear();
      const { fresh, seen } = splitSeen(page.items, ctx());
      for (const card of seen) stash.set(card.id, card);
      return { ...page, items: fresh };
    },
    onPage: (page) => o.onPage(releaseSeen(page, stash)),
  };
}
