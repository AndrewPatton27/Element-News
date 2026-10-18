// Swipe to react on phone-sized layouts (pure, no React; tested in
// lib/__tests__/swipeLogic.test.ts). Right = like, left = dislike, the same
// signals as the thumb buttons. components/FeedPager.tsx does the gesture.

import type { Feedback } from './accountLogic.ts';

export const AXIS_LOCK_PX = 8; // movement before the gesture picks horizontal or vertical
export const SWIPE_THRESHOLD = 0.35; // share of the card width that completes a swipe
export const FLING_VELOCITY = 0.8; // px per ms (PanResponder vx) that completes a swipe early
export const FLING_MIN_PX = 24; // a fling still has to travel this far
export const MAX_TILT_DEG = 8;
export const SWIPE_COACH_KEY = 'element.swipe-coach-seen';

export type Axis = 'x' | 'y';

// Decide the axis once the finger has moved a few px; until then null. Ties go to
// vertical so paging always wins over reacting.
export function lockAxis(dx: number, dy: number, lockPx: number = AXIS_LOCK_PX): Axis | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < lockPx) return null;
  return ax > ay ? 'x' : 'y';
}

// On release: like, dislike, or null (spring back).
export function swipeDecision(dx: number, vx: number, width: number): Feedback | null {
  if (!(width > 0) || !Number.isFinite(dx)) return null;
  const far = Math.abs(dx) >= width * SWIPE_THRESHOLD;
  const fling = Number.isFinite(vx) && Math.abs(vx) >= FLING_VELOCITY && Math.abs(dx) >= FLING_MIN_PX && Math.sign(vx) === Math.sign(dx);
  if (!far && !fling) return null;
  return dx > 0 ? 'like' : 'dislike';
}

// 0..1, how close the drag is to completing (drives the overlay).
export function swipeProgress(dx: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.abs(dx) / (width * SWIPE_THRESHOLD));
}

// The thumb buttons toggle: pressing the active one clears it. A swipe means "set",
// so it sends nothing when the card already has that reaction.
export function reactionToSend(current: Feedback | undefined, swiped: Feedback): Feedback | null {
  return current === swiped ? null : swiped;
}

// What to press to undo a swipe: the old reaction back, or the same one again to clear it.
export function undoPress(previous: Feedback | undefined, sent: Feedback | null): Feedback | null {
  if (!sent) return null;
  return previous ?? sent;
}

// Swiping is for touch on phone layouts with reactions available (signed in).
// Desktop keeps the buttons; mouse drag is opt-in.
export function swipeEnabled(o: { wide: boolean; canReact: boolean; touch: boolean; mouseSwipe?: boolean }): boolean {
  return !o.wide && o.canReact && (o.touch || !!o.mouseSwipe);
}

// Web: the primary pointer is a finger ('pointer: coarse'). Touch laptops have a fine
// primary pointer, so their mouse never drags cards. Without matchMedia, fall back to
// touch points. Native is always touch.
export function hasTouch(env: { native: boolean; matchMedia?: ((q: string) => { matches: boolean }) | null; maxTouchPoints?: number }): boolean {
  if (env.native) return true;
  if (env.matchMedia) {
    try {
      return env.matchMedia('(pointer: coarse)').matches;
    } catch {
      // old browsers: fall through
    }
  }
  return (env.maxTouchPoints ?? 0) > 0;
}

export function showCoach(o: { enabled: boolean; seen: string | null; index: number }): boolean {
  return o.enabled && o.seen !== '1' && o.index === 0;
}

export interface PointerPoint { x: number; y: number; }
const MAX_TAP_MOVEMENT_PX = 10;
const MAX_TAP_DURATION_MS = 400;
const SWIPE_COOLDOWN_MS = 350;
let lastSwipeEndAt = Number.NEGATIVE_INFINITY;

export function shouldOpenDetail(down: PointerPoint | null, up: PointerPoint | null, durationMs: number, msAfterSwipeEnd: number): boolean {
  if (durationMs > MAX_TAP_DURATION_MS || (msAfterSwipeEnd >= 0 && msAfterSwipeEnd < SWIPE_COOLDOWN_MS)) return false;
  if (!down || !up) return true; // keyboard activation has no pointer coordinates
  return Math.hypot(up.x - down.x, up.y - down.y) <= MAX_TAP_MOVEMENT_PX;
}

// Drew: a story that was swiped to like or dislike can never open its More detail sheet from
// the trailing touch of that swipe (or by a stray tap while the card flies off).
const swipedCards = new Set<string>();
export function markCardSwiped(id: string): void { swipedCards.add(id); }
export function wasCardSwiped(id: string): boolean { return swipedCards.has(id); }

export function markSwipeEnd(): void { lastSwipeEndAt = Date.now(); }
export function msSinceSwipeEnd(): number { return Date.now() - lastSwipeEndAt; }
