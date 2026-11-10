// Where the corner Undo toast sits and how big it is (pure; tested in
// lib/__tests__/toastPlacement.test.ts, placement checked by e2e/feedNav.spec.ts).
// components/feed/UndoToast.tsx placement="corner" reads these; it is used by the feed's like /
// dislike toast, the hide-topic / hide-source / follow-topic toasts on the feed and the unfollow
// toast on Following.
//
// CORNER_TOAST.bottom is the single knob for the vertical position: the distance from the bottom
// of the screen area the toast is drawn in. Cards no longer carry small print (D-80 moved it to
// the notice strip under the card area), so on phones the pill sits over the left end of the
// card's bottom bar (the source name, for the few seconds it shows), clear of the headline,
// takeaways, "More detail" and the like / dislike / follow / share buttons to its right.

export const CORNER_TOAST = {
  bottom: { phone: 28, wide: 40 },
  left: { phone: 26, wide: 32 },
  pillHeight: 36, // what the eye sees
  hitMin: 44, // the Undo tap target (project rule: real 44 px boxes)
  maxWidth: 132, // ends before the card's first action button on a 390 px phone (x = 161)
} as const;

/** Where the first action button (like) starts on a 390 px phone card, measured in the e2e run. */
export const PHONE_390_BUTTONS_X = 161;

export function cornerToastBox(o: { wide: boolean; insetLeft?: number; insetBottom?: number }): { left: number; bottom: number } {
  const k = o.wide ? 'wide' : 'phone';
  return { left: CORNER_TOAST.left[k] + Math.max(0, o.insetLeft ?? 0), bottom: CORNER_TOAST.bottom[k] + Math.max(0, o.insetBottom ?? 0) };
}

// The Undo button is taller than the pill; the extra is handed back with negative margins so the
// pill stays visually small while the tap target is a full 44 px.
export function undoHitMargin(): number {
  return -(CORNER_TOAST.hitMin - CORNER_TOAST.pillHeight) / 2;
}

// The corner pill shows a short word or two (the corner is narrow); screen readers hear the full
// sentence. Long topic or source names stay out of the visible text.
export type ToastKind = 'like' | 'dislike' | 'hideTopic' | 'hideSource' | 'follow' | 'unfollow' | 'unfollowStory';
export function cornerToastText(kind: ToastKind, name?: string): { text: string; label: string } {
  switch (kind) {
    case 'like':
      return { text: 'Liked', label: 'Liked. More like this.' };
    case 'dislike':
      return { text: 'Disliked', label: 'Disliked. Less like this.' };
    case 'hideTopic':
      return { text: 'Hidden', label: `${name ?? 'This'} topics hidden.` };
    case 'hideSource':
      return { text: 'Hidden', label: `Cards from ${name ?? 'this source'} hidden.` };
    case 'follow':
      return { text: 'Following', label: `Following ${name ?? 'this topic'}` };
    case 'unfollow':
      return { text: 'Unfollowed', label: `Unfollowed ${name ?? 'this topic'}` };
    case 'unfollowStory':
      return { text: 'Unfollowed', label: 'Stopped following this story' };
  }
}
