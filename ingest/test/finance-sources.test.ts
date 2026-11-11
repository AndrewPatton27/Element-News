// Finance and rates sources (2026-11-08): Treasury FiscalData, FOMC statements/minutes labelling, Fed speeches,
// SEC press releases, extra FRED series and the computed 10Y-2Y spread. Offline: fixtures and fake fetchers only.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed, AllowlistError } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { runOnce, SOURCE_NAMES, templateAllowed, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { fedItemToItem, parseRss } from '../src/sources/fed.ts';
import { fedSpeechToItem, selectFedSpeeches } from '../src/sources/fedspeech.ts';
import { avgRatesUrl, debtUrl, parseAvgRates, parseDebt } from '../src/sources/fiscaldata.ts';
import { buildDataCard, buildObservation, differenceSeries, formatAmount, SERIES, type Point } from '../src/sources/macro.ts';
import { secPressToItem, selectSecPress } from '../src/sources/secpress.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { validatePublish } from '../src/validate.ts';
import type { RawItem } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const pts = (...p: [string, number][]): Point[] => p.map(([date, value]) => ({ date, value }));
const NOW = new Date('2026-11-08T15:00:00Z');

// ---- allowlist --------------------------------------------------------------------------

test('allowlist: FiscalData is an API host only; Fed and SEC feeds are page hosts; NY Fed stays refused (R-37)', () => {
  assert.doesNotThrow(() => assertAllowed(avgRatesUrl(), 'api'));
  assert.doesNotThrow(() => assertAllowed(debtUrl(), 'api'));
  assert.throws(() => assertAllowed(avgRatesUrl(), 'page'), AllowlistError, 'FiscalData pages are never downloaded');
  assert.doesNotThrow(() => assertAllowed(config.feeds.fedSpeechRss, 'page'));
  assert.doesNotThrow(() => assertAllowed(config.feeds.secPressRss, 'page'));
  for (const kind of ['api', 'page'] as const) {
    assert.throws(() => assertAllowed('https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json', kind), AllowlistError);
  }
});

// ---- Treasury FiscalData ----------------------------------------------------------------

test('FiscalData average rates: strings parsed, "null" and non-marketable rows dropped, oldest first', () => {
  const r = parseAvgRates(fx('fiscaldata-avg-rates-two-months.json'));
  assert.deepEqual(r.TREAS_AVG_BILLS, pts(['2026-09-30', 4.08], ['2026-10-31', 4.014]));
  assert.deepEqual(r.TREAS_AVG_NOTES, pts(['2026-09-30', 3.35], ['2026-10-31', 3.399]));
  assert.deepEqual(r.TREAS_AVG_BONDS, pts(['2026-09-30', 3.2]), 'the "null" October bond rate is ignored');
  assert.equal(Object.keys(r).length, 3);
  const given = parseAvgRates(fx('fiscaldata-avg-interest-rates.json'));
  assert.deepEqual(given.TREAS_AVG_BILLS, pts(['2026-10-31', 4.014]));
});

test('FiscalData debt: string dollars parsed, "null" dropped', () => {
  assert.deepEqual(parseDebt(fx('fiscaldata-debt.json')), pts(['2026-11-04', 38_090_000_000_000], ['2026-11-05', 38_100_000_000_000]));
  assert.deepEqual(parseDebt('{"data":[]}'), []);
  assert.deepEqual(parseDebt('{}'), []);
});

test('average-rate series: observation, data card only via the agency, no FRED wording', () => {
  const o = buildObservation('TREAS_AVG_NOTES', parseAvgRates(fx('fiscaldata-avg-rates-two-months.json')).TREAS_AVG_NOTES)!;
  assert.deepEqual([o.display_value, o.change_text, o.direction, o.period_label], ['3.40%', '+5 bp', 'up', 'Oct 2026']);
  const c = buildDataCard(o)!;
  assert.equal(c.headline, 'Average interest rate on Treasury notes rises to 3.40% in October');
  assert.equal(c.category, 'economy');
  assert.equal(c.sources[0].name, 'U.S. Department of the Treasury, Fiscal Service');
  assert.match(c.macro[0].source_url, /^https:\/\/fiscaldata\.treasury\.gov\//);
  assert.equal(c.macro[0].source_short, 'Treasury Fiscal Service');
  assert.ok(!JSON.stringify(c).includes('FRED'));
  assert.deepEqual(validatePublish(c).errors, []);
});

test('national debt: trillions format, never a data card (numbers only)', () => {
  assert.equal(formatAmount(38.1e12, 2), '38.10T');
  assert.equal(formatAmount(745e9, 1), '745.0B', 'billions unchanged');
  const o = buildObservation('TREAS_DEBT', parseDebt(fx('fiscaldata-debt.json')))!;
  assert.equal(o.display_value, '$38.10T');
  assert.ok(config.dataCardMinMove.TREAS_DEBT >= 1e9);
  assert.equal(buildDataCard(o), null);
});

// ---- extra FRED series and the spread -----------------------------------------------------

test('new FRED series are configured, public-domain Fed citations, and no copyrighted ones sneak in', () => {
  for (const id of ['DGS3MO', 'DGS5', 'DGS30', 'EFFR', 'DFEDTARU', 'DFEDTARL']) {
    assert.ok((config.macroSeries as readonly string[]).includes(id), id);
    assert.equal(SERIES[id].source_short, 'Federal Reserve via FRED', id);
    assert.ok(SERIES[id].source_name.endsWith('via FRED'), id);
  }
  for (const banned of ['T10Y2Y', 'SOFR', 'MORTGAGE30US']) assert.ok(!(config.macroSeries as readonly string[]).includes(banned), banned);
  assert.deepEqual(config.derivedSeries.SPREAD_10Y2Y, ['DGS10', 'DGS2']);
});

test('10Y-2Y spread is computed from DGS10 and DGS2 on shared dates', () => {
  const d = differenceSeries(pts(['2026-11-03', 4.1], ['2026-11-04', 4.15], ['2026-11-05', 4.2]), pts(['2026-11-04', 3.6], ['2026-11-05', 3.55], ['2026-11-06', 3.5]));
  assert.deepEqual(d, pts(['2026-11-04', 0.55], ['2026-11-05', 0.65]));
  const o = buildObservation('SPREAD_10Y2Y', d)!;
  assert.deepEqual([o.display_value, o.change_text, o.direction], ['0.65%', '+10 bp', 'up']);
  assert.equal(buildDataCard(o), null, 'numbers only');
});

// ---- FOMC statements and minutes --------------------------------------------------------

test('FOMC statement is labelled, flagged as fed and credits the Board (summary text goes through the 25-word limit)', () => {
  const items = parseRss(fx('fed-rss-monetary-and-speeches.xml'));
  const statement = fedItemToItem(items[0]);
  assert.equal(statement.doc_label, 'FOMC statement');
  assert.equal(statement.event_type, 'fed');
  assert.equal(statement.license_class, 'public_domain');
  assert.equal(statement.attribution, 'Source: Board of Governors of the Federal Reserve System');
  assert.equal(config.copyLimitWords.public_domain, 25);
  const minutes = fedItemToItem({ ...items[0], title: 'Minutes of the Federal Open Market Committee, October 27-28, 2026', link: 'https://www.federalreserve.gov/monetarypolicy/fomcminutes20261028.htm' });
  assert.equal(minutes.doc_label, 'FOMC minutes');
  assert.equal(fedItemToItem({ ...items[0], title: 'Federal Reserve Board announces final rule' }).attribution, undefined);
});

// ---- Fed speeches --------------------------------------------------------------------------

test('Fed speeches: only /speech/ and /testimony/ links, none dated in the future, newest first', () => {
  const list = parseRss(fx('fed-rss-monetary-and-speeches.xml'));
  const sel = selectFedSpeeches([list], NOW, 60);
  assert.deepEqual(sel.map((i) => i.link), ['https://www.federalreserve.gov/newsevents/speech/waller20261008a.htm']);
  assert.deepEqual(selectFedSpeeches([list], new Date('2026-10-07T12:00:00Z'), 60), [], 'embargoed: pubDate is still in the future');
  assert.deepEqual(selectFedSpeeches([list], NOW, 10), [], 'older than the window');
});

test('Fed speech item: public domain, policy, no event type, Board attribution, feed text only', () => {
  const it = fedSpeechToItem(parseRss(fx('fed-rss-monetary-and-speeches.xml'))[1]);
  assert.deepEqual([it.source, it.license_class, it.category, it.event_type, it.doc_label], ['fed_speech', 'public_domain', 'policy', null, 'Speech']);
  assert.equal(it.attribution, 'Source: Board of Governors of the Federal Reserve System');
  assert.equal(it.summary_text, 'Waller, The Signaling Value of the Summary of Economic Projections. Speech At the Istanbul Economic Forum');
  assert.equal(fedSpeechToItem({ ...parseRss(fx('fed-rss-monetary-and-speeches.xml'))[1], link: 'https://www.federalreserve.gov/newsevents/testimony/waller20261008a.htm' }).doc_label, 'Testimony');
});

// ---- SEC press releases --------------------------------------------------------------------

test('SEC press releases: deduped by link, future and old items dropped', () => {
  const sel = selectSecPress(parseRss(fx('sec-press.rss.xml')), NOW);
  assert.deepEqual(sel.map((i) => i.link), [
    'https://www.sec.gov/newsroom/press-releases/2026-141',
    'https://www.sec.gov/newsroom/press-releases/2026-140',
  ]);
});

test('SEC press item: 10-word copy limit class, SEC credit, HTML stripped', () => {
  const sel = selectSecPress(parseRss(fx('sec-press.rss.xml')), NOW).map(secPressToItem);
  assert.equal(sel[0].license_class, 'company_filing');
  assert.equal(config.copyLimitWords[sel[0].license_class], 10);
  assert.equal(sel[0].attribution, 'Source: U.S. Securities and Exchange Commission');
  assert.equal(sel[0].source_name, 'U.S. Securities and Exchange Commission');
  assert.equal(sel[1].summary_text, 'SEC Announces Enforcement Results for Fiscal Year 2026. The SEC announced results of its enforcement actions for the fiscal year ended September 30.');
  assert.ok(!sel[1].summary_text.includes('<'));
});

test('speeches and SEC press releases never get template cards (AI relevance only)', () => {
  assert.equal(templateAllowed({ source: 'fed_speech' } as RawItem), false);
  assert.equal(templateAllowed({ source: 'sec_press' } as RawItem), false);
});

// ---- migration -----------------------------------------------------------------------------

test('migration 20261111000000: series rows match the code, cron jobs match the source names, no copyrighted series', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261111000000_finance_sources_cron.sql', import.meta.url), 'utf8');
  const ids = ['DGS3MO', 'DGS5', 'DGS30', 'EFFR', 'DFEDTARU', 'DFEDTARL', 'SPREAD_10Y2Y', 'TREAS_AVG_BILLS', 'TREAS_AVG_NOTES', 'TREAS_AVG_BONDS', 'TREAS_DEBT'];
  for (const id of ids) {
    const row = new RegExp(`\\('${id}',\\s*'([^']+)',\\s*'(fred|treasury)',\\s*'([^']+)',\\s*'([^']+)',\\s*'[^']+',\\s*'[^']+',\\s*'[^']+',\\s*(\\d+)`).exec(sql);
    assert.ok(row, `migration row for ${id}`);
    const s = SERIES[id];
    assert.deepEqual([row[1], row[3], row[4], Number(row[5])], [s.label, s.source_name, s.source_short, s.sort_order], id);
    assert.equal(row[2], s.provider ?? 'fred', id);
    assert.notEqual(row[4], 'FRED');
  }
  assert.ok(!/\('(T10Y2Y|SOFR|MORTGAGE30US)'/.test(sql));
  for (const name of ['fedspeech', 'secpress', 'treasury']) {
    assert.ok(sql.includes(`'element-ingest-${name}'`), name);
    assert.ok(sql.includes(`"source":"${name}"`), name);
    assert.ok((SOURCE_NAMES as readonly string[]).includes(name));
  }
  const check = /check \(source in \(([^)]*)\)\)/.exec(sql)![1].replace(/'/g, '').split(',').map((s) => s.trim());
  assert.deepEqual(check.filter((s) => s !== 'brief-summary').sort(), [...SOURCE_NAMES].filter((s) => !['bls', 'beadata', 'eia', 'census', 'auctions', 'fomc', 'blscal', 'mts', 'newsdata_market', 'newsdata_latest'].includes(s)).sort(), 'run_log accepts exactly the pipeline sources (bls and beadata are added by 20261127000000)');
  assert.ok(/'(\d+) \* \* \* \*'|\* \* \*/.test(sql));
});

// ---- pipeline ----------------------------------------------------------------------------------

function fakeDeps(fetchText: Deps['fetchText'], fredApiKey: string | null = null) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = { fetchText, publisher: dry.publisher, providers: [], counter: memoryCounter(), fredApiKey, now: NOW, log: (l) => lines.push(l) };
  return { dry, lines, deps };
}

test('new sources are registered under their own names (the cron job names)', () => {
  for (const s of ['treasury', 'fedspeech', 'secpress']) assert.ok((SOURCE_NAMES as readonly string[]).includes(s), s);
});

test('runOnce treasury: numbers for 3 rates and the debt, one data card (notes), URLs pass the allowlist', async () => {
  const seen: string[] = [];
  const { dry, deps } = fakeDeps(async (url, kind) => {
    assertAllowed(url, kind);
    seen.push(url);
    return url === avgRatesUrl() ? fx('fiscaldata-avg-rates-two-months.json') : fx('fiscaldata-debt.json');
  });
  const stats = await runOnce(deps, { only: ['treasury'] });
  assert.deepEqual(seen, [avgRatesUrl(), debtUrl()]);
  assert.deepEqual(dry.macro.map((m) => m.series_id).sort(), ['TREAS_AVG_BILLS', 'TREAS_AVG_BONDS', 'TREAS_AVG_NOTES', 'TREAS_DEBT']);
  assert.equal(stats.macro, 4);
  assert.equal(stats.data_cards, 1);
  assert.equal(dry.cards[0].dedupe_key, 'TREAS_AVG_NOTES:2026-10-31');
});

test('runOnce treasury: one dataset failing does not stop the other', async () => {
  const { dry, lines, deps } = fakeDeps(async (url) => {
    if (url === avgRatesUrl()) throw new Error('HTTP 503 from api.fiscaldata.treasury.gov');
    return fx('fiscaldata-debt.json');
  });
  await runOnce(deps, { only: ['treasury'] });
  assert.deepEqual(dry.macro.map((m) => m.series_id), ['TREAS_DEBT']);
  assert.ok(lines.some((l) => l.includes('average rates failed')));
});

test('runOnce macro: computes the spread from DGS10 and DGS2 and fetches no T10Y2Y', async () => {
  const urls: string[] = [];
  const { dry, deps } = fakeDeps(async (url) => {
    urls.push(url);
    const id = new URL(url).searchParams.get('series_id');
    const v = id === 'DGS10' ? ['4.10', '4.20'] : id === 'DGS2' ? ['3.60', '3.65'] : ['1.00', '1.00'];
    return JSON.stringify({ observations: [{ date: '2026-11-04', value: v[0] }, { date: '2026-11-05', value: v[1] }] });
  }, 'test-key');
  await runOnce(deps, { only: ['macro'] });
  const spread = dry.macro.find((m) => m.series_id === 'SPREAD_10Y2Y')!;
  assert.deepEqual([spread.display_value, spread.change_text], ['0.55%', '+5 bp']);
  assert.ok(!urls.some((u) => /T10Y2Y|series_id=SOFR/.test(u)));
  assert.ok(['DGS3MO', 'DGS5', 'DGS30', 'EFFR', 'DFEDTARU', 'DFEDTARL'].every((id) => dry.macro.some((m) => m.series_id === id)));
});

test('runOnce fedspeech / secpress: one failing feed is logged, nothing else breaks', async () => {
  const a = fakeDeps(async () => { throw new Error('boom'); });
  await runOnce(a.deps, { only: ['fedspeech', 'secpress'] });
  assert.ok(a.lines.some((l) => l.startsWith('fedspeech: feed failed')));
  assert.ok(a.lines.some((l) => l.startsWith('secpress: feed failed')));
});

test('runOnce secpress: an item without an AI provider is not published as a template card', async () => {
  const { dry, deps } = fakeDeps(async (url) => {
    assertAllowed(url, 'page');
    return fx('sec-press.rss.xml');
  });
  const stats = await runOnce(deps, { only: ['secpress'] });
  assert.equal(stats.published, 0);
  assert.equal(dry.cards.length, 0);
});
