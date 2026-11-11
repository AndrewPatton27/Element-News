// Latest stays strictly time-ordered (nothing re-ranks it), so a card the reader disliked is not removed: it is
// shown faded instead (conflict 10 of the sample-user study). Rendering only; no ranking, no network.

/** True when a card should be drawn faded: on Latest, and the reader's own reaction is a dislike. */
export function isDimmedInLatest(latest: boolean, reaction: string | null | undefined): boolean {
  return latest && reaction === 'dislike';
}
