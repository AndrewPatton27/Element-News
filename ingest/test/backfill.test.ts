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

  assert.equal(stats.failed, 10, 'the other ten series fail and are logged, not fatal');
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
