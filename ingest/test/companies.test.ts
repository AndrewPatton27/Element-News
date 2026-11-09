// Company directory and tagging (contract/companies.ts, contract/companyMatch.ts). The same cases run in
// SQL (supabase/tests/companies_check.sql), and the generated SQL blocks must match these sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPANIES, COMPANY_SECTORS, tickerInText } from '../../contract/companies.ts';
import { companyQueryScore, matchCompanies, normalizeCompanyText, trigramSimilarity, trigrams } from '../../contract/companyMatch.ts';
import { CASES_BEGIN, CASES_END, SEED_BEGIN, SEED_END, companiesSeedSql, readBlock, secLookup, taggingCasesSql, type TaggingCase } from '../../contract/companiesSql.ts';
import { config } from '../src/config.ts';
import { classifySecEntry, parseSubmissionsJson, resolveWatchList } from '../src/sources/sec.ts';

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8').replace(/\r\n/g, '\n');
const secJson = read('ingest/src/fixtures/sec-company-tickers-watch.json');
const cases = (JSON.parse(read('contract/fixtures/company_tagging_cases.json')) as { cases: TaggingCase[] }).cases;

test('shared tagging cases: false positives stay untagged, real mentions are tagged (same cases as the SQL check)', () => {
  assert.ok(cases.length >= 30);
  for (const c of cases) {
    const got = matchCompanies({ headline: c.headline, body: c.body, tickers: (c.tickers ?? []).map((symbol) => ({ symbol })), filing: c.filing });
    assert.deepEqual(got.map((t) => t.ticker), c.expect, `case "${c.name}"`);
    if (c.methods?.length) assert.deepEqual(got.map((t) => t.method), c.methods, `methods of "${c.name}"`);
  }
});

test('named false positives: fruit, rainforest, actors, court doctrines, visas', () => {
  const none = (headline: string, body = '') => assert.deepEqual(matchCompanies({ headline, body }), [], headline);
  none('Apple pie contest draws record crowd', 'Bakers brought 300 pies; the winner gets a $1 million prize.');
  none('Harrison Ford says the company behind his new film paid him $10 million');
  none('Amazon River levels fall to a record low', 'Shipping companies say barges are stuck.');
  none('Chevron doctrine ruling changes how regulators work');
  none('Student visa applicants face new interview rules');
  none('Celsius readings top 40 degrees in Phoenix');
  // a capitalised name right before "Ford" mid-sentence is a person, even with business words around it
  none('Ontario premier Doug Ford says tariffs will cost the company jobs');
  none('Shares in a startup founded by engineer Sam Ford jumped');
});

test('confidence order and the cap: filing > card ticker > ticker in text > alias > context', () => {
  const t = matchCompanies({ headline: 'Apple and Microsoft talk to Nvidia (Nasdaq: NVDA) about $TSLA', tickers: [{ symbol: 'AAPL' }], filing: true });
  assert.deepEqual(t.map((x) => [x.ticker, x.method, x.confidence]), [['AAPL', 'filing', 1], ['NVDA', 'ticker_text', 0.9], ['TSLA', 'ticker_text', 0.9]]);
  assert.equal(matchCompanies({ headline: 'Apple Inc and Microsoft' }, undefined, { maxPerCard: 1 }).length, 1);
  assert.deepEqual(matchCompanies({ headline: 'Apple shares fall' }, undefined, { minConfidence: 0.7 }), []);
});

test('SEC 8-K cards are tagged by CIK: the watch list resolves the CIK to the directory ticker', () => {
  const sub = parseSubmissionsJson(read('ingest/src/fixtures/sec-submissions-CIK0000320193.json'), new Date('2026-10-17T12:00:00Z'), 3650);
  const w = resolveWatchList(secJson).map;
  const entry = sub.find((e) => e.form === '8-K' && e.items.some((i) => i.number === '2.02'));
  assert.ok(entry, 'fixture has an Item 2.02 8-K');
  const r = classifySecEntry(entry!, null, { watch: w });
  assert.ok('item' in r);
  const item = (r as { item: { tickers: { symbol: string }[] } }).item;
  assert.deepEqual(item.tickers.map((t) => t.symbol), ['AAPL']);
  const tags = matchCompanies({ headline: 'Quarterly results', body: '', tickers: item.tickers, filing: true });
  assert.deepEqual(tags, [{ ticker: 'AAPL', method: 'filing', confidence: 1 }]);
  // the directory's CIKs agree with the ones the ingest resolves at run time
  const lookup = secLookup(JSON.parse(secJson));
  for (const [cik, ref] of w) assert.equal(lookup.get(ref.symbol)?.cik, cik, ref.symbol);
});

test('the directory covers the SEC watch list exactly, once per ticker, with valid sectors and names', () => {
  const tickers = COMPANIES.map((c) => c.ticker);
  assert.equal(new Set(tickers).size, tickers.length, 'duplicate ticker');
  assert.deepEqual([...tickers].sort(), [...config.watchCompanies].sort());
  const sectors = new Set(COMPANY_SECTORS.map((s) => s.slug));
  for (const c of COMPANIES) {
    assert.ok(sectors.has(c.sector), `${c.ticker} sector`);
    assert.ok((c.aliases?.length ?? 0) + (c.context?.length ?? 0) > 0, `${c.ticker} has a name to match`);
    assert.match(c.ticker, /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/);
    assert.ok(c.name.length <= 80 && c.short.length <= 40);
    for (const k of Object.keys(c)) assert.doesNotMatch(k, /price|quote/i, 'no prices in the directory (rule 9)');
  }
  // tickers that are words never match bare
  assert.equal(tickerInText(COMPANIES.find((c) => c.ticker === 'COST')!), false);
  assert.equal(tickerInText(COMPANIES.find((c) => c.ticker === 'AAPL')!), true);
});

test('generated SQL blocks are in sync (run: node scripts/gen-companies-sql.mjs)', () => {
  const mig = read('supabase/migrations/20261115000000_companies.sql');
  assert.equal(readBlock(mig, SEED_BEGIN, SEED_END), companiesSeedSql(JSON.parse(secJson)), 'migration seed drifted');
  const check = read('supabase/tests/companies_check.sql');
  assert.equal(readBlock(check, CASES_BEGIN, CASES_END), taggingCasesSql(cases), 'SQL check cases drifted');
});

test('company search scores: ticker > exact name > prefix > typo; nothing for gibberish', () => {
  const best = (q: string) => COMPANIES.map((c) => ({ t: c.ticker, s: companyQueryScore(q, c) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.t < b.t ? -1 : 1))[0];
  assert.deepEqual(best('AAPL'), { t: 'AAPL', s: 1 });
  assert.deepEqual(best('$tsla'), { t: 'TSLA', s: 1 });
  assert.deepEqual(best('brk.b'), { t: 'BRK-B', s: 1 });
  assert.deepEqual(best('Facebook'), { t: 'META', s: 0.95 });
  assert.deepEqual(best('lowes'), { t: 'LOW', s: 0.95 });
  assert.deepEqual(best('home dep'), { t: 'HD', s: 0.8 });
  assert.equal(best('mircosoft')?.t, 'MSFT');
  assert.equal(best('nvidea')?.t, 'NVDA');
  assert.ok(best('mircosoft')!.s < 0.8, 'typo scores below prefix');
  assert.equal(best('qqqqzzzz'), undefined);
  assert.equal(best(''), undefined);
});

test('trigram helpers match core.trigrams / core.trigram_sim', () => {
  assert.deepEqual(trigrams('Ab'), ['  a', ' ab', 'ab ']);
  assert.equal(normalizeCompanyText("Lowe's  &  Co."), 'lowes co');
  assert.equal(trigramSimilarity('aple', 'apple'), 4 / 7);
  assert.equal(trigramSimilarity('', 'apple'), 0);
});
