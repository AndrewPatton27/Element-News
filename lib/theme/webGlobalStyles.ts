// Web-only global CSS, injected once from app/_layout.tsx. Three things React Native
// styles cannot express:
// 1. A visible keyboard focus ring on every focusable control (buttons, links, tabs,
//    inputs), only for keyboard focus (:focus-visible), never on mouse or touch.
// 2. Very long words (glued tickers, URLs, names) wrap instead of running off a card.
// 3. Reduced motion: no smooth scrolling and no CSS transitions when the reader asks.
// Pure string builder plus a tiny installer; the string is unit tested.

import { cssBezier, motion } from './motion.ts';

export const FOCUS_RING_COLOR = '#0B6B5D'; // light palette accent (AA on bg and surface)
const SELECTION_BG = '#DCEEE9'; // light palette accentSoft
const SELECTION_INK = '#14211C'; // light palette ink

export function webGlobalCss(ring: string = FOCUS_RING_COLOR): string {
  return [
    `[role="button"]:focus-visible,[role="link"]:focus-visible,[role="tab"]:focus-visible,[role="checkbox"]:focus-visible,[role="switch"]:focus-visible,a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid ${ring};outline-offset:2px;}`,
    `[role="button"]:focus:not(:focus-visible),[role="link"]:focus:not(:focus-visible){outline:none;}`,
    `[dir="auto"]{overflow-wrap:anywhere;}`,
    // Phones: no grey tap flash and no 300 ms double-tap wait on controls; press feedback (the
    // pressed scale set in the components) eases in and out instead of snapping.
    `html{-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%;}`,
    `[role="button"],[role="link"],[role="tab"],a,button{touch-action:manipulation;transition:transform ${motion.pressMs}ms ${cssBezier(motion.easeOut)},opacity ${motion.pressMs}ms ${cssBezier(motion.easeOut)};}`,
    // Browser surfaces in the palette: text selection and the caret.
    `::selection{background:${SELECTION_BG};color:${SELECTION_INK};}`,
    `input,textarea{caret-color:${ring};}`,
    `@media (prefers-reduced-motion: reduce){*{scroll-behavior:auto !important;transition-duration:0.01ms !important;animation-duration:0.01ms !important;}}`,
  ].join('\n');
}

const STYLE_ID = 'element-global-css';

export function installWebGlobalCss(doc: { getElementById(id: string): unknown; createElement(tag: string): any; head: { appendChild(el: unknown): unknown } } | undefined): boolean {
  if (!doc || doc.getElementById(STYLE_ID)) return false;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = webGlobalCss();
  doc.head.appendChild(el);
  return true;
}
