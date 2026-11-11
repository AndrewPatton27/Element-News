// Data-card charts: parsing api.macro_history, which series a card charts, geometry, the screen-reader sentence,
// the lazy loader (batching, cache, failures) and the mock history. All offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MacroFact } from '../../contract/types.ts';
import { createSupabaseApi, planRequest } from '../api/api.supabase.ts';
import { createHistoryLoader } from '../history/historyLoader.ts';
import { mockMacroHistory, sampleLevels } from '../history/mockHistory.ts';
import {
  chartGeometry, chartSpec, describeChart, formatLike, parseMacroHistory, rangeText, spanPhrase, spokenChange, usableSeries, type MacroHistory,
} from '../history/seriesHistory.ts';

const fact = (series_id: string, over: Partial<MacroFact> = {}): MacroFact => ({
  series_id, label: '10-yr Treasury', value: '4.84%', change: '+3 bp', direction: 'up', period: null, as_of: '2026-11-10',
  source_name: 'Federal Reserve Board via FRED', source_short: 'Federal Reserve via FRED', source_url: 'https://fred.stlouisfed.org/series/DGS10', sort_order: 1, ...over,
});
const days = (n: number, start = '2026-09-01') => Array.from({ length: n }, (_, i) => [new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), 4 + i * 0.01]);

test('parseMacroHistory keeps good series, sorts, dedupes and drops bad points and series', () => {
  const h = parseMacroHistory({
    DGS10: { frequency: 'daily', points: [['2026-09-03', 4.2], ['2026-09-01', 4.0], ['2026-09-01', 9], ['bad', 1], ['2026-09-02', 'x'], ['2026-09-04', '4.3']] },
    bad_lower: { frequency: 'daily', points: [] },
    UNRATE: { frequency: 'hourly', points: [] },
    CPI: { frequency: 'monthly', points: 'nope' },
  });
  assert.deepEqual(Object.keys(h), ['DGS10']);
  assert.deepEqual(h.DGS10.points.map((p) => p.date), ['2026-09-01', '2026-09-03', '2026-09-04']);
  assert.equal(h.DGS10.points[2].value, 4.3);
  assert.deepEqual(parseMacroHistory(null), {});
  assert.deepEqual(parseMacroHistory([]), {});
  const long = parseMacroHistory({ DGS10: { frequency: 'daily', points: days(300) } });
  assert.equal(long.DGS10.points.length, 120);
});

test('chartSpec: yield-curve card charts four maturities, others their first number, only data cards', () => {
  const curve = chartSpec({ kind: 'data', macro: [fact('DGS10'), fact('DGS2'), fact('SPREAD_10Y2Y')] });
  assert.deepEqual(curve, { series: ['DGS2', 'DGS5', 'DGS10', 'DGS30'], curve: true });
  assert.deepEqual(chartSpec({ kind: 'data', macro: [fact('UNRATE')] }), { series: ['UNRATE'], curve: false });
  assert.deepEqual(chartSpec({ kind: 'data', macro: [fact('DGS2')] }), { series: ['DGS2'], curve: false });
  assert.equal(chartSpec({ kind: 'summary', macro: [] }), null);
  assert.equal(chartSpec({ kind: 'data', macro: [] }), null);
});

test('chartGeometry: one shared scale, ends on the latest point, flat series do not divide by zero, tiny input draws nothing', () => {
  const pts = parseMacroHistory({ A: { frequency: 'daily', points: days(30) } }).A.points;
  const g = chartGeometry([{ id: 'A', points: pts }], 300, 60)!;
  assert.equal(g.lines.length, 1);
  assert.ok(g.lines[0].area?.endsWith('Z'));
  assert.equal(g.lines[0].last.x, 300 - 6);                       // right padding, the newest reading is the last x
  assert.ok(g.lines[0].last.y < g.lines[0].min.y, 'rising series: the newest point is above the lowest');
  assert.equal(g.lastDate, pts[29].date);
  const flat = chartGeometry([{ id: 'F', points: pts.map((p) => ({ ...p, value: 3 })) }], 200, 50)!;
  assert.ok(Number.isFinite(flat.lines[0].last.y));
  assert.equal(chartGeometry([{ id: 'A', points: pts.slice(0, 1) }], 300, 60), null);
  assert.equal(chartGeometry([{ id: 'A', points: pts }], 0, 60), null);
  const two = chartGeometry([{ id: 'A', points: pts }, { id: 'B', points: pts.map((p) => ({ ...p, value: p.value + 1 })) }], 300, 60)!;
  assert.equal(two.lines.length, 2);
  assert.equal(two.lines[0].area, null, 'multi-line charts have no area fill');
  assert.ok(two.lines[1].last.y < two.lines[0].last.y, 'one scale: the higher series is drawn higher');
});

test('spokenChange and spanPhrase read like speech', () => {
  assert.equal(spokenChange('+3 bp'), '3 basis points');
  assert.equal(spokenChange('-1 bp'), '1 basis point');
  assert.equal(spokenChange('+0.06 pts'), '0.06 points');
  assert.equal(spokenChange('-0.8%'), '0.8%');
  assert.equal(spokenChange(null), null);
  assert.equal(spanPhrase('daily', '2026-09-11', '2026-11-10'), 'the last 60 days');
  assert.equal(spanPhrase('weekly', '2026-05-01', '2026-11-06'), 'the last 27 weeks');
  assert.equal(spanPhrase('monthly', '2025-10-01', '2026-10-01'), 'the last 12 months');
});

test('describeChart: the summary says label, value, move, since when and the span; curve names every maturity', () => {
  const dgs = { frequency: 'daily' as const, points: [['2026-09-11', 4.5], ['2026-11-05', 4.81], ['2026-11-09', 4.81], ['2026-11-10', 4.84]].map(([date, value]) => ({ date: date as string, value: value as number })) };
  const h: MacroHistory = { DGS10: dgs };
  assert.equal(
    describeChart(fact('DGS10', { label: '10-year yield' }), { series: ['DGS10'], curve: false }, h),
    '10-year yield, 4.84%, up 3 basis points since Monday; chart of the last 60 days',
  );
  assert.equal(describeChart(fact('DGS10', { direction: 'flat', change: null }), { series: ['DGS10'], curve: false }, h), '10-yr Treasury, 4.84%, unchanged since Monday; chart of the last 60 days');
  assert.equal(describeChart(fact('DGS10'), { series: ['UNRATE'], curve: false }, h), '', 'no history, no sentence');
  const curve = describeChart(fact('DGS10'), { series: ['DGS2', 'DGS10'], curve: true }, { DGS2: { ...dgs, points: dgs.points.map((p) => ({ ...p, value: p.value - 1 })) }, DGS10: dgs });
  assert.match(curve, /^Treasury yields, 2-year 3\.84%, 10-year 4\.84%; the 10-year up 3 basis points since Monday; chart of the last 60 days, one line per maturity$/);
  assert.equal(usableSeries({ series: ['DGS10'], curve: false }, { DGS10: { frequency: 'daily', points: dgs.points.slice(0, 2) } }).length, 0, 'two points is not a chart');
});

test('formatLike copies the card format and scale; rangeText gives low and high', () => {
  assert.equal(formatLike('4.84%', 4.84, 4.5), '4.50%');
  assert.equal(formatLike('$61.40', 61.4, 58.123), '$58.12');
  assert.equal(formatLike('212,000', 212000, 198500), '198,500');
  assert.equal(formatLike('$7.1 billion', 7100, 6900), '$6.9 billion');          // series stored in millions
  assert.equal(formatLike('n/a', 1, 1), null);
  const pts = days(10).map(([date, value]) => ({ date: date as string, value: value as number }));
  const g = chartGeometry([{ id: 'A', points: pts }], 300, 60)!;
  assert.equal(rangeText(g.lines[0], '4.09%', 4.09), 'Low 4.00% (Sep 1), high 4.09% (Sep 10)');
});

test('history loader: one batched call for many cards, chunks of 6, cache with ttl, failures remembered briefly, absent series are fine', async () => {
  let t = 0;
  const calls: string[][] = [];
  let fail = false;
  const loader = createHistoryLoader({
    now: () => t, batchMs: 5, ttlMs: 1000, failTtlMs: 100,
    fetchHistory: async (ids) => {
      calls.push(ids);
      if (fail) throw new Error('boom');
      return Object.fromEntries(ids.filter((i) => i !== 'GHOST').map((i) => [i, { frequency: 'daily' as const, points: [] }]));
    },
  });
  const [a, b] = await Promise.all([loader.load(['DGS10', 'DGS2']), loader.load(['DGS10', 'UNRATE'])]);
  assert.equal(calls.length, 1, 'both cards share one call');
  assert.deepEqual(calls[0].sort(), ['DGS10', 'DGS2', 'UNRATE']);
  assert.deepEqual(Object.keys(a).sort(), ['DGS10', 'DGS2']);
  assert.deepEqual(Object.keys(b).sort(), ['DGS10', 'UNRATE']);
  assert.ok(loader.peek(['DGS10']), 'cached');
  await loader.load(['DGS10']);
  assert.equal(calls.length, 1, 'cache hit');
  assert.deepEqual(await loader.load(['GHOST']), {});
  await loader.load(['GHOST']);
  assert.equal(calls.length, 2, 'a series with no history is cached too');
  t = 2000;
  assert.equal(loader.peek(['DGS10']), undefined, 'expired');
  fail = true;
  assert.deepEqual(await loader.load(['DGS10']), {}, 'a failure never rejects');
  await loader.load(['DGS10']);
  assert.equal(calls.length, 3, 'the failure is remembered, no hammering');
  t = 2200; fail = false;
  assert.ok((await loader.load(['DGS10'])).DGS10);
  const many = await loader.load(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
  assert.equal(Object.keys(many).length, 8);
  assert.deepEqual(calls.slice(-2).map((c) => c.length), [6, 2]);
});

test('macro_history request: clean ids only, at most 6, documented RPC body; failures give {}', async () => {
  const p = planRequest('https://x.supabase.co', 'k', 'macro_history', { mode: 'top', seriesIds: ['DGS10', 'DGS10', 'bad id', 'a;drop', 'DGS2', 'A', 'B', 'C', 'D', 'E'] });
  assert.equal(p.url, 'https://x.supabase.co/rest/v1/rpc/macro_history');
  assert.deepEqual(JSON.parse(p.init.body as string), { p_series: ['DGS10', 'DGS2', 'A', 'B', 'C', 'D'] });
  assert.equal(p.init.headers['Content-Profile'], 'api');
  const ok = createSupabaseApi({ url: 'https://x.supabase.co', key: 'k', fetchFn: (async () => new Response(JSON.stringify({ DGS10: { frequency: 'daily', points: [['2026-11-10', 4.8]] } }), { status: 200 })) as typeof fetch });
  assert.equal((await ok.macroHistory(['DGS10'])).DGS10.points[0].value, 4.8);
  const missing = createSupabaseApi({ url: 'https://x.supabase.co', key: 'k', fetchFn: (async () => new Response(JSON.stringify({ message: 'Could not find the function' }), { status: 404 })) as typeof fetch });
  assert.deepEqual(await missing.macroHistory(['DGS10']), {});
});

test('mock history ends on the card value, has no weekend readings, is repeatable and covers the curve maturities', () => {
  const levels = sampleLevels([{ series_id: 'DGS2', value: '3.48%' }, { series_id: 'DGS10', value: '4.02%' }, { series_id: 'CPIAUCSL', value: '2.9%' }, { series_id: 'DCOILWTICO', value: '$61.40' }]);
  assert.ok(levels.DGS5 && levels.DGS30);
  const today = new Date('2026-11-14T10:00:00Z');                    // a Saturday
  const h = mockMacroHistory(['DGS2', 'DGS5', 'DGS10', 'DGS30', 'CPIAUCSL', 'DCOILWTICO', 'NOPE'], levels, today);
  assert.deepEqual(Object.keys(h).sort(), ['CPIAUCSL', 'DCOILWTICO', 'DGS10', 'DGS2', 'DGS30', 'DGS5']);
  assert.ok(!('NOPE' in h));
  assert.ok(Object.keys(h).length <= 6);
  const d = h.DGS10.points;
  assert.equal(d[d.length - 1].value, 4.02);
  assert.equal(d[d.length - 1].date, '2026-11-13', 'the newest daily reading is the last weekday');
  assert.ok(d.every((p) => ![0, 6].includes(new Date(`${p.date}T00:00:00Z`).getUTCDay())));
  assert.equal(h.CPIAUCSL.frequency, 'monthly');
  assert.equal(h.CPIAUCSL.points.length, 13);
  assert.deepEqual(mockMacroHistory(['DGS10'], levels, today).DGS10, h.DGS10);
});
