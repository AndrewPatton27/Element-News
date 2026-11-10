// Brief window math, macro-first ordering in the brief prompt, and the never-empty rules (D-119, workstream 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyWindow, windowSpan } from '../src/briefTime.ts';
import {
  briefIsEmpty,
  briefSourceText,
  buildBriefPrompt,
  runBriefSummary,
  templateBriefSummary,
  type BriefInput,
  type SummaryJobDeps,
} from '../src/briefSummary.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import type { BlurbCard, MacroFact } from '../../contract/types.ts';

// ---- window math, New York time, fixed dates ----

test('dailyWindow: 24 h normally, 72 h "since Friday" on Monday', () => {
  const tue = dailyWindow(new Date('2026-11-10T15:00:00Z'));
  assert.deepEqual([tue.hours, tue.kind, tue.label], [24, '24h', 'Last 24 hours']);
  const mon = dailyWindow(new Date('2026-11-09T15:00:00Z'));
  assert.deepEqual([mon.hours, mon.kind, mon.label, mon.span], [72, 'since_friday', 'Since Friday', 'the time since Friday']);
});

test('dailyWindow: judged in New York at midnight and across the 2026 DST edges', () => {
  const h = (iso: string) => dailyWindow(new Date(iso)).hours;
  assert.equal(h('2026-11-09T05:30:00Z'), 72); // Mon 00:30 EST
  assert.equal(h('2026-11-09T04:30:00Z'), 24); // Sun 23:30 EST
  assert.equal(h('2026-11-02T05:30:00Z'), 72); // first Monday after DST ends, 00:30 EST
  assert.equal(h('2026-11-02T04:30:00Z'), 24); // Sunday 23:30 EST
  assert.equal(h('2026-03-09T04:30:00Z'), 72); // first Monday after DST starts, 00:30 EDT
  assert.equal(h('2026-03-09T03:30:00Z'), 24); // Sunday 23:30 EDT
  assert.equal(dailyWindow(new Date('2026-11-09T03:00:00Z'), 'UTC').hours, 72, 'another zone, another weekday');
});

test('windowSpan: the span text follows the brief JSON window fields', () => {
  assert.deepEqual(windowSpan('since_friday', 72), { label: 'Since Friday', span: 'the time since Friday' });
  assert.deepEqual(windowSpan('24h', 24), { label: 'Last 24 hours', span: 'the last 24 hours' });
  assert.deepEqual(windowSpan(undefined, undefined), { label: 'Last 24 hours', span: 'the last 24 hours' });
  assert.equal(windowSpan('week', 168).span, 'this week');
  assert.equal(windowSpan(undefined, 100).span, 'the last 100 hours');
});

// ---- fixtures ----

const SRC = { name: 'SEC', kind: 'filing', doc_label: 'Form 8-K', url: 'https://www.sec.gov/x', published_at: '2026-11-10T12:00:00Z', license_class: 'company_filing', attribution: null, is_primary: true };
const mk = (id: string, headline: string, over: Partial<BlurbCard> = {}): BlurbCard => ({
  id, kind: 'summary', headline, body: `${headline} body.`, category: 'earnings', event_type: 'earnings', tickers: [{ symbol: 'TTWO', name: 'Take-Two', exchange: 'Nasdaq', quote: null }],
  macro: [], sources: [SRC], source_count: 1, as_of: '2026-11-10T12:00:00Z', published_at: '2026-11-10T12:00:00Z', sort_at: '2026-11-10T12:00:00Z', updated_at: null, revision: 1,
  freshness: { delayed_hours: null }, ai: { generated: true, label: null }, attribution: null, image: null, is_saved: false, share_path: `/b/${id}`, ...over,
} as unknown as BlurbCard);
const GDP: MacroFact = { series_id: 'GDP', label: 'Real GDP growth', value: '4.3%', change: null, direction: 'up', period: 'Q3 2026', as_of: '2026-11-06', source_name: 'BEA', source_short: 'BEA', source_url: 'https://www.bea.gov/', sort_order: 1 };

const brief = (over: Partial<BriefInput> = {}): BriefInput => ({
  generated_at: '2026-11-10T11:00:00Z', window_hours: 24, window_kind: '24h',
  // the server's order: a company filing and a recall first, the Fed last (the F-01 complaint)
  headline_cards: [mk('take2', 'Take-Two reports a net loss'), mk('recall', 'Airline part recall', { category: 'safety', event_type: 'recall', tickers: [] }), mk('fed', 'Fed holds rates steady', { category: 'economy', event_type: 'fed', tickers: [] })],
  sections: [], numbers: [GDP], ...over,
} as BriefInput);

test('brief source text: numbers first, then Fed and government, companies, other, recalls last', () => {
  const text = briefSourceText(brief());
  const at = (s: string) => text.indexOf(s);
  assert.ok(at('NUMBERS:') === 0, 'one numbers block, first');
  assert.ok(at('Fed holds rates steady') < at('Take-Two reports a net loss'), 'macro before the company filing');
  assert.ok(at('Take-Two reports a net loss') < at('Airline part recall'), 'recalls last');
  assert.equal(text.split('NUMBERS:').length, 2, 'no second numbers block');
});

test('brief prompt: macro-first order, the real span, no bullets in the AI text', () => {
  const p = buildBriefPrompt('daily', briefSourceText(brief()), undefined, { kind: '24h', hours: 24 });
  assert.match(p, /what mattered in the last 24 hours/);
  assert.match(p, /ORDER \(most important first\)/);
  assert.match(p, /Federal Reserve and the most important economic data/);
  assert.match(p, /single company filing never comes before an economic release/);
  assert.match(p, /do not write one/);
  const monday = buildBriefPrompt('daily', 'x', undefined, { kind: 'since_friday', hours: 72 });
  assert.match(monday, /what mattered in the time since Friday/);
  assert.doesNotMatch(monday, /last 72 hours|last 24 hours/);
  assert.match(buildBriefPrompt('weekly', 'x'), /what mattered in this week/);
  assert.match(buildBriefPrompt('daily', 'x', ['too short']), /rejected for: too short/);
});

test('template summary leads with the macro story and names the Monday span', () => {
  const t = templateBriefSummary('daily', brief({ window_kind: 'since_friday', window_hours: 72 }));
  assert.match(t, /^The top story since Friday: Fed holds rates steady\./);
});

// ---- never empty: a fallback brief is not re-summarized as today's ----

const deps = (b: BriefInput, puts: string[]): SummaryJobDeps => ({
  fetchBrief: async () => b,
  putSummary: async (k, d) => { puts.push(`${k}:${d}`); },
  models: [], counter: memoryCounter(), now: new Date('2026-11-10T15:00:00Z'), log: () => undefined,
});

test('runBriefSummary: a fallback brief (older cards) writes nothing, the last summary stays', async () => {
  const puts: string[] = [];
  const out = await runBriefSummary(deps(brief({ fallback: true, as_of: '2026-11-06T12:00:00Z' }), puts), { kinds: ['daily'] });
  assert.equal(out[0]?.status, 'empty');
  assert.deepEqual(puts, []);
});

test('runBriefSummary: a normal brief still writes today summary (template when no AI)', async () => {
  const puts: string[] = [];
  const out = await runBriefSummary(deps(brief(), puts), { kinds: ['daily'] });
  assert.equal(out[0]?.status, 'written');
  assert.deepEqual(puts, ['daily:2026-11-10']);
  assert.equal(briefIsEmpty(brief()), false);
});
