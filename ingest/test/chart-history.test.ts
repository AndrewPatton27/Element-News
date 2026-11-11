// M9c chart cards: the macro run keeps recent history filled (one batched call per series, never fatal) and every
// data card key is "<series>:<date>" so core.supersede_series leaves one live card per series. All offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HISTORY_KEEP, historyObservations, runMacro } from '../src/macroRun.ts';
import { config } from '../src/config.ts';
import type { Deps, RunStats } from '../src/pipeline.ts';
import { createDryRunPublisher, type Publisher } from '../src/publish.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { buildDataCard, buildObservation, buildYieldCurveCard, parseFredObservations, SERIES } from '../src/sources/macro.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const stats = (): RunStats => ({ published: 0, duplicate: 0, ticker_cap: 0, skipped: 0, failed: 0, ai: 0, template: 0, macro: 0, data_cards: 0 } as RunStats);

function deps(publisher: Publisher, lines: string[]): Deps {
  return {
    fetchText: async (url) => {
      const id = new URL(url).searchParams.get('series_id');
      if (id === 'DGS10') return fx('fred-backfill-DGS10.json');
      if (id === 'CPIAUCSL') return fx('fred-backfill-CPIAUCSL.json');
      throw new Error('HTTP 400 from api.stlouisfed.org');
    },
    publisher, providers: [], counter: memoryCounter(), fredApiKey: 'SECRET-FRED-KEY',
    now: new Date('2026-10-18T11:00:00Z'), log: (s) => lines.push(s),
  } as Deps;
}

test('historyObservations: newest readings only, oldest first, one per date, year-over-year formatted per reading', () => {
  const dgs = parseFredObservations(fx('fred-backfill-DGS10.json'));
  const rows = historyObservations('DGS10', dgs);
  assert.equal(rows.length, HISTORY_KEEP.daily);
  assert.equal(rows[rows.length - 1].obs_date, dgs[dgs.length - 1].date);
  assert.deepEqual(rows.map((r) => r.obs_date), [...rows.map((r) => r.obs_date)].sort());
  assert.equal(new Set(rows.map((r) => r.obs_date)).size, rows.length);
  const cpi = historyObservations('CPIAUCSL', parseFredObservations(fx('fred-backfill-CPIAUCSL.json')));
  assert.equal(cpi.length, HISTORY_KEEP.monthly);
  assert.equal(cpi[cpi.length - 1].display_value, '3.0%');
  assert.deepEqual(historyObservations('NOT_A_SERIES', dgs), []);
  assert.deepEqual(historyObservations('DGS10', []), []);
});

test('runMacro stores each series history in one batch (rows within the RPC cap) and never publishes old readings as cards', async () => {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  await runMacro(deps(dry.publisher, lines), stats());
  const dgs = dry.macroHistory.find((b) => b[0].series_id === 'DGS10');
  assert.ok(dgs && dgs.length === HISTORY_KEEP.daily, 'DGS10 history batch');
  assert.ok(dry.macroHistory.every((b) => b.length <= 200 && new Set(b.map((o) => o.series_id)).size === 1), 'one series per batch, under the 200-row cap');
  assert.equal(dry.macro.filter((o) => o.series_id === 'DGS10').length, 1, 'the live reading still goes through upsert_macro once');
  assert.ok(!lines.join('\n').includes('SECRET-FRED-KEY'));
});

test('a failing history call is logged and never stops the run or the card', async () => {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const publisher: Publisher = { ...dry.publisher, upsertMacroBatch: async () => { throw new Error('HTTP 404 from supabase.co'); } };
  const s = stats();
  await runMacro(deps(publisher, lines), s);
  assert.ok(s.macro >= 2, 'numbers rows still stored');
  assert.ok(lines.some((l) => /DGS10: chart history not stored: HTTP 404/.test(l)));
  const noBatch: Publisher = { ...dry.publisher, upsertMacroBatch: undefined };
  await runMacro(deps(noBatch, []), stats());                      // an older publisher without the method is fine
});

test('one live card per series: every data card key is "<SERIES>:<date>" with the series id before the colon', () => {
  const pts = parseFredObservations(fx('fred-backfill-DGS10.json'));
  let checked = 0;
  for (const id of Object.keys(SERIES)) {
    const o = buildObservation(id, pts);
    if (!o) continue;
    const c = buildDataCard({ ...o, series_id: id }, [], { force: true });
    if (!c) continue;
    checked++;
    assert.match(c.dedupe_key, /^[A-Z0-9_]+:\d{4}-\d{2}-\d{2}$/);
    assert.equal(c.dedupe_key.split(':')[0], id, `${id}: the supersede series is the series id`);
  }
  assert.ok(checked > 5, `checked ${checked}`);
  const curve = buildYieldCurveCard(Object.fromEntries(['DGS2', 'DGS5', 'DGS10', 'DGS30'].map((id) => [id, pts])), { force: true });
  assert.equal(curve?.dedupe_key.split(':')[0], 'YIELDCURVE');
  assert.equal(config.dataCardMinMove.DGS10, 99, 'a single maturity never gets its own card: the curve card carries it');
});
