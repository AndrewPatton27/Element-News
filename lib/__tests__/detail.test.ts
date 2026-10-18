import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardDetail, detailParagraphs } from '../detail.ts';
import { cardLabels } from '../labels.ts';
import { isBlurbCard } from '../types.ts';
import { card } from './helpers.ts';

const withDetail = (detail: unknown) => card({ detail: detail as never });

test('cardDetail keeps clean paragraphs and key points', () => {
  const c = withDetail({ paragraphs: ['First.', '  ', 'Second.'], key_points: ['A', 7, ' B '] });
  assert.deepEqual(cardDetail(c), { paragraphs: ['First.', 'Second.'], key_points: ['A', 'B'] });
});

test('missing, null or malformed detail means none, and the card still renders', () => {
  for (const d of [undefined, null, 'text', [], { paragraphs: [], key_points: [] }, { paragraphs: 'x' }]) {
    const c = withDetail(d);
    assert.equal(cardDetail(c), null, JSON.stringify(d));
    assert.equal(isBlurbCard(c), true, 'a bad detail never drops the card');
    assert.ok(cardLabels(c, null).disclaimer.length > 0);
  }
});

test('detailParagraphs falls back to the card summary', () => {
  assert.deepEqual(detailParagraphs(withDetail({ paragraphs: ['P1', 'P2'], key_points: ['K'] })), { paragraphs: ['P1', 'P2'], fallback: false });
  assert.deepEqual(detailParagraphs(withDetail(null)), { paragraphs: ['Northwind reported revenue of $1.2 billion.'], fallback: true });
  // key points only: show them, plus the summary as the text, without the "not available" note
  assert.deepEqual(detailParagraphs(withDetail({ paragraphs: [], key_points: ['K'] })), {
    paragraphs: ['Northwind reported revenue of $1.2 billion.'],
    fallback: false,
  });
  assert.deepEqual(detailParagraphs(card({ body: null, detail: null })), { paragraphs: [], fallback: true });
});

test('sample fixtures: details follow the contract limits', () => {
  const page = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'contract', 'fixtures', 'feed.page1.json'), 'utf8'));
  const withD = page.items.filter((c: object) => cardDetail(c as never));
  assert.ok(withD.length >= 1, 'at least one sample card has detail');
  for (const c of withD) {
    const d = cardDetail(c)!;
    const words = d.paragraphs.join(' ').split(/\s+/).length;
    assert.ok(d.paragraphs.length >= 1 && d.paragraphs.length <= 4, `${c.id} paragraphs`);
    assert.ok(words <= 180, `${c.id} has ${words} words`);
    assert.ok(d.key_points.length <= 5, `${c.id} key points`);
  }
});
