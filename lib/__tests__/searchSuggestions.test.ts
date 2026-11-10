import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUGGESTION_MAX, guestOrder, pickSuggestions, seenIdsOf, suggestionMeta } from '../search/suggestions.ts';
import { EMPTY_LOCAL } from '../storage/localPrefs.ts';
import { card } from './helpers.ts';

const mk = (id: string, category: string, hoursAgo = 0, sourceName = 'SEC') =>
  card({ id, category, sort_at: new Date(Date.parse('2026-11-09T12:00:00Z') - hoursAgo * 3_600_000).toISOString(), importance: 1, sources: [{ ...card().sources[0], name: sourceName }] });

test('at most 5, in the order given, without seen, hidden topics, hidden sources or repeats', () => {
  const cards = [mk('a', 'tech'), mk('b', 'economy'), mk('a', 'tech'), mk('c', 'world'), mk('d', 'tech', 0, 'Federal Reserve Board'), mk('e', 'energy'), mk('f', 'deals'), mk('g', 'health'), mk('h', 'science')];
  assert.deepEqual(pickSuggestions(cards, { seenIds: [] }).map((c) => c.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(SUGGESTION_MAX, 5);
  const got = pickSuggestions(cards, { seenIds: ['b'], hiddenTopics: ['world'], hiddenSources: ['fed'] }).map((c) => c.id);
  assert.deepEqual(got, ['a', 'e', 'f', 'g', 'h']);
  assert.deepEqual(pickSuggestions([], { seenIds: [] }), []);
  assert.deepEqual(pickSuggestions(cards, { seenIds: cards.map((c) => c.id) }), [], 'everything seen: nothing to suggest');
});

test('seen = the For you seen list plus every card the reader reacted to', () => {
  const s = seenIdsOf([{ id: 'x' }, { id: 'y' }], { z: 'like' });
  assert.deepEqual([...s].sort(), ['x', 'y', 'z']);
  assert.equal(seenIdsOf([], null).size, 0);
});

test('guests: Trending re-ordered by the device-local follows (same ranking as the guest For you)', () => {
  const trending = [mk('econ1', 'economy', 0), mk('econ2', 'economy', 1), mk('tech1', 'tech', 2)];
  assert.equal(guestOrder(trending, EMPTY_LOCAL)[0].id, 'econ1');
  const followsTech = { ...EMPTY_LOCAL, follows: { topics: ['tech'], sources: [], tickers: [] } };
  assert.equal(guestOrder(trending, followsTech)[0].id, 'tech1');
});

test('meta line', () => {
  assert.equal(suggestionMeta('Economy', '2 h ago'), 'Economy · 2 h ago');
  assert.equal(suggestionMeta('Economy', ''), 'Economy');
});
