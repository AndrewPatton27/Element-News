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
