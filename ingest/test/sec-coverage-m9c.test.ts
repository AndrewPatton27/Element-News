// M9c SEC top-500 coverage (R-360): EDGAR daily index, rotating safety slice, extended watch list, Reg FD / other-events gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPANIES } from '../../contract/companies.ts';
import { COMPANIES_EXTRA } from '../../contract/companiesExtra.ts';
import { EXTRA_BEGIN, EXTRA_END, extraCompaniesSeedSql, readBlock } from '../../contract/companiesSql.ts';
import { COMPANY_SECTORS } from '../../contract/companies.ts';
import { config } from '../src/config.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import {
  classifySecEntry, dailyIndexUrls, isBoilerplateRegFd, isRegFdOnly, parseDailyIndex, parseSec8kAtom, resolveWatchList, rotationSlice,
  type Sec8kEntry,
} from '../src/sources/sec.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { templateSummarizer } from '../src/summarizer/template.ts';
import type { Summarizer } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8').replace(/\r\n/g, '\n');
const items = (...n: string[]) => n.map((number) => ({ number, title: `Item ${number}` }));
const idx = fx('sec-daily-index-form.idx');
const mutIdx = config.secIndex as unknown as { rotationPerRun: number };   // config is `as const`; tests change one knob and restore it

// ---- daily index -------------------------------------------------------------------------

test('parseDailyIndex: plain 8-K lines only, CIK padded, URL equals the one the submissions path builds', () => {
  const got = parseDailyIndex(idx);
  assert.equal(got.length, 6, 'the 8-K/A and the 10-K are not candidates');
  assert.deepEqual(got[0], {
    form: '8-K', company_raw: '908 Devices Inc.', cik: '0001555279', filed: '2026-11-10', accession: '0001104659-26-124772',
    url: 'https://www.sec.gov/Archives/edgar/data/1555279/000110465926124772/0001104659-26-124772-index.htm',
  });
  assert.equal(got.find((f) => f.company_raw === 'AMPCO PITTSBURGH CORP')?.cik, '0000006176', 'short CIK padded');
  assert.equal(got.find((f) => f.company_raw.startsWith('JPMORGAN'))?.company_raw, 'JPMORGAN CHASE BANK, NATIONAL ASSOCIATION', 'long names survive');
  assert.deepEqual(parseDailyIndex(''), []);
  assert.deepEqual(parseDailyIndex('8-K   garbage line'), []);
});

test('dailyIndexUrls: last days, quarter folder follows the month, host is www.sec.gov', () => {
  assert.deepEqual(dailyIndexUrls(new Date('2026-11-11T09:00:00Z'), 3), [
    'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261111.idx',
    'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261110.idx',
    'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261109.idx',
  ]);
  const edge = dailyIndexUrls(new Date('2027-01-01T05:00:00Z'), 2);
  assert.match(edge[0], /2027\/QTR1\/form\.20270101\.idx$/);
  assert.match(edge[1], /2026\/QTR4\/form\.20261231\.idx$/);
  for (const u of edge) assert.ok((config.pageHosts as readonly string[]).includes(new URL(u).hostname), 'rule 2: a page host');
});

// ---- rotation -------------------------------------------------------------------------

test('rotationSlice: consecutive hours walk through the whole list, every item once per cycle', () => {
  const all = Array.from({ length: 95 }, (_, i) => `c${i}`);
  const start = Date.UTC(2026, 10, 11, 0);
  const seen = new Map<string, number>();
  for (let h = 0; h < 4; h++) for (const c of rotationSlice(all, new Date(start + h * 3_600_000), 30)) seen.set(c, (seen.get(c) ?? 0) + 1);
  assert.equal(seen.size, 95, 'four hours cover 95 companies at 30 per run');
  assert.ok([...seen.values()].every((n) => n === 1));
  assert.deepEqual(rotationSlice(all, new Date(start), 30), rotationSlice(all, new Date(start + 59 * 60_000), 30), 'same hour, same slice');
  assert.deepEqual(rotationSlice([], new Date(start), 30), []);
  assert.deepEqual(rotationSlice(all, new Date(start), 0), []);
  assert.equal(rotationSlice(all, new Date(start), 1000).length, 95);
});

// ---- extended watch list ----------------------------------------------------------------

test('extended watch list: ~350 verified large caps, valid, unique, disjoint from the household directory', () => {
  assert.ok(COMPANIES_EXTRA.length >= 300 && COMPANIES_EXTRA.length <= 450, `size ${COMPANIES_EXTRA.length}`);
  const sectors = new Set(COMPANY_SECTORS.map((s) => s.slug));
  const dir = new Set(COMPANIES.map((c) => c.ticker));
  const tickers = new Set<string>(), ciks = new Set<string>();
  for (const c of COMPANIES_EXTRA) {
    assert.match(c.ticker, /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/);
    assert.match(c.cik, /^\d{10}$/);
    assert.ok(sectors.has(c.sector), `${c.ticker} sector`);
    assert.ok(c.name.length >= 2 && c.name.length <= 80 && c.short.length >= 1 && c.short.length <= 40, c.ticker);
    assert.doesNotMatch(c.name + c.short, /\/|\bINC\b$/, `${c.ticker} name looks cleaned`);
    assert.ok(!dir.has(c.ticker), `${c.ticker} already in the directory`);
    assert.ok(!tickers.has(c.ticker) && !ciks.has(c.cik), `${c.ticker} unique`);
    tickers.add(c.ticker); ciks.add(c.cik);
    for (const k of Object.keys(c)) assert.doesNotMatch(k, /price|quote/i, 'rule 9');
  }
  assert.deepEqual([...config.secExtraWatch].sort(), [...tickers].sort());
  // the household-name list is unchanged: the extras are a second list
  assert.equal(new Set(config.watchCompanies).size, 188);
});

test('extended watch list resolves against SEC rows: the CIK in the data file is the CIK the ingest resolves', () => {
  const snapshot = fx('sec-company-tickers-extra.json');
  const { map, missing } = resolveWatchList(snapshot, config.secExtraWatch);
  assert.deepEqual(missing, []);
  assert.equal(map.size, COMPANIES_EXTRA.length);
  for (const c of COMPANIES_EXTRA) assert.equal(map.get(c.cik)?.symbol, c.ticker, c.ticker);
  // and no CIK collides with a household-name company
  const hh = resolveWatchList(fx('sec-company-tickers-watch.json')).map;
  for (const cik of hh.keys()) assert.ok(!map.has(cik), `CIK ${cik} in both lists`);
});

test('extra directory migration is in sync with contract/companiesExtra.ts (run: node scripts/gen-companies-sql.mjs)', () => {
  const mig = read('supabase/migrations/20261136000000_companies_extra.sql');
  assert.equal(readBlock(mig, EXTRA_BEGIN, EXTRA_END), extraCompaniesSeedSql(), 'extra seed drifted');
  assert.match(mig, /on conflict \(ticker\) do update/);
});

test('a filing by an extended-list company becomes a card candidate tagged with its ticker', () => {
  const { map } = resolveWatchList(fx('sec-company-tickers-extra.json'), config.secExtraWatch);
  const ibm = COMPANIES_EXTRA.find((c) => c.ticker === 'ACN')!;
  const e: Sec8kEntry = {
    form: '8-K', company_raw: 'Accenture plc', cik: ibm.cik, url: 'https://www.sec.gov/Archives/edgar/data/1467373/000146737326000001/0001467373-26-000001-index.htm',
    filed: '2026-11-10', accession: '0001467373-26-000001', updated: '2026-11-10T21:00:00.000Z', items: items('2.02', '9.01'), summary_text: 'Filed: 2026-11-10',
  };
  const r = classifySecEntry(e, null, { watch: map });
  assert.ok('item' in r);
  assert.deepEqual((r as { item: { tickers: { symbol: string }[] } }).item.tickers.map((t) => t.symbol), ['ACN']);
});

// ---- Reg FD / other events -----------------------------------------------------------------

const sec = (items_: string[]) => items(...items_);

test('Reg FD gate: 7.01/8.01-only filings of watched companies pass classification; unwatched still do not; 9.01 only stays low value', () => {
  const { map } = resolveWatchList(fx('sec-company-tickers-watch.json'));
  const base = parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'))[0];
  const apple: Sec8kEntry = { ...base, cik: '0000320193' };
  for (const nums of [['7.01'], ['8.01', '9.01'], ['7.01', '8.01', '9.01']]) {
    const r = classifySecEntry({ ...apple, items: sec(nums) }, null, { watch: map });
    assert.ok('item' in r, nums.join(','));
  }
  assert.deepEqual(classifySecEntry({ ...apple, items: sec(['9.01']) }, null, { watch: map }), { skip: 'low_value' }, '9.01 alone is exhibits only');
  assert.deepEqual(classifySecEntry({ ...apple, items: sec(['5.07']) }, null, { watch: map }), { skip: 'not_watch_item' });
  assert.deepEqual(classifySecEntry({ ...apple, cik: '0000000001', items: sec(['7.01']) }, null, { watch: map }), { skip: 'not_watched' });
  // without a watch list (legacy path) 7.01/8.01 stays low value
  assert.deepEqual(classifySecEntry({ ...apple, items: sec(['8.01', '9.01']) }, null), { skip: 'low_value' });
  assert.equal(isRegFdOnly(items('7.01', '9.01')), true);
  assert.equal(isRegFdOnly(items('2.02', '7.01')), false);
  assert.equal(isRegFdOnly(items('5.02', '8.01')), false);
  assert.equal(config.minEverydayRelevance, 3, 'the relevance gate is unchanged');
});

const FD = (body: string, n = '7.01') => `Item ${n}: Regulation FD Disclosure\n\nItem ${n} ${n === '7.01' ? 'Regulation FD Disclosure' : 'Other Events'}.\n${body}\n\nItem 9.01 Financial Statements and Exhibits. (d) Exhibits. Exhibit 99.1 Press release. SIGNATURES Pursuant to the requirements of the Securities Exchange Act of 1934, the registrant has duly caused this report to be signed.`;

test('isBoilerplateRegFd: conference attendance, slide decks and exhibit pointers are skipped; real news and numbers pass', () => {
  const only = items('7.01', '9.01');
  const yes = (t: string) => assert.equal(isBoilerplateRegFd(only, t), true, t.slice(0, 90));
  const no = (t: string) => assert.equal(isBoilerplateRegFd(only, t), false, t.slice(0, 90));
  yes(FD('The Company will participate in the Goldman Sachs Technology Conference on December 3, 2026 and will present a fireside chat that will be webcast on its investor relations website.'));
  yes(FD('The Company is furnishing an updated investor presentation, which management will use in meetings with investors.'));
  yes(FD('On November 9, 2026, the Company issued a press release. A copy is attached as Exhibit 99.1. The information in this Item 7.01, including Exhibit 99.1, is being furnished and shall not be deemed filed for purposes of Section 18 of the Securities Exchange Act of 1934.'));
  yes(FD('Forward-looking statements. This report contains forward-looking statements within the meaning of the safe harbor provisions of the Private Securities Litigation Reform Act of 1995.'));
  no(FD('On November 9, 2026, the Company announced that its board approved a $5 billion share repurchase program and raised its quarterly dividend by 8 percent to $0.52 per share, payable on December 15, 2026 to holders of record on November 30, 2026.'));
  no(FD('The Company announced that it has reached an agreement with the Department of Justice to resolve its antitrust investigation, which will require the Company to divest two of its regional distribution businesses within twelve months of the agreement.', '8.01'));
  no(FD('The Company will participate in a conference. The Company also announced that it expects to lay off about 4,000 employees, roughly 6% of its workforce, as part of a restructuring that will cost $600 million.'));
  // anything with a substantive item is not judged here (the 5.02 filter and the AI decide)
  assert.equal(isBoilerplateRegFd(items('2.02', '7.01'), FD('will participate in a conference')), false);
  assert.equal(isBoilerplateRegFd(items('5.02'), 'Item 5.02 Departure'), false);
});

// ---- runSec: daily index + rotation + Reg FD cap, end to end with fake fetches ------------------------------

const NOW = new Date('2026-11-11T14:00:00Z');
const fxApple = fx('sec-submissions-CIK0000320193.json');
const applePage = (url: string) => /-index\.htm$/.test(url) ? '<table><tr><td>8-K</td><td><a href="/Archives/edgar/data/320193/doc.htm">doc.htm</a></td></tr></table>' : '<html><body>Item 7.01 Regulation FD Disclosure. The Company announced a $3 billion buyback and a 10 percent larger dividend for shareholders, effective immediately across all share classes. Item 9.01</body></html>';

function secDeps(opts: { index: string; handled?: Set<string>; submissions?: Record<string, string> }) {
  const requested: string[] = [];
  const lines: string[] = [];
  const dry = createDryRunPublisher();
  const publisher = { ...dry.publisher, async handledUrls(urls: string[]) { return new Set(urls.filter((u) => opts.handled?.has(u))); } };
  const ai: Summarizer = {
    name: 'gemini', usesAi: true,
    async summarize(i) {
      return { headline: `${i.item.company} announces a share repurchase`, body: 'The company said it will repurchase $3 billion of its shares and raise its dividend by 10 percent.', category: 'markets', event_type: null, tickers: [], everyday_relevance: 4 };
    },
  };
  const deps: Deps = {
    fetchText: async (url) => {
      requested.push(url);
      if (url === config.secTickersUrl) return fx('sec-company-tickers-watch.json');
      if (url === config.feeds.sec8k) throw new Error('feed down');
      if (url.includes('/daily-index/')) { if (url.endsWith('form.20261111.idx')) return opts.index; throw new Error('HTTP 404'); }
      if (url.startsWith('https://data.sec.gov/submissions/')) {
        const cik = /CIK(\d{10})\.json/.exec(url)![1];
        const body = opts.submissions?.[cik] ?? (cik === '0000320193' ? fxApple : null);
        if (!body) throw new Error('HTTP 404');
        return body;
      }
      return applePage(url);
    },
    publisher, providers: [ai, templateSummarizer], counter: memoryCounter(), fredApiKey: null, now: NOW, log: (s) => lines.push(s),
  };
  return { deps, requested, lines, dry };
}

test('runSec: only companies with a NEW filing in the daily index get a submissions request (rotation off)', async () => {
  const saved = mutIdx.rotationPerRun;
  mutIdx.rotationPerRun = 0;
  try {
    const hit = `${idx}\n8-K              Apple Inc.                                                    320193      20261111    edgar/data/320193/0009999999-26-000002.txt`;
    const t = secDeps({ index: hit });
    await runOnce(t.deps, { only: ['sec'] });
    const subs = t.requested.filter((u) => u.startsWith('https://data.sec.gov/'));
    assert.deepEqual(subs, ['https://data.sec.gov/submissions/CIK0000320193.json'], t.lines.join('\n'));
    assert.ok(t.lines.some((l) => /daily index 1 days read, 1 watched 8-Ks, 1 not handled yet, 1 companies to read/.test(l)), t.lines.join('\n'));
    // every daily-index request is a www.sec.gov page (rule 2)
    for (const u of t.requested.filter((x) => x.includes('/daily-index/'))) assert.equal(new URL(u).hostname, 'www.sec.gov');

    // the same filing already handled by the database: no submissions request at all
    const handled = new Set(['https://www.sec.gov/Archives/edgar/data/320193/000999999926000002/0009999999-26-000002-index.htm']);
    const t2 = secDeps({ index: hit, handled });
    await runOnce(t2.deps, { only: ['sec'] });
    assert.deepEqual(t2.requested.filter((u) => u.startsWith('https://data.sec.gov/')), [], t2.lines.join('\n'));
    assert.ok(t2.lines.some((l) => /1 watched 8-Ks, 0 not handled yet, 0 companies to read/.test(l)));
  } finally { mutIdx.rotationPerRun = saved; }
});

test('runSec: a missing daily index does not stop the run; the rotating slice still reads company lists', async () => {
  const saved = mutIdx.rotationPerRun;
  mutIdx.rotationPerRun = 25;
  try {
    const t = secDeps({ index: '' });
    await runOnce(t.deps, { only: ['sec'] });
    const subs = t.requested.filter((u) => u.startsWith('https://data.sec.gov/'));
    assert.equal(subs.length, 25, t.lines.join('\n'));
    assert.ok(subs.length <= mutIdx.rotationPerRun);
    // at most 25 company requests plus tickers, feed and 3 index days: far below the old 190
    assert.ok(t.requested.length < 40);
  } finally { mutIdx.rotationPerRun = saved; }
});

test('runSec: Reg FD filings are capped per run and the AI is asked once for the one that is let through', async () => {
  const saved = mutIdx.rotationPerRun;
  mutIdx.rotationPerRun = 0;
  try {
    const mk = (n: number) => ({ acc: `0009999999-26-0000${n}`, d: '2026-11-10' });
    const sub = JSON.stringify({
      cik: '320193', name: 'Apple Inc.',
      filings: { recent: {
        form: ['8-K', '8-K', '8-K'], filingDate: ['2026-11-10', '2026-11-10', '2026-11-10'],
        acceptanceDateTime: ['2026-11-10T20:00:00.000Z', '2026-11-10T19:00:00.000Z', '2026-11-10T18:00:00.000Z'],
        accessionNumber: [mk(11).acc, mk(12).acc, mk(13).acc], items: ['7.01,9.01', '8.01,9.01', '7.01'],
      } },
    });
    const hit = `${idx}\n8-K              Apple Inc.                                                    320193      20261111    edgar/data/320193/0009999999-26-000011.txt`;
    const t = secDeps({ index: hit, submissions: { '0000320193': sub } });
    const s = await runOnce(t.deps, { only: ['sec'] });
    assert.equal(s.published, 1, t.lines.join('\n'));
    assert.equal(s.ai, 1);
    assert.equal(t.lines.filter((l) => l.startsWith('skip regfd_cap')).length, 2, t.lines.join('\n'));
    assert.equal(config.secRegFd.maxPerRun, 1);
  } finally { mutIdx.rotationPerRun = saved; }
});
