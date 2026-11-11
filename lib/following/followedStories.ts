// Followed STORIES: a card the reader follows with the pulse button. Device-first
// (signed in or out): a list of { id, at } kept in the key-value store. Pure rules
// here; the React hook is lib/useFollowedStories.ts.

import type { BlurbCard } from '../../contract/types.ts';
import type { Api } from '../api/api';
import { primarySource } from '../shared/labels.ts';
import { relativeTime, shortDate } from '../shared/format.ts';

export interface FollowedStory {
  id: string;
  /** When it was followed (ms since epoch). */
  at: number;
  /** Snapshot of the story card (there is no get-card-by-id in the api), so the page can show and open it. */
  card?: BlurbCard;
}

export const FOLLOWED_STORIES_KEY = 'element.followedStories';
export const MAX_FOLLOWED_STORIES = 50;
export const STORY_UPDATES_TTL_MS = 120_000;
const storyUpdatesCache = new Map<string, { at: number; list: BlurbCard[] }>();

export function clearStoryUpdatesCache(): void { storyUpdatesCache.clear(); }

export async function loadStoryUpdates(api: Pick<Api, 'relatedCards'>, story: FollowedStory, now = Date.now()): Promise<BlurbCard[]> {
  if (!story.card) return [];
  const hit = storyUpdatesCache.get(story.id);
  if (hit && now - hit.at < STORY_UPDATES_TTL_MS) return hit.list;
  let cards: BlurbCard[];
  try { cards = await api.relatedCards(story.id, 5); } catch { return []; }
  const list = updatesFor(story.card, cards);
  storyUpdatesCache.set(story.id, { at: now, list });
  return list;
}

export function parseFollowedStories(raw: string | null): FollowedStory[] {
  if (!raw) return [];
  try {
    const x = JSON.parse(raw) as unknown;
    if (!Array.isArray(x)) return [];
    const out: FollowedStory[] = [];
    for (const v of x) {
      const r = v as Partial<FollowedStory> | null;
      const card = r?.card;
      const validCard = card && typeof card === 'object' && typeof (card as BlurbCard).id === 'string' && typeof (card as BlurbCard).headline === 'string' && typeof (card as BlurbCard).published_at === 'string';
      if (r && typeof r.id === 'string' && r.id !== '' && typeof r.at === 'number' && Number.isFinite(r.at) && !out.some((o) => o.id === r.id)) out.push({ id: r.id, at: r.at, ...(validCard ? { card: card as BlurbCard } : {}) });
    }
    return out.slice(0, MAX_FOLLOWED_STORIES);
  } catch {
    return [];
  }
}

export function serializeFollowedStories(list: FollowedStory[]): string {
  return JSON.stringify(list);
}

// ---- Whose list it is ----
//
// The list lives under one device key, but signed-in For you sends its ids to the server (p_followed). So the
// device remembers who the list belongs to ('' = a signed-out reader). On a switch the old owner's list is
// put aside under its own key and the new owner's list comes back: the next person to sign in on this device
// never sends (or sees) someone else's followed stories. A guest list is kept when the guest signs in (merged
// into that account's list), like the other device choices (localPrefs.mergeIntoAccount).

export const FOLLOWED_STORIES_OWNER_KEY = 'element.followedStories.owner';
export const followedStoriesStashKey = (uid: string) => `element.followedStories.u.${uid}`;

interface StoryStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Who the device list belongs to: a user id, or '' for a signed-out reader (also when never set). */
export function followedStoriesOwner(store: Pick<StoryStore, 'get'>): string {
  return store.get(FOLLOWED_STORIES_OWNER_KEY) ?? '';
}

/**
 * Makes the device list belong to `uid` (null = signed out). Call it whenever the signed-in user changes.
 * Returns true when the list changed.
 */
export function switchFollowedStoriesOwner(store: StoryStore, uid: string | null): boolean {
  const next = uid ?? '';
  const owner = followedStoriesOwner(store);
  if (owner === next) return false;
  const current = parseFollowedStories(store.get(FOLLOWED_STORIES_KEY));
  // Put the old owner's list aside (a guest's list is not kept apart: it joins the account below).
  if (owner && current.length) store.set(followedStoriesStashKey(owner), serializeFollowedStories(current));
  else if (owner) store.remove(followedStoriesStashKey(owner));
  let restored: FollowedStory[] = [];
  if (next) {
    restored = parseFollowedStories(store.get(followedStoriesStashKey(next)));
    store.remove(followedStoriesStashKey(next));
    if (!owner) {
      // guest -> signed in: keep what the guest followed, newest first, no duplicates
      const ids = new Set(restored.map((s) => s.id));
      restored = [...restored, ...current.filter((s) => !ids.has(s.id))].sort((a, b) => b.at - a.at).slice(0, MAX_FOLLOWED_STORIES);
    }
  }
  if (restored.length) store.set(FOLLOWED_STORIES_KEY, serializeFollowedStories(restored));
  else store.remove(FOLLOWED_STORIES_KEY);
  store.set(FOLLOWED_STORIES_OWNER_KEY, next);
  return true;
}

/**
 * Followed-story ids to send for `uid`, newest first. [] when the device list belongs to someone else (the
 * switch above has not run yet), so another reader's ids are never sent.
 */
export function followedStoryIdsFor(store: Pick<StoryStore, 'get'>, uid: string | null, max: number): string[] {
  if (followedStoriesOwner(store) !== (uid ?? '')) return [];
  return parseFollowedStories(store.get(FOLLOWED_STORIES_KEY)).map((s) => s.id).slice(0, Math.max(0, max));
}

export function isStoryFollowed(list: readonly FollowedStory[], id: string): boolean {
  return list.some((s) => s.id === id);
}

/** Adds the story (newest first) or removes it when already followed. */
export function toggleStory(list: readonly FollowedStory[], id: string, now: number = Date.now(), card?: BlurbCard): FollowedStory[] {
  if (isStoryFollowed(list, id)) return list.filter((s) => s.id !== id);
  return [{ id, at: now, ...(card ? { card } : {}) }, ...list].slice(0, MAX_FOLLOWED_STORIES);
}

// ---- Following page rules ----

export interface StoryUpdate {
  card: BlurbCard;
  /** Only the newest one is "fresh" (strong dot and weight in the mock-up). */
  text: string;
  meta: string;
}

/** Cards published after the story itself, newest first, without the story. */
export function updatesFor(story: Pick<BlurbCard, 'id' | 'published_at'>, related: BlurbCard[]): BlurbCard[] {
  const t = Date.parse(story.published_at);
  return related
    .filter((c) => c.id !== story.id && Date.parse(c.published_at) > t)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

// A fiscal period named in a headline: "Q4 2026", "Q2 FY2026", "fiscal 2026", "second-quarter 2026".
const FISCAL_PERIOD = /\b(?:Q[1-4]\s*(?:FY\s?)?'?\d{2,4}|FY\s?\d{4}|fiscal (?:year )?\d{4}|(?:first|second|third|fourth)[- ]quarter(?: of)?(?: fiscal)?(?: year)? \d{4})\b/i;

/**
 * The period one update covers, so two figures in a thread are never read as the same quarter (G-02):
 * a number's reporting period ("Sep 2026"), a fiscal period named in the headline ("Q4 2026"), else the date
 * the source is as of ("As of Oct 16"). Never invented: it comes from the card.
 */
export function updatePeriod(card: Pick<BlurbCard, 'macro' | 'headline' | 'as_of'>): string | null {
  const macro = card.macro?.find((m) => m.period);
  if (macro?.period) return `Period ${macro.period}`;
  const fiscal = FISCAL_PERIOD.exec(card.headline);
  if (fiscal) return `Period ${fiscal[0].replace(/\s+/g, ' ')}`;
  const t = Date.parse(card.as_of);
  return Number.isNaN(t) ? null : `As of ${shortDate(card.as_of)}`;
}

export function updateMeta(card: BlurbCard, now: Date = new Date()): string {
  const src = primarySource(card)?.name;
  const when = relativeTime(card.published_at, now);
  return [updatePeriod(card), when, src].filter(Boolean).join(' · ');
}

export function storyBadge(updates: BlurbCard[], now: Date = new Date()): string {
  return updates.length ? `Updated ${relativeTime(updates[0].published_at, now)}` : 'No new update yet';
}

export function storiesHeader(updatedCount: number, total: number): { left: string; right: string } {
  return { left: `${total} ${total === 1 ? 'story' : 'stories'}`, right: updatedCount ? `${updatedCount} updated` : '' };
}

export interface StoryRow {
  story: BlurbCard;
  updates: BlurbCard[];
}

/** Stories with updates first (newest update first), then the rest in followed order. */
export function sortStories(rows: StoryRow[]): StoryRow[] {
  const latest = (r: StoryRow) => (r.updates.length ? Date.parse(r.updates[0].published_at) : -1);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => latest(b.r) - latest(a.r) || a.i - b.i).map((x) => x.r);
}

/**
 * "More stories you may like" must not repeat what the stories section above already shows: the followed story
 * cards and the update cards in their timelines (M9c #4: the CPI card was listed under both).
 */
export function withoutShownStories(items: BlurbCard[], followed: readonly { id: string }[], rows: readonly StoryRow[]): BlurbCard[] {
  const shown = new Set<string>(followed.map((s) => s.id));
  for (const r of rows) {
    shown.add(r.story.id);
    for (const u of r.updates) shown.add(u.id);
  }
  return shown.size ? items.filter((c) => !shown.has(c.id)) : items;
}
