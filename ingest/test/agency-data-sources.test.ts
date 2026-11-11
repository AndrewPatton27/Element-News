// Agency data-card sources (D-113): EIA, Census (off by default), Treasury auctions, FOMC calendar and minutes.
// Offline: fixtures and fake fetchers only. No key value appears in any card or log line.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed, AllowlistError } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { runOnce, SOURCE_NAMES, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { fedItemToItem, fedPageText, parseRss } from '../src/sources/fed.ts';
import { censusCard, censusUrl, parseCensus } from '../src/sources/census.ts';
import { eiaUrl, gasolineCard, gasStorageCard, parseEia, petroleumCard } from '../src/sources/eia.ts';
import { fomcCard, upcomingMeetings } from '../src/sources/fomc.ts';
import { auctionCard, auctionsUrl, parseAuctions } from '../src/sources/treasuryauctions.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { validatePublish } from '../src/validate.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = new Date('2026-11-10T20:00:00Z');
const KEY = 'SECRET-EIA-KEY-123';

function fakeDeps(fetchText: Deps['fetchText'], over: Partial<Deps> = {}) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = { fetchText, publisher: dry.publisher, providers: [], counter: memoryCounter(), fredApiKey: null, now: NOW, log: (l) => lines.push(l), ...over };
  return { dry, lines, deps };
}

test('registered source names and allowlist: EIA and Census are API hosts only', () => {
  for (const s of ['eia', 'census', 'auctions', 'fomc']) assert.ok((SOURCE_NAMES as readonly string[]).includes(s), s);
  assert.doesNotThrow(() => assertAllowed(eiaUrl('/petroleum/stoc/wstk/data/', ['WCESTUS1'], KEY, 2), 'api'));
  assert.throws(() => assertAllowed('https://api.eia.gov/v2/petroleum', 'page'), AllowlistError);
  assert.doesNotThrow(() => assertAllowed(censusUrl('retail', NOW, null), 'api'));
  assert.doesNotThrow(() => assertAllowed(auctionsUrl(NOW), 'api'));
  assert.throws(() => assertAllowed('https://www.eia.gov/petroleum/supply/weekly/', 'api'), AllowlistError);
});

// ---- EIA ---------------------------------------------------------------------------------

test('EIA petroleum: crude headline with the change, gasoline and distillate in the detail, agency credit', () => {
  const rows = parseEia(fx('eia-petroleum-stocks.json'));
  assert.equal(rows.length, 6);
  const c = petroleumCard(rows)!;
  assert.equal(c.headline, 'U.S. crude oil inventories fall 3.4 million barrels in the week ending Nov 6');
  assert.equal(c.kind, 'data');
  assert.equal(c.ai_generated, false);
  assert.equal(c.category, 'energy');
  assert.equal(c.dedupe_key, 'EIA_PETROLEUM:2026-11-06');
  assert.equal(c.attribution, 'Source: U.S. Energy Information Administration');
  assert.equal(c.sources[0].name, 'U.S. Energy Information Administration');
  assert.equal(c.sources[0].license_class, 'public_domain');
  assert.ok(c.detail!.key_points!.some((k) => k.startsWith('Motor gasoline inventories: 215.1 million barrels (+1.1')));
  assert.deepEqual(validatePublish(c).errors, []);
});

test('EIA gas storage and gasoline: formatted, bad "null" rows ignored; one row only gives no card', () => {
  const g = gasStorageCard(parseEia(fx('eia-gas-storage.json')))!;
  assert.equal(g.headline, 'U.S. natural gas storage rises 52 Bcf in the week ending Nov 6');
  assert.equal(g.dedupe_key, 'EIA_GAS_STORAGE:2026-11-06');
  assert.deepEqual(validatePublish(g).errors, []);
  const p = gasolineCard(parseEia(fx('eia-gasoline.json')))!;
  assert.equal(p.headline, 'U.S. regular gas price rises to $3.12 a gallon in the week of Nov 9');
  assert.deepEqual(validatePublish(p).errors, []);
  assert.equal(gasStorageCard(parseEia('{"response":{"data":[{"period":"2026-11-06","series":"NW2_EPG0_SWO_R48_BCF","value":"3912"}]}}')), null);
  assert.deepEqual(parseEia('{}'), []);
});

test('runOnce eia: needs a key, never logs it, three cards (gasoline stays off), a rerun gives duplicates only', async () => {
  const none = fakeDeps(async () => { throw new Error('should not fetch'); });
  await runOnce(none.deps, { only: ['eia'] });
  assert.ok(none.lines.some((l) => /EIA_API_KEY not set/.test(l)));
  assert.equal(none.dry.cards.length, 0);

  const seen: string[] = [];
  const { dry, lines, deps } = fakeDeps(async (url, kind) => {
    assertAllowed(url, kind);
    seen.push(url);
    return url.includes('/stoc/wstk/') ? fx('eia-petroleum-stocks.json') : url.includes('/stor/wkly/') ? fx('eia-gas-storage.json') : url.includes('/sndw/') ? fx('eia-supply-weekly.json') : url.includes('/wiup/') ? fx('eia-utilization-weekly.json') : '{}';
  }, { eiaApiKey: KEY });
  const stats = await runOnce(deps, { only: ['eia'] });
  assert.equal(seen.length, 4, 'one request per report group (supply uses two), gasoline off');
  assert.equal(dry.cards.length, 3);
  assert.equal(stats.data_cards, 3);
  assert.equal(stats.template, 3);
  assert.equal(stats.ai, 0, 'no AI call');
  assert.ok(!JSON.stringify([lines, dry.cards]).includes(KEY), 'the key never reaches cards or logs');
  const again = await runOnce(deps, { only: ['eia'] });
  assert.equal(again.published, 0);
  assert.equal(dry.cards.length, 3, 'idempotent');
});

test('runOnce eia: one failing report does not stop the other', async () => {
  const { dry, lines, deps } = fakeDeps(async (url) => {
    if (url.includes('/stoc/wstk/')) throw new Error('HTTP 500 from api.eia.gov');
    return fx('eia-gas-storage.json');
  }, { eiaApiKey: KEY });
  await runOnce(deps, { only: ['eia'] });
  assert.equal(dry.cards.length, 1);
  assert.ok(lines.some((l) => /petroleum failed/.test(l)));
});

// ---- Treasury auctions ---------------------------------------------------------------------

test('Treasury auctions: only settled note/bond results, TIPS and bills skipped, newest first', () => {
  const r = parseAuctions(fx('treasury-auctions.json'));
  assert.deepEqual(r.map((x) => x.cusip), ['91282CPA1', '91282CPC7', '91282CPD5', '91282CPE3']);
  const c = auctionCard(r[0])!;
  assert.equal(c.headline, '10-year Treasury note auction clears at 4.215%');
  assert.match(c.body!, /offered \$42 billion/);
  assert.match(c.body!, /2\.61 times/);
  assert.equal(c.dedupe_key, 'AUCTION_10Y_NOTE:2026-11-10');
  assert.equal(c.category, 'markets');
  assert.equal(c.sources[0].name, 'U.S. Department of the Treasury, Fiscal Service');
  assert.deepEqual(validatePublish(c).errors, []);
  assert.equal(auctionCard(r[2]), null, 'inflation-protected securities get no card');
});

test('runOnce auctions: at most 2 new cards per run, the rest next run; reruns add nothing', async () => {
  const { dry, lines, deps } = fakeDeps(async (url, kind) => { assertAllowed(url, kind); return fx('treasury-auctions.json'); });
  const s1 = await runOnce(deps, { only: ['auctions'] });
  assert.equal(s1.data_cards, 2);
  assert.ok(lines.some((l) => /card cap reached/.test(l)));
  const s2 = await runOnce(deps, { only: ['auctions'] });
  assert.equal(s2.data_cards, 1, 'the one left over from the first run (TIPS skipped)');
  const s3 = await runOnce(deps, { only: ['auctions'] });
  assert.equal(s3.data_cards, 0);
  assert.equal(dry.cards.length, 3);
});

// ---- Census (off by default) -----------------------------------------------------------------

test('Census: disabled by default, fetches nothing', async () => {
  assert.equal(config.agency.census.enabled, false);
  const { dry, lines, deps } = fakeDeps(async () => { throw new Error('should not fetch'); });
  await runOnce(deps, { only: ['census'] });
  assert.equal(dry.cards.length, 0);
  assert.ok(lines.some((l) => /census: disabled/.test(l)));
});

test('Census parsers and cards (when enabled): error rows dropped, notice on the card, dedupe per month', async () => {
  const retail = parseCensus(fx('census-retail.json'));
  assert.deepEqual(retail.map((p) => p.time), ['2026-08', '2026-09', '2026-10']);
  const c = censusCard('retail', retail)!;
  assert.equal(c.headline, 'Retail sales rise 0.6% in Oct');
  assert.equal(c.dedupe_key, 'CENSUS_RETAIL:2026-10');
  assert.match(c.attribution!, /not endorsed or certified by the Census Bureau/);
  assert.match(c.body!, /\$745\.5 billion/);
  assert.deepEqual(validatePublish(c).errors, []);
  const h = censusCard('housing', parseCensus(fx('census-housing.json')))!;
  assert.equal(h.headline, 'Housing starts rise to 1,352,000 in Oct');
  assert.equal(censusCard('housing', []), null);
  assert.deepEqual(parseCensus('[]'), []);

  const c0 = config.agency.census as { enabled: boolean };
  c0.enabled = true;
  try {
    const { dry, deps } = fakeDeps(async (url, kind) => { assertAllowed(url, kind); return url.includes('/marts') ? fx('census-retail.json') : fx('census-housing.json'); });
    await runOnce(deps, { only: ['census'] });
    await runOnce(deps, { only: ['census'] });
    assert.equal(dry.cards.length, 2, 'the same month never makes a second card');
  } finally { c0.enabled = false; }
});

// ---- FOMC calendar and minutes ---------------------------------------------------------------

test('FOMC calendar: card only inside the lead window, dedupe per meeting, no AI', async () => {
  assert.deepEqual(upcomingMeetings(new Date('2026-11-20T10:00:00Z')), []);
  assert.deepEqual(upcomingMeetings(new Date('2026-12-01T10:00:00Z')).map((m) => m[1]), ['2026-12-09']);
  assert.deepEqual(upcomingMeetings(new Date('2026-12-10T10:00:00Z')), [], 'meeting over');
  const now = new Date('2026-12-02T10:00:00Z');
  const c = fomcCard(['2026-12-08', '2026-12-09', true], now);
  assert.equal(c.headline, 'Fed policy meeting set for Dec 8-9');
  assert.match(c.body!, /minutes follow about three weeks later, around Dec 30/);
  assert.match(c.body!, /economic projections/);
  assert.equal(c.attribution, 'Source: Board of Governors of the Federal Reserve System');
  assert.equal(c.sources[0].name, 'Federal Reserve Board');
  assert.deepEqual(validatePublish(c).errors, []);
  const { dry, deps } = fakeDeps(async () => { throw new Error('no network'); }, { now });
  await runOnce(deps, { only: ['fomc'] });
  await runOnce(deps, { only: ['fomc'] });
  assert.equal(dry.cards.length, 1);
});

test('FOMC minutes arrive through the existing Fed page path: labelled, credited to the Board, page text from a page host', () => {
  const xml = `<rss><channel><item><title>Minutes of the Federal Open Market Committee, October 27-28, 2026</title>
    <link>https://www.federalreserve.gov/monetarypolicy/fomcminutes20261028.htm</link><description>Minutes</description>
    <category>Monetary Policy</category><pubDate>Wed, 18 Nov 2026 19:00:00 GMT</pubDate></item></rss>`;
  const [item] = parseRss(xml).map(fedItemToItem);
  assert.equal(item.doc_label, 'FOMC minutes');
  assert.equal(item.license_class, 'public_domain');
  assert.equal(item.attribution, config.fedSpeechAttribution);
  assert.doesNotThrow(() => assertAllowed(item.url, 'page'), 'www.federalreserve.gov is a page host (rule 2)');
  assert.ok(fedPageText('<div id="article"><p>Participants discussed.</p></div></div>').includes('Participants'));
  assert.ok(config.pageHosts.includes('www.federalreserve.gov'));
});

test('every agency source states a per-run cap of at most 4 new cards (EIA reports four a week)', () => {
  const a = config.agency;
  for (const cap of [a.eia.maxCardsPerRun, a.census.maxCardsPerRun, a.auctions.maxCardsPerRun]) assert.ok(cap >= 1 && cap <= 4);
});

test('cron migration: idempotent, mirrors the element-ingest jobs, run_log accepts the new sources', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261128000000_agency_sources_cron.sql', import.meta.url), 'utf8');
  for (const name of ['eia', 'auctions', 'fomc']) {
    assert.ok(sql.includes(`'element-ingest-${name}'`), name);
    assert.ok(sql.includes(`"source":"${name}"`), name);
  }
  assert.ok(!sql.includes('"source":"census"'), 'census has no cron job');
  assert.ok(/cron\.unschedule\(jobname\)/.test(sql));
  const check = /check \(source in \(([^)]*)\)\)/.exec(sql)![1].replace(/\s|'/g, '').split(',');
  for (const s of ['eia', 'census', 'auctions', 'fomc', 'macro', 'brief-summary']) assert.ok(check.includes(s), s);
  for (const s of check.filter((x) => x !== 'brief-summary')) assert.ok((SOURCE_NAMES as readonly string[]).includes(s), s);
});
