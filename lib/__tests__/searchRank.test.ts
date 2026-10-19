import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, isTypo, matchedTermCount, rankSearch, searchScore, searchTerms, SEARCH_TERM_BONUS, termScores } from '../search/searchLogic.ts';
import { createMockFeatureApi } from '../api/api.mockFeatures.ts';
import { card, dataCard } from './helpers.ts';
import type { BlurbCard } from '../../contract/types.ts';

// Trending hours set per card so the order is easy to read.
const hours = new Map<string, number>();
const trend = (c: BlurbCard) => hours.get(c.id) ?? 0;
function mk(id: string, headline: string, body: string, h: number, over: Partial<BlurbCard> = {}): BlurbCard {
  hours.set(id, h);
  return card({ id, headline, body, tickers: [], sources: [{ ...card().sources[0], name: 'Test Source' }], ...over });
}

const cards = [
  mk('fedhold', 'Federal Reserve holds steady', 'The central bank kept its benchmark unchanged.', 1),
  mk('mortgage', 'Mortgage rates climb', 'Home loan costs rose this week.', 5),
  mk('fedcut', 'Fed cuts rates', 'Policy makers lowered borrowing costs.', 0),
  mk('apple', 'Apple posts quarterly results', 'Sales grew.', 2, { tickers: [{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'Nasdaq', quote: null }] }),
  mk('oil', 'Oil jumps after supply cut', 'Barrel costs rose.', 3),
  mk('chile', 'Earthquake shakes northern Chile', 'Damage was light.', 1.5),
  mk('infl', 'Inflation cools in September', 'Consumer costs rose more slowly.', 2.5),
];
const ids = (q: string) => rankSearch(cards, q, trend).map((c) => c.id);

test('searchTerms: lowercase, no punctuation, no stopwords, no repeats, at most 6', () => {
  assert.deepEqual(searchTerms('  The FED, rate!! '), ['fed', 'rate']);
  assert.deepEqual(searchTerms('a b c'), []);
  assert.deepEqual(searchTerms('the of'), []);
  assert.deepEqual(searchTerms('x'), []);
  assert.deepEqual(searchTerms('one two three four five six seven two'), ['one', 'two', 'three', 'four', 'five', 'six']);
});

test('search finds a word, a prefix and a stem', () => {
  assert.ok(ids('federal').includes('fedhold'));
  assert.ok(ids('infl').includes('infl'));
  assert.ok(ids('climbing').includes('mortgage'));
});

test('search finds similar words (synonyms)', () => {
  assert.ok(ids('wti').includes('oil'));
  assert.ok(ids('quake').includes('chile'));
  assert.ok(ids('fomc').includes('fedhold'));
  assert.ok(ids('cpi').includes('infl'));
});

test('search tolerates typos', () => {
  assert.ok(ids('federl').includes('fedhold'));
  assert.ok(ids('inflaton').includes('infl'));
  assert.ok(ids('earthqake').includes('chile'));
  assert.equal(editDistance('federl', 'federal'), 1);
  assert.equal(isTypo('oil', 'oils'), false, 'short words get no typo matching');
});

test('search finds exact tickers and series ids', () => {
  assert.deepEqual(ids('AAPL'), ['apple']);
  assert.deepEqual(ids('aapl'), ['apple']);
  const d = dataCard();
  assert.equal(matchedTermCount(d, [d.macro[0].series_id.toLowerCase()]), 1);
});

test('multiple words: any word matches; more and better matches first, then trending (x1.3 bonus per extra word)', () => {
  // fedcut matches both words (0.5 + 0.8), fedhold one exact (1.0), mortgage one stem (0.8).
  assert.deepEqual(ids('fed rate'), ['fedcut', 'fedhold', 'mortgage']);
  assert.ok(Math.abs(searchScore(0, 2) - 8 * Math.log2(SEARCH_TERM_BONUS)) < 1e-9);
});

test('ordering by trending: a more trending match comes first; empty and no-match give nothing', () => {
  assert.deepEqual(ids('costs'), ['mortgage', 'oil', 'infl', 'fedcut']);
  hours.set('mortgage', 0); hours.set('oil', 6);
  assert.deepEqual(ids('costs'), ['oil', 'infl', 'mortgage', 'fedcut']);
  hours.set('mortgage', 5); hours.set('oil', 3);
  hours.set('fedhold', 1);
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids('qqqxxnomatch'), []);
});

test('quality gate blocks source-prefix false positives and weak metadata; short oil cannot typo-match quake', () => {
  const faa = mk('faa', 'FAA updates aviation rule', 'New Federal Register notice.', 100,
    { sources: [{ ...card().sources[0], name: 'Federal Register' }], category: 'safety' });
  assert.deepEqual(rankSearch([faa], 'fed rate', trend), []);
  assert.deepEqual(rankSearch([cards.find((c) => c.id === 'chile')!], 'oil', trend), []);
  assert.ok(ids('recall').includes('chile') === false);
});

test('mock api search pages through the same results without repeats', () => {
  const api = createMockFeatureApi(cards, [], []);
  const first = api.search('costs', null, 2);
  const second = api.search('costs', first.next_cursor, 2);
  assert.equal(first.items.length, 2);
  assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((c) => c.id)).size, 4);
});

test('v4: a headline or summary match outranks a detail-only match; Trending breaks ties; gate unchanged', () => {
  // Real trending keys are hours since 1970 (about 490,000), as in the database and mockRankScore.
  const B = Date.parse('2026-10-19T00:00:00Z') / 3_600_000;
  const detail = (p: string) => ({ key_points: ['Revenue rose.'], paragraphs: [p] });
  const fed = mk('v4fed', 'Fed holds interest rates steady', 'Officials said inflation is still too high.', B + 1);
  const cpi = mk('v4cpi', 'Inflation cools in September', 'Price growth slowed.', B + 2);
  const pep = mk('v4pep', 'Snack maker reports quarterly earnings', 'Revenue rose 5%.', B + 50,
    { detail: detail('Cost cuts aim to offset rising input cost inflation.') });
  const weak = mk('v4weak', 'Bridge reopens after repairs', 'Traffic moves.', B + 100,
    { sources: [{ ...card().sources[0], name: 'Inflation Monitor' }] });
  const pool = [pep, fed, cpi, weak];
  const order = (q: string) => rankSearch(pool, q, trend).map((c) => c.id);
  assert.deepEqual(order('inflation'), ['v4cpi', 'v4fed', 'v4pep'], 'visible first (Trending among them), detail-only last, source-only dropped');
  assert.deepEqual(order('inflaton'), ['v4cpi', 'v4fed', 'v4pep'], 'typo still matches, detail-only typo still passes the gate');
  assert.ok(order('cpi').includes('v4cpi'), 'synonym still works');
  assert.deepEqual(termScores('inflation', pep), { gate: 1, rank: 0.2 });
  assert.deepEqual(termScores('inflation', cpi), { gate: 1, rank: 1 });
  hours.set('v4fed', B + 3);
  assert.deepEqual(order('inflation'), ['v4fed', 'v4cpi', 'v4pep'], 'equal visible matches follow Trending');
});
