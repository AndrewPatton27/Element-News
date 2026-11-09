import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAKEAWAYS_MAX, cardBarMeta, cardTakeaways, shortSourceName, shortTime } from '../shared/cardBody.ts';
import { NOW, card, dataCard } from './helpers.ts';

const points = (n: number) => Array.from({ length: n }, (_, i) => `Point ${i + 1}.`);

test('two to four persisted key points become the bullets, in order', () => {
  for (const n of [2, 3, 4]) {
    const c = card({ detail: { paragraphs: [], key_points: points(n) } });
    assert.deepEqual(cardTakeaways(c), { kind: 'points', points: points(n) });
  }
});

test('more than four key points are cut to four (or to the max that fits)', () => {
  const c = card({ detail: { paragraphs: [], key_points: points(6) } });
  assert.deepEqual(cardTakeaways(c), { kind: 'points', points: points(TAKEAWAYS_MAX) });
  assert.deepEqual(cardTakeaways(c, 2), { kind: 'points', points: points(2) });
  assert.deepEqual(cardTakeaways(c, 0), { kind: 'points', points: points(1) });
  assert.deepEqual(cardTakeaways(c, 99), { kind: 'points', points: points(4) });
});

test('no key points, or only one: the card summary is shown instead, word for word', () => {
  const body = 'Northwind reported revenue of $1.2 billion.';
  assert.deepEqual(cardTakeaways(card({ body, detail: null })), { kind: 'summary', text: body });
  assert.deepEqual(cardTakeaways(card({ body, detail: undefined })), { kind: 'summary', text: body });
  assert.deepEqual(cardTakeaways(card({ body, detail: { paragraphs: ['x'], key_points: ['Only one.'] } })), { kind: 'summary', text: body });
});

test('nothing is invented: blank or malformed points are dropped, an empty card shows nothing', () => {
  const messy = card({ body: null, detail: { paragraphs: [], key_points: ['  ', 'Real point.', 7 as unknown as string] } });
  assert.deepEqual(cardTakeaways(messy), { kind: 'points', points: ['Real point.'] });
  assert.deepEqual(cardTakeaways(card({ body: '   ', detail: null })), { kind: 'none' });
});

test('link-out cards never get a body (rule 7: no description)', () => {
  const c = card({ kind: 'link_out', body: 'A description', detail: { paragraphs: [], key_points: points(3) } });
  assert.deepEqual(cardTakeaways(c), { kind: 'none' });
});

test('bottom bar: primary source name, time, count and a "Sources:" accessible name', () => {
  const c = card({ source_count: 3 });
  const m = cardBarMeta(c, { now: NOW });
  assert.ok(m);
  assert.equal(m.name, 'SEC');
  assert.equal(m.docLabel, 'Form 8-K');
  assert.equal(m.time, '6 h ago');
  assert.equal(m.timeShort, '6 h');
  assert.equal(m.count, 3);
  assert.match(m.a11y, /^Sources: SEC · \+2 sources\. Published 6 h ago\. Opens/);
  assert.equal(m.a11yLink, 'Source: SEC, 3 sources. Published 6 h ago. Opens the original.');
});

test('bottom bar on the Latest tab says when we added the card', () => {
  const m = cardBarMeta(card(), { timeLabel: 'added', now: NOW });
  assert.ok(m);
  assert.match(m.time, /^Added /);
  assert.doesNotMatch(m.a11y, /Published Added/);
});

test('bottom bar: data cards use their publish time; no sources means no bar', () => {
  assert.ok(cardBarMeta(dataCard(), { now: NOW }));
  assert.equal(cardBarMeta(card({ sources: [] }), { now: NOW }), null);
});

test('bars use the usual short name of well-known agencies only', () => {
  assert.equal(shortSourceName('Federal Reserve Board'), 'Fed');
  assert.equal(shortSourceName('U.S. Bureau of Labor Statistics'), 'BLS');
  assert.equal(shortSourceName('SEC'), 'SEC');
  assert.equal(shortSourceName('Northwind Daily'), 'Northwind Daily');
  const m = cardBarMeta(card({ sources: [{ ...card().sources[0], name: 'U.S. Geological Survey' }] }), { now: NOW });
  assert.equal(m?.shortName, 'USGS');
  assert.match(m?.a11y ?? '', /U\.S\. Geological Survey/);
});

test('short time drops "ago" only', () => {
  assert.equal(shortTime('5 h ago'), '5 h');
  assert.equal(shortTime('just now'), 'just now');
  assert.equal(shortTime('Oct 3'), 'Oct 3');
});
