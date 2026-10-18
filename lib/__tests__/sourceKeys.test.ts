import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_KEYS, cardSourceKey, sourceName, toggleSource, withoutHiddenSources } from '../sourceKeys.ts';
import { SOURCES } from '../sourcesInfo.ts';
import { card, dataCard } from './helpers.ts';

const src = (name: string, is_primary = true) => ({ ...card().sources[0], name, is_primary });

test('card source key follows the server rule', () => {
  assert.equal(cardSourceKey(card()), 'sec'); // helper card's primary source is "SEC"
  assert.equal(cardSourceKey(dataCard()), 'fred', 'data cards are FRED numbers');
  assert.equal(cardSourceKey(card({ sources: [src('Wikipedia')] })), 'wikipedia');
  assert.equal(
    cardSourceKey(card({ sources: [src('Some Newspaper', true), src('Federal Register', false)] })),
    'fedreg',
    'falls back to a keyed secondary source',
  );
  assert.equal(cardSourceKey(card({ sources: [src('Some Newspaper')] })), null, 'unknown sources cannot be switched off');
});

test('hidden sources leave the feed; unkeyed cards stay', () => {
  const cards = [card({ id: 'a' }), dataCard({ id: 'b' }), card({ id: 'c', sources: [src('Some Newspaper')] })];
  assert.deepEqual(
    withoutHiddenSources(cards, ['sec', 'fred']).map((c) => c.id),
    ['c'],
  );
  assert.equal(withoutHiddenSources(cards, []), cards);
});

test('at least one source stays on', () => {
  const all = SOURCE_KEYS.map((s) => s.key);
  assert.deepEqual(toggleSource([], 'sec'), ['sec']);
  assert.deepEqual(toggleSource(['sec', 'nasa'], 'sec'), ['nasa'], 'switching back on');
  const allButOne = all.filter((k) => k !== 'nasa');
  assert.equal(toggleSource(allButOne, 'nasa'), null, 'the last source cannot be switched off');
  assert.equal(sourceName('cpsc'), 'Product recalls (CPSC)');
});

test('keys match the migration and every source has an About entry', () => {
  const sql = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'migrations', '20261017070000_trending_foryou.sql'), 'utf8');
  for (const s of SOURCE_KEYS) {
    assert.match(sql, new RegExp(`\\('${s.key}',`), `${s.key} is a key in core.source_keys`);
    assert.ok(
      SOURCES.some((i) => i.key === s.key),
      `${s.key} has an About entry`,
    );
  }
});
