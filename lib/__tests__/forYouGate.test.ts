import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forYouProgress, recordSeen, readSeen, MAX_SEEN, FOR_YOU_MIN_STORIES, FOR_YOU_MIN_TOPICS } from '../feed/forYouGate.ts';
import { memoryStore } from '../storage/storage.ts';

const mk = (n: number, topics: number, p = 's') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, category: `t${i % topics}` }));

test('thresholds are 3 stories and 1 topic (M9 F4)', () => {
  assert.equal(FOR_YOU_MIN_STORIES, 3);
  assert.equal(FOR_YOU_MIN_TOPICS, 1);
});

test('locked below and unlocked exactly at the thresholds', () => {
  assert.equal(forYouProgress({}).ready, false);
  assert.equal(forYouProgress({ seen: mk(2, 2) }).ready, false);
  assert.deepEqual(forYouProgress({ seen: mk(3, 1) }), { stories: 3, topics: 1, ready: true });
  assert.equal(forYouProgress({ seen: mk(15, 6) }).ready, true);
});

test('one followed topic or company opens For you at once, with no stories read', () => {
  assert.equal(forYouProgress({ followed: 1 }).ready, true);
  assert.equal(forYouProgress({ followed: 0 }).ready, false);
  assert.equal(forYouProgress({ seen: mk(1, 1), followed: 2 }).ready, true);
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
