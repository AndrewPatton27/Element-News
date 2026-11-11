// BLS (wages, Employment Cost Index, JOLTS) and BEA (PCE prices, personal income, GDP) data sources.
// Offline: real API replies saved in fixtures/ (bls-*.json, bea-nipa-*.json; the BEA key is not in them) and fake fetchers.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed, AllowlistError } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { beaPeriodDate, beaTableUrl, beaYears, parseBeaNipa } from '../src/sources/beadata.ts';
import { blsSeriesUrl, parseBlsSeries } from '../src/sources/bls.ts';
import { buildDataCard, buildObservation, SERIES } from '../src/sources/macro.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { templateSummarizer } from '../src/summarizer/template.ts';
import { validatePublish } from '../src/validate.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = new Date('2026-11-10T15:00:00Z');
const FAKE_KEY = '00000000-0000-0000-0000-000000000000';

function fetcher(seen: string[]): Deps['fetchText'] {
  return async (url, kind) => {
    assertAllowed(url, kind);
    seen.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.bls.gov') return fx(`bls-${u.pathname.split('/').pop()}.json`);
    if (u.hostname === 'apps.bea.gov') {
      const t = u.searchParams.get('TableName');
      return fx(t === 'T20804' ? 'bea-nipa-T20804-pce-prices.json' : t === 'T20600' ? 'bea-nipa-T20600-personal-income.json' : 'bea-nipa-T10105-gdp.json');
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}
function deps(seen: string[], extra: Partial<Deps> = {}) {
  const dry = createDryRunPublisher();
  const d: Deps = { fetchText: fetcher(seen), publisher: dry.publisher, providers: [templateSummarizer], counter: memoryCounter(), fredApiKey: null, now: NOW, log: () => {}, ...extra };
  return { d, dry };
}

test('allowlist: api.bls.gov and apps.bea.gov are API hosts, never page hosts', () => {
  assert.doesNotThrow(() => assertAllowed(blsSeriesUrl('CES0500000003'), 'api'));
  assert.doesNotThrow(() => assertAllowed(beaTableUrl('T10105', 'Q', [2026], FAKE_KEY), 'api'));
  assert.throws(() => assertAllowed(blsSeriesUrl('CES0500000003'), 'page'), AllowlistError);
  assert.throws(() => assertAllowed('https://www.bls.gov/eci/', 'api'), AllowlistError, 'bls.gov pages are page-kind only');
});

test('BLS parse: real reply -> points, annual and odd periods dropped, oldest first', () => {
  const ahe = parseBlsSeries(fx('bls-CES0500000003.json'));
  assert.ok(ahe.length >= 13, 'enough months for a year-over-year change');
  assert.deepEqual(ahe.at(-1), { date: '2026-10-01', value: 38.0 });
  assert.ok(ahe.every((p, i) => i === 0 || ahe[i - 1].date < p.date));
  assert.deepEqual(parseBlsSeries(fx('bls-CIU1010000000000A.json')).at(-1), { date: '2026-07-01', value: 3.4 }, 'Q03 = July (third quarter)');
  const mixed = JSON.stringify({ status: 'REQUEST_SUCCEEDED', Results: { series: [{ data: [
    { year: '2026', period: 'M13', value: '1' }, { year: '2026', period: 'Q05', value: '1' }, { year: '2026', period: 'S01', value: '1' },
    { year: '2026', period: 'M02', value: '-' }, { year: '2026', period: 'M03', value: '1,234.5' }] }] } });
  assert.deepEqual(parseBlsSeries(mixed), [{ date: '2026-03-01', value: 1234.5 }]);
});

test('BLS parse: a refused request throws with the API message', () => {
  const refused = JSON.stringify({ status: 'REQUEST_NOT_PROCESSED', message: ['daily threshold for total number of requests allocated has been reached'], Results: {} });
  assert.throws(() => parseBlsSeries(refused), /REQUEST_NOT_PROCESSED.*daily threshold/);
});

test('BLS url: v1 without a key, v2 with one; series id encoded', () => {
  assert.equal(blsSeriesUrl('CES0500000003'), 'https://api.bls.gov/publicAPI/v1/timeseries/data/CES0500000003');
  assert.equal(blsSeriesUrl('X', 'k1'), 'https://api.bls.gov/publicAPI/v2/timeseries/data/X?registrationkey=k1');
});

test('BEA parse: real replies -> real-unit points; commas and UNIT_MULT handled', () => {
  const pce = parseBeaNipa(fx('bea-nipa-T20804-pce-prices.json'), { DPCERG: 'BEA_PCE_YOY', DPCCRG: 'BEA_CORE_PCE_YOY' });
  assert.deepEqual(Object.keys(pce).sort(), ['BEA_CORE_PCE_YOY', 'BEA_PCE_YOY']);
  assert.deepEqual(pce.BEA_CORE_PCE_YOY.at(-1), { date: '2026-09-01', value: 130.902 });
  const inc = parseBeaNipa(fx('bea-nipa-T20600-personal-income.json'), { A065RC: 'BEA_PERSONAL_INCOME' });
  assert.deepEqual(inc.BEA_PERSONAL_INCOME.at(-1), { date: '2026-09-01', value: 27_707_845e6 });
  const gdp = parseBeaNipa(fx('bea-nipa-T10105-gdp.json'), { A191RC: 'BEA_GDP' });
  assert.deepEqual(gdp.BEA_GDP.at(-1), { date: '2026-07-01', value: 33_010_036e6 });
});

test('BEA helpers: period dates, year list, error reply hides ids', () => {
  assert.equal(beaPeriodDate('2026M09'), '2026-09-01');
  assert.equal(beaPeriodDate('2026Q4'), '2026-10-01');
  assert.equal(beaPeriodDate('2026'), null);
  assert.deepEqual(beaYears(NOW, 2), [2024, 2025, 2026]);
  const bad = JSON.stringify({ BEAAPI: { Results: { Error: { APIErrorCode: '1', APIErrorDescription: `Invalid API UserId ${FAKE_KEY}` } } } });
  assert.throws(() => parseBeaNipa(bad, {}), (e: Error) => /error 1/.test(e.message) && !e.message.includes(FAKE_KEY));
});

test('series cards: agency named (never FRED), economy category, valid, one per new period', () => {
  const ahe = parseBlsSeries(fx('bls-CES0500000003.json'));
  const c = buildDataCard(buildObservation('BLS_AHE', ahe)!)!;
  assert.match(c.headline, /^Average hourly earnings (up|down) \d\.\d% from a year earlier in October$/);
  assert.equal(c.dedupe_key, 'BLS_AHE:2026-10-01');
  const jolts = buildDataCard(buildObservation('BLS_JOLTS', parseBlsSeries(fx('bls-JTS000000000000000JOL.json')))!)!;
  assert.match(jolts.headline, /^Job openings (rise|fall) to 7\.52M in September$/);
  const eci = buildDataCard(buildObservation('BLS_ECI', parseBlsSeries(fx('bls-CIU1010000000000A.json')))!)!;
  assert.match(eci.headline, /^Employer labor costs unchanged at 3\.4% \(yearly change\) in Q3 2026$/);
  const gdp = buildDataCard(buildObservation('BEA_GDP', parseBeaNipa(fx('bea-nipa-T10105-gdp.json'), { A191RC: 'BEA_GDP' }).BEA_GDP)!)!;
  assert.match(gdp.headline, /^U\.S\. GDP (rises|falls) to \$33\.01T \(annual rate\) in Q3 2026$/);
  for (const card of [c, jolts, eci, gdp]) {
    assert.equal(card.category, 'economy');
    assert.equal(card.ai_generated, false);
    assert.ok(card.sources.length >= 1 && card.sources[0].license_class === 'public_domain');
    assert.match(card.sources[0].name, /^U\.S\. Bureau of (Labor Statistics|Economic Analysis)$/);
    assert.ok(!JSON.stringify(card).includes('FRED'), 'rule 8: the agency, never FRED');
    assert.match(card.macro[0].source_url, /^https:\/\/www\.(bls|bea)\.gov\//);
    assert.deepEqual(validatePublish(card).errors, []);
  }
});

test('every new series has an agency, provider and a unique sort order', () => {
  const ids = ['BLS_AHE', 'BLS_ECI', 'BLS_JOLTS', 'BEA_PCE_YOY', 'BEA_CORE_PCE_YOY', 'BEA_PERSONAL_INCOME', 'BEA_GDP'];
  assert.equal(new Set(Object.values(SERIES).map((s) => s.sort_order)).size, Object.keys(SERIES).length, 'sort_order is unique');
  for (const id of ids) assert.ok(SERIES[id].provider === 'bls' || SERIES[id].provider === 'bea', id);
  assert.deepEqual(Object.values(config.bls.series).sort(), ['BLS_AHE', 'BLS_CPI_ELECTRICITY', 'BLS_CPI_FOOD_HOME', 'BLS_CPI_MEDICAL', 'BLS_CPI_RENT', 'BLS_ECI', 'BLS_JOLTS']);
});

test('bls run: 7 requests (1 per series), 3 cards (the CPI components have no October card: October 2025 was never published), rerun adds no card; no key in any URL', async () => {
  const seen: string[] = [];
  const { d, dry } = deps(seen);
  const s1 = await runOnce(d, { only: ['bls'] });
  assert.equal(seen.length, 7, '3 labor series plus 4 CPI components');
  assert.ok(seen.every((u) => u.startsWith('https://api.bls.gov/publicAPI/v1/')));
  assert.deepEqual([s1.macro, s1.data_cards], [3, 3]);
  const s2 = await runOnce(d, { only: ['bls'] });
  assert.deepEqual([s2.macro, s2.data_cards], [3, 0], 'same period again: dedupe key already published');
  assert.equal(dry.cards.length, 3);
});

test('beadata run: off by default, off without a key, on with both; key never logged', async () => {
  const seen: string[] = [];
  const logs: string[] = [];
  const off = deps(seen, { keys: { bea: FAKE_KEY }, log: (l) => logs.push(l) });
  await runOnce(off.d, { only: ['beadata'] });
  assert.equal(seen.length, 0, 'disabled unless BEA_DATA_ENABLED');
  assert.ok(logs.some((l) => /disabled/.test(l)));
  const nokey = deps(seen, { keys: { beaDataEnabled: true } });
  await runOnce(nokey.d, { only: ['beadata'] });
  assert.equal(seen.length, 0);
  const on = deps(seen, { keys: { bea: FAKE_KEY, beaDataEnabled: true }, log: (l) => logs.push(l) });
  const s = await runOnce(on.d, { only: ['beadata'] });
  assert.equal(seen.length, 3, 'one request per table');
  assert.deepEqual([s.macro, s.data_cards], [4, 4]);
  assert.ok(logs.every((l) => !l.includes(FAKE_KEY)));
  assert.deepEqual(on.dry.cards.map((c) => c.dedupe_key).sort(), ['BEA_CORE_PCE_YOY:2026-09-01', 'BEA_GDP:2026-07-01', 'BEA_PCE_YOY:2026-09-01', 'BEA_PERSONAL_INCOME:2026-09-01']);
});

test('failing request is logged without the key and the other series still run', async () => {
  const logs: string[] = [];
  const dry = createDryRunPublisher();
  let n = 0;
  const d: Deps = { fetchText: async (url) => { if (n++ === 0) throw new Error(`HTTP 500 from ${new URL(url).hostname}`); return fx(`bls-${new URL(url).pathname.split('/').pop()}.json`); },
    publisher: dry.publisher, providers: [templateSummarizer], counter: memoryCounter(), fredApiKey: null, now: NOW, log: (l) => logs.push(l) };
  const s = await runOnce(d, { only: ['bls'] });
  assert.equal(s.data_cards, 2);
  assert.ok(logs.some((l) => /bls: BLS_AHE: HTTP 500/.test(l)));
});

test('migration 20261127000000: series rows match the code; cron jobs use the source names; no FRED wording', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261127000000_bls_bea_sources_cron.sql', import.meta.url), 'utf8');
  for (const id of ['BLS_AHE', 'BLS_ECI', 'BLS_JOLTS', 'BEA_PCE_YOY', 'BEA_CORE_PCE_YOY', 'BEA_PERSONAL_INCOME', 'BEA_GDP']) {
    const row = new RegExp(`\\('${id}',\\s*'([^']+)',\\s*'(bls|bea)',\\s*'([^']+)',\\s*'([^']+)',\\s*'([^']+)',\\s*'[^']+',\\s*'[^']+',\\s*(\\d+)`).exec(sql);
    assert.ok(row, `migration row for ${id}`);
    const s = SERIES[id];
    assert.deepEqual([row[1], row[2], row[3], row[4], row[5], Number(row[6])], [s.label, s.provider, s.source_name, s.source_short, s.agency.url, s.sort_order], id);
  }
  for (const name of ['bls', 'beadata']) {
    assert.ok(sql.includes(`'element-ingest-${name}'`) && sql.includes(`"source":"${name}"`), name);
  }
  const code = sql.split(/\r?\n/).filter((l) => !l.startsWith('--')).join(' ');
  assert.ok(!/FRED/.test(code), 'no FRED wording outside comments');
});
