// "Suggested for you" on the empty Search screen. Pure: no React (lib/__tests__/searchSuggestions.test.ts).
//
// Signed in: the reader's For you page (api.feed_for_you, the server's current For you ranking).
// Signed out: the Trending page re-ordered on this device by the same local ranking the guest
// For you uses (lib/feed/localRank.ts: followed topics, sources and companies, likes, dislikes).
// Either way: stories the reader has already seen on this device (looked at for 2 s, or reacted
// to) and hidden topics or sources are left out, then the first SUGGESTION_MAX are shown.
// Nothing new is fetched or stored: the lists come from the existing feed calls.

import type { BlurbCard } from '../../contract/types.ts';
import type { LocalPrefs } from '../storage/localPrefs.ts';
import { rankLocal } from '../feed/localRank.ts';
import { withoutHiddenSources } from '../sources/sourceKeys.ts';

export const SUGGESTION_MAX = 5;
export const SUGGESTION_FETCH = 10; // one page; leaves room for seen and hidden cards to drop out

export interface SuggestionFilter {
  seenIds: Iterable<string>;
  hiddenTopics?: readonly string[];
  hiddenSources?: readonly string[];
  max?: number;
}

/** Unseen, visible, one per id, at most `max`, in the order given. */
export function pickSuggestions(cards: readonly BlurbCard[], f: SuggestionFilter): BlurbCard[] {
  const seen = new Set(f.seenIds);
  const hiddenTopics = f.hiddenTopics ?? [];
  const ids = new Set<string>();
  const kept = cards.filter((c) => {
    if (!c || typeof c.id !== 'string' || ids.has(c.id) || seen.has(c.id) || hiddenTopics.includes(c.category)) return false;
    ids.add(c.id);
    return true;
  });
  return withoutHiddenSources(kept, [...(f.hiddenSources ?? [])]).slice(0, Math.max(0, f.max ?? SUGGESTION_MAX));
}

/** Guests: Trending cards in the local For you order (follows, likes and dislikes on this device). */
export function guestOrder(cards: BlurbCard[], local: LocalPrefs): BlurbCard[] {
  return rankLocal(cards, local);
}

/** Card ids the reader has seen here: the For you "seen" list plus every card they reacted to. */
export function seenIdsOf(seen: readonly { id: string }[], reactions: Record<string, unknown> | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of seen) if (s && typeof s.id === 'string') out.add(s.id);
  for (const id of Object.keys(reactions ?? {})) out.add(id);
  return out;
}

/** Signed out nothing is personal, so the list is called what it is. */
export function suggestionsHeading(signedIn: boolean): string {
  return signedIn ? 'Suggested for you' : 'Popular right now';
}

/** The small line above a suggestion: "Economy · 2 h ago". */
export function suggestionMeta(topic: string, time: string): string {
  return [topic, time].filter((x) => x && x.trim() !== '').join(' · ');
}
