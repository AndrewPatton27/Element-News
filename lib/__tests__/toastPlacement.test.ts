import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORNER_TOAST, PHONE_390_BUTTONS_X, cornerToastBox, cornerToastText, undoHitMargin, type ToastKind } from '../feed/toastPlacement.ts';

test('the Undo tap target is at least 44 px while the pill stays visually small', () => {
  assert.ok(CORNER_TOAST.hitMin >= 44);
  assert.ok(CORNER_TOAST.pillHeight <= 40);
  // The negative margins hand back exactly the extra height, so the pill does not grow.
  assert.equal(CORNER_TOAST.hitMin + 2 * undoHitMargin(), CORNER_TOAST.pillHeight);
});

test('one place sets the position: bottom-left, plus the safe-area insets', () => {
  assert.deepEqual(cornerToastBox({ wide: false }), { left: CORNER_TOAST.left.phone, bottom: CORNER_TOAST.bottom.phone });
  assert.deepEqual(cornerToastBox({ wide: true }), { left: CORNER_TOAST.left.wide, bottom: CORNER_TOAST.bottom.wide });
  assert.deepEqual(cornerToastBox({ wide: false, insetLeft: 44, insetBottom: 20 }), { left: CORNER_TOAST.left.phone + 44, bottom: CORNER_TOAST.bottom.phone + 20 });
  assert.deepEqual(cornerToastBox({ wide: false, insetLeft: -5 }), cornerToastBox({ wide: false }), 'negative insets are ignored');
});

test('the pill ends before the action buttons on a 390 px phone', () => {
  assert.ok(CORNER_TOAST.left.phone + CORNER_TOAST.maxWidth <= PHONE_390_BUTTONS_X);
  assert.ok(CORNER_TOAST.maxWidth >= 12 + 4 + CORNER_TOAST.hitMin + 60, 'room for the text and the Undo target');
});

test('visible text is short; screen readers hear the full sentence', () => {
  const kinds: ToastKind[] = ['like', 'dislike', 'hideTopic', 'hideSource', 'follow', 'unfollow', 'unfollowStory'];
  for (const k of kinds) {
    const t = cornerToastText(k, 'Science & Space and a very long source name');
    assert.ok(t.text.length <= 10, `${k}: "${t.text}" fits the corner`);
    assert.ok(t.label.length >= t.text.length);
  }
  assert.equal(cornerToastText('hideTopic', 'Economy').label, 'Economy topics hidden.');
  assert.equal(cornerToastText('hideSource', 'SEC').label, 'Cards from SEC hidden.');
  assert.equal(cornerToastText('follow', 'Tech').label, 'Following Tech');
  assert.equal(cornerToastText('unfollowStory').label, 'Stopped following this story');
});
