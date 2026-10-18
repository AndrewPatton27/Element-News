// Followed STORIES: a card the reader follows with the pulse button. Device-first
// (signed in or out): a list of { id, at } kept in the key-value store. Pure rules
// here; the React hook is lib/useFollowedStories.ts.

import type { BlurbCard } from '../contract/types.ts';
import type { Api } from './api';
import { primarySource } from './labels.ts';
import { relativeTime } from './format.ts';

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

export function updateMeta(card: BlurbCard, now: Date = new Date()): string {
  const src = primarySource(card)?.name;
  const when = relativeTime(card.published_at, now);
  return [when, src].filter(Boolean).join(' · ');
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
