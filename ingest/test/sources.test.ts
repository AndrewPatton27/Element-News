import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  displayCompanyName, findPrimaryDocUrl, parseSec8kAtom, parseTickerExchangeJson, primaryItem, secEntryToItem,
} from '../src/sources/sec.ts';
import { fedItemToItem, fedPageText, mergeFedItems, parseRss } from '../src/sources/fed.ts';
import { buildDataCard, buildObservation, parseFredObservations, parseTreasuryCsv, type Point } from '../src/sources/macro.ts';
import { decodeEntities, htmlToText } from '../src/html.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');

test('every fixture carries a REAL / RECONSTRUCTED / SYNTHETIC label', () => {
  for (const f of ['sec-8k-item-2.02.atom.xml', 'sec-8k-item-5.02.atom.xml', 'sec-8k-feed.atom.xml', 'fed-press-monetary.rss.xml',
    'fred-DGS10-observations.json', 'sec-company-tickers-exchange.json', 'sec-filing-index.html', 'sec-primary-8k.html', 'fed-press-release.html']) {
    assert.match(fx(f).slice(0, 400), /\b(REAL|RECONSTRUCTED|SYNTHETIC)\b/, f);
  }
});

// ---- SEC ----------------------------------------------------------------------------

test('SEC 8-K Atom: entry fields and item list (GoPro, Item 2.02)', () => {
  const [e] = parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'));
  assert.equal(e.form, '8-K');
  assert.equal(e.company_raw, 'GoPro, Inc.');
  assert.equal(e.cik, '0001500435');
  assert.equal(e.accession, '0001500435-26-000064');
  assert.equal(e.filed, '2026-10-16');
  assert.equal(e.url, 'https://www.sec.gov/Archives/edgar/data/1500435/000150043526000064/0001500435-26-000064-index.htm');
  assert.equal(e.updated, '2026-10-16T21:30:16.000Z');
  assert.deepEqual(e.items.map((i) => i.number), ['2.02', '4.02', '8.01']);
  assert.equal(e.items[0].title, 'Results of Operations and Financial Condition');
});

test('SEC: Costco 5.02 maps to exec_change; ticker and name come from the ticker list', () => {
  const tickers = parseTickerExchangeJson(fx('sec-company-tickers-exchange.json'));
  const [e] = parseSec8kAtom(fx('sec-8k-item-5.02.atom.xml'));
  const it = secEntryToItem(e, tickers)!;
  assert.equal(it.event_type, 'exec_change');
  assert.equal(it.company, 'Costco Wholesale Corp');
  assert.deepEqual(it.tickers, [{ symbol: 'COST', name: 'Costco Wholesale Corp', exchange: 'Nasdaq' }]);
  assert.equal(it.license_class, 'company_filing');
  assert.equal(it.items![0].number, '5.02');
});

test('SEC: GoPro 2.02 is an earnings card; most important item first', () => {
  const [e] = parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'));
  const it = secEntryToItem(e, null)!;
  assert.equal(it.category, 'earnings');
  assert.equal(it.event_type, 'earnings');
  assert.equal(primaryItem(e.items), '2.02');
});

test('SEC: amendments, untracked items and OTC-only companies are skipped', () => {
  const tickers = parseTickerExchangeJson(fx('sec-company-tickers-exchange.json'));
  assert.equal(tickers.has('0009999901'), false, 'OTC listing dropped');
  const [e] = parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'));
  assert.equal(secEntryToItem({ ...e, form: '8-K/A' }, null), null);
  assert.equal(secEntryToItem({ ...e, items: [{ number: '9.01', title: 'Financial Statements and Exhibits' }] }, null), null);
  assert.equal(secEntryToItem({ ...e, cik: '0009999901' }, tickers), null);
});

test('company names: all-caps cleaned, mixed case kept', () => {
  assert.equal(displayCompanyName('COSTCO WHOLESALE CORP /NEW'), 'Costco Wholesale Corp');
  assert.equal(displayCompanyName('GoPro, Inc.'), 'GoPro, Inc.');
  assert.equal(displayCompanyName('EXAMPLE HOLDINGS LLC /DE/'), 'Example Holdings LLC');
});

test('filing index: finds the 8-K document, unwraps inline-XBRL links', () => {
  const idx = 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm';
  assert.equal(findPrimaryDocUrl(fx('sec-filing-index.html'), idx), 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/primary-8k.htm');
  const ix = '<table><tr><td>1</td><td>8-K</td><td><a href="/ix?doc=/Archives/edgar/data/1/2/doc8k.htm">doc8k.htm</a></td><td>8-K</td></tr></table>';
  assert.equal(findPrimaryDocUrl(ix, idx), 'https://www.sec.gov/Archives/edgar/data/1/2/doc8k.htm');
  assert.equal(findPrimaryDocUrl('<p>nothing</p>', idx), null);
});

// ---- Fed ----------------------------------------------------------------------------

test('Fed RSS: title entities decoded, monetary item is a fed/policy card', () => {
  const [i] = parseRss(fx('fed-press-monetary.rss.xml'));
  assert.equal(i.title, "Minutes of the Board's discount rate meetings on August 17, September 9, and September 16, 2026");
  assert.equal(i.pubDate, '2026-10-13T18:00:00.000Z');
  const it = fedItemToItem(i);
  assert.equal(it.event_type, 'fed');
  assert.equal(it.category, 'policy');
  assert.equal(it.license_class, 'public_domain');
  assert.equal(it.summary_text, i.title, 'description repeats the title, so it is not doubled');
});

test('Fed: feeds merged by URL, old items dropped', () => {
  const [i] = parseRss(fx('fed-press-monetary.rss.xml'));
  assert.equal(mergeFedItems([[i], [i]], new Date('2026-10-17T00:00:00Z')).length, 1);
  assert.equal(mergeFedItems([[i]], new Date('2026-11-17T00:00:00Z')).length, 0);
});

test('Fed page text: article only, scripts removed', () => {
  const t = fedPageText(fx('fed-press-release.html'));
  assert.match(t, /released the minutes/);
  assert.doesNotMatch(t, /var x/);
});

test('html helpers', () => {
  assert.equal(decodeEntities('Board&#39;s &amp; &lt;b&gt; &#x2019;'), "Board's & <b> ’");
  assert.equal(htmlToText('<p>a</p><script>bad()</script><p>b&nbsp;c</p>'), 'a\nb c');
});

// ---- macro ----------------------------------------------------------------------------

test('FRED JSON: "." dropped, oldest first; DGS10 observation formatted', () => {
  const pts = parseFredObservations(fx('fred-DGS10-observations.json'));
  assert.deepEqual(pts.map((p) => p.date), ['2026-10-14', '2026-10-15', '2026-10-16']);
  const o = buildObservation('DGS10', pts)!;
  assert.deepEqual(o, { series_id: 'DGS10', obs_date: '2026-10-16', value: 5.09, display_value: '5.09%', change_text: '-0.01 pts', direction: 'down', period_label: null, move: 0.01 });
  assert.equal(buildDataCard(o), null, 'a 0.01-point move stays in the numbers panel');
});

test('Treasury CSV: 10 Yr column parsed (dates MM/DD/YYYY)', () => {
  const pts = parseTreasuryCsv(fx('treasury-par-yield-2026.csv'), '10 Yr');
  assert.deepEqual(pts, [{ date: '2026-10-14', value: 5.19 }, { date: '2026-10-15', value: 5.1 }, { date: '2026-10-16', value: 5.09 }]);
});

test('big daily move -> data card citing the agency, ai_generated false', () => {
  const o = buildObservation('DGS2', [{ date: '2026-10-15', value: 3.4 }, { date: '2026-10-16', value: 3.48 }])!;
  const card = buildDataCard(o)!;
  assert.equal(card.headline, '2-year Treasury yield rises to 3.48%');
  assert.equal(card.body, 'The 2-year Treasury yield, the interest rate the U.S. government pays to borrow for 2 years, was 3.48% on Oct 16, up 0.08 points from the prior day.');
  assert.equal(card.dedupe_key, 'DGS2:2026-10-16');
  assert.equal(card.ai_generated, false);
  assert.equal(card.macro[0].source_name, 'Board of Governors of the Federal Reserve System (US) via FRED');
  assert.equal(card.sources[0].url, 'https://www.federalreserve.gov/releases/h15/');
});

test('CPI: year-over-year from the index level; monthly card always published', () => {
  const idx: Point[] = [];
  for (let m = 0; m < 14; m++) {
    const y = 2025 + Math.floor((m + 7) / 12), mo = ((m + 7) % 12) + 1;   // Aug 2025 .. Sep 2026
    idx.push({ date: `${y}-${String(mo).padStart(2, '0')}-01`, value: 300 * (1 + 0.0024 * m) });
  }
  const o = buildObservation('CPIAUCSL', idx)!;
  assert.equal(o.obs_date, '2026-09-01');
  assert.equal(o.period_label, 'Sep 2026');
  assert.match(o.display_value, /^\d\.\d%$/);
  const card = buildDataCard(o)!;
  assert.match(card.headline, /^Consumer prices up \d\.\d% from a year earlier in September$/);
  assert.equal(card.category, 'economy');
});

test('oil: dollar value and percent change', () => {
  const o = buildObservation('DCOILWTICO', [{ date: '2026-10-12', value: 61.9 }, { date: '2026-10-13', value: 61.4 }])!;
  assert.equal(o.display_value, '$61.40');
  assert.equal(o.change_text, '-0.8%');
  assert.equal(buildDataCard(o), null, 'below the 2% threshold');
});
