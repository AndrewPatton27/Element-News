import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlurbCard, isHttpUrl, parseAppConfig, parseCategories, parseFeedPage, parseMacroFacts } from '../shared/types.ts';
import { card, config, dataCard, fact } from './helpers.ts';

test('isHttpUrl accepts only https URLs (matches the DB CHECK)', () => {
  assert.equal(isHttpUrl('https://example.com'), true);
  assert.equal(isHttpUrl('https://fred.stlouisfed.org/series/DGS10'), true);
  assert.equal(isHttpUrl('HTTPS://EXAMPLE.COM'), true);
  // Rejected: cleartext, other schemes, non-strings, empty/whitespace.
  assert.equal(isHttpUrl('http://example.com'), false);
  assert.equal(isHttpUrl('HTTP://example.com'), false);
  assert.equal(isHttpUrl('ftp://example.com'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('https://'), false);
  assert.equal(isHttpUrl('https:// has space'), false);
  assert.equal(isHttpUrl(''), false);
  assert.equal(isHttpUrl(null), false);
  assert.equal(isHttpUrl(42), false);
});

test('a card whose source url is http:// is rejected', () => {
  const bad = card();
  bad.sources[0] = { ...bad.sources[0], url: 'http://www.sec.gov/x' };
  assert.equal(isBlurbCard(bad), false);
});

test('valid summary and data cards pass', () => {
  assert.equal(isBlurbCard(card()), true);
  assert.equal(isBlurbCard(dataCard()), true);
});

test('cards without a usable source link are rejected', () => {
  assert.equal(isBlurbCard(card({ sources: [] })), false);
  const bad = card();
  bad.sources[0] = { ...bad.sources[0], url: 'javascript:alert(1)' };
  assert.equal(isBlurbCard(bad), false);
});

test('ticker rows need a non-empty symbol', () => {
  assert.equal(isBlurbCard(card({ tickers: [{ symbol: 'AAPL' }] })), true);
  assert.equal(isBlurbCard(card({ tickers: [{ symbol: null }] })), false);
  assert.equal(isBlurbCard(card({ tickers: [{ symbol: '' }] })), false);
});

test('unknown kinds, link_out, empty headlines and data cards without numbers are rejected', () => {
  assert.equal(isBlurbCard(card({ kind: 'link_out' })), false);
  assert.equal(isBlurbCard({ ...card(), kind: 'poll' }), false);
  assert.equal(isBlurbCard(card({ headline: '  ' })), false);
  assert.equal(isBlurbCard(dataCard({ macro: [] })), false);
  assert.equal(isBlurbCard(null), false);
  assert.equal(isBlurbCard('card'), false);
});

test('parseFeedPage filters bad rows and normalises the cursor', () => {
  const page = parseFeedPage({ items: [card(), { id: 'x' }, card({ id: 'l', kind: 'link_out' })], next_cursor: '' });
  assert.deepEqual(
    page.items.map((c) => c.id),
    ['c1'],
  );
  assert.equal(page.next_cursor, null);
  assert.throws(() => parseFeedPage({ nope: true }));
});

test('parseAppConfig accepts a row or a one-row array', () => {
  assert.equal(parseAppConfig(config()).disclaimer, 'Informational only · Not investment advice');
  assert.equal(parseAppConfig([config()]).ai_notice, 'AI-generated summary · may contain errors');
  assert.throws(() => parseAppConfig([]));
});

test('macro facts and categories are sorted by sort_order', () => {
  const facts = parseMacroFacts([fact({ series_id: 'B', sort_order: 2 }), fact({ series_id: 'A', sort_order: 1 }), { bad: 1 }]);
  assert.deepEqual(
    facts.map((f) => f.series_id),
    ['A', 'B'],
  );
  const cats = parseCategories([
    { slug: 'tech', name: 'Tech', sort_order: 2 },
    { slug: 'markets', name: 'Markets', sort_order: 1 },
  ]);
  assert.deepEqual(
    cats.map((c) => c.slug),
    ['markets', 'tech'],
  );
});
