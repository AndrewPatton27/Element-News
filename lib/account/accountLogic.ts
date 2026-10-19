// Pure rules for accounts and tailored recommendations. No React imports.

import type { BlurbCard } from '../../contract/types.ts';
import { mockRankScore } from '../feed/feedLogic.ts';

export type Feedback = 'like' | 'dislike';
export type TrackEvent = 'view' | 'like' | 'dislike' | 'open_source' | 'open_detail' | 'dwell' | 'clear';

export interface UserPrefs {
  followed: string[];
  hidden: string[];
  /** Source keys switched off; null when the server doesn't support it yet (before migration 070000). */
  hiddenSources: string[] | null;
  onboarded: boolean;
}

export const EMPTY_PREFS: UserPrefs = { followed: [], hidden: [], hiddenSources: [], onboarded: false };

// Onboarding ("pick topics") shows once after sign-in until the user saves topics
// (the server's onboarded flag) or skips it on this device.
export function needsOnboarding(signedIn: boolean, prefs: UserPrefs | null, skipped: boolean): boolean {
  return signedIn && prefs !== null && !prefs.onboarded && !skipped;
}

// The For you feed returns cards with my_reaction ('like' | 'dislike' | null).
export function reactionOf(card: object): Feedback | undefined {
  const r = (card as { my_reaction?: unknown }).my_reaction;
  return r === 'like' || r === 'dislike' ? r : undefined;
}

// Event to send when a feedback button is pressed: the reaction, or 'clear' to undo it.
export function feedbackEvent(current: Feedback | undefined, pressed: Feedback): TrackEvent {
  return current === pressed ? 'clear' : pressed;
}

export function toggleTopic(selected: string[], slug: string): string[] {
  return selected.includes(slug) ? selected.filter((s) => s !== slug) : [...selected, slug];
}

// Pressing the same button again clears it; pressing the other one switches.
export function nextFeedback(current: Feedback | undefined, pressed: Feedback): Feedback | null {
  return current === pressed ? null : pressed;
}

// Records each card view at most once per session (the server rate-limits too).
export class ViewTracker {
  private seen = new Set<string>();
  shouldTrack(cardId: string): boolean {
    if (this.seen.has(cardId)) return false;
    this.seen.add(cardId);
    return true;
  }
  reset() {
    this.seen.clear();
  }
}

// Mock "For you": cards in followed topics first (ranked), liked topics get a
// boost, disliked cards drop out, everything else follows. Mirrors the idea of
// the server function so sample mode behaves sensibly; the real order comes
// from api.feed_for_you.
export function mockForYouOrder(cards: BlurbCard[], topics: string[], feedback: Record<string, Feedback>, hidden: string[] = []): BlurbCard[] {
  const liked = new Set(cards.filter((c) => feedback[c.id] === 'like').map((c) => c.category as string));
  const kept = cards.filter((c) => feedback[c.id] !== 'dislike' && !hidden.includes(c.category));
  const score = (c: BlurbCard) => {
    let s = mockRankScore(c);
    if (topics.includes(c.category)) s += 24; // a followed topic is worth about a day of freshness
    if (liked.has(c.category)) s += 8;
    return s;
  };
  return kept.slice().sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1));
}

// For you header: when none of the loaded cards is in a followed topic, the server
// is showing top stories instead, so the header must say so (not "Tailored to X").
export function forYouCoversTopics(cards: Pick<BlurbCard, 'category'>[], followed: string[]): boolean {
  if (followed.length === 0 || cards.length === 0) return true;
  return cards.some((c) => followed.includes(c.category));
}

// my_reaction from the server is applied once per card per session. Applying it
// again (each time For you reloads) would undo the user's later "clear" and, in
// React, re-render forever. `noted` remembers which cards were already seen.
export function unseenReactions(cards: object[], noted: Set<string>): Record<string, Feedback> | null {
  const found: Record<string, Feedback> = {};
  for (const c of cards) {
    const id = (c as { id?: unknown }).id;
    if (typeof id !== 'string' || noted.has(id)) continue;
    noted.add(id);
    const r = reactionOf(c);
    if (r) found[id] = r;
  }
  return Object.keys(found).length ? found : null;
}

// Same signed-in user as before (a token refresh hands out a new user object).
export function sameUser(a: { id: string; email: string } | null, b: { id: string; email: string } | null): boolean {
  return a === b || (!!a && !!b && a.id === b.id && a.email === b.email);
}

// ---- Hide topics ----

export type TopicState = 'follow' | 'normal' | 'hide';

export function topicState(prefs: Pick<UserPrefs, 'followed' | 'hidden'> | null, slug: string): TopicState {
  if (prefs?.hidden.includes(slug)) return 'hide';
  if (prefs?.followed.includes(slug)) return 'follow';
  return 'normal';
}

// Sets one topic's state. A topic is never both followed and hidden (the server
// rejects that with 422), so each state removes the slug from the other list.
export function withTopicState(
  prefs: Pick<UserPrefs, 'followed' | 'hidden'>,
  slug: string,
  state: TopicState,
): { followed: string[]; hidden: string[] } {
  const followed = prefs.followed.filter((s) => s !== slug);
  const hidden = prefs.hidden.filter((s) => s !== slug);
  if (state === 'follow') followed.push(slug);
  if (state === 'hide') hidden.push(slug);
  return { followed, hidden };
}

// Signed-in readers don't see hidden topics in the chips or the feed.
export function withoutHidden<T extends { slug?: string; category?: string }>(list: T[], hidden: string[]): T[] {
  if (hidden.length === 0) return list;
  return list.filter((x) => !hidden.includes((x.slug ?? x.category) as string));
}
