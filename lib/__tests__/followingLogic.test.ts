import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_FOLLOWS,
  FOLLOWABLE_SOURCES,
  MAX_FOLLOWS_PER_KIND,
  effectiveFollows,
  followCountText,
  followReasonText,
  followsKey,
  hasFollows,
  isDirectMatch,
  normalizeTicker,
  parseFollows,
  serializeFollows,
  sourceLabel,
  toggleValue,
} from '../following/followingLogic.ts';
import { createMockFeatureApi } from '../api/api.mockFeatures.ts';
import { card } from './helpers.ts';
import type { Category } from '../../contract/types.ts';

const cats = [
  { slug: 'safety', name: 'Recalls & Safety' },
  { slug: 'economy', name: 'Economy' },
] as Category[];

test('parseFollows survives missing, broken and odd storage', () => {
  assert.deepEqual(parseFollows(null), EMPTY_FOLLOWS);
  assert.deepEqual(parseFollows('nope'), EMPTY_FOLLOWS);
  assert.deepEqual(parseFollows('[1]'), EMPTY_FOLLOWS);
  const f = parseFollows(JSON.stringify({ topics: ['economy', 3, 'economy'], sources: 'x', tickers: ['aapl', ' '] }));
  assert.deepEqual(f, { topics: ['economy'], sources: [], tickers: ['AAPL'] });
  assert.deepEqual(parseFollows(serializeFollows({ topics: ['a'], sources: ['SEC'], tickers: ['BA'] })), { topics: ['a'], sources: ['SEC'], tickers: ['BA'] });
});

test('toggleValue adds, removes, and refuses past the cap', () => {
  assert.deepEqual(toggleValue(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleValue(['a', 'b'], 'a'), ['b']);
  const full = Array.from({ length: MAX_FOLLOWS_PER_KIND }, (_, i) => `t${i}`);
  assert.equal(toggleValue(full, 'new'), full);
  assert.equal(toggleValue(full, 't1').length, MAX_FOLLOWS_PER_KIND - 1); // removing still works when full
});

test('normalizeTicker accepts 1-5 letters with an optional class and rejects the rest', () => {
  assert.equal(normalizeTicker(' aapl '), 'AAPL');
  assert.equal(normalizeTicker('ba'), 'BA');
  assert.equal(normalizeTicker('brk.b'), 'BRK.B');
  for (const bad of ['', 'toolong', 'A1', 'federal reserve', 'ab cd', '$AAPL']) assert.equal(normalizeTicker(bad), null, bad);
});

test('effectiveFollows: signed-in topics come from the account, the rest from the device', () => {
  const local = { topics: ['world'], sources: ['SEC'], tickers: ['BA'] };
  assert.deepEqual(effectiveFollows(local, null), local);
  assert.deepEqual(effectiveFollows(local, ['economy']), { topics: ['economy'], sources: ['SEC'], tickers: ['BA'] });
  assert.deepEqual(effectiveFollows(local, []), { topics: [], sources: ['SEC'], tickers: ['BA'] });
});

test('hasFollows, followsKey and followCountText', () => {
  assert.equal(hasFollows(EMPTY_FOLLOWS), false);
  assert.equal(hasFollows({ ...EMPTY_FOLLOWS, tickers: ['BA'] }), true);
  assert.equal(followsKey({ topics: ['b', 'a'], sources: [], tickers: [] }), followsKey({ topics: ['a', 'b'], sources: [], tickers: [] }));
  assert.notEqual(followsKey({ topics: ['a'], sources: [], tickers: [] }), followsKey({ topics: [], sources: [], tickers: ['a'] }));
  assert.equal(followCountText(EMPTY_FOLLOWS), '');
  assert.equal(followCountText({ topics: ['a'], sources: [], tickers: ['BA'] }), '1 topic · 1 company');
  assert.equal(followCountText({ topics: ['a', 'b'], sources: ['SEC'], tickers: ['BA', 'MSFT'] }), '2 topics · 1 source · 2 companies');
});

test('followReasonText turns a topic slug into its name and leaves other text alone', () => {
  assert.equal(followReasonText({ follow_reason: 'Because you follow safety' }, cats), 'Because you follow Recalls & Safety');
  assert.equal(followReasonText({ follow_reason: 'Related to economy' }, cats), 'Related to Economy');
  assert.equal(followReasonText({ follow_reason: 'Because you follow AAPL' }, cats), 'Because you follow AAPL');
  assert.equal(followReasonText({ follow_reason: 'Because you follow Federal Reserve Board' }, cats), 'Because you follow Federal Reserve');
  assert.equal(followReasonText({ follow_reason: 'Because you follow personal-finance' }, cats), 'Because you follow Money');
  assert.equal(followReasonText({ follow_reason: 'Something else' }, cats), 'Something else');
  assert.equal(followReasonText({}, cats), null);
  assert.equal(followReasonText({ follow_reason: '  ' }, cats), null);
});

test('isDirectMatch', () => {
  assert.equal(isDirectMatch({ follow_reason: 'Because you follow BA' }), true);
  assert.equal(isDirectMatch({ follow_reason: 'Related to BA' }), false);
  assert.equal(isDirectMatch({}), false);
});

test('followable sources use the names cards carry, with a plain label', () => {
  assert.ok(FOLLOWABLE_SOURCES.some((s) => s.name === 'Federal Reserve Board' && s.label === 'Federal Reserve'));
  assert.equal(sourceLabel('SEC'), 'SEC filings');
  assert.equal(sourceLabel('Unknown outlet'), 'Unknown outlet');
});

// The mock API is what the screens run against while the real RPCs are not live.
const api = createMockFeatureApi(
  [
    card({ id: 'a', headline: '[SAMPLE] Northwind beats estimates', category: 'earnings' }),
    card({ id: 'b', headline: '[SAMPLE] Fed holds rates steady', category: 'policy', tickers: [], sources: [{ ...card().sources[0], name: 'Federal Reserve Board' }] }),
    card({ id: 'c', headline: '[SAMPLE] Another earnings report', category: 'earnings', tickers: [] }),
  ],
  [],
  [],
);

test('mock followingFeed: followed-topic cards say why; no follows gives the top feed', () => {
  const none = api.followingFeed({ topics: [], sources: [], tickers: [] });
  assert.equal(none.items.length, 3);
  assert.ok(none.items.every((c) => c.follow_reason === undefined));
  const page = api.followingFeed({ topics: ['policy'], sources: [], tickers: [] });
  assert.equal(page.items[0].id, 'b');
  assert.equal(followReasonText(page.items[0], cats), 'Because you follow Government');
  const bySource = api.followingFeed({ topics: [], sources: ['Federal Reserve Board'], tickers: [] });
  assert.equal(followReasonText(bySource.items[0], cats), 'Because you follow Federal Reserve');
});

test('mock search: 2+ characters find cards, 1 character finds none', () => {
  assert.deepEqual(api.search('fed').items.map((c) => c.id), ['b']);
  assert.equal(api.search('a').items.length, 0);
  assert.equal(api.search('zzzzqqqq').items.length, 0);
});
