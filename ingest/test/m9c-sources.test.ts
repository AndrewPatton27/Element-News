// M9c sources: 16 more FRED series, BLS release calendar, Treasury monthly budget statement, EIA refinery supply.
// Offline: recorded fixtures (real responses saved 2026-11-11 by ingest/scripts/live-m9c-check.ts) and fake fetchers only.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { runOnce, SOURCE_NAMES, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { blsCalendarCard, easternDate, majorFor, parseBlsCalendar, upcomingReleases } from '../src/sources/blscal.ts';
import { eiaUrl, parseEia, supplyCard } from '../src/sources/eia.ts';
import { buildDataCard, buildObservation, parseFredObservations, SERIES, WHY } from '../src/sources/macro.ts';
import { MORE_SERIES, MORE_WHY } from '../src/sources/moreSeries.ts';
import { mtsCard, mtsUrl, parseMts } from '../src/sources/mts.ts';
import { auctionCard, parseAuctions } from '../src/sources/treasuryauctions.ts';
import { gasStorageCard, petroleumCard } from '../src/sources/eia.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { validatePublish } from '../src/validate.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = new Date('2026-11-09T15:00:00Z');

function fakeDeps(fetchText: Deps['fetchText'], over: Partial<Deps> = {}) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = { fetchText, publisher: dry.publisher, providers: [], counter: memoryCounter(), fredApiKey: null, now: NOW, log: (l) => lines.push(l), ...over };
  return { dry, lines, deps };
}

// ---- registration and allowlist -----------------------------------------------------------

test('new source names are registered and fetched only from allowed hosts', () => {
  for (const s of ['blscal', 'mts']) assert.ok((SOURCE_NAMES as readonly string[]).includes(s), s);
  assert.doesNotThrow(() => assertAllowed(config.agency.blscal.url, 'page'));
  assert.throws(() => assertAllowed(config.agency.blscal.url, 'api'));
  assert.doesNotThrow(() => assertAllowed(mtsUrl(NOW), 'api'));
  assert.doesNotThrow(() => assertAllowed(eiaUrl(config.agency.eia.supply.routeSupply, ['WCRFPUS2'], 'K', 2), 'api'));
});

// ---- more FRED series ---------------------------------------------------------------------

test('16 new FRED series: fetched, defined once, cite the original agency plus "via FRED", have a WHY line, none is forbidden', () => {
  const ids = Object.keys(MORE_SERIES);
  assert.equal(ids.length, 16);
  for (const id of ids) {
    const s = SERIES[id];
    assert.ok((config.macroSeries as readonly string[]).includes(id), `${id} is fetched`);
    assert.ok(!(config.forbiddenSeries as readonly string[]).includes(id), id);
    assert.match(s.source_name, / via FRED$/, `${id} names the agency and FRED`);
    assert.doesNotMatch(s.source_name, /^FRED/, 'never bare FRED');
    assert.ok(s.agency.name && !/FRED/.test(s.agency.name), `${id} primary source is the agency`);
    assert.ok(WHY[id] && WHY[id] === MORE_WHY[id], `${id} WHY`);
    assert.ok(!WHY[id].includes(s.about), `${id} WHY does not repeat about`);
    assert.equal(s.provider, undefined, 'FRED provider');
    assert.equal(s.category, 'economy');
  }
  assert.equal(new Set(ids.map((i) => SERIES[i].sort_order)).size, ids.length, 'sort orders are unique');
  for (const banned of ['MORTGAGE30US', 'MORTGAGE15US', 'SP500', 'DJIA', 'NASDAQCOM', 'VIXCLS', 'RRPONTSYD', 'SOFR']) {
    assert.ok(!(config.macroSeries as readonly string[]).includes(banned), banned);
  }
});

test('PCE (yearly) from a recorded FRED response: card names BEA, links FRED for the number, passes validation', () => {
  const pts = parseFredObservations(fx('fred-PCEPI-observations.json'));
  const o = buildObservation('PCEPI', pts)!;
  assert.ok(o, 'a reading with a year-ago comparison');
  const c = buildDataCard(o)!;
  assert.match(c.headline, /^PCE inflation (up|down) \d+\.\d% from a year earlier in [A-Z][a-z]+$/);
  assert.equal(c.ai_generated, false);
  assert.equal(c.kind, 'data');
  assert.equal(c.sources[0].name, 'U.S. Bureau of Economic Analysis');
  assert.equal(c.macro[0].source_name, 'U.S. Bureau of Economic Analysis via FRED');
  assert.match(c.macro[0].source_url ?? '', /fred\.stlouisfed\.org\/series\/PCEPI/);
  assert.ok(c.body!.endsWith(WHY.PCEPI));
  assert.deepEqual(validatePublish(c).errors, []);
});

test('continuing claims (weekly): "week ending" wording, 3% threshold, millions shown with two decimals', () => {
  const pts = parseFredObservations(fx('fred-CCSA-observations.json'));
  const o = buildObservation('CCSA', pts)!;
  assert.match(o.display_value, /^\d\.\d\dM$/);
  assert.match(o.period_label ?? '', /^Week ending [A-Z][a-z]{2} \d+$/);
  const flat = buildObservation('CCSA', [{ date: '2026-10-17', value: 1_700_000 }, { date: '2026-10-24', value: 1_720_000 }])!;
  assert.equal(buildDataCard(flat), null, '+1.2% is below 3%');
  const big = buildObservation('CCSA', [{ date: '2026-10-17', value: 1_700_000 }, { date: '2026-10-24', value: 1_780_000 }])!;
  assert.match(buildDataCard(big)!.headline, /^Continuing jobless claims rise to 1\.78M in the week ending Oct 24$/);
});

test('unit scales read right: consumer credit in trillions, Fed balance sheet, durable goods in billions', () => {
  assert.equal(buildObservation('TOTALSL', [{ date: '2026-08-01', value: 5_200_000 }, { date: '2026-09-01', value: 5_224_420 }])!.display_value, '$5.22T');
  assert.equal(buildObservation('WALCL', [{ date: '2026-10-28', value: 6_700_000 }, { date: '2026-11-04', value: 6_750_000 }])!.display_value, '$6.75T');
  assert.equal(buildObservation('DGORDER', [{ date: '2026-08-01', value: 340_000 }, { date: '2026-09-01', value: 345_700 }])!.display_value, '$345.7B');
});

// ---- BLS release calendar -----------------------------------------------------------------

test('BLS calendar: parses the ICS, keeps only whole-name major releases, Eastern dates as written', () => {
  const all = parseBlsCalendar(fx('bls-calendar-sample.ics'));
  assert.equal(all.length, 9);
  assert.deepEqual(all.find((r) => r.name === 'Consumer Price Index'), { name: 'Consumer Price Index', date: '2026-11-10', time: '08:30' });
  assert.equal(majorFor('Consumer Price Index')!.slug, 'CPI');
  assert.equal(majorFor('Job Openings and Labor Turnover Survey (Monthly)')!.slug, 'JOLTS');
  assert.equal(majorFor('State Employment and Unemployment (Monthly)'), null);
  assert.equal(majorFor('Employer-Reported Workplace Injuries and Illnesses (Annual)'), null);
  assert.deepEqual(parseBlsCalendar('not a calendar'), []);
  assert.equal(easternDate(new Date('2026-11-10T03:30:00Z')), '2026-11-09', 'Eastern day, not UTC day');
});

test('BLS calendar card: day, time, agency credit, no AI, series key per report, valid', () => {
  const due = upcomingReleases(parseBlsCalendar(fx('bls-calendar-sample.ics')), NOW);
  assert.deepEqual(due.map((r) => r.name), ['Real Earnings', 'Consumer Price Index']);   // both Nov 10; PPI on Nov 13 is past the 3-day lead
  const c = blsCalendarCard(due[1], NOW);
  assert.equal(c.headline, 'Consumer price index (inflation) due Tuesday, Nov 10 at 8:30 a.m. ET');
  assert.equal(c.dedupe_key, 'BLSCAL_CPI:2026-11-10');
  assert.equal(c.kind, 'data');
  assert.equal(c.ai_generated, false);
  assert.equal(c.attribution, 'Source: U.S. Bureau of Labor Statistics');
  assert.equal(c.sources[0].name, 'U.S. Bureau of Labor Statistics');
  assert.equal(c.sources[0].license_class, 'public_domain');
  assert.deepEqual(validatePublish(c).errors, []);
  assert.equal(upcomingReleases(parseBlsCalendar(fx('bls-calendar-sample.ics')), NOW, 5).length, 3, 'lead window is configurable');
  assert.equal(upcomingReleases(parseBlsCalendar(fx('bls-calendar-sample.ics')), new Date('2026-11-14T15:00:00Z')).length, 1, 'past releases are never carded');
});

test('runOnce blscal: one card per due release, a rerun is all duplicates, no key or AI involved', async () => {
  const { dry, lines, deps } = fakeDeps(async (url, kind) => { assertAllowed(url, kind); return fx('bls-calendar-sample.ics'); });
  const stats = await runOnce(deps, { only: ['blscal'] });
  assert.equal(dry.cards.length, 2);
  assert.equal(stats.data_cards, 2);
  assert.equal(stats.ai, 0);
  assert.ok(lines.some((l) => /2 major releases/.test(l)));
  const again = await runOnce(deps, { only: ['blscal'] });
  assert.equal(again.data_cards, 0);
  assert.equal(dry.cards.length, 2, 'idempotent');
  const bad = fakeDeps(async () => { throw new Error('HTTP 503 from www.bls.gov'); });
  await runOnce(bad.deps, { only: ['blscal'] });
  assert.ok(bad.lines.some((l) => /blscal: failed/.test(l)));
});

// ---- Treasury monthly budget statement ----------------------------------------------------

test('MTS: newest month from a recorded table, deficit wording, year-earlier and fiscal-year-to-date context', () => {
  const m = parseMts(fx('mts-table-1.json'))!;
  assert.equal(m.recordDate, '2026-09-30');
  assert.equal(m.monthName, 'September');
  assert.equal(m.fiscalYear, 2026);
  assert.ok(m.deficit > 0, 'positive = deficit in the table');
  const c = mtsCard(m);
  assert.equal(c.headline, 'Federal government runs a $26.9 billion deficit in September');
  assert.match(c.body!, /A year earlier it was a \$197\.9 billion surplus\./);
  assert.match(c.body!, /For fiscal year 2026 so far the deficit is \$1\.99 trillion\./);
  assert.equal(c.dedupe_key, 'MTS_BUDGET:2026-09-30');
  assert.equal(c.sources[0].name, 'U.S. Department of the Treasury, Fiscal Service');
  assert.deepEqual(validatePublish(c).errors, []);
  assert.equal(parseMts('{}'), null);
  assert.equal(parseMts(JSON.stringify({ data: [{ record_date: '2026-10-31', classification_desc: 'October', current_month_gross_rcpt_amt: 'null', current_month_gross_outly_amt: 'null', current_month_dfct_sur_amt: 'null' }] })), null, 'a month with no numbers yet gives no card');
});

test('MTS surplus month reads as surplus (April); runOnce mts publishes once', async () => {
  const rows = [
    { record_date: '2026-04-30', print_order_nbr: '1', classification_desc: 'April', current_month_gross_rcpt_amt: '850000000000', current_month_gross_outly_amt: '600000000000', current_month_dfct_sur_amt: '-250000000000' },
    { record_date: '2026-04-30', print_order_nbr: '2', classification_desc: 'Year-to-Date', current_month_gross_rcpt_amt: '3000000000000', current_month_gross_outly_amt: '4000000000000', current_month_dfct_sur_amt: '1000000000000' },
  ];
  const m = parseMts(JSON.stringify({ data: rows }))!;
  assert.equal(mtsCard(m).headline, 'Federal government runs a $250.0 billion surplus in April');
  const { dry, deps } = fakeDeps(async (url, kind) => { assertAllowed(url, kind); return fx('mts-table-1.json'); });
  const stats = await runOnce(deps, { only: ['mts'] });
  assert.equal(dry.cards.length, 1);
  assert.equal(stats.template, 1);
  await runOnce(deps, { only: ['mts'] });
  assert.equal(dry.cards.length, 1, 'idempotent');
});

// ---- EIA refinery supply ------------------------------------------------------------------

test('EIA supply: refinery utilization headline with production, imports and demand in the detail', () => {
  const rows = [...parseEia(fx('eia-supply-weekly.json')), ...parseEia(fx('eia-utilization-weekly.json'))];
  const c = supplyCard(rows)!;
  assert.equal(c.headline, 'U.S. refineries run at 94.5% of capacity in the week ending Oct 30, up from 92.8%');
  assert.equal(c.dedupe_key, 'EIA_SUPPLY:2026-10-30');
  assert.equal(c.category, 'energy');
  assert.equal(c.attribution, 'Source: U.S. Energy Information Administration');
  assert.ok(c.detail?.key_points?.some((k) => /crude oil production: 14\.0 million barrels a day/.test(k)));
  assert.deepEqual(validatePublish(c).errors, []);
  assert.equal(supplyCard([]), null);
});

// ---- dedupe keys and one-live-card-per-series ---------------------------------------------

test('agency card keys: each report type is its own series (core.supersede_series keeps one live card per split_part(key, ":", 1))', () => {
  const series = (k: string) => k.split(':')[0];
  const pet = petroleumCard(parseEia(fx('eia-petroleum-stocks.json')))!.dedupe_key;
  const gas = gasStorageCard(parseEia(fx('eia-gas-storage.json')))!.dedupe_key;
  const sup = supplyCard([...parseEia(fx('eia-supply-weekly.json')), ...parseEia(fx('eia-utilization-weekly.json'))])!.dedupe_key;
  assert.equal(new Set([pet, gas, sup].map(series)).size, 3, 'petroleum, gas storage and supply are separate series');
  const auctions = parseAuctions(fx('treasury-auctions.json')).map(auctionCard).filter((c) => c !== null).map((c) => c!.dedupe_key);
  assert.ok(auctions.length >= 1);
  for (const k of [pet, gas, sup, ...auctions]) assert.match(k, /^[A-Z0-9_]+:\d{4}-\d{2}-\d{2}$/, 'SERIES:date, the date sorts the newest reading');
});

test('migration 20261134000000: rows match the code, run_log names match the registered sources, cron file has the two jobs', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261134000000_m9c_series.sql', import.meta.url), 'utf8');
  for (const id of Object.keys(MORE_SERIES)) {
    const s = SERIES[id];
    const row = new RegExp(String.raw`\('${id}',\s*'([^']+)',\s*'fred',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'[^']+',\s*'[^']+',\s*(\d+)`).exec(sql);
    assert.ok(row, `migration row for ${id}`);
    assert.deepEqual([row[1], row[2], row[3], row[4], Number(row[5])], [s.label, s.source_name, s.source_short, `https://fred.stlouisfed.org/series/${id}`, s.sort_order], id);
  }
  assert.ok(/array\['blscal', 'mts'/.test(sql));
  const cron = readFileSync(new URL('../../supabase/migrations/20261134000100_m9c_sources_cron.sql', import.meta.url), 'utf8');
  for (const name of ['blscal', 'mts']) {
    assert.ok(cron.includes(`'element-ingest-${name}'`), name);
    assert.ok(cron.includes(`"source":"${name}"`), name);
    assert.ok((SOURCE_NAMES as readonly string[]).includes(name));
  }
  assert.ok(cron.includes('cron.unschedule'), 'idempotent');
  assert.ok(!/set search_path|security definer/i.test(sql + cron), 'no functions here');
});
