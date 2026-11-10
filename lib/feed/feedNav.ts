// Feed navigation state machine (pure, no React; tested in lib/__tests__/feedNav.test.ts and
// e2e/feedNav.spec.ts). components/feed/FeedPager.tsx drives it.
//
// The one source of truth is the id of the card on screen (`currentId`), not an index. The rules:
// - The order the reader has been given is frozen: every card already rendered (the `revealed`
//   window, which always covers the current card and the next two) keeps its place. A refetch, a
//   rerank after a like, a new page whose cards sort earlier, or a "first card" swap from the tab
//   heads can only change the cards that have not been rendered yet, and new cards only ever join
//   after the frozen ones. Cards that leave upstream (a topic or source hidden) are dropped.
// - One user action moves at most one card: `step` is ignored while a short lock from the last move
//   is on, and the screen ignores key auto-repeat. Like and dislike are a step forward; Undo goes
//   back to the card it undoes.
// - Scroll reports from the list (where the scroll came to rest) only move the current card when
//   they are not a leftover of our own animated scroll: while a programmatic move is pending, a
//   report for any other card is ignored until the move lands or a grace period runs out.
// - If the current card itself is removed, the reader moves FORWARD to the next surviving card.

export const NAV_LOCK_MS = 320; // one move per action: further steps inside this window are dropped
export const SETTLE_GRACE_MS = 900; // how long a programmatic scroll may take before rest reports win
export const REVEAL_STEP = 5; // rows rendered at a time
export const REVEAL_AHEAD = 2; // rows always rendered past the current one

export interface NavState {
  order: string[]; // ids in the order shown
  revealed: number; // order[0..revealed) is rendered and frozen
  currentId: string | null;
  pending: { id: string; until: number } | null; // our own animated scroll in flight
  lockedUntil: number;
}

export type NavCause = 'none' | 'step' | 'settle' | 'sync' | 'undo';

export interface NavResult {
  state: NavState;
  accepted: boolean; // the action did something
  cause: NavCause; // why the current card changed (for the screen: animate or jump)
}

export function currentIndex(s: NavState): number {
  return s.currentId === null ? -1 : s.order.indexOf(s.currentId);
}

function grow(s: NavState): NavState {
  const i = Math.max(0, currentIndex(s));
  let revealed = Math.max(s.revealed, Math.min(s.order.length, REVEAL_STEP), Math.min(s.order.length, i + REVEAL_AHEAD + 1));
  if (i >= revealed - REVEAL_AHEAD) revealed = Math.min(s.order.length, revealed + REVEAL_STEP);
  revealed = Math.min(revealed, s.order.length);
  return revealed === s.revealed ? s : { ...s, revealed };
}

export function initNav(ids: readonly string[]): NavState {
  const order = unique(ids);
  return grow({ order, revealed: 0, currentId: order[0] ?? null, pending: null, lockedUntil: 0 });
}

function unique(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) if (!seen.has(id)) (seen.add(id), out.push(id));
  return out;
}

/** Merge what the feed wants to show now. Frozen cards keep their order; the rest follow upstream. */
export function syncNav(s: NavState, incoming: readonly string[]): NavResult {
  const ids = unique(incoming);
  const have = new Set(ids);
  const frozen = s.order.slice(0, s.revealed);
  const kept = frozen.filter((id) => have.has(id));
  const keptSet = new Set(kept);
  const order = [...kept, ...ids.filter((id) => !keptSet.has(id))];
  let currentId = s.currentId;
  if (currentId === null || !have.has(currentId)) {
    // Forward first: the first card after the old current one that is still there.
    const at = currentId === null ? -1 : s.order.indexOf(currentId);
    const after = at < 0 ? undefined : s.order.slice(at + 1).find((id) => have.has(id));
    const before = at < 0 ? undefined : s.order.slice(0, at).reverse().find((id) => have.has(id));
    currentId = after ?? (at >= 0 ? (order[kept.length] ?? before) : undefined) ?? order[0] ?? null;
  }
  const pending = s.pending && have.has(s.pending.id) ? s.pending : null;
  const same = order.length === s.order.length && order.every((id, i) => id === s.order[i]) && currentId === s.currentId && pending === s.pending;
  if (same) return { state: s, accepted: false, cause: 'none' };
  const next = grow({ ...s, order, revealed: kept.length, currentId, pending });
  return { state: next, accepted: true, cause: currentId === s.currentId ? 'none' : 'sync' };
}

/** One card forward (dir 1) or back (dir -1). Ignored inside the lock or at either end. */
export function stepNav(s: NavState, dir: 1 | -1, now: number): NavResult {
  if (now < s.lockedUntil) return { state: s, accepted: false, cause: 'none' };
  const i = currentIndex(s);
  const t = i + dir;
  if (i < 0 || t < 0 || t >= s.order.length) return { state: s, accepted: false, cause: 'none' };
  const id = s.order[t];
  return { state: grow({ ...s, currentId: id, pending: { id, until: now + SETTLE_GRACE_MS }, lockedUntil: now + NAV_LOCK_MS }), accepted: true, cause: 'step' };
}

/** Whether a like / dislike (arrow key or swipe) on `cardId` may happen now: it must be the card on
 *  screen and outside the lock. The reaction and the step forward go together. */
export function canReactNow(s: NavState, cardId: string, now: number): boolean {
  return now >= s.lockedUntil && s.currentId === cardId;
}

/** Like / dislike: the step forward that goes with the reaction (the reaction is the caller's). On
 *  the last card nothing moves but the action still counts. */
export function reactNav(s: NavState, cardId: string, now: number): NavResult {
  if (!canReactNow(s, cardId, now)) return { state: s, accepted: false, cause: 'none' };
  const r = stepNav(s, 1, now);
  if (r.accepted) return r;
  return { state: { ...s, lockedUntil: now + NAV_LOCK_MS }, accepted: true, cause: 'none' };
}

/** Undo a reaction: back to the card it was on, if it is still in the feed and behind the reader
 *  (right after a like that is exactly one card back). Undo never moves the reader forward. */
export function undoNav(s: NavState, cardId: string, now: number): NavResult {
  const t = s.order.indexOf(cardId);
  if (t < 0 || t >= currentIndex(s)) return { state: s, accepted: false, cause: 'none' };
  return { state: grow({ ...s, currentId: cardId, pending: { id: cardId, until: now + SETTLE_GRACE_MS }, lockedUntil: now + NAV_LOCK_MS }), accepted: true, cause: 'undo' };
}

/** The list came to rest on row `index` (from its scroll offset). */
export function settleNav(s: NavState, index: number, now: number): NavResult {
  const id = s.order[index];
  if (id === undefined || index >= s.revealed) return { state: s, accepted: false, cause: 'none' };
  if (s.pending) {
    if (id === s.pending.id) return { state: { ...s, pending: null }, accepted: true, cause: 'none' };
    if (now < s.pending.until) return { state: s, accepted: false, cause: 'none' }; // our own scroll is still on its way
  }
  if (id === s.currentId) return { state: s.pending ? { ...s, pending: null } : s, accepted: !!s.pending, cause: 'none' };
  return { state: grow({ ...s, currentId: id, pending: null }), accepted: true, cause: 'settle' };
}

/** Rows to render: the frozen window. */
export function renderedIds(s: NavState): string[] {
  return s.order.slice(0, s.revealed);
}

/** Which row a scroll offset rests on (pages are `pageHeight` tall). */
export function restingIndex(offset: number, pageHeight: number): number {
  if (!(pageHeight > 0) || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.round(offset / pageHeight));
}

/** Web keydown: only real presses move the feed; an auto-repeat of a held key is swallowed. */
export function isKeyRepeat(e: { repeat?: boolean }): boolean {
  return e.repeat === true;
}
