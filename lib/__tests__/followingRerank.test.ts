import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerankFollowing } from '../followingRerank.ts';
import { EMPTY_LOCAL, withReaction } from '../localPrefs.ts';
import { card } from './helpers.ts';
import type { BlurbCard } from '../../contract/types.ts';

const at = (h: number) => new Date(Date.UTC(2026, 9, 17, h)).toISOString();
const c = (id: string, category: string, hour: number, reason: string, extra: Partial<BlurbCard> = {}) =>
  card({ id, category: category as BlurbCard['category'], sort_at: at(hour), published_at: at(hour), follow_reason: reason, ...extra });
const ids = (cards: BlurbCard[]) => cards.map((x) => x.id);

test('a liked topic rises and a disliked topic falls within the direct tier', () => {
  const base = [c('economy', 'economy', 10, 'Because you follow economy'), c('safety', 'safety', 8, 'Because you follow safety')];
  const liked = withReaction(EMPTY_LOCAL, c('prior', 'safety', 1, '', { sources: [] }), 'like');
  assert.deepEqual(ids(rerankFollowing(base, liked)), ['safety', 'economy']);
  const disliked = withReaction(EMPTY_LOCAL, c('prior', 'economy', 1, '', { sources: [] }), 'dislike');
  assert.deepEqual(ids(rerankFollowing(base, disliked)), ['safety', 'economy']);
});

test('direct matches remain above related cards; output is stable and idempotent', () => {
  const list = [c('related-new', 'tech', 12, 'Related to tech'), c('direct-old', 'safety', 1, 'Because you follow safety'), c('direct-new', 'safety', 3, 'Because you follow safety'), c('related-old', 'tech', 2, 'Related to tech')];
  const once = rerankFollowing(list, EMPTY_LOCAL);
  assert.deepEqual(ids(once).slice(0, 2), ['direct-new', 'direct-old']);
  assert.deepEqual(ids(rerankFollowing(once, EMPTY_LOCAL)), ids(once));
  assert.deepEqual(ids(rerankFollowing(list, EMPTY_LOCAL)), ids(once));
});
