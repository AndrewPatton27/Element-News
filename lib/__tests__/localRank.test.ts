import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RANK, localScore, rankLocal } from '../localRank.ts';
import { EMPTY_LOCAL, withHiddenSources, withReaction, withTopics } from '../localPrefs.ts';
import { card, dataCard } from './helpers.ts';
import type { BlurbCard } from '../../contract/types.ts';

const at = (h: number) => new Date(Date.UTC(2026, 9, 17, h)).toISOString();
const c = (id: string, category: string, hour: number, over: Partial<BlurbCard> = {}) =>
  card({ id, category: category as BlurbCard['category'], sort_at: at(hour), importance: 1, ...over });
const ids = (l: BlurbCard[]) => l.map((x) => x.id);

test('no choices: newest first (recency kept), deterministic ties', () => {
  const list = [c('old', 'earnings', 1), c('new', 'tech', 10), c('mid', 'safety', 5)];
  assert.deepEqual(ids(rankLocal(list, EMPTY_LOCAL)), ['new', 'mid', 'old']);
  const tie = [c('b', 'tech', 3), c('a', 'safety', 3)];
  assert.deepEqual(ids(rankLocal(tie, EMPTY_LOCAL)), ['a', 'b']);
  assert.deepEqual(ids(rankLocal(tie, EMPTY_LOCAL)), ids(rankLocal(tie.slice().reverse(), EMPTY_LOCAL)));
});

test('liked topic and favorite topic rise; disliked topic sinks; disliked card leaves', () => {
  const liked = c('liked-before', 'space', 0);
  let prefs = withReaction(EMPTY_LOCAL, liked, 'like');
  const list = [c('econ', 'economy', 10), c('space', 'space', 4)];
  assert.deepEqual(ids(rankLocal(list, prefs)), ['space', 'econ']); // +8 topic, +4 same source
  prefs = withTopics(prefs, ['economy'], []);
  assert.deepEqual(ids(rankLocal(list, prefs)), ['econ', 'space']); // +24 favorite
  const disliked = withReaction(EMPTY_LOCAL, c('x', 'economy', 0, { sources: [] }), 'dislike');
  assert.ok(localScore(list[0], disliked) < localScore(list[0], EMPTY_LOCAL) - RANK.dislikeTopic + 0.001);
  const gone = withReaction(EMPTY_LOCAL, list[0], 'dislike');
  assert.deepEqual(ids(rankLocal(list, gone)), ['space']);
});

test('hidden topics and sources drop out', () => {
  const list = [c('a', 'economy', 3), dataCard({ id: 'd', sort_at: at(4) }), c('b', 'tech', 2)];
  const prefs = withHiddenSources(withTopics(EMPTY_LOCAL, [], ['tech']), ['fred']);
  assert.deepEqual(ids(rankLocal(list, prefs)), ['a']);
});

test('diversity: one topic does not fill the top of the page', () => {
  const list = [c('t1', 'tech', 10), c('t2', 'tech', 9.5), c('t3', 'tech', 9), c('s1', 'safety', 6)];
  // Without the repeat cost safety (4h older) would be last; after one tech card it moves up.
  assert.deepEqual(ids(rankLocal(list, EMPTY_LOCAL)), ['t1', 's1', 't2', 't3']);
});
