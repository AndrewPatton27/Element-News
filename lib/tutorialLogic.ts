// First-run tutorial logic (pure apart from the KeyValueStore it is given;
// tested in lib/__tests__/tutorialLogic.test.ts).
//
// - Seen flag: kept on this device under a versioned key, so a later tour
//   (TUTORIAL_VERSION bump) shows once again. Signed in or not, same flag.
// - Step navigation: next / back clamp to the step range.
// - Keyboard (web): ArrowDown / ArrowRight / PageDown = next, ArrowUp /
//   ArrowLeft / PageUp = back, Escape = skip. Enter / Space stay with the
//   focused button (handling them here too would step twice).
// - Auto-show: only on the first visit, and never over the /tutorial route
//   itself or a password-reset link opened from an email.

import type { KeyValueStore } from './storage.ts';
import { swipeDecision } from './swipeLogic.ts';

export const TUTORIAL_VERSION = 1;
export const TUTORIAL_SEEN_KEY = `element.tutorial-seen.v${TUTORIAL_VERSION}`;

export function hasSeenTutorial(store: KeyValueStore): boolean {
  try {
    return store.get(TUTORIAL_SEEN_KEY) !== null;
  } catch {
    // Unreadable storage: treat as seen so the tour never traps a reader in a loop.
    return true;
  }
}

export function markTutorialSeen(store: KeyValueStore, now: Date = new Date()): void {
  try {
    store.set(TUTORIAL_SEEN_KEY, now.toISOString());
  } catch {
    // storage blocked: the tour may show again next visit, which is harmless
  }
}

export function clampStep(step: number, count: number): number {
  if (count <= 0 || !Number.isFinite(step)) return 0;
  return Math.min(Math.max(Math.trunc(step), 0), count - 1);
}

export function nextStep(step: number, count: number): number {
  return clampStep(step + 1, count);
}

export function backStep(step: number, count: number): number {
  return clampStep(step - 1, count);
}

export function isLastStep(step: number, count: number): boolean {
  return count > 0 && clampStep(step, count) === count - 1;
}

export type TutorialAction = 'next' | 'back' | 'skip' | 'done' | null;

export function keyToAction(key: string, step: number, count: number): TutorialAction {
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
    case 'PageDown':
      return isLastStep(step, count) ? null : 'next';
    case 'ArrowUp':
    case 'ArrowLeft':
    case 'PageUp':
      return step > 0 ? 'back' : null;
    case 'Escape':
      return 'skip';
    default:
      return null;
  }
}

/** Returns the focusable control index to wrap to for Tab / Shift+Tab. */
export function trapTabIndex(current: number, count: number, backwards = false): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  if (backwards && current === 0) return count - 1;
  if (!backwards && current >= count - 1) return 0;
  return Math.min(Math.max(Math.trunc(current), 0), count - 1);
}

// Routes the first-run overlay never covers.
const NO_AUTO_SHOW = ['/tutorial', '/reset-password'];

export function shouldAutoShow(seen: boolean, pathname: string | null | undefined): boolean {
  if (seen) return false;
  const path = (pathname ?? '/').split('?')[0];
  return !NO_AUTO_SHOW.some((p) => path === p || path.startsWith(`${p}/`));
}

// "Step 2 of 4" for screen readers; the visual label is "Quick tour · 2 of 4".
export function progressLabel(step: number, count: number): string {
  return `Quick tour · ${clampStep(step, count) + 1} of ${Math.max(count, 1)}`;
}

// ---------------------------------------------------------------------------
// Practice card (step 1). The buttons and the swipe really respond, but this is a
// demo: the state lives only in this object / the component's useState. It never
// writes storage, calls the api, changes account or local prefs, or sends
// analytics (tested with fakes in lib/__tests__/tutorialLogic.test.ts). The card
// itself is PRACTICE_SAMPLE in lib/tutorialSteps.ts, never a real Blurb.

export type PracticeReaction = 'like' | 'dislike';

export interface PracticeState {
  reaction: PracticeReaction | null;
  message: string | null; // the small confirmation ("Liked", "Disliked", ...)
  seq: number; // bumps on every event, so the same message re-shows
}

export type PracticeEvent =
  | { type: 'press'; reaction: PracticeReaction } // thumbs button / LIKE-DISLIKE pill
  | { type: 'swipe'; reaction: PracticeReaction } // drag past the threshold
  | { type: 'share' }
  | { type: 'source' }
  | { type: 'reset' } // after the fly-off: the card comes back, ready to try again
  | { type: 'dismiss' }; // the confirmation timed out

export const PRACTICE_INITIAL: PracticeState = Object.freeze({ reaction: null, message: null, seq: 0 });

export const PRACTICE_MESSAGES = {
  like: 'Liked',
  dislike: 'Disliked',
  cleared: 'Reaction removed',
  share: 'Share opens here on real cards',
  source: 'The source opens here on real cards',
} as const;

export const PRACTICE_MESSAGE_MS = 1800; // how long the confirmation stays
export const PRACTICE_RESET_MS = 450; // fly-off done -> card back in place (same as the feed)

export function practiceReducer(state: PracticeState, event: PracticeEvent): PracticeState {
  const seq = state.seq + 1;
  switch (event.type) {
    case 'press':
      // Same as the real thumbs: pressing the active one clears it.
      return state.reaction === event.reaction
        ? { reaction: null, message: PRACTICE_MESSAGES.cleared, seq }
        : { reaction: event.reaction, message: PRACTICE_MESSAGES[event.reaction], seq };
    case 'swipe':
      // A swipe means "set" (like the feed); the card then resets for another try.
      return { reaction: event.reaction, message: PRACTICE_MESSAGES[event.reaction], seq };
    case 'share':
      return { ...state, message: PRACTICE_MESSAGES.share, seq };
    case 'source':
      return { ...state, message: PRACTICE_MESSAGES.source, seq };
    case 'reset':
      return { ...state, reaction: null, seq };
    case 'dismiss':
      return state.message === null ? state : { ...state, message: null, seq };
    default:
      return state;
  }
}

// The handlers components/TutorialPractice.tsx wires to the buttons and the drag.
// `dispatch` (React's useReducer dispatch, or a fake in tests) is their only output.
export function practiceHandlers(dispatch: (e: PracticeEvent) => void) {
  return {
    like: () => dispatch({ type: 'press', reaction: 'like' }),
    dislike: () => dispatch({ type: 'press', reaction: 'dislike' }),
    share: () => dispatch({ type: 'share' }),
    source: () => dispatch({ type: 'source' }),
    // On release: same rule as the feed (lib/swipeLogic.ts). Returns the decision so
    // the component can fly the card off, or null to spring back.
    release: (dx: number, vx: number, width: number): PracticeReaction | null => {
      const decision = swipeDecision(dx, vx, width);
      if (decision) dispatch({ type: 'swipe', reaction: decision });
      return decision;
    },
    reset: () => dispatch({ type: 'reset' }),
    dismiss: () => dispatch({ type: 'dismiss' }),
  };
}

// The two bottom buttons of every step. Back is hidden on step 1; Next becomes Done
// on the last step and finishes the tour (the seen flag is saved by the caller).
export interface NavButtons {
  showBack: boolean;
  primaryLabel: 'Next' | 'Done';
}

export function navButtons(step: number, count: number): NavButtons {
  return { showBack: clampStep(step, count) > 0, primaryLabel: isLastStep(step, count) ? 'Done' : 'Next' };
}

/** What pressing Next does: go to the next step, or finish on the last one. */
export function nextOrDone(step: number, count: number): { type: 'step'; step: number } | { type: 'done' } {
  return isLastStep(step, count) ? { type: 'done' } : { type: 'step', step: nextStep(step, count) };
}
