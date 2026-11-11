// B-06 "Since yesterday" (flag `since`): remembers when the reader last looked, and picks the cards published after
// that moment, macro first. Pure apart from the KeyValueStore (lib/__tests__/since.test.ts).
//
// A visit is one session: opening the app more than SESSION_GAP_MS after the last touch starts a new one, and the
// previous session's last touch becomes "your last visit". With no history (first visit) the window is the last
// DEFAULT_WINDOW_MS. The window never reaches back further than MAX_WINDOW_MS, so a reader back after a month
// sees a day of news, not a month.

import type { BlurbCard } from '../../contract/types.ts';
import type { KeyValueStore } from '../storage/storage.ts';

export const VISIT_KEY = 'element.visit';
export const SESSION_GAP_MS = 30 * 60 * 1000;
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface Visit {
  prev: number | null; // last touch of the previous session
  last: number; // last touch of this session
}

export function readVisit(store: KeyValueStore): Visit | null {
  try {
    const x = JSON.parse(store.get(VISIT_KEY) ?? 'null') as Partial<Visit> | null;
    if (x && typeof x.last === 'number' && Number.isFinite(x.last)) return { prev: typeof x.prev === 'number' ? x.prev : null, last: x.last };
  } catch {
    // unreadable: no history
  }
  return null;
}

/** Call once when the app opens: starts a new session when the gap is long, stores and returns the state. */
export function startVisit(store: KeyValueStore, now: number = Date.now()): Visit {
  const old = readVisit(store);
  const next: Visit = !old ? { prev: null, last: now } : now - old.last > SESSION_GAP_MS ? { prev: old.last, last: now } : { prev: old.prev, last: now };
  try {
    store.set(VISIT_KEY, JSON.stringify(next));
  } catch {
    // blocked storage: the window just falls back to the default
  }
  return next;
}

/** Keeps the session alive while the app stays open (call every few minutes and on hide). */
export function touchVisit(store: KeyValueStore, now: number = Date.now()): void {
  const old = readVisit(store);
  try {
    store.set(VISIT_KEY, JSON.stringify({ prev: old?.prev ?? null, last: now }));
  } catch {
    // ignore
  }
}

/** Start of the "since" window in ms. */
export function sinceStart(visit: Visit, now: number = Date.now()): number {
  const floor = now - MAX_WINDOW_MS;
  const from = visit.prev ?? now - DEFAULT_WINDOW_MS;
  return Math.max(from, floor);
}

const MACRO = new Set(['economy', 'policy']);

/** Rank for "macro first": data cards and economy/policy first, then the rest; newest first inside each. */
function tier(c: BlurbCard): number {
  return c.kind === 'data' || MACRO.has(c.category) ? 0 : 1;
}

export function cardsSince(cards: BlurbCard[], from: number): BlurbCard[] {
  const t = (c: BlurbCard) => Date.parse(c.published_at) || 0;
  const seen = new Set<string>();
  return cards
    .filter((c) => {
      if (seen.has(c.id) || t(c) <= from) return false;
      seen.add(c.id);
      return true;
    })
    .sort((a, b) => tier(a) - tier(b) || t(b) - t(a));
}

export function sinceLabel(from: number, now: number = Date.now()): string {
  const h = Math.round((now - from) / 3_600_000);
  if (h < 1) return 'the last hour';
  if (h < 36) return `the last ${h} hour${h === 1 ? '' : 's'}`;
  return `the last ${Math.round(h / 24)} days`;
}
