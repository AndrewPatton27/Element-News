// What a signed-out reader chose, kept on this device only (never sent to the server).
// Pure apart from the KeyValueStore it is given (lib/__tests__/localPrefs.test.ts).
//
// - reactions: like / dislike per card id, with the card's topic and source so the
//   local "For you" ranking (lib/localRank.ts) can learn from them;
// - hidden topics and hidden sources;
// - followed topics, sources and companies: the same `element.follows` entry the
//   Following screen uses (lib/followingLogic.ts). Followed topics are the reader's
//   favorite topics: they come first in the chips and in "For you".
//
// On sign-in the choices are merged into the account once (mergeIntoAccount).

import type { BlurbCard } from '../contract/types.ts';
import type { Feedback, UserPrefs } from './accountLogic.ts';
import { FOLLOWS_KEY, parseFollows, serializeFollows, type Follows } from './followingLogic.ts';
import { RECENT_KEY } from './searchLogic.ts';
import { cardSourceKey } from './sourceKeys.ts';
import { TUTORIAL_SEEN_KEY } from './tutorialLogic.ts';
import type { KeyValueStore } from './storage.ts';

export const LOCAL_PREFS_KEY = 'element.local-prefs';
export const MAX_LOCAL_REACTIONS = 200;
const MAX_LIST = 50;
export const migratedKey = (uid: string) => `element.local-migrated.${uid}`;

export interface LocalReaction {
  r: Feedback;
  topic: string;
  source: string | null;
  at: number; // ms; the oldest are dropped past MAX_LOCAL_REACTIONS
}

export interface LocalPrefs {
  reactions: Record<string, LocalReaction>;
  hiddenTopics: string[];
  hiddenSources: string[];
  follows: Follows;
}

export const EMPTY_LOCAL: LocalPrefs = { reactions: {}, hiddenTopics: [], hiddenSources: [], follows: { topics: [], sources: [], tickers: [] } };

function strings(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const v of x) if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v);
  return out.slice(0, MAX_LIST);
}

function reactions(x: unknown): Record<string, LocalReaction> {
  const out: Record<string, LocalReaction> = {};
  if (!x || typeof x !== 'object') return out;
  for (const [id, v] of Object.entries(x as Record<string, unknown>)) {
    const o = v as Partial<LocalReaction> | null;
    if (!o || (o.r !== 'like' && o.r !== 'dislike') || typeof o.topic !== 'string') continue;
    out[id] = { r: o.r, topic: o.topic, source: typeof o.source === 'string' ? o.source : null, at: typeof o.at === 'number' ? o.at : 0 };
  }
  return out;
}

/** Reads everything; anything unreadable counts as "nothing chosen". */
export function readLocal(store: KeyValueStore): LocalPrefs {
  const follows = parseFollows(store.get(FOLLOWS_KEY));
  let raw: Record<string, unknown> = {};
  try {
    const x = JSON.parse(store.get(LOCAL_PREFS_KEY) ?? '{}');
    if (x && typeof x === 'object') raw = x as Record<string, unknown>;
  } catch {
    // broken entry: start clean
  }
  return { reactions: reactions(raw.reactions), hiddenTopics: strings(raw.hiddenTopics), hiddenSources: strings(raw.hiddenSources), follows };
}

export function writeLocal(store: KeyValueStore, p: LocalPrefs): void {
  store.set(LOCAL_PREFS_KEY, JSON.stringify({ reactions: p.reactions, hiddenTopics: p.hiddenTopics, hiddenSources: p.hiddenSources }));
  store.set(FOLLOWS_KEY, serializeFollows(p.follows));
}

/** Pressing the same button again clears it; the other one switches. Keeps the newest MAX_LOCAL_REACTIONS. */
export function withReaction(p: LocalPrefs, card: Pick<BlurbCard, 'id' | 'category' | 'kind' | 'sources'>, pressed: Feedback, now = Date.now()): LocalPrefs {
  const next = { ...p.reactions };
  if (next[card.id]?.r === pressed) delete next[card.id];
  else next[card.id] = { r: pressed, topic: card.category, source: cardSourceKey(card), at: now };
  const ids = Object.keys(next);
  if (ids.length > MAX_LOCAL_REACTIONS) {
    ids.sort((a, b) => next[a].at - next[b].at || (a < b ? -1 : 1));
    for (const id of ids.slice(0, ids.length - MAX_LOCAL_REACTIONS)) delete next[id];
  }
  return { ...p, reactions: next };
}

export function reactionMap(p: LocalPrefs): Record<string, Feedback> {
  const out: Record<string, Feedback> = {};
  for (const [id, v] of Object.entries(p.reactions)) out[id] = v.r;
  return out;
}

/** Sets favorite (followed) and hidden topics; a topic is never both (hidden wins). */
export function withTopics(p: LocalPrefs, followed: string[], hidden: string[]): LocalPrefs {
  const h = strings(hidden);
  return { ...p, hiddenTopics: h, follows: { ...p.follows, topics: strings(followed).filter((s) => !h.includes(s)) } };
}

export function withHiddenSources(p: LocalPrefs, hiddenSources: string[]): LocalPrefs {
  return { ...p, hiddenSources: strings(hiddenSources) };
}

/** The guest's choices in the account's shape, so every screen reads one thing. */
export function asUserPrefs(p: LocalPrefs): UserPrefs {
  return { followed: p.follows.topics, hidden: p.hiddenTopics, hiddenSources: p.hiddenSources, onboarded: p.follows.topics.length > 0 };
}

/** Every key "Clear data on this device" removes: choices, follows, recent searches, the quick-tour flag. */
export const DEVICE_DATA_KEYS = [LOCAL_PREFS_KEY, FOLLOWS_KEY, RECENT_KEY, TUTORIAL_SEEN_KEY] as const;

/** Forgets everything this device saved. Local only: nothing is sent to or removed from the server. */
export function clearAll(store: KeyValueStore): void {
  for (const k of DEVICE_DATA_KEYS) store.remove(k);
}

export function hasLocalChoices(p: LocalPrefs): boolean {
  return Object.keys(p.reactions).length + p.hiddenTopics.length + p.hiddenSources.length + p.follows.topics.length > 0;
}

/** Favorites first (in their saved order), the rest keep their order. */
export function favoritesFirst<T extends { slug: string }>(list: T[], favorites: string[]): T[] {
  if (favorites.length === 0) return list;
  const fav = favorites.map((s) => list.find((x) => x.slug === s)).filter((x): x is T => !!x);
  return [...fav, ...list.filter((x) => !favorites.includes(x.slug))];
}

export interface MergePlan {
  /** New account prefs, or null when nothing changes. */
  prefs: { followed: string[]; hidden: string[]; hiddenSources?: string[] } | null;
  /** Reactions to send, oldest first; cards the account already reacted to are skipped. */
  reactions: { cardId: string; event: Feedback }[];
}

/**
 * Union of the account's choices and this device's. The account wins a conflict
 * (a topic it hides stays hidden even if this device followed it). Running it again
 * on the result changes nothing, so a repeated migration is harmless.
 */
export function mergeIntoAccount(account: UserPrefs, local: LocalPrefs, accountReactions: Record<string, Feedback> = {}): MergePlan {
  const hidden = [...account.hidden, ...local.hiddenTopics.filter((s) => !account.hidden.includes(s) && !account.followed.includes(s))];
  const followed = [...account.followed, ...local.follows.topics.filter((s) => !account.followed.includes(s) && !hidden.includes(s))];
  const sourcesSupported = account.hiddenSources !== null;
  const accSources = account.hiddenSources ?? [];
  const hiddenSources = [...accSources, ...local.hiddenSources.filter((s) => !accSources.includes(s))];
  const changed =
    followed.length !== account.followed.length ||
    hidden.length !== account.hidden.length ||
    (sourcesSupported && hiddenSources.length !== accSources.length);
  const reactions = Object.entries(local.reactions)
    .filter(([id]) => !accountReactions[id])
    .sort((a, b) => a[1].at - b[1].at || (a[0] < b[0] ? -1 : 1))
    .map(([cardId, v]) => ({ cardId, event: v.r }));
  return {
    prefs: changed ? { followed, hidden, ...(sourcesSupported ? { hiddenSources } : {}) } : null,
    reactions,
  };
}
