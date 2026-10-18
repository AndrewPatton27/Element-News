import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forYouProgress, recordSeen, readSeen, MAX_SEEN, FOR_YOU_MIN_STORIES, FOR_YOU_MIN_TOPICS } from '../forYouGate.ts';
import { memoryStore } from '../storage.ts';

const mk = (n: number, topics: number, p = 's') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, category: `t${i % topics}` }));

test('thresholds are 10 stories and 4 topics', () => {
  assert.equal(FOR_YOU_MIN_STORIES, 10);
  assert.equal(FOR_YOU_MIN_TOPICS, 4);
});

test('locked below and unlocked exactly at the thresholds', () => {
  assert.equal(forYouProgress({}).ready, false);
  assert.equal(forYouProgress({ seen: mk(9, 4) }).ready, false);
  assert.equal(forYouProgress({ seen: mk(10, 3) }).ready, false);
  assert.deepEqual(forYouProgress({ seen: mk(10, 4) }), { stories: 10, topics: 4, ready: true });
  assert.equal(forYouProgress({ seen: mk(15, 6) }).ready, true);
});

test('one-topic readers stay locked however much they read', () => {
  assert.equal(forYouProgress({ seen: mk(50, 1) }).ready, false);
});

test('reacted and seen are combined and deduped by id', () => {
  const r = forYouProgress({ reacted: mk(6, 4), seen: [...mk(6, 4), ...mk(4, 4, 'x')] });
  assert.equal(r.stories, 10);
  assert.equal(r.ready, true);
});

test('recordSeen stores once per id and caps the list', () => {
  const st = memoryStore();
  recordSeen(st, { id: 'a', category: 'x' }, 1);
  recordSeen(st, { id: 'a', category: 'x' }, 2);
  assert.equal(readSeen(st).length, 1);
  for (let i = 0; i < MAX_SEEN + 20; i++) recordSeen(st, { id: `c${i}`, category: 'x' }, i);
  assert.equal(readSeen(st).length, MAX_SEEN);
  assert.equal(readSeen(memoryStore()).length, 0);
});
