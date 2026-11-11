// M9c3 sources: Fed Beige Book, Federal Register trade actions, regulator press releases (Crypto lane), annual figures (off),
// EIA diesel, four BLS CPI components. Offline: recorded fixtures (real responses saved 2026-11-11 by
// ingest/scripts/live-m9c3-check.ts) and fake fetchers only.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { runOnce, SOURCE_NAMES, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { annualCard, annualDue, ANNUAL_FIGURES } from '../src/sources/annual.ts';
import { beigeCard, beigeDue, beigeSummaryUrl, firstSentence, parseBeigeSummary } from '../src/sources/beige.ts';
import { blsSeriesUrl, parseBlsSeries } from '../src/sources/bls.ts';
import { dieselCard, eiaUrl, parseEia } from '../src/sources/eia.ts';
import { parseRss } from '../src/sources/fed.ts';
import { buildDataCard, buildObservation, SERIES, WHY } from '../src/sources/macro.ts';
import { cryptoRe, regPressCard, selectRegPress } from '../src/sources/regpress.ts';
import { agencyOf, parseTrade, selectTrade, tradeAction, tradeCard, tradeUrl } from '../src/sources/trade.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { validatePublish } from '../src/validate.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = new Date('2026-11-11T15:00:00Z');

function fakeDeps(fetchText: Deps['fetchText'], over: Partial<Deps> = {}) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = { fetchText, publisher: dry.publisher, providers: [], counter: memoryCounter(), fredApiKey: null, now: NOW, log: (l) => lines.push(l), ...over };
  return { dry, lines, deps };
}
const rules = (c: { headline: string; body: string | null; sources: unknown[]; ai_generated: boolean }) => {
  assert.ok(c.headline.length <= 90, `headline length ${c.headline.length}`);
  assert.equal(c.ai_generated, false);
  assert.ok(c.sources.length >= 1);
  assert.deepEqual(validatePublish(c as never).errors, []);
  assert.doesNotMatch(`${c.headline} ${c.body}`, /\b(buy|sell|should invest)\b/i);
};

test('new sources are registered; feeds and APIs pass the allowlist, pages only on the three hosts', () => {
  for (const s of ['beige', 'trade', 'regpress', 'annual']) assert.ok((SOURCE_NAMES as readonly string[]).includes(s), s);
  assert.doesNotThrow(() => assertAllowed(tradeUrl(NOW), 'api'));
  for (const f of config.agency.regpress.feeds) assert.doesNotThrow(() => assertAllowed(f.url, 'api'), f.id);
  assert.throws(() => assertAllowed(config.agency.regpress.feeds[0].url, 'page'), 'regulator feeds are never read as pages');
  assert.doesNotThrow(() => assertAllowed(beigeSummaryUrl('2026-11-25'), 'page'));
  assert.equal(beigeSummaryUrl('2026-11-25'), 'https://www.federalreserve.gov/monetarypolicy/beigebook202611-summary.htm');
});

// ---- Beige Book ---------------------------------------------------------------------------

test('Beige Book window: preview 3 days before, release card from the day for 4 days, nothing otherwise', () => {
  assert.equal(beigeDue(new Date('2026-11-21T10:00:00Z')), null);
  assert.deepEqual(beigeDue(new Date('2026-11-22T10:00:00Z')), { date: '2026-11-25', stage: 'preview' });
  assert.deepEqual(beigeDue(new Date('2026-11-25T14:00:00Z')), { date: '2026-11-25', stage: 'release' });
  assert.deepEqual(beigeDue(new Date('2026-11-28T14:00:00Z')), { date: '2026-11-25', stage: 'release' });
  assert.equal(beigeDue(new Date('2026-11-29T14:00:00Z')), null);
});

test('Beige Book summary: first sentence per section, only when 25 words or fewer; long sentences are dropped, never cut', () => {
  const s = parseBeigeSummary(fx('beige-summary-202610.html'));
  assert.match(s.activity!, /^Since the prior Beige Book, two of the twelve/);
  assert.match(s.labor!, /^Most Districts described little or no net change/);
  assert.equal(s.prices, null, 'the prices sentence is longer than 25 words');
  for (const q of [s.activity, s.labor]) assert.ok(q!.split(/\s+/).length <= config.agency.beige.maxQuoteWords);
  assert.equal(firstSentence('One two three. Four five.', 5), 'One two three.');
  assert.equal(firstSentence('One two three four five six.', 5), null);
  assert.deepEqual(parseBeigeSummary('<html>changed layout</html>'), { activity: null, labor: null, prices: null });
});

test('Beige Book cards: preview, release with quotes, release without quotes; same series so the release replaces the preview', () => {
  const pre = beigeCard({ date: '2026-11-25', stage: 'preview' }, null, NOW);
  const rel = beigeCard({ date: '2026-11-25', stage: 'release' }, parseBeigeSummary(fx('beige-summary-202610.html')), NOW);
  const bare = beigeCard({ date: '2026-11-25', stage: 'release' }, { activity: null, labor: null, prices: null }, NOW);
  for (const c of [pre, rel, bare]) { rules(c); assert.equal(c.sources[0].name, 'Federal Reserve Board'); assert.equal(c.sources[0].license_class, 'public_domain'); assert.equal(c.kind, 'data'); }
  assert.equal(pre.dedupe_key.split(':')[0], rel.dedupe_key.split(':')[0]);
  assert.ok(rel.dedupe_key.split(':')[1] > pre.dedupe_key.split(':')[1], 'the release sorts after the preview');
  assert.match(rel.body!, /On activity, it says: "Since the prior Beige Book/);
  assert.doesNotMatch(bare.body!, /"/);
  assert.match(pre.headline, /^Fed's Beige Book comes out November 25$/);
});

test('runOnce beige: nothing outside the window; a failed summary fetch publishes nothing and retries; preview then release', async () => {
  const none = fakeDeps(async () => { throw new Error('must not fetch'); });
  await runOnce(none.deps, { only: ['beige'] });
  assert.equal(none.dry.cards.length, 0);
  const pre = fakeDeps(async () => { throw new Error('must not fetch'); }, { now: new Date('2026-11-23T15:00:00Z') });
  await runOnce(pre.deps, { only: ['beige'] });
  assert.equal(pre.dry.cards.length, 1);
  const down = fakeDeps(async () => { throw new Error('HTTP 503'); }, { now: new Date('2026-11-25T19:00:00Z') });
  await runOnce(down.deps, { only: ['beige'] });
  assert.equal(down.dry.cards.length, 0);
  assert.ok(down.lines.some((l) => /retrying next run/.test(l)));
  const rel = fakeDeps(async (u, k) => { assertAllowed(u, k); return fx('beige-summary-202610.html'); }, { now: new Date('2026-11-25T19:00:00Z') });
  const st = await runOnce(rel.deps, { only: ['beige'] });
  assert.equal(st.ai, 0);
  assert.equal(rel.dry.cards.length, 1);
  await runOnce(rel.deps, { only: ['beige'] });
  assert.equal(rel.dry.cards.length, 1, 'idempotent');
});

// ---- Federal Register trade documents -----------------------------------------------------

test('trade: only USTR tariff actions and BIS export-control rules become cards; antidumping, OFAC, info collections never', () => {
  const docs = parseTrade(fx('fr-trade.json'));
  assert.ok(docs.length > 20);
  const picked = selectTrade(docs, NOW);
  assert.ok(picked.length >= 3 && picked.length <= 12, `${picked.length}`);
  for (const p of picked) {
    const a = agencyOf(p.doc)!;
    assert.ok(a, 'known agency');
    assert.doesNotMatch(p.doc.title, /antidumping|countervailing|OFAC|information collection/i, p.doc.title);
    const c = tradeCard(p.doc, p.verb, NOW)!;
    rules(c);
    assert.match(c.dedupe_key, /^FRTRADE:\d{4}-\d+$/);
    assert.equal(c.kind, 'summary');
    assert.equal(c.sources[0].url.startsWith('https://www.federalregister.gov/'), true);
    assert.match(c.body!, /Its title reads: "/);
    assert.ok(c.body!.split('"')[1].replace(/ \.\.\.$/, '').split(' ').length <= config.agency.trade.maxTitleWords);
  }
  assert.ok(picked.some((p) => /exclusion/i.test(p.doc.title)), 'the USTR exclusion extension is carded');
  assert.equal(picked.length, new Set(picked.map((p) => p.doc.document_number)).size);
  const mk = (title: string, slug: string, type = 'Notice') => ({ document_number: '1', title, abstract: null, html_url: 'https://www.federalregister.gov/x', publication_date: '2026-11-10', type, agencies: [{ slug, name: slug }] });
  assert.equal(tradeAction(mk('Notice of OFAC Sanctions Action', 'foreign-assets-control-office') as never), null);
  assert.equal(tradeAction(mk('Order Renewing Order Temporarily Denying Export Privileges', 'industry-and-security-bureau') as never), null);
  assert.equal(tradeAction(mk('Additions to the Entity List', 'industry-and-security-bureau', 'Rule') as never)!.tag, 'entity');
  assert.equal(tradeAction(mk('Tin Mill Products From Taiwan: Preliminary Affirmative Determination', 'international-trade-administration') as never), null);
  assert.equal(tradeAction(mk('Performance Review Board Membership', 'trade-representative-office-of-united-states') as never), null);
  assert.equal(tradeCard(mk('Notice of Product Exclusion Extensions: China', 'trade-representative-office-of-united-states', 'Notice') as never, 'x', NOW)!.sources[0].url, 'https://www.federalregister.gov/x');
  assert.equal(tradeCard({ ...mk('t', 'trade-representative-office-of-united-states'), html_url: 'https://evil.example/x' } as never, 'x', NOW), null, 'non-Federal-Register link is refused');
});

test('runOnce trade: per-run cap, one request, rerun is all duplicates, an API outage is logged', async () => {
  let calls = 0;
  const { dry, deps, lines } = fakeDeps(async (u, k) => { assertAllowed(u, k); calls++; return fx('fr-trade.json'); });
  const st = await runOnce(deps, { only: ['trade'] });
  assert.equal(calls, 1);
  assert.equal(dry.cards.length, config.agency.trade.maxCardsPerRun);
  assert.equal(st.ai, 0);
  assert.ok(lines.some((l) => /material trade documents/.test(l)));
  const again = await runOnce(deps, { only: ['trade'] });
  assert.ok(dry.cards.length > config.agency.trade.maxCardsPerRun - 1 && dry.cards.length <= config.agency.trade.maxCardsPerRun * 2, 'the next run adds the next ones, never the same');
  assert.equal(new Set(dry.cards.map((c) => c.dedupe_key)).size, dry.cards.length);
  void again;
  const bad = fakeDeps(async () => { throw new Error('HTTP 503'); });
  await runOnce(bad.deps, { only: ['trade'] });
  assert.ok(bad.lines.some((l) => /trade: failed/.test(l)));
});

// ---- Regulator press releases (Crypto lane) -----------------------------------------------

test('regpress: only crypto-matching titles under 90 characters, verbatim headline, no description text, agency named', () => {
  assert.ok(cryptoRe().test('OCC Advances U.S. Digital Asset Leadership with Final Rule to Implement GENIUS Act'));
  assert.ok(!cryptoRe().test('CFTC Chairman Selig Releases Statement on Equity Perpetual Futures'));
  assert.ok(!cryptoRe().test('OCC Announces Enforcement Actions for October 2026'));
  const occ = config.agency.regpress.feeds.find((f) => f.id === 'occ')!;
  const items = parseRss(fx('regpress-occ.xml'));
  const sel = selectRegPress(items, new Date('2026-10-22T12:00:00Z'));
  assert.equal(sel.length, 1);
  const c = regPressCard(sel[0], occ)!;
  rules(c);
  assert.equal(c.headline, 'OCC Advances U.S. Digital Asset Leadership with Final Rule to Implement GENIUS Act');
  assert.equal(c.sources[0].name, 'Office of the Comptroller of the Currency');
  assert.match(c.dedupe_key, /^REGPRESS-occ-[0-9a-f]{10}$/);
  assert.equal(c.kind, 'summary');
  assert.equal(selectRegPress(items, NOW).length, 0, 'outside the 5-day window');
  assert.equal(regPressCard({ ...sel[0], title: 'Crypto '.repeat(30) }, occ), null, 'too long for a headline: skipped, not cut');
  assert.equal(regPressCard({ ...sel[0], link: 'http://insecure.example/x' }, occ), null);
  const cftc = parseRss(fx('regpress-cftc.xml'));
  assert.equal(selectRegPress(cftc, new Date('2026-11-04T12:00:00Z')).length, 0, 'equity perpetual futures is not the crypto lane');
  assert.equal(selectRegPress(parseRss(fx('regpress-cfpb.xml')), new Date('2026-10-14T12:00:00Z')).length, 0);
});

test('runOnce regpress: one request per feed, one failing feed does not stop the others', async () => {
  const urls: string[] = [];
  const { dry, deps, lines } = fakeDeps(async (u, k) => {
    assertAllowed(u, k); urls.push(u);
    if (u.includes('cftc')) throw new Error('HTTP 503');
    return u.includes('occ.gov') ? fx('regpress-occ.xml') : fx('regpress-cfpb.xml');
  }, { now: new Date('2026-10-22T12:00:00Z'), keys: { occEnabled: true } });
  const st = await runOnce(deps, { only: ['regpress'] });
  assert.equal(urls.length, 3);
  assert.equal(dry.cards.length, 1);
  assert.equal(st.ai, 0);
  assert.ok(lines.some((l) => /regpress: cftc failed/.test(l)));
  await runOnce(deps, { only: ['regpress'] });
  assert.equal(dry.cards.length, 1, 'idempotent');
  const noOcc = fakeDeps(async (u) => { if (u.includes('occ.gov')) throw new Error('OCC must not be fetched'); return fx('regpress-cfpb.xml'); }, { now: new Date('2026-10-22T12:00:00Z') });
  await runOnce(noOcc.deps, { only: ['regpress'] });
  assert.equal(noOcc.dry.cards.length, 0);
  assert.ok(noOcc.lines.some((l) => /occ: disabled \(REGPRESS_OCC_ENABLED not set\)/.test(l)));
});

// ---- Annual figures (off by default) ------------------------------------------------------

test('annual figures: off unless ANNUAL_FIGURES_ENABLED, then one card per verified entry inside the window', async () => {
  const off = fakeDeps(async () => { throw new Error('no network'); });
  await runOnce(off.deps, { only: ['annual'] });
  assert.equal(off.dry.cards.length, 0);
  assert.ok(off.lines.some((l) => /disabled \(ANNUAL_FIGURES_ENABLED not set\)/.test(l)));
  const on = fakeDeps(async () => { throw new Error('no network'); }, { keys: { annualEnabled: true } });
  const st = await runOnce(on.deps, { only: ['annual'] });
  assert.equal(st.ai, 0);
  assert.equal(on.dry.cards.length, 1);
  const c = on.dry.cards[0];
  rules(c);
  assert.equal(c.dedupe_key, 'ANNUAL_SSA_COLA:2026-10-14');
  assert.match(c.headline, /3\.6%/);
  assert.equal(c.sources[0].url.startsWith('https://www.ssa.gov/'), true);
  assert.equal(annualDue(new Date('2027-01-20T12:00:00Z')).length, 0, 'a stale announcement is not carded');
  assert.equal(annualDue(new Date('2026-10-01T12:00:00Z')).length, 0, 'never before the announcement');
  for (const f of ANNUAL_FIGURES) { assert.ok(f.headline.length <= 90); assert.ok(annualCard(f).sources[0].url.startsWith('https://')); }
});

// ---- EIA diesel ---------------------------------------------------------------------------

test('EIA diesel: weekly card from the recorded reply, key per week, gasoline stays off', () => {
  assert.equal(config.agency.eia.gasoline.enabled, false);
  assert.doesNotThrow(() => assertAllowed(eiaUrl(config.agency.eia.diesel.route, [config.agency.eia.diesel.series], 'K', 4), 'api'));
  const c = dieselCard(parseEia(fx('eia-diesel.json')))!;
  rules(c);
  assert.equal(c.dedupe_key, 'EIA_DIESEL:2026-11-09');
  assert.equal(c.headline, 'U.S. diesel price falls to $6.13 a gallon in the week of Nov 9');
  assert.match(c.body!, /down 17 cents/);
  assert.equal(c.sources[0].name, 'U.S. Energy Information Administration');
  assert.equal(dieselCard([]), null);
});

// ---- BLS CPI components -------------------------------------------------------------------

test('BLS CPI components: four series, defined once, agency named, WHY line; the card builds from a recorded reply', () => {
  const ids = Object.values(config.bls.series).filter((i) => i.startsWith('BLS_CPI'));
  assert.deepEqual(ids.sort(), ['BLS_CPI_ELECTRICITY', 'BLS_CPI_FOOD_HOME', 'BLS_CPI_MEDICAL', 'BLS_CPI_RENT']);
  for (const id of ids) {
    const s = SERIES[id];
    assert.equal(s.provider, 'bls');
    assert.equal(s.source_name, 'U.S. Bureau of Labor Statistics');
    assert.doesNotMatch(s.source_name, /FRED/);
    assert.ok(WHY[id] && !WHY[id].includes(s.about), `${id} WHY`);
  }
  assert.equal(new Set(Object.values(SERIES).map((s) => s.sort_order)).size, Object.keys(SERIES).length, 'sort orders stay unique');
  assert.doesNotThrow(() => assertAllowed(blsSeriesUrl('CUUR0000SAF11'), 'api'));
  // The real October 2026 reading has no year-earlier value (October 2025 was not published), so the newest card is September.
  const pts = parseBlsSeries(fx('bls-CUUR0000SAF11.json'));
  assert.equal(buildObservation('BLS_CPI_FOOD_HOME', pts), null, 'no October card until a comparable month exists');
  const card = buildDataCard(buildObservation('BLS_CPI_FOOD_HOME', pts.filter((p) => p.date < '2026-10-01'))!)!;
  rules(card);
  assert.match(card.dedupe_key, /^BLS_CPI_FOOD_HOME:2026-09-01$/);
  assert.equal(card.sources[0].name, 'U.S. Bureau of Labor Statistics');
  for (const sid of Object.keys(config.bls.series).filter((k) => k.startsWith('CUUR'))) assert.equal(parseBlsSeries(fx(`bls-${sid}.json`)).length > 12, true, sid);
});

// ---- migrations ----------------------------------------------------------------------------

test('migrations 20261138: series rows match the code, run_log extends the live constraint, four cron jobs use the source names', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261138000000_m9c3_sources.sql', import.meta.url), 'utf8');
  for (const id of Object.values(config.bls.series).filter((i) => i.startsWith('BLS_CPI'))) {
    const row = new RegExp(String.raw`\('${id}',\s*'([^']+)',\s*'bls',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'percent',\s*'monthly',\s*(\d+)`).exec(sql);
    assert.ok(row, `migration row for ${id}`);
    const s = SERIES[id];
    assert.deepEqual([row[1], row[2], row[3], row[4], Number(row[5])], [s.label, s.source_name, s.source_short, s.agency.url, s.sort_order], id);
  }
  assert.ok(/names \|\| array\['beige', 'trade', 'regpress', 'annual'\]/.test(sql), 'reads the live list and adds ours');
  assert.ok(/pg_get_constraintdef/.test(sql) && !/check \(source in \('/.test(sql), 'never a hard-coded run_log list');
  const cron = readFileSync(new URL('../../supabase/migrations/20261138000100_m9c3_sources_cron.sql', import.meta.url), 'utf8');
  for (const name of ['beige', 'trade', 'regpress', 'annual']) {
    assert.ok(cron.includes(`'element-ingest-${name}'`), name);
    assert.ok(cron.includes(`"source":"${name}"`), name);
    assert.ok((SOURCE_NAMES as readonly string[]).includes(name));
  }
  assert.ok(cron.includes('cron.unschedule'), 'idempotent');
  const logic = readFileSync(new URL('../../workers/watchdog/src/logic.ts', import.meta.url), 'utf8');
  assert.match(logic, /EXPECTED_JOBS = 38;/, '26 + 4 (M9c3) + 8 cadence jobs: 5 fast sources, 2 NewsData, 1 release queue');
});
