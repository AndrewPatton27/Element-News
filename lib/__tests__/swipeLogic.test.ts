import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasTouch,
  lockAxis,
  reactionToSend,
  showCoach,
  swipeDecision,
  swipeEnabled,
  swipeProgress,
  undoPress,
} from '../feed/swipeLogic.ts';

test('axis lock waits a few px, then picks the bigger move; ties go vertical', () => {
  assert.equal(lockAxis(3, 2), null);
  assert.equal(lockAxis(-7, 7), null);
  assert.equal(lockAxis(-8, 8), 'y');
  assert.equal(lockAxis(12, 4), 'x');
  assert.equal(lockAxis(-12, 4), 'x');
  assert.equal(lockAxis(4, -12), 'y');
  assert.equal(lockAxis(9, 9), 'y');
});

test('release past 35% of the width completes; short drags spring back', () => {
  assert.equal(swipeDecision(140, 0, 400), 'like');
  assert.equal(swipeDecision(-140, 0, 400), 'dislike');
  assert.equal(swipeDecision(139, 0.1, 400), null);
  assert.equal(swipeDecision(0, 0, 400), null);
  assert.equal(swipeDecision(200, 0, 0), null);
  assert.equal(swipeDecision(Number.NaN, 0, 400), null);
});

test('a fast fling completes early, but only in the drag direction and past a minimum', () => {
  assert.equal(swipeDecision(40, 1.2, 400), 'like');
  assert.equal(swipeDecision(-40, -1.2, 400), 'dislike');
  assert.equal(swipeDecision(40, -1.2, 400), null); // flung back the other way
  assert.equal(swipeDecision(10, 2, 400), null); // a flick, not a swipe
});

test('progress is 0..1 against the threshold', () => {
  assert.equal(swipeProgress(0, 400), 0);
  assert.equal(swipeProgress(70, 400), 0.5);
  assert.equal(swipeProgress(-500, 400), 1);
  assert.equal(swipeProgress(50, 0), 0);
});

test('a swipe sets the reaction (never toggles it off) and undo restores the old one', () => {
  assert.equal(reactionToSend(undefined, 'like'), 'like');
  assert.equal(reactionToSend('dislike', 'like'), 'like');
  assert.equal(reactionToSend('like', 'like'), null);
  assert.equal(undoPress(undefined, 'like'), 'like'); // pressing again clears it
  assert.equal(undoPress('dislike', 'like'), 'dislike');
  assert.equal(undoPress('like', null), null);
});

test('swipe only on touch phone layouts with reactions; mouse drag is opt-in', () => {
  assert.equal(swipeEnabled({ wide: false, canReact: true, touch: true }), true);
  assert.equal(swipeEnabled({ wide: true, canReact: true, touch: true }), false);
  assert.equal(swipeEnabled({ wide: false, canReact: false, touch: true }), false);
  assert.equal(swipeEnabled({ wide: false, canReact: true, touch: false }), false);
  assert.equal(swipeEnabled({ wide: false, canReact: true, touch: false, mouseSwipe: true }), true);
});

test('touch detection: native, coarse pointer or touch points', () => {
  assert.equal(hasTouch({ native: true }), true);
  assert.equal(hasTouch({ native: false, matchMedia: () => ({ matches: true }) }), true);
  assert.equal(hasTouch({ native: false, matchMedia: () => ({ matches: false }), maxTouchPoints: 0 }), false);
  assert.equal(hasTouch({ native: false, matchMedia: () => ({ matches: false }), maxTouchPoints: 10 }), false); // touch laptop
  assert.equal(hasTouch({ native: false, matchMedia: null, maxTouchPoints: 5 }), true);
  assert.equal(hasTouch({ native: false, matchMedia: () => { throw new Error('x'); }, maxTouchPoints: 0 }), false);
});

test('coach hint: first card only, until seen', () => {
  assert.equal(showCoach({ enabled: true, seen: null, index: 0 }), true);
  assert.equal(showCoach({ enabled: true, seen: '1', index: 0 }), false);
  assert.equal(showCoach({ enabled: true, seen: null, index: 1 }), false);
  assert.equal(showCoach({ enabled: false, seen: null, index: 0 }), false);
});

import { shouldOpenDetail } from '../feed/swipeLogic.ts';

const down = { x: 100, y: 100 };
const tap = { x: 103, y: 104 };
test('a clean tap opens detail', () => assert.equal(shouldOpenDetail(down, tap, 180, 1000), true));
test('a 40 px horizontal drag does not open detail', () => assert.equal(shouldOpenDetail(down, { x: 140, y: 100 }, 180, 1000), false));
test('a 12 px movement does not open detail', () => assert.equal(shouldOpenDetail(down, { x: 112, y: 100 }, 180, 1000), false));
test('a long press does not open detail', () => assert.equal(shouldOpenDetail(down, tap, 401, 1000), false));
test('a tap 100 ms after a swipe does not open detail', () => assert.equal(shouldOpenDetail(down, tap, 100, 100), false));
test('a tap 500 ms after a swipe opens detail', () => assert.equal(shouldOpenDetail(down, tap, 100, 500), true));

test('a card swiped to like or dislike never opens More detail afterwards', async () => {
  const { markCardSwiped, wasCardSwiped } = await import('../feed/swipeLogic.ts');
  assert.equal(wasCardSwiped('card-x'), false);
  markCardSwiped('card-x');
  assert.equal(wasCardSwiped('card-x'), true);
  assert.equal(wasCardSwiped('card-y'), false);
});

import { coachLane, COACH_LANE_PX } from '../feed/swipeLogic.ts';
test('swipe hint gets its own lane on every phone size, never over the card', () => {
  // pager heights are roughly window height minus header, ticker, chips and tab bar
  for (const h of [667 - 230, 844 - 250, 852 - 250, 932 - 250]) {
    assert.equal(coachLane(true, h), COACH_LANE_PX);
    assert.ok(h - coachLane(true, h) > 0);
    assert.equal(coachLane(false, h), 0);
  }
  assert.equal(coachLane(true, 100), 0); // degenerate tiny pager: no lane
});
