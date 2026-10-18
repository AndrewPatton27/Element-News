import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFollowedStories, toggleStory, isStoryFollowed, updatesFor, storyBadge, storiesHeader, sortStories, serializeFollowedStories } from '../followedStories.ts';
import type { BlurbCard } from '../../contract/types.ts';

const c = (id: string, published_at: string) => ({ id, published_at, sources: [] }) as unknown as BlurbCard;

test('toggle adds newest first and removes', () => {
  let l = toggleStory([], 'a', 1);
  l = toggleStory(l, 'b', 2);
  assert.deepEqual(l.map((s) => s.id), ['b', 'a']);
  assert.ok(isStoryFollowed(l, 'a'));
  assert.deepEqual(toggleStory(l, 'a').map((s) => s.id), ['b']);
});

test('parse is forgiving and round-trips', () => {
  assert.deepEqual(parseFollowedStories('nope'), []);
  assert.deepEqual(parseFollowedStories(null), []);
  const l = toggleStory([], 'a', 5);
  assert.deepEqual(parseFollowedStories(serializeFollowedStories(l)), l);
});

test('updates are newer cards, newest first', () => {
  const s = c('s', '2026-10-01T00:00:00Z');
  const u = updatesFor(s, [c('old', '2026-09-01T00:00:00Z'), c('n1', '2026-10-02T00:00:00Z'), c('n2', '2026-10-03T00:00:00Z'), s]);
  assert.deepEqual(u.map((x) => x.id), ['n2', 'n1']);
});

test('badge, header and sort', () => {
  const now = new Date('2026-10-03T02:00:00Z');
  assert.equal(storyBadge([c('n', '2026-10-03T00:00:00Z')], now), 'Updated 2 h ago');
  assert.equal(storyBadge([], now), 'No new update yet');
  assert.deepEqual(storiesHeader(2, 3), { left: '3 stories', right: '2 updated' });
  assert.equal(storiesHeader(0, 1).left, '1 story');
  const rows = sortStories([
    { story: c('a', '2026-10-01T00:00:00Z'), updates: [] },
    { story: c('b', '2026-10-01T00:00:00Z'), updates: [c('u1', '2026-10-02T00:00:00Z')] },
    { story: c('d', '2026-10-01T00:00:00Z'), updates: [c('u2', '2026-10-03T00:00:00Z')] },
  ]);
  assert.deepEqual(rows.map((r) => r.story.id), ['d', 'b', 'a']);
});
