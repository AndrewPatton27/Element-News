// Wording and rules for the card bar's "Follow story" button (G-04): the pulse icon alone did not say what it follows.
// Pure helpers, tested in lib/__tests__/followLabel.test.ts.

/** The text next to the pulse icon. */
export function followStoryLabel(followed: boolean): string {
  return followed ? 'Following' : 'Follow story';
}

/** The card must be at least this wide (px) for the bar to carry the label next to the icon; phones keep the
 *  icon and the source name (the bar never wraps and the source truncates first), and their toast says the same. */
export const FOLLOW_LABEL_MIN_CARD_WIDTH = 480;

export function showFollowLabel(cardWidth: number): boolean {
  return Number.isFinite(cardWidth) && cardWidth >= FOLLOW_LABEL_MIN_CARD_WIDTH;
}
