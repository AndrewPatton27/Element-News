import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cssBezier, flingDuration, motion, sheetDismiss } from '../theme/motion.ts';
import { webGlobalCss } from '../theme/webGlobalStyles.ts';

test('motion tokens: UI motion stays under 300 ms and exits are faster than entries', () => {
  for (const ms of [motion.pressMs, motion.toastInMs, motion.toastOutMs, motion.sheetInMs, motion.sheetOutMs, motion.panelInMs, motion.reducedMs]) {
    assert.ok(ms <= 300, `${ms} ms`);
  }
  assert.ok(motion.toastOutMs < motion.toastInMs);
  assert.ok(motion.sheetOutMs < motion.sheetInMs);
  // damping ratio = damping / (2 * sqrt(stiffness * mass)) = 0.8: settles with a hint of overshoot
  const { stiffness, damping, mass } = motion.springSnap;
  assert.ok(Math.abs(damping / (2 * Math.sqrt(stiffness * mass)) - 0.8) < 0.01);
});

test('sheetDismiss: distance OR velocity closes; a slow short pull or an upward flick does not', () => {
  assert.equal(sheetDismiss(10, 0.1, 600), false); // short and slow: spring back
  assert.equal(sheetDismiss(200, 0, 600), true); // past 30% of the height
  assert.equal(sheetDismiss(40, 0.9, 600), true); // a quick flick is enough
  assert.equal(sheetDismiss(-30, -0.4, 600), false); // pulled up (rubber band)
  assert.equal(sheetDismiss(0, 0, 0), false);
});

test('flingDuration: faster fingers finish sooner, within 140-320 ms', () => {
  const slow = flingDuration(120, 0.6);
  const fast = flingDuration(120, 3);
  assert.ok(fast < slow);
  assert.ok(fast >= 140 && slow <= 320);
  assert.equal(flingDuration(0, 1), 140);
  assert.equal(flingDuration(400, 0), 320); // no velocity: the slowest allowed, never infinite
});

test('global web CSS: no tap flash, eased press feedback with the shared curve, themed selection', () => {
  const css = webGlobalCss();
  assert.match(css, /-webkit-tap-highlight-color:transparent/);
  assert.match(css, /touch-action:manipulation/);
  assert.ok(css.includes(`transform ${motion.pressMs}ms ${cssBezier(motion.easeOut)}`));
  assert.match(css, /::selection\{background:#DCEEE9/);
});
