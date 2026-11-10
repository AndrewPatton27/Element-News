import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampLabel } from '../shared/timestamp.ts';
import { cardBarMeta } from '../shared/cardBody.ts';
import { NOW, card, dataCard } from './helpers.ts';

test('card stamp: data cards say "Data as of <date>"', () => {
  const c = dataCard({ as_of: '2026-10-14T18:00:00Z' });
  assert.deepEqual(stampLabel(c, 'card', NOW), { label: 'Data as of Oct 14', short: 'As of Oct 14' });
});

test('card stamp: filings say "Filed", other cards the plain relative time', () => {
  const filing = card({ as_of: '2026-10-17T13:00:00Z' });
  const src = { ...filing.sources[0], kind: 'filing' as const };
  assert.equal(stampLabel({ ...filing, sources: [src] }, 'card', NOW).label, 'Filed 5 h ago');
  const news = { ...filing, sources: [{ ...src, kind: 'news' as const }] };
  assert.deepEqual(stampLabel(news, 'card', NOW), { label: '5 h ago', short: '5 h' });
});

test('sheet stamp: "Added <time>" from published_at', () => {
  const c = card({ published_at: '2026-10-17T16:00:00Z' });
  assert.equal(stampLabel(c, 'sheet', NOW).label, 'Added 2 h ago');
});

test('unreadable dates give an empty label', () => {
  assert.equal(stampLabel(card({ as_of: 'x', published_at: 'x' }), 'card', NOW).label, '');
  assert.equal(stampLabel(card({ published_at: 'x' }), 'sheet', NOW).label, '');
});

test('the bar uses the same formatter as the sheet', () => {
  const c = card();
  assert.equal(cardBarMeta(c, { timeLabel: 'added', now: NOW })?.time, stampLabel(c, 'sheet', NOW).label);
  assert.equal(cardBarMeta(c, { now: NOW })?.time, stampLabel(c, 'card', NOW).label);
});
