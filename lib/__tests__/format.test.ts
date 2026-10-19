import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryName, changeText, clampHeadline, eventLabel, factA11yLabel, hostOf, relativeTime } from '../shared/format.ts';
import { NOW, fact } from './helpers.ts';

test('relative time', () => {
  assert.equal(relativeTime('2026-10-17T17:59:30Z', NOW), 'just now');
  assert.equal(relativeTime('2026-10-17T17:23:00Z', NOW), '37 min ago');
  assert.equal(relativeTime('2026-10-17T13:00:00Z', NOW), '5 h ago');
  assert.equal(relativeTime('2026-10-14T18:00:00Z', NOW), '3 d ago');
  assert.equal(relativeTime('2026-10-03T18:00:00Z', NOW), 'Oct 3');
  assert.equal(relativeTime('2025-10-03T18:00:00Z', NOW), 'Oct 3, 2025');
  assert.equal(relativeTime('not a date', NOW), '');
});

test('headline clamp keeps 90 chars max', () => {
  const long = 'x'.repeat(120);
  assert.equal(clampHeadline(long).length, 90);
  assert.ok(clampHeadline(long).endsWith('…'));
  assert.equal(clampHeadline('short'), 'short');
});

test('change uses glyph and word, never colour alone', () => {
  assert.equal(changeText(fact()), '▲ up +0.05 pts');
  assert.equal(changeText(fact({ direction: 'down', change: '-0.8%' })), '▼ down -0.8%');
  assert.equal(changeText(fact({ direction: 'flat', change: '0.00 pts' })), '■ unchanged');
  assert.equal(changeText(fact({ direction: null, change: null })), '');
});

test('a11y label names value, change and source', () => {
  const label = factA11yLabel(fact());
  assert.match(label, /10-yr Treasury 4\.12%/);
  assert.match(label, /up \+0\.05 pts/);
  assert.match(label, /Source: Board of Governors/);
  assert.match(factA11yLabel(fact({ period: 'Sep 2026' })), /for Sep 2026/);
});

test('category and event labels', () => {
  assert.equal(categoryName('personal-finance', null), 'Money');
  assert.equal(categoryName('policy', null), 'Government');
  assert.equal(categoryName('markets', null), 'Business');
  assert.equal(categoryName('science', null), 'Science & Space');
  assert.equal(categoryName('brand-new', null), 'Brand New');
  assert.equal(categoryName('markets', [{ slug: 'markets', name: 'Markets (API)', sort_order: 1 }]), 'Markets (API)');
  assert.equal(eventLabel('world_event'), 'World');
  assert.equal(eventLabel('recall'), 'Recall');
  assert.equal(eventLabel('science'), 'Science');
  assert.equal(categoryName('tech', [{ slug: 'tech', name: 'Tech & AI', sort_order: 1 }]), 'Tech & AI');
  assert.equal(eventLabel('exec_change'), 'Leadership change');
  assert.equal(eventLabel('something_new'), null);
  assert.equal(eventLabel(null), null);
});

test('hostOf strips scheme, www and path', () => {
  assert.equal(hostOf('https://www.federalreserve.gov/newsevents/x.htm'), 'federalreserve.gov');
  assert.equal(hostOf('https://fred.stlouisfed.org/series/DGS10'), 'fred.stlouisfed.org');
  assert.equal(hostOf('not a url'), '');
});
