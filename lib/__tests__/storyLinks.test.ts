import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFeatureApi } from '../api/api.mockFeatures.ts';
import { card } from './helpers.ts';

test('linked stories appear first in related cards and Following with exact reasons', () => {
  const followed = card({ id: 'followed', headline: 'Followed story', category: 'earnings', sort_at: new Date().toISOString() });
  const upd = card({ id: 'upd', headline: 'Update', category: 'world', sort_at: new Date().toISOString() });
  const ang = card({ id: 'ang', headline: 'Angle', category: 'world', sort_at: new Date().toISOString() });
  const rel = card({ id: 'rel', headline: 'Related', category: 'world', sort_at: new Date().toISOString() });
  const links = [
    { card_id: 'upd', related_id: 'followed', kind: 'update' as const },
    { card_id: 'ang', related_id: 'followed', kind: 'angle' as const },
    { card_id: 'rel', related_id: 'followed', kind: 'related' as const },
  ];
  const api = createMockFeatureApi([followed, upd, ang, rel], [], [], links);
  const following = api.followingFeed({ topics: ['earnings'], sources: [], tickers: [], limit: 20 }).items;
  assert.deepEqual(following.slice(0, 4).map((c) => c.id), ['followed', 'upd', 'ang', 'rel']);
  assert.deepEqual(following.slice(1).map((c) => c.follow_reason), ['Update to a story you follow', 'Another angle on a story you follow', 'Related to something you follow']);
  assert.deepEqual(api.relatedCards('followed', 3).map((c) => c.id), ['upd', 'ang', 'rel']);
});
