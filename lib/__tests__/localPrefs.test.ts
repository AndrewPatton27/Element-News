import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_LOCAL,
  DEVICE_DATA_KEYS,
  clearAll,
  LOCAL_PREFS_KEY,
  MAX_LOCAL_REACTIONS,
  asUserPrefs,
  favoritesFirst,
  hasLocalChoices,
  mergeIntoAccount,
  reactionMap,
  readLocal,
  withHiddenSources,
  withReaction,
  withTopics,
  writeLocal,
} from '../localPrefs.ts';
import { FOLLOWS_KEY } from '../followingLogic.ts';
import { memoryStore, onStoreChange, defaultStore } from '../storage.ts';
import { card } from './helpers.ts';

test('readLocal survives empty and broken storage', () => {
  const s = memoryStore();
  assert.deepEqual(readLocal(s), EMPTY_LOCAL);
  s.set(LOCAL_PREFS_KEY, 'nope');
  s.set(FOLLOWS_KEY, '{bad');
  assert.deepEqual(readLocal(s), EMPTY_LOCAL);
  s.set(LOCAL_PREFS_KEY, JSON.stringify({ reactions: { a: { r: 'meh', topic: 'x' }, b: { r: 'like', topic: 'tech' } }, hiddenTopics: [1, 'x'] }));
  const p = readLocal(s);
  assert.deepEqual(Object.keys(p.reactions), ['b']);
  assert.deepEqual(p.hiddenTopics, ['x']);
});

test('reactions toggle, switch, round-trip and stay bounded', () => {
  const s = memoryStore();
  const c = card({ id: 'a', category: 'earnings' });
  let p = withReaction(EMPTY_LOCAL, c, 'like', 1);
  assert.equal(p.reactions.a.r, 'like');
  assert.equal(p.reactions.a.topic, 'earnings');
  assert.equal(p.reactions.a.source, 'sec');
  p = withReaction(p, c, 'dislike', 2);
  assert.deepEqual(reactionMap(p), { a: 'dislike' });
  writeLocal(s, p);
  assert.deepEqual(readLocal(s).reactions, p.reactions);
  p = withReaction(p, c, 'dislike', 3);
  assert.deepEqual(reactionMap(p), {});
  for (let i = 0; i < MAX_LOCAL_REACTIONS + 5; i++) p = withReaction(p, card({ id: `x${i}` }), 'like', i);
  assert.equal(Object.keys(p.reactions).length, MAX_LOCAL_REACTIONS);
  assert.equal(p.reactions.x0, undefined); // oldest dropped
});

test('topics: hidden wins, favorites share the Following list', () => {
  const s = memoryStore();
  const p = withTopics(EMPTY_LOCAL, ['tech', 'safety'], ['safety']);
  assert.deepEqual(p.follows.topics, ['tech']);
  assert.deepEqual(p.hiddenTopics, ['safety']);
  writeLocal(s, withHiddenSources(p, ['nasa']));
  assert.deepEqual(JSON.parse(s.get(FOLLOWS_KEY)!).topics, ['tech']);
  const u = asUserPrefs(readLocal(s));
  assert.deepEqual(u, { followed: ['tech'], hidden: ['safety'], hiddenSources: ['nasa'], onboarded: true });
  assert.equal(hasLocalChoices(EMPTY_LOCAL), false);
  assert.equal(hasLocalChoices(p), true);
});

test('favoritesFirst puts favorites first in saved order', () => {
  const list = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
  assert.deepEqual(favoritesFirst(list, ['c', 'zz', 'b']).map((x) => x.slug), ['c', 'b', 'a']);
  assert.equal(favoritesFirst(list, []), list);
});

test('mergeIntoAccount is a union, account wins conflicts, and is idempotent', () => {
  let local = withTopics(EMPTY_LOCAL, ['tech', 'safety'], ['economy', 'space']);
  local = withHiddenSources(local, ['nasa']);
  local = withReaction(local, card({ id: 'a' }), 'like', 1);
  local = withReaction(local, card({ id: 'b' }), 'dislike', 2);
  const account = { followed: ['economy'], hidden: ['tech'], hiddenSources: [], onboarded: true };
  const plan = mergeIntoAccount(account, local, { b: 'like' });
  assert.deepEqual(plan.prefs, { followed: ['economy', 'safety'], hidden: ['tech', 'space'], hiddenSources: ['nasa'] });
  assert.deepEqual(plan.reactions, [{ cardId: 'a', event: 'like' }]);
  const again = mergeIntoAccount({ ...plan.prefs!, onboarded: true }, local, { a: 'like', b: 'like' });
  assert.equal(again.prefs, null);
  assert.deepEqual(again.reactions, []);
  // Server without hidden sources: they are not sent.
  const old = mergeIntoAccount({ ...account, hiddenSources: null }, local);
  assert.equal('hiddenSources' in old.prefs!, false);
});

test('defaultStore writes notify listeners', () => {
  const seen: string[] = [];
  const off = onStoreChange((k) => seen.push(k));
  defaultStore().set('element.test-key', '1');
  defaultStore().remove('element.test-key');
  off();
  defaultStore().set('element.test-key', '2');
  assert.deepEqual(seen, ['element.test-key', 'element.test-key']);
});

test('clearAll removes choices, follows, recent searches and the tour flag; the login is left alone', () => {
  const s = memoryStore();
  writeLocal(s, withTopics(EMPTY_LOCAL, ['tech'], ['crypto']));
  s.set('element.recent-searches', '["apple"]');
  s.set('element.tutorial-seen.v1', 'x');
  s.set('sb-session', 'keep-me');
  clearAll(s);
  for (const k of DEVICE_DATA_KEYS) assert.equal(s.get(k), null, k);
  assert.deepEqual(readLocal(s), EMPTY_LOCAL);
  assert.equal(s.get('sb-session'), 'keep-me');
  assert.ok(DEVICE_DATA_KEYS.includes('element.recent-searches' as never) && DEVICE_DATA_KEYS.includes('element.tutorial-seen.v1' as never));
});
