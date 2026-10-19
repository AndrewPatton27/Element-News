// For you unlocks after the reader has given the algorithm a little to learn from:
// FOR_YOU_MIN_STORIES stories (reacted to, or looked at for 2 seconds) across at
// least FOR_YOU_MIN_TOPICS different topics. Pure apart from the store it is given.

import type { KeyValueStore } from '../storage/storage.ts';

export const FOR_YOU_MIN_STORIES = 10;
export const FOR_YOU_MIN_TOPICS = 4;
export const FOR_YOU_SEEN_MS = 2000;
export const SEEN_KEY = 'element.seen-stories';
export const MAX_SEEN = 200;

export interface StorySignal {
  id: string;
  category: string;
}
export interface SeenStory extends StorySignal {
  at: number;
}

export interface ForYouProgress {
  stories: number;
  topics: number;
  ready: boolean;
}

/** `reacted` and `seen` may overlap; a story counts once by card id. */
export function forYouProgress(signals: { reacted?: StorySignal[]; seen?: StorySignal[] }): ForYouProgress {
  const byId = new Map<string, string>();
  for (const s of [...(signals.reacted ?? []), ...(signals.seen ?? [])]) {
    if (s && typeof s.id === 'string' && s.id !== '' && !byId.has(s.id)) byId.set(s.id, s.category);
  }
  const stories = byId.size;
  const topics = new Set([...byId.values()].filter((c) => typeof c === 'string' && c !== '')).size;
  return { stories, topics, ready: stories >= FOR_YOU_MIN_STORIES && topics >= FOR_YOU_MIN_TOPICS };
}

export function readSeen(store: KeyValueStore): SeenStory[] {
  try {
    const x = JSON.parse(store.get(SEEN_KEY) ?? '[]') as unknown;
    if (!Array.isArray(x)) return [];
    return x.filter((v): v is SeenStory => !!v && typeof v.id === 'string' && typeof v.category === 'string' && typeof v.at === 'number').slice(-MAX_SEEN);
  } catch {
    return [];
  }
}

/** Adds the story (once per id), keeping the newest MAX_SEEN. Returns the new list. */
export function recordSeen(store: KeyValueStore, card: StorySignal, now: number = Date.now()): SeenStory[] {
  const cur = readSeen(store);
  if (cur.some((s) => s.id === card.id)) return cur;
  const next = [...cur, { id: card.id, category: card.category, at: now }].slice(-MAX_SEEN);
  try {
    store.set(SEEN_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the count just will not persist
  }
  return next;
}
