import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECENT_MAX,
  SEARCH_MAX_CHARS,
  addRecent,
  canSearch,
  emptyResultsMessage,
  normalizeQuery,
  parseRecents,
  removeRecent,
  resultCountText,
  searchKey,
  searchTarget,
  serializeRecents,
  suggestedTopics,
} from '../search/searchLogic.ts';
import type { Category } from '../../contract/types.ts';

test('normalizeQuery trims, collapses spaces and caps the length', () => {
  assert.equal(normalizeQuery('  federal   reserve '), 'federal reserve');
  assert.equal(normalizeQuery('x'.repeat(200)).length, SEARCH_MAX_CHARS);
  assert.equal(normalizeQuery('   '), '');
});

test('canSearch needs 2 characters after trimming', () => {
  assert.equal(canSearch(''), false);
  assert.equal(canSearch(' a '), false);
  assert.equal(canSearch('BA'), true);
  assert.equal(canSearch(' ba '), true);
});

test('searchTarget: idle, short, query, category', () => {
  assert.deepEqual(searchTarget('', null), { kind: 'idle' });
  assert.deepEqual(searchTarget(' ', null), { kind: 'idle' });
  assert.deepEqual(searchTarget('a', null), { kind: 'short' });
  assert.deepEqual(searchTarget(' Boeing  ', null), { kind: 'query', q: 'Boeing' });
  // a chosen category wins over the text
  assert.deepEqual(searchTarget('boe', { slug: 'safety', name: 'Recalls & Safety' }), { kind: 'category', slug: 'safety', name: 'Recalls & Safety' });
});

test('searchKey: same words in another case share a key; idle and short have none', () => {
  assert.equal(searchKey({ kind: 'idle' }), null);
  assert.equal(searchKey({ kind: 'short' }), null);
  assert.equal(searchKey({ kind: 'query', q: 'Boeing' }), searchKey({ kind: 'query', q: 'boeing' }));
  assert.notEqual(searchKey({ kind: 'query', q: 'safety' }), searchKey({ kind: 'category', slug: 'safety', name: 'Safety' }));
});

test('addRecent puts the newest first, drops duplicates ignoring case, and caps the list', () => {
  assert.deepEqual(addRecent(['Boeing', 'Inflation'], 'inflation'), ['inflation', 'Boeing']);
  assert.deepEqual(addRecent([], ' Fed  rates '), ['Fed rates']);
  assert.deepEqual(addRecent(['Boeing'], 'a'), ['Boeing']); // too short to keep
  let list: string[] = [];
  for (let i = 0; i < RECENT_MAX + 4; i++) list = addRecent(list, `query ${i}`);
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0], `query ${RECENT_MAX + 3}`);
});

test('removeRecent removes one entry', () => {
  assert.deepEqual(removeRecent(['a1', 'b2', 'c3'], 'b2'), ['a1', 'c3']);
});

test('parseRecents survives missing, broken and odd storage', () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents('not json'), []);
  assert.deepEqual(parseRecents('{"a":1}'), []);
  assert.deepEqual(parseRecents(JSON.stringify(['Boeing', 7, 'boeing', 'x', ' Fed '])), ['Boeing', 'Fed']);
  assert.deepEqual(parseRecents(serializeRecents(['Boeing', 'Inflation'])), ['Boeing', 'Inflation']);
});

test('suggestedTopics leaves out hidden topics', () => {
  const cats = [
    { slug: 'world', name: 'World' },
    { slug: 'economy', name: 'Economy' },
  ] as Category[];
  assert.deepEqual(suggestedTopics(cats, ['world']).map((c) => c.slug), ['economy']);
  assert.equal(suggestedTopics(cats).length, 2);
});

test('resultCountText and emptyResultsMessage', () => {
  assert.equal(resultCountText(0, true), 'No results');
  assert.equal(resultCountText(1, true), '1 result');
  assert.equal(resultCountText(12, true), '12 results');
  assert.equal(resultCountText(20, false), '20+ results');
  assert.match(emptyResultsMessage({ kind: 'query', q: 'zzz' }), /zzz/);
  assert.match(emptyResultsMessage({ kind: 'category', slug: 'safety', name: 'Recalls & Safety' }), /Recalls & Safety/);
  assert.equal(emptyResultsMessage({ kind: 'idle' }), '');
});
