import type { BlurbCard } from '../../contract/types.ts';
import type { LocalPrefs } from '../storage/localPrefs.ts';
import { rankLocal } from './localRank.ts';

export const REVEAL_SIZE = 5;
export const MIN_AHEAD = 3;
export const MAX_AHEAD = 7;

/** Signal breadth and volume both increase confidence, with diminishing returns. */
export function confidence(signals: { reactions?: number; topics?: number; sources?: number; tickers?: number; favorites?: number; accountSignals?: number }): number {
  const counts = [signals.reactions ?? 0, signals.topics ?? 0, signals.sources ?? 0, signals.tickers ?? 0, signals.favorites ?? 0, signals.accountSignals ?? 0].map((n) => Math.max(0, n));
  const active = counts.filter((n) => n > 0).length;
  const volume = counts.reduce((sum, n) => sum + Math.min(n, 8), 0);
  return Math.max(0, Math.min(1, (active / counts.length) * 0.6 + (1 - Math.exp(-volume / 12)) * 0.4));
}

export function targetAhead(value: number): number {
  return Math.max(MIN_AHEAD, Math.min(MAX_AHEAD, MIN_AHEAD + Math.round(4 * Math.max(0, Math.min(1, value)))));
}

export function shouldFetchAhead(buffered: number, target: number): boolean {
  return buffered < target;
}

/** Preserve the visible/seen prefix; only local For-you ranking moves the unseen tail. */
export function rerankQueue(queue: BlurbCard[], signals: LocalPrefs, seenCount: number, signedIn = false): BlurbCard[] {
  // Keep the visible card and the next card fixed: the latter may already be
  // rendered or partway through a swipe animation.
  const prefix = queue.slice(0, Math.max(0, seenCount + 2));
  const tail = queue.slice(prefix.length);
  const pinned = new Set(prefix.map((c) => c.id));
  const unique = tail.filter((c, i) => !pinned.has(c.id) && tail.findIndex((x) => x.id === c.id) === i);
  // Signed-in server order is already personal; retain its base order here.
  return [...prefix, ...(signedIn ? unique : rankLocal(unique, signals))];
}
