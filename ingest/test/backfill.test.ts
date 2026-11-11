import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backfillFetchDays, runBackfill, selectBackfillPoints } from '../src/backfill.ts';
import { config } from '../src/config.ts';
import { parseArgs } from '../src/main.ts';
import type { Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { parseFredObservations } from '../src/sources/macro.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

function setup() {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const requested: string[] = [];
  const deps: Deps = {
    fetchText: async (url) => {
      requested.push(url);
      const id = new URL(url).searchParams.get('series_id');
      if (id === 'DGS10') return fx('fred-backfill-DGS10.json');
      if (id === 'CPIAUCSL') return fx('fred-backfill-CPIAUCSL.json');
      throw new Error('HTTP 400 from api.stlouisfed.org');           // every other series fails: must not stop the run
    },
    publisher: dry.publisher, providers: [], counter: memoryCounter(), fredApiKey: 'SECRET-FRED-KEY',
    now: new Date('2026-10-18T11:00:00Z'), log: (s) => lines.push(s),
  };
  return { deps, dry, lines, requested };
}

test('--backfill-macro and --weeks parse; bad weeks rejected', () => {
  assert.equal(parseArgs([]).backfillMacro, false);
  assert.equal(parseArgs([]).weeks, config.backfillWeeksDefault);
  const a = parseArgs(['--backfill-macro', '--weeks', '12']);
  assert.equal(a.backfillMacro, true);
  assert.equal(a.weeks, 12);
  assert.throws(() => parseArgs(['--weeks', 'x']), /whole number/);
  assert.throws(() => parseArgs(['--weeks', '0']), /whole number/);
});

test('selectBackfillPoints: weekly window for daily series, month and quarter floors otherwise', () => {
  const daily = parseFredObservations(fx('fred-backfill-DGS10.json'));
  const kept = selectBackfillPoints('daily', daily, 4);
  assert.equal(kept[kept.length - 1].date, '2026-10-16');
  assert.ok(kept[0].date >= '2026-09-18' && kept.length >= 19 && kept.length <= 21, `kept ${kept.length}`);
  const monthly = parseFredObservations(fx('fred-backfill-CPIAUCSL.json'));
  assert.equal(selectBackfillPoints('monthly', monthly, 16).length, 14);
  assert.equal(selectBackfillPoints('monthly', monthly, 80).length, 19);      // ceil(80 / 4.345)
  assert.equal(selectBackfillPoints('quarterly', monthly, 16).length, 8);
  assert.deepEqual(selectBackfillPoints('daily', [], 16), []);
});

test('backfill writes history through upsertMacro: daily weeks, CPI year-over-year, no data cards, key never logged', async () => {
  const { deps, dry, lines, requested } = setup();
  const stats = await runBackfill(deps, { weeks: 16, pauseMs: 0 });

  const dgs = dry.macro.filter((o) => o.series_id === 'DGS10');
  assert.equal(stats.series.DGS10, dgs.length);
  assert.ok(dgs.length >= 70, `DGS10 readings ${dgs.length}`);                // 16 weeks of the 78 weekdays minus the "." day
  assert.ok(!dgs.some((o) => o.obs_date === '2026-09-07'), 'missing "." reading skipped');
  assert.equal(new Set(dgs.map((o) => o.obs_date)).size, dgs.length, 'one row per date');
  const newest = dgs[dgs.length - 1];
  assert.equal(newest.obs_date, '2026-10-16');
  assert.match(newest.display_value, /^\d\.\d\d%$/);
  assert.equal(newest.direction, 'up');

  const cpi = dry.macro.filter((o) => o.series_id === 'CPIAUCSL');
  assert.equal(cpi.length, 14);
  assert.equal(cpi[cpi.length - 1].obs_date, '2026-09-01');
  assert.equal(cpi[cpi.length - 1].display_value, '3.0%');                    // 1.0025^12 - 1 = 3.04% -> 3.0
  assert.equal(cpi[cpi.length - 1].period_label, 'Sep 2026');

  assert.equal(stats.failed, config.macroSeries.length - 2, "every series without a fixture fails and is logged, not fatal");
  assert.equal(dry.cards.length, 0, 'backfill never publishes data cards');
  assert.ok(requested.every((u) => new URL(u).hostname === 'api.stlouisfed.org'));
  assert.ok(requested.every((u) => new URL(u).searchParams.get('observation_start')! <= '2026-10-18'));
  assert.ok(!lines.join('\n').includes('SECRET-FRED-KEY'), 'the API key is never logged');
});

test('backfill is idempotent: same rows (series + date) on a second run', async () => {
  const a = setup();
  await runBackfill(a.deps, { weeks: 8, pauseMs: 0 });
  const b = setup();
  await runBackfill(b.deps, { weeks: 8, pauseMs: 0 });
  assert.deepEqual(a.dry.macro, b.dry.macro);
  const keys = a.dry.macro.map((o) => `${o.series_id}:${o.obs_date}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('backfill pauses between FRED requests and skips without a key', async () => {
  const { deps } = setup();
  const sleeps: number[] = [];
  await runBackfill(deps, { weeks: 4, pauseMs: 700, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(sleeps.length, config.macroSeries.length - 1);
  const none = setup();
  none.deps.fredApiKey = null;
  const s = await runBackfill(none.deps, { weeks: 4, pauseMs: 0 });
  assert.equal(s.written, 0);
  assert.equal(none.requested.length, 0);
  await assert.rejects(() => runBackfill(none.deps, { weeks: 0 }), /whole number/);
  assert.ok(backfillFetchDays(16) > 500);
});

// ---- card backfill ----------------------------------------------------------------------

import { fixtureFetcher, DRY_NOW } from '../src/main.ts';
import { aiCallsLeft, newsSources, runCardBackfill } from '../src/backfill.ts';
import { templateSummarizer } from '../src/summarizer/template.ts';

function dryDeps() {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = {
    fetchText: fixtureFetcher(), publisher: dry.publisher, providers: [templateSummarizer], counter: memoryCounter(),
    fredApiKey: 'dry-run', now: DRY_NOW, log: (s) => lines.push(s),
  };
  return { deps, dry, lines };
}

test('--backfill-cards and --days parse; bad days rejected', () => {
  assert.equal(parseArgs([]).backfillCards, false);
  assert.equal(parseArgs([]).days, config.cardBackfill.daysDefault);
  const a = parseArgs(['--backfill-cards', '--days', '3', '--limit', '5']);
  assert.equal(a.backfillCards, true);
  assert.equal(a.days, 3);
  assert.equal(a.limitSet, true);
  assert.equal(parseArgs(['--backfill-cards']).limitSet, false);
  assert.throws(() => parseArgs(['--days', '0']), /whole number/);
  assert.throws(() => parseArgs(['--days', String(config.cardBackfill.daysMax + 1)]), /whole number/);
});

test('card backfill never includes data-card sources and rejects them in --only', async () => {
  assert.ok(!newsSources().includes('macro'));
  assert.ok(!newsSources().includes('treasury'));
  await assert.rejects(runCardBackfill(dryDeps().deps, { only: ['macro'] }), /data-card sources/);
  await assert.rejects(runCardBackfill(dryDeps().deps, { days: 0 }), /whole number/);
});

test('card backfill publishes, is idempotent, and a shorter window publishes no more cards', async () => {
  const wide = dryDeps();
  const a = await runCardBackfill(wide.deps, { days: 30, limit: 100 });
  assert.ok(a.published > 0, 'fixtures should yield cards');
  assert.equal(wide.dry.cards.length, a.published);
  const again = await runCardBackfill(wide.deps, { days: 30, limit: 100 });
  assert.equal(again.published, 0);                       // everything already handled
  assert.equal(again.stoppedBy, 'no_new_cards');
  const narrow = dryDeps();
  const b = await runCardBackfill(narrow.deps, { days: 1, limit: 100 });
  assert.ok(b.published <= a.published);
  for (const c of narrow.dry.cards) assert.ok(Date.parse(String((c as { sort_at?: string }).sort_at)) >= DRY_NOW.getTime() - 86_400_000);
});

test('card backfill stops when the AI budget is used and never publishes template fallbacks', async () => {
  const { deps, dry } = dryDeps();
  const fake = { name: 'gemini', model: 'x', summarize: async () => { throw new Error('must not be called'); } } as unknown as Deps['providers'][number];
  deps.providers = [fake];
  for (let i = 0; i < 1000; i++) deps.counter.add('gemini');
  assert.equal(aiCallsLeft(deps), 0);
  const r = await runCardBackfill(deps, { days: 30 });
  assert.equal(r.stoppedBy, 'ai_budget');
  assert.equal(r.rounds, 0);
  assert.equal(dry.cards.length, 0);
});

test('card backfill skips disaster, recall, space and world sources by default; widens short feed windows then restores them', async () => {
  const s = newsSources();
  for (const n of ['usgs', 'cpsc', 'nasa', 'wiki', 'macro', 'treasury'] as const) assert.ok(!s.includes(n), n);
  for (const n of ['fed', 'fedspeech', 'secpress', 'bea', 'fedreg', 'sec'] as const) assert.ok(s.includes(n), n);
  const before = [config.fedSpeechMaxAgeDays, config.secPressMaxAgeDays];
  await runCardBackfill(dryDeps().deps, { days: 60, limit: 100 });
  assert.deepEqual([config.fedSpeechMaxAgeDays, config.secPressMaxAgeDays], before);
});

test('sharedAiCounter starts from cloud usage and flushes its own calls through ai_usage_take', async () => {
  const calls: string[] = [];
  const f = (async (u: string) => {
    calls.push(String(u).split('/').pop()!);
    return new Response(String(u).endsWith('ai_usage_get') ? '{"gemini":40}' : 'true', { status: 200 });
  }) as unknown as typeof fetch;
  const { sharedAiCounter } = await import('../src/backfill.ts');
  const { counter, flush } = await sharedAiCounter('https://x.supabase.co', 'k', f);
  assert.equal(counter.used('gemini'), 40);
  counter.add('gemini'); counter.add('gemini');
  assert.equal(counter.used('gemini'), 42);
  assert.equal(await flush(), 2);
  assert.deepEqual(calls, ['ai_usage_get', 'ai_usage_take', 'ai_usage_take']);
});
