import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTopicFollowed, toggleTopicFollow } from '../followingLogic.ts';

test('card topic follow toggles on and off without changing other follows', () => {
  const current = ['markets', 'policy'];
  assert.deepEqual(toggleTopicFollow(current, 'safety'), ['markets', 'policy', 'safety']);
  assert.deepEqual(toggleTopicFollow(current, 'markets'), ['policy']);
  assert.deepEqual(current, ['markets', 'policy']);
});

test('card follow state looks up the exact topic slug', () => {
  assert.equal(isTopicFollowed(['markets'], 'markets'), true);
  assert.equal(isTopicFollowed(['markets'], 'market'), false);
});
