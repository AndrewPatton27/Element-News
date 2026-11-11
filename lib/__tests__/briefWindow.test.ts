// Brief window, never-empty fallback and macro-first ordering (release M9, workstream 7, D-119).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyWindow, localWeekday, spanLabel } from '../brief/briefWindow.ts';
import {
  briefHasStories,
  briefStatusLine,
  briefView,
  headlineLabel,
  loadLastGoodBrief,
  resolveBrief,
  saveLastGoodBrief,
  summaryAgeNote,
  toBriefData,
} from '../brief/briefLogic.ts';
import { briefLeadCards, briefTier, categoryTier, orderBriefCards } from '../../contract/briefOrder.ts';
import { createMockFeatureApi } from '../api/api.mockFeatures.ts';
import { memoryStore } from '../storage/storage.ts';
import { card, dataCard, fact } from './helpers.ts';

// ---- window math (New York time, fixed dates) ----

test('daily window: 24 h Tuesday to Sunday, 72 h "since Friday" on Monday', () => {
  assert.deepEqual(dailyWindow(new Date('2026-11-10T15:00:00Z')), { hours: 24, kind: '24h' }); // Tue
  assert.deepEqual(dailyWindow(new Date('2026-11-08T15:00:00Z')), { hours: 24, kind: '24h' }); // Sun
  assert.deepEqual(dailyWindow(new Date('2026-11-09T15:00:00Z')), { hours: 72, kind: 'since_friday' }); // Mon
});

test('daily window: the weekday is the New York one, around midnight and the 2026 DST edges', () => {
  // Monday 2026-11-09 00:30 EST = 05:30Z; 23:30 EST Sunday = 04:30Z
  assert.equal(dailyWindow(new Date('2026-11-09T05:30:00Z')).hours, 72);
  assert.equal(dailyWindow(new Date('2026-11-09T04:30:00Z')).hours, 24);
  // DST ends Sun 2026-11-01 (06:00Z): Mon 2026-11-02 00:30 EST = 05:30Z, Sun 23:30 EST = 04:30Z
  assert.equal(dailyWindow(new Date('2026-11-02T05:30:00Z')).hours, 72);
  assert.equal(dailyWindow(new Date('2026-11-02T04:30:00Z')).hours, 24);
  // DST starts Sun 2026-03-08 (07:00Z): Mon 2026-03-09 00:30 EDT = 04:30Z, Sun 23:30 EDT = 03:30Z
  assert.equal(dailyWindow(new Date('2026-03-09T04:30:00Z')).hours, 72);
  assert.equal(dailyWindow(new Date('2026-03-09T03:30:00Z')).hours, 24);
  // the same instant is Sunday in New York and Monday in UTC
  assert.equal(localWeekday(new Date('2026-11-09T03:00:00Z')), 7);
  assert.equal(localWeekday(new Date('2026-11-09T03:00:00Z'), 'UTC'), 1);
});

test('spanLabel: honest text for each window', () => {
  assert.equal(spanLabel('24h', 24), 'Last 24 hours');
  assert.equal(spanLabel('since_friday', 72), 'Since Friday');
  assert.equal(spanLabel('week', 168), 'Last 7 days');
  assert.equal(spanLabel(undefined, 24), 'Last 24 hours');
  assert.equal(spanLabel(undefined, 72), 'Since Friday');
  assert.equal(spanLabel(undefined, 48), 'Last 2 days');
  assert.equal(spanLabel(undefined, Number.NaN), 'Last 24 hours');
  assert.equal(headlineLabel('daily', 72, 'since_friday'), 'Top stories · since Friday');
  assert.equal(headlineLabel('daily', 24, '24h'), 'Today in a minute');
});

// ---- the mock mirrors the RPC: window, Monday, never-empty fallback ----

const TUE = Date.parse('2026-11-10T15:00:00Z');
const MON = Date.parse('2026-11-09T15:00:00Z');
const agoFrom = (now: number, h: number) => new Date(now - h * 3_600_000).toISOString();
const mockAt = (now: number, ages: number[]) =>
  createMockFeatureApi(ages.map((h, i) => card({ id: `m${i}`, category: 'economy', sort_at: agoFrom(now, h) })), [], [], [], () => now);

test('mock daily brief: Monday reaches back 72 h and says so; Tuesday only 24 h', async () => {
  const mon = await mockAt(MON, [1, 60]).dailyBrief();
  assert.equal(mon.window_hours, 72);
  assert.equal(mon.window_kind, 'since_friday');
  assert.equal(mon.sections.flatMap((s) => s.cards).length, 2);
  const tue = await mockAt(TUE, [1, 60]).dailyBrief();
  assert.equal(tue.window_hours, 24);
  assert.equal(tue.sections.flatMap((s) => s.cards).length, 1);
});

test('mock daily brief never empty: no card in the window shows the last good cards, flagged and dated', async () => {
  const b = await mockAt(TUE, [100, 130]).dailyBrief();
  assert.equal(b.fallback, true);
  assert.ok(b.window_hours >= 100 && b.window_hours <= 720);
  assert.ok(b.headline_cards.length > 0);
  assert.equal(b.as_of, agoFrom(TUE, 100));
  assert.equal((await mockAt(TUE, [2]).dailyBrief()).fallback, false);
  // older than 30 days: nothing to show, and no error
  const none = await mockAt(TUE, [800]).dailyBrief();
  assert.equal(none.headline_cards.length, 0);
  assert.equal(none.fallback, false);
});

// ---- the saved last good brief ----

const withStories = (over = {}) => toBriefData({ generated_at: '2026-11-06T13:00:00Z', window_hours: 24, headline_cards: [card({ id: 'a' })], sections: [], numbers: [], ...over });
const empty = () => toBriefData({ generated_at: new Date(0).toISOString(), window_hours: 24, headline_cards: [], sections: [], numbers: [fact()] });

test('resolveBrief: live brief with stories wins; else the saved one; else the live empty one', () => {
  const live = withStories({ headline_cards: [card({ id: 'live' })] });
  const saved = withStories();
  assert.deepEqual(resolveBrief(live, saved), { data: live, source: 'live' });
  assert.deepEqual(resolveBrief(empty(), saved), { data: saved, source: 'cached' });
  assert.deepEqual(resolveBrief(null, saved), { data: saved, source: 'cached' });
  const e = empty();
  assert.deepEqual(resolveBrief(e, null), { data: e, source: 'live' });
  assert.equal(briefHasStories(e), false, 'numbers alone are not stories');
});

test('last good brief: only a brief with stories is saved; garbage reads as none', () => {
  const store = memoryStore();
  saveLastGoodBrief(store, 'daily', empty());
  assert.equal(loadLastGoodBrief(store, 'daily'), null);
  saveLastGoodBrief(store, 'daily', withStories());
  assert.equal(loadLastGoodBrief(store, 'daily')?.headline_cards[0]?.id, 'a');
  assert.equal(loadLastGoodBrief(store, 'weekly'), null, 'modes are kept apart');
  store.set('element.brief-last-good.weekly', '{not json');
  assert.equal(loadLastGoodBrief(store, 'weekly'), null);
  saveLastGoodBrief(store, 'daily', empty()); // an empty brief never overwrites a good one
  assert.equal(loadLastGoodBrief(store, 'daily')?.headline_cards[0]?.id, 'a');
});

test('briefStatusLine: normal, fallback and saved copies each name their date or span', () => {
  const now = new Date('2026-11-10T18:00:00Z');
  const live = withStories({ generated_at: '2026-11-10T13:00:00Z', window_kind: '24h' });
  assert.equal(briefStatusLine(live, 'live', now, true), 'Generated 5 h ago · Last 24 hours');
  const mon = withStories({ generated_at: '2026-11-10T13:00:00Z', window_hours: 72, window_kind: 'since_friday' });
  assert.equal(briefStatusLine(mon, 'live', now, true), 'Generated 5 h ago · Since Friday');
  const fb = withStories({ fallback: true, as_of: '2026-11-06T15:00:00Z', generated_at: '2026-11-10T13:00:00Z' });
  assert.equal(briefStatusLine(fb, 'live', now, true), 'Updated Fri, Nov 6 · the latest stories we have');
  assert.equal(briefStatusLine(withStories({ generated_at: '2026-11-06T13:00:00Z' }), 'cached', now, true), 'Updated Fri, Nov 6 · saved copy, the latest could not be loaded');
});

test('summaryAgeNote: flags a stored summary older than the brief day (daily) or week (weekly)', () => {
  const s = (for_date: string) => ({ text: 't', generated_at: 'x', model: 'm', for_date });
  assert.equal(summaryAgeNote(s('2026-11-10'), 'daily', '2026-11-10'), null);
  assert.equal(summaryAgeNote(s('2026-11-06'), 'daily', '2026-11-10'), 'Summary from Fri, Nov 6');
  assert.equal(summaryAgeNote(s('2026-11-09'), 'weekly', '2026-11-12'), null, 'the Monday of this week is current');
  assert.equal(summaryAgeNote(s('2026-11-02'), 'weekly', '2026-11-12'), 'Summary from Mon, Nov 2');
  assert.equal(summaryAgeNote({ text: 't', generated_at: 'x', model: 'm' }, 'daily', '2026-11-10'), null, 'older servers send no date');
  assert.equal(summaryAgeNote(null, 'daily', '2026-11-10'), null);
});

// ---- macro before company ----

const company = (id: string) => card({ id, category: 'earnings', event_type: 'earnings' });
const fedCard = (id: string) => card({ id, category: 'economy', event_type: 'fed', tickers: [] });
const recall = (id: string) => card({ id, category: 'safety', event_type: 'recall', tickers: [] });
const space = (id: string) => card({ id, category: 'science', event_type: 'science', tickers: [] });
const other = (id: string) => card({ id, category: 'world', event_type: 'world_event', tickers: [] });

test('ordering: macro, then company, then other, then recalls/space/science; stable inside a tier', () => {
  const cards = [recall('r'), company('c1'), space('s'), other('o'), company('c2'), fedCard('f'), dataCard({ id: 'd' })];
  assert.deepEqual(orderBriefCards(cards).map((c) => c.id), ['f', 'd', 'c1', 'c2', 'o', 'r', 's']);
});

test('ordering: a Fed card that names a ticker is still macro; a macro source makes a card macro', () => {
  const fedWithTicker = card({ id: 'ft', category: 'policy', event_type: 'fed' });
  assert.equal(briefTier(fedWithTicker), 0);
  const src = card().sources[0]!;
  assert.equal(briefTier(card({ id: 'bls', category: 'policy', event_type: null, tickers: [], sources: [{ ...src, name: 'U.S. Bureau of Labor Statistics' }] })), 0);
  assert.equal(briefTier(company('x')), 1);
  assert.equal(categoryTier('economy'), 0);
  assert.equal(categoryTier('earnings'), 1);
  assert.equal(categoryTier('safety'), 3);
});

test('lead: three bullets, macro first, one per story', () => {
  const lead = briefLeadCards([company('c1'), company('c2'), fedCard('f'), dataCard({ id: 'd' }), fedCard('f')]);
  assert.deepEqual(lead.map((c) => c.id), ['f', 'd', 'c1']);
});

test('briefView: macro stories lead the headlines, the lead and the sections; recalls and space go last', () => {
  const data = toBriefData({
    generated_at: '2026-11-10T13:00:00Z', window_hours: 24, numbers: [],
    headline_cards: [company('c1'), recall('r'), fedCard('f')],
    sections: [
      { category: 'safety', label: 'Recalls & Safety', cards: [recall('r2')] },
      { category: 'earnings', label: 'Earnings', cards: [company('c2')] },
      { category: 'economy', label: 'Economy', cards: [fedCard('f2')] },
    ],
  });
  const v = briefView(data, []);
  assert.deepEqual(v.headlines.map((c) => c.id), ['f', 'c1', 'r']);
  assert.deepEqual(v.lead.map((c) => c.id), ['f', 'f2', 'c1']);
  assert.deepEqual(v.sections.map((s) => s.category), ['economy', 'earnings', 'safety']);
});

test('briefView: one numbers block (the market numbers merge into it, one per series)', () => {
  const a = fact({ series_id: 'DGS10' });
  const b = fact({ series_id: 'DFF' });
  const data = toBriefData({
    generated_at: '2026-11-10T13:00:00Z', window_hours: 24, headline_cards: [card()], sections: [], numbers: [a],
    markets: { cards: [], numbers: [a, b], total: 0 },
  });
  const v = briefView(data, []);
  assert.deepEqual(v.numbers.map((n) => n.series_id), ['DGS10', 'DFF']);
  assert.deepEqual(v.marketNumbers, []);
});
