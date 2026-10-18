import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card } from './helpers.ts';
import { createMockFeatureApi } from '../api.mockFeatures.ts';
import { toBriefData } from '../briefLogic.ts';
import type { BlurbCard } from '../../contract/types.ts';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
// No markets/earnings/deals here: those go to the Markets section (brief_email), not topic sections.
const TOPICS = ['world', 'policy', 'economy', 'personal-finance', 'tech', 'science', 'safety', 'energy', 'insider', 'health'];
const PER_TOPIC = [9, 8, 7, 5, 4, 4, 3, 3, 2, 1]; // cards per topic, most important first

/** Cards whose importance falls with the topic number, all published 1 h ago. */
function supply(ageHours = 1): BlurbCard[] {
  const out: BlurbCard[] = [];
  TOPICS.forEach((category, k) => {
    for (let j = 0; j < PER_TOPIC[k]; j++) {
      out.push(card({ id: `t${k}-${j}`, category, headline: `Topic ${k} story ${j}`, importance: 100 - k * 5 - j * 0.1, sort_at: hoursAgo(ageHours) }));
    }
  });
  return out;
}

test('daily brief: a section per topic (max 8), depth by importance, total and rank', async () => {
  const daily = await createMockFeatureApi(supply(), [], []).dailyBrief();
  assert.equal(daily.window_hours, 24);
  assert.deepEqual(daily.sections.map((s) => s.category), TOPICS.slice(0, 8));
  assert.deepEqual(daily.sections.map((s) => s.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(daily.sections.map((s) => s.total), [9, 8, 7, 5, 4, 4, 3, 3]);
  assert.deepEqual(daily.sections.map((s) => s.slug), TOPICS.slice(0, 8));
  assert.deepEqual(daily.sections.map((s) => s.cards.length), [6, 6, 6, 3, 3, 2, 2, 2]);
  assert.equal(daily.sections[0]?.cards[0]?.headline, 'Topic 0 story 0', 'best story first');
  assert.equal(daily.sections[0]?.cards[1]?.headline, 'Topic 0 story 1');
});

test('weekly brief goes deeper in the top 3 topics (8 stories)', async () => {
  const weekly = await createMockFeatureApi(supply(100), [], []).weeklyBrief();
  assert.equal(weekly.window_hours, 168);
  assert.deepEqual(weekly.sections.map((s) => s.cards.length), [8, 8, 7, 3, 3, 2, 2, 2]);
  assert.deepEqual(weekly.sections.slice(0, 3).map((s) => s.total), [9, 8, 7]);
});

test('brief headlines are the top card of the three most important, different topics', async () => {
  const daily = await createMockFeatureApi(supply(), [], []).dailyBrief();
  assert.deepEqual(daily.headline_cards.map((c) => c.category), ['world', 'policy', 'economy']);
  assert.equal(new Set(daily.headline_cards.map((c) => c.id)).size, 3);
});

test('topic importance is the best card first, not the card count', async () => {
  const cards = supply();
  cards.push(card({ id: 'star', category: 'health', headline: 'Star', importance: 500, sort_at: hoursAgo(1) }));
  const daily = await createMockFeatureApi(cards, [], []).dailyBrief();
  assert.equal(daily.sections[0]?.category, 'health');
  assert.equal(daily.sections[0]?.total, 2);
});

test('daily window widens 24 -> 48 -> 72 h when fewer than 12 cards; weekly stays 168', async () => {
  const mk = (ages: number[]) => ages.map((h, i) => card({ id: `w${i}`, sort_at: hoursAgo(h) }));
  const api = (ages: number[]) => createMockFeatureApi(mk(ages), [], []);
  assert.equal((await api(Array(12).fill(1)).dailyBrief()).window_hours, 24, '12 in 24 h: no widening');
  assert.equal((await api([1, 1, 1, ...Array(12).fill(30)]).dailyBrief()).window_hours, 48);
  assert.equal((await api([1, 1, 1, ...Array(8).fill(30), 60, 60, 60]).dailyBrief()).window_hours, 72, '11 in 48 h widens again');
  assert.equal((await api([1]).weeklyBrief()).window_hours, 168);
});

test('empty supply gives empty sections without throwing', async () => {
  const daily = await createMockFeatureApi([], [], []).dailyBrief();
  assert.deepEqual(daily.sections, []);
  assert.deepEqual(daily.headline_cards, []);
});

test('the new section fields survive toBriefData and are optional for old servers', () => {
  const withNew = toBriefData({
    generated_at: 'x', window_hours: 24, headline_cards: [], numbers: [],
    sections: [{ category: 'world', label: 'World', cards: [], slug: 'world', rank: 1, total: 14 }],
  });
  assert.equal(withNew.sections[0]?.total, 14);
  const old = toBriefData({ generated_at: 'x', window_hours: 24, headline_cards: [], numbers: [], sections: [{ category: 'world', label: 'World', cards: [] }] });
  assert.equal(old.sections[0]?.total, undefined);
});
