import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseCompactCard } from '../feed/cardFit.ts';

test('compact mode activates below the short-phone window threshold', () => {
  assert.equal(shouldUseCompactCard(667, 490), true);
  assert.equal(shouldUseCompactCard(739, 490), true);
  assert.equal(shouldUseCompactCard(740, 490), false);
});

test('compact mode also activates when feed chrome leaves a short pager viewport', () => {
  assert.equal(shouldUseCompactCard(844, 459), true);
  assert.equal(shouldUseCompactCard(844, 460), false);
  assert.equal(shouldUseCompactCard(0, 0), false);
});
