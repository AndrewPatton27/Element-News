// Keyboard help (web): move focus to the main content of the screen. Used by the "Skip to content" link (first Tab
// stop on every screen) and after the first-run tour closes, so the next Tab starts at the cards, not at the top bar.
// The feed marks its card area with nativeID "skip-target"; other screens fall back to their role="main" region.

export const SKIP_TARGET_ID = 'skip-target';

interface DocLike {
  getElementById(id: string): FocusableLike | null;
  querySelector(sel: string): FocusableLike | null;
}
interface FocusableLike {
  focus(opts?: { preventScroll?: boolean }): void;
  setAttribute?(name: string, value: string): void;
  hasAttribute?(name: string): boolean;
}

/** True when something took focus. Safe to call anywhere (native has no document: returns false). */
export function focusMain(doc: DocLike | undefined = typeof document === 'undefined' ? undefined : (document as unknown as DocLike)): boolean {
  if (!doc) return false;
  const el = doc.getElementById(SKIP_TARGET_ID) ?? doc.querySelector('[role="main"]');
  if (!el) return false;
  // A plain region is not focusable by default: -1 lets a script focus it without adding a Tab stop.
  if (el.hasAttribute && !el.hasAttribute('tabindex') && el.setAttribute) el.setAttribute('tabindex', '-1');
  el.focus();
  return true;
}
