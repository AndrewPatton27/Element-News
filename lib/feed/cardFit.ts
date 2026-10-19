/** Compact cards on short phones or when feed chrome leaves little card height. */
export const CARD_COMPACT_WINDOW_HEIGHT = 740;
export const CARD_COMPACT_VIEWPORT_HEIGHT = 460;

export function shouldUseCompactCard(windowHeight: number, pagerHeight: number): boolean {
  return (windowHeight > 0 && windowHeight < CARD_COMPACT_WINDOW_HEIGHT) ||
    (pagerHeight > 0 && pagerHeight < CARD_COMPACT_VIEWPORT_HEIGHT);
}
