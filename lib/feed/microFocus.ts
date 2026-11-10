// Macro/finance focus on the client (mirror of supabase/migrations/20261116000000_macro_focus.sql).
// 1. Recall gate: a card in a gated topic (Recalls & Safety) is left out of Trending / Latest / For you unless it is
//    material. The server decides; the card JSON has no material flag, so in mock mode every fixture recall counts
//    as not material (as on the server before the ingest stores a verdict). A topic chip lists everything.
// 2. Page cap: at most MICRO_MAX_PER_10 micro cards (gated or cap-only topics) in any 10 in a row, soft (a micro card
//    is shown when nothing else is left).
// 3. Followed companies: mergeFollowedMicro puts the left-out recalls of followed companies (api.followed_micro)
//    into an already loaded list at fixed slots, without touching the server cursor.
// Pure functions; inputs are card lists, outputs new lists. No I/O.

import type { BlurbCard } from '../../contract/types.ts';

/** core.rank_params micro_category:<slug>: 2 = cap + gate, 1 = cap only. */
export const MICRO_CATEGORIES: Readonly<Record<string, 1 | 2>> = { safety: 2, science: 1 };
/** core.rank_params micro_max_per_10. */
export const MICRO_MAX_PER_10 = 1;

export const isMicro = (c: Pick<BlurbCard, 'category'>): boolean => (MICRO_CATEGORIES[c.category] ?? 0) > 0;

/** Left out of the three feeds: gated topic and not material (a card may carry material: true from a future API). */
export const isGated = (c: Pick<BlurbCard, 'category'> & { material?: boolean | null }): boolean =>
  MICRO_CATEGORIES[c.category] === 2 && c.material !== true;

/**
 * Page cap over a list (best first), like core.micro_cap_pick: each slot takes the first card that keeps
 * "at most max micro cards in any 10 in a row", else the first card left (soft). `history` = micro flags of
 * the cards already shown before this list (oldest first), so a list can continue another.
 */
export function microCapOrder<T extends Pick<BlurbCard, 'category'>>(cards: T[], max = MICRO_MAX_PER_10, history: boolean[] = []): T[] {
  const left = [...cards];
  const out: T[] = [];
  const recent = history.slice(-9);
  while (left.length) {
    const full = recent.filter(Boolean).length >= max;
    let i = left.findIndex((c) => !(full && isMicro(c)));
    if (i < 0) i = 0;
    const [c] = left.splice(i, 1);
    out.push(c);
    recent.push(isMicro(c));
    if (recent.length > 9) recent.shift();
  }
  return out;
}

/** The three feeds (no topic chip): gated cards out, then the page cap. A topic chip: unchanged. */
export function applyMicroFocus<T extends Pick<BlurbCard, 'category'>>(cards: T[], category: string | null): T[] {
  if (category !== null) return cards;
  return microCapOrder(cards.filter((c) => !isGated(c)));
}

/**
 * Inserts followed-company recalls (newest first, from api.followed_micro) into a loaded feed list at slots
 * first, first + every, first + 2 x every, ... (default 2, 12, 22: at most one per 10). Cards already in the list
 * are skipped. Deterministic and prefix-stable: appending pages to `feed` never moves an inserted card that is
 * already placed, so the list never reshuffles while the reader scrolls.
 */
export function mergeFollowedMicro<T extends { id: string }>(feed: T[], followed: T[], opts: { first?: number; every?: number } = {}): T[] {
  const first = Math.max(0, Math.trunc(opts.first ?? 2));
  const every = Math.max(1, Math.trunc(opts.every ?? 10));
  const have = new Set(feed.map((c) => c.id));
  const extra = followed.filter((c, i) => !have.has(c.id) && followed.findIndex((x) => x.id === c.id) === i);
  const out: T[] = [];
  let k = 0;
  for (const c of feed) {
    while (k < extra.length && out.length === first + k * every) out.push(extra[k++]);
    out.push(c);
  }
  while (k < extra.length && out.length === first + k * every) out.push(extra[k++]);
  return out;
}
