// A-22 reader signals kept on this device (flag `signals`): companies and fine topics the reader muted, stories saved
// for later, the depth preference (short / normal), the opt-in lanes (Crypto, Tech/AI) and the interests chosen in
// the 3-question setup (flag `onboarding`). Category mutes use the existing hidden topics (account or device), so a
// signed-in reader's topic mute is already on the server; the rest has no server store yet and stays local (D-200).
// Pure apart from the KeyValueStore it is given (lib/__tests__/signals.test.ts).

import type { BlurbCard } from '../../contract/types.ts';
import { FINE_TOPICS, LANE_TOPICS, fineTopicsOf, type FineTopic } from '../topics/fineTopics.ts';
import type { KeyValueStore } from '../storage/storage.ts';

export const SIGNALS_KEY = 'element.signals';
export const MAX_SAVED = 50;
export const MAX_MUTED = 30;

export type Depth = 'normal' | 'short';
export type SetupState = 'done' | 'skipped' | null;

export interface SavedStory {
  id: string;
  headline: string;
  category: string;
  at: number; // ms saved
}

export interface Signals {
  mutedTickers: string[];
  mutedTopics: string[]; // fine topic slugs
  saved: SavedStory[]; // newest first
  depth: Depth;
  optIn: string[]; // lane slugs
  interests: string[]; // fine topic slugs chosen in setup
  setup: SetupState;
}

export const EMPTY_SIGNALS: Signals = { mutedTickers: [], mutedTopics: [], saved: [], depth: 'normal', optIn: [], interests: [], setup: null };

function strs(x: unknown, max: number, pick?: (s: string) => string): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const v of x) {
    if (typeof v !== 'string' || v === '') continue;
    const s = pick ? pick(v) : v;
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, max);
}

export function readSignals(store: KeyValueStore): Signals {
  let raw: Record<string, unknown> = {};
  try {
    const x = JSON.parse(store.get(SIGNALS_KEY) ?? '{}');
    if (x && typeof x === 'object') raw = x as Record<string, unknown>;
  } catch {
    // broken entry: start clean
  }
  const saved: SavedStory[] = [];
  if (Array.isArray(raw.saved)) {
    for (const v of raw.saved as Partial<SavedStory>[]) {
      if (v && typeof v.id === 'string' && typeof v.headline === 'string' && !saved.some((s) => s.id === v.id)) {
        saved.push({ id: v.id, headline: v.headline.slice(0, 200), category: typeof v.category === 'string' ? v.category : '', at: typeof v.at === 'number' ? v.at : 0 });
      }
    }
  }
  const known = (FINE_TOPICS as readonly string[]);
  return {
    mutedTickers: strs(raw.mutedTickers, MAX_MUTED, (s) => s.toUpperCase()),
    mutedTopics: strs(raw.mutedTopics, MAX_MUTED).filter((s) => known.includes(s)),
    saved: saved.slice(0, MAX_SAVED),
    depth: raw.depth === 'short' ? 'short' : 'normal',
    optIn: strs(raw.optIn, 4).filter((s) => (LANE_TOPICS as readonly string[]).includes(s)),
    interests: strs(raw.interests, 12).filter((s) => known.includes(s)),
    setup: raw.setup === 'done' || raw.setup === 'skipped' ? raw.setup : null,
  };
}

export function writeSignals(store: KeyValueStore, s: Signals): void {
  try {
    store.set(SIGNALS_KEY, JSON.stringify(s));
  } catch {
    // storage blocked: the choice just will not persist
  }
}

function toggle(list: string[], v: string, max: number): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : list.length >= max ? list : [...list, v];
}

export const toggleMutedTicker = (s: Signals, symbol: string): Signals => ({ ...s, mutedTickers: toggle(s.mutedTickers, symbol.toUpperCase(), MAX_MUTED) });
export const toggleMutedTopic = (s: Signals, slug: string): Signals => ({ ...s, mutedTopics: toggle(s.mutedTopics, slug, MAX_MUTED) });
export const toggleOptIn = (s: Signals, lane: string): Signals => ({ ...s, optIn: toggle(s.optIn, lane, 4) });
export const withDepth = (s: Signals, depth: Depth): Signals => ({ ...s, depth });

export function isSaved(s: Signals, id: string): boolean {
  return s.saved.some((x) => x.id === id);
}

/** Saves the card (newest first, MAX_SAVED kept), or removes it when already saved. */
export function toggleSaved(s: Signals, card: Pick<BlurbCard, 'id' | 'headline' | 'category'>, now: number = Date.now()): Signals {
  if (isSaved(s, card.id)) return { ...s, saved: s.saved.filter((x) => x.id !== card.id) };
  const entry: SavedStory = { id: card.id, headline: card.headline.slice(0, 200), category: card.category, at: now };
  return { ...s, saved: [entry, ...s.saved].slice(0, MAX_SAVED) };
}

/** Cards without the muted companies and muted fine topics. A card is dropped when ANY of its tickers is muted. */
export function withoutMuted(cards: BlurbCard[], s: Pick<Signals, 'mutedTickers' | 'mutedTopics'>): BlurbCard[] {
  if (s.mutedTickers.length === 0 && s.mutedTopics.length === 0) return cards;
  return cards.filter((c) => {
    if (c.tickers.some((t) => s.mutedTickers.includes(t.symbol.toUpperCase()))) return false;
    if (s.mutedTopics.length > 0 && fineTopicsOf(c).some((t) => s.mutedTopics.includes(t))) return false;
    return true;
  });
}

/** The reader's interests first (stable); the rest keep their order. Only used on the For you tab. */
export function interestsFirst(cards: BlurbCard[], interests: readonly string[]): BlurbCard[] {
  if (interests.length === 0) return cards;
  const hit: BlurbCard[] = [];
  const rest: BlurbCard[] = [];
  for (const c of cards) (fineTopicsOf(c).some((t: FineTopic) => interests.includes(t)) ? hit : rest).push(c);
  return [...hit, ...rest];
}
