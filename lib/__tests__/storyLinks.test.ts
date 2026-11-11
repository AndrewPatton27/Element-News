import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFeatureApi } from '../api/api.mockFeatures.ts';
import { card } from './helpers.ts';

const NW = [{ symbol: 'NWND', name: 'Northwind' }];

test('linked stories appear first in related cards and Following with exact reasons', () => {
  const followed = card({ id: 'followed', headline: 'Followed story', category: 'earnings', tickers: NW, sort_at: new Date().toISOString() });
  const upd = card({ id: 'upd', tickers: NW, headline: 'Update', category: 'world', sort_at: new Date().toISOString() });
  const ang = card({ id: 'ang', tickers: NW, headline: 'Angle', category: 'world', sort_at: new Date().toISOString() });
  const rel = card({ id: 'rel', tickers: NW, headline: 'Related', category: 'world', sort_at: new Date().toISOString() });
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

test('M9c #4: a story link counts only when the cards share a ticker or macro series', () => {
  const now = new Date().toISOString();
  const yieldCard = card({ id: 'y', headline: 'Yield', category: 'markets', kind: 'data', tickers: [], macro: [{ series_id: 'DGS10', label: '10-yr', value: '4%' }] as never, sort_at: now });
  const yield2 = card({ id: 'y2', headline: 'Yield again', category: 'markets', kind: 'data', tickers: [], macro: [{ series_id: 'DGS10', label: '10-yr', value: '4.1%' }] as never, sort_at: now });
  const earnings = card({ id: 'e', headline: 'Northwind earnings', category: 'earnings', tickers: NW, sort_at: now });
  const links = [
    { card_id: 'y2', related_id: 'y', kind: 'update' as const },
    { card_id: 'e', related_id: 'y', kind: 'update' as const },
  ];
  const api = createMockFeatureApi([yieldCard, yield2, earnings], [], [], links);
  assert.deepEqual(api.relatedCards('y', 5).filter((c) => c.story_link).map((c) => c.id), ['y2']);
  const items = api.followingFeed({ topics: ['markets'], sources: [], tickers: [], limit: 20 }).items;
  const e = items.find((c) => c.id === 'e');
  assert.notEqual(e?.follow_reason, 'Update to a story you follow');
  assert.equal(items.filter((c) => c.id === 'y').length, 1);
  assert.equal(items.filter((c) => c.id === 'y2').length, 1);
});

test('M9c #4: the generated sample chain never links cards that share nothing', () => {
  const now = new Date().toISOString();
  const cards = [
    card({ id: 'a', category: 'markets', kind: 'data', tickers: [], macro: [{ series_id: 'DGS10', label: '10-yr', value: '4%' }] as never, sort_at: now }),
    card({ id: 'b', category: 'earnings', tickers: NW, sort_at: now }),
    card({ id: 'c', category: 'world', tickers: [], macro: [], sort_at: now }),
  ];
  const api = createMockFeatureApi(cards, [], []);
  assert.deepEqual(api.relatedCards('a', 5).filter((c) => c.story_link), []);
});
