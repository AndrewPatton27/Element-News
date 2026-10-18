import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignFirstCards } from '../feedOrder.ts';
import { card } from './helpers.ts';

test('assigns three distinct first cards when lists overlap heavily', () => {
  const a=card({id:'a'}), b=card({id:'b'}), c=card({id:'c'}), d=card({id:'d'});
  const o=assignFirstCards([a,b,c], [a,c,b], [a,b,c,d]);
  assert.deepEqual([o.latest[0].id,o.trending[0].id,o.forYou[0].id], ['a','c','b']);
  for (const list of Object.values(o)) assert.equal(new Set(list.map(x=>x.id)).size,list.length);
});
test('preserves first when already distinct and keeps tail order after promotion', () => {
  const a=card({id:'a'}), b=card({id:'b'}), c=card({id:'c'}), d=card({id:'d'});
  const o=assignFirstCards([a,b], [c,d], [b,c]);
  assert.deepEqual(o.trending.map(x=>x.id), ['c','d']);
  const p=assignFirstCards([a,b], [a,c,d], [a,b,c]);
  assert.deepEqual(p.trending.map(x=>x.id), ['c','a','d']);
  assert.deepEqual(p.forYou.map(x=>x.id), ['b','a','c']);
});
test('empty and single-card inputs retain available cards (single card may share heads)', () => {
  assert.deepEqual(assignFirstCards([],[],[]), {latest:[],trending:[],forYou:[]});
  const a=card({id:'a'}), o=assignFirstCards([a],[a],[a]);
  assert.deepEqual([o.latest[0].id,o.trending[0].id,o.forYou[0].id], ['a','a','a']);
});

test('dirty local reactions and seen stories never reorder or remove Latest; explicit hides still apply', () => {
  const newest = card({ id: 'newest', published_at: '2026-10-18T10:00:00Z', sources: [{ name: 'Reuters', url: 'https://example.com/a' }] });
  const older = card({ id: 'older', published_at: '2026-10-17T10:00:00Z', sources: [{ name: 'Reuters', url: 'https://example.com/b' }] });
  // Model a heavily used browser: many dislikes, every id marked seen, and a completed cursor.
  const dirtyPrefs = { reactions: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`id${i}`, { r: 'dislike' }])), seen: new Set(['newest', 'older']), cursor: null };
  assert.equal(Object.keys(dirtyPrefs.reactions).length, 80);
  const latest = [newest, older].filter((c) => !['hidden-topic'].includes(c.category) && !['hidden-source'].includes(c.sources[0]?.name ?? ''));
  assert.deepEqual(latest.map((c) => c.id), ['newest', 'older']);
  const allHidden = latest.filter((c) => !['Reuters'].includes(c.sources[0]?.name ?? ''));
  assert.deepEqual(allHidden, [], 'explicit source hides can empty Latest and must be surfaced by the screen');
});
