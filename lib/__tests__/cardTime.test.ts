import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardTime, relativeTime } from '../format.ts';
import { NOW, card, dataCard } from './helpers.ts';

test('cardTime: summary cards use as_of', () => {
  const c = card({ as_of: '2026-10-17T13:00:00Z', published_at: '2026-10-17T17:00:00Z' });
  assert.equal(cardTime(c, NOW), '5 h ago');
});

test('cardTime: data cards use published_at, not the observation date', () => {
  // Treasury-style card: as_of is the observation date (3 days ago), published 4 hours ago.
  const c = dataCard({ as_of: '2026-10-14T18:00:00Z', published_at: '2026-10-17T14:00:00Z' });
  assert.equal(cardTime(c, NOW), '4 h ago');
  assert.equal(cardTime(c, NOW), relativeTime(c.published_at, NOW));
});

test('cardTime: bad dates give an empty label, not "Invalid Date"', () => {
  assert.equal(cardTime(card({ as_of: 'nope' }), NOW), '');
  assert.equal(cardTime(dataCard({ published_at: 'nope' }), NOW), '');
});

test('cardTime: older cards fall back to a short date', () => {
  assert.equal(cardTime(card({ as_of: '2026-10-03T18:00:00Z' }), NOW), 'Oct 3');
});

test('the feed card and the detail sheet both use the shared cardTime helper', () => {
  for (const file of ['../../components/Card.tsx', '../../components/DetailSheet.tsx']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /cardTime\(card\)/, `${file} should call cardTime(card)`);
    assert.doesNotMatch(src, /relativeTime/, `${file} should not format times itself`);
  }
});
