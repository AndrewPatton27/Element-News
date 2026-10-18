// Topic filter (2026-10-17): SEC cards only for household-name companies and big 8-K items,
// routine director-only 5.02s skipped, an AI everyday_relevance score gates every AI card,
// template cards only where the source is reliably relevant, plain-language prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { fixtureFetcher } from '../src/main.ts';
import { runOnce, templateAllowed, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher, type Publisher } from '../src/publish.ts';
import {
  classifySecEntry, isRoutine502, parseSec8kAtom, parseSubmissionsJson, resolveWatchList,
} from '../src/sources/sec.ts';
import { memoryCounter, summarizeWithChain } from '../src/summarizer/chain.ts';
import { buildPrompt, RESPONSE_SCHEMA } from '../src/summarizer/gemini.ts';
import { GROQ_JSON_SCHEMA } from '../src/summarizer/groq.ts';
import { templateDraft, templateSummarizer } from '../src/summarizer/template.ts';
import type { RawItem, Summarizer, SummaryDraft } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const TICKERS = fx('sec-company-tickers-watch.json');            // RECONSTRUCTED from the real SEC list
const APPLE = fx('sec-submissions-CIK0000320193.json');          // RECONSTRUCTED from the real submissions JSON
const items = (...n: string[]) => n.map((number) => ({ number, title: `Item ${number}` }));
const AUG5 = new Date('2026-08-05T12:00:00Z');

// ---- watch list -------------------------------------------------------------------

test('watch list: broader large-company coverage, student brands in, foreign filer / private companies out', () => {
  const w = config.watchCompanies as readonly string[];
  assert.ok(w.length >= 170 && w.length <= 210, `size ${w.length}`);
  assert.equal(new Set(w).size, 188, 'unique expanded list');
  for (const t of ['AAPL', 'NFLX', 'CMG', 'SBUX', 'UBER', 'DASH', 'SOFI', 'HOOD', 'SLM', 'NNI', 'LULU', 'CROX', 'RBLX', 'VZ', 'DAL', 'COST']) {
    assert.ok(w.includes(t), t);
  }
  for (const t of ['SPOT', 'EA', 'WBA', 'GPRO', 'LFST', 'LASE', 'BLIN']) assert.ok(!w.includes(t), t);
});

test('watch list resolves from the SEC fixture; new additions are absent only because the fixture predates expansion', () => {
  const { map, missing } = resolveWatchList(TICKERS);
  const added = ['NOW','CSCO','TXN','AMAT','MU','LRCX','KLAC','ADI','PANW','CRWD','PLTR','USB','PNC','TFC','BK','STT','BLK','ICE','CME','SPGI','MCO','M','JWN','FIVE','ORLY','AZO','TSCO','LMT','RTX','GD','NOC','HON','CAT','DE','GE','MMM'];
  assert.deepEqual(missing, added);
  assert.equal(map.size, new Set(config.watchCompanies).size - added.length);
  assert.deepEqual(map.get('0000320193'), { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'Nasdaq' });
  assert.equal(map.get('0002041610')?.symbol, 'PSKY', 'first row for this CIK is SKYD; the watch ticker wins');
  assert.equal(map.get('0001617640')?.symbol, 'Z');
  assert.equal(map.has('0001500435'), false, 'GoPro is not watched');
});

test('a ticker missing from the SEC list is returned as missing (logged), never a crash', () => {
  const { map, missing } = resolveWatchList(TICKERS, ['AAPL', 'EA', 'NOPE']);
  assert.deepEqual(missing, ['EA', 'NOPE']);
  assert.equal(map.size, 1);
});

test('classifySecEntry with the watch list: off-list -> not_watched; small items -> not_watch_item', () => {
  const { map } = resolveWatchList(TICKERS);
  const [gopro, costco] = parseSec8kAtom(fx('sec-8k-feed.atom.xml'));
  assert.deepEqual(classifySecEntry(gopro, null, { watch: map }), { skip: 'not_watched' }, 'GoPro earnings: small company');
  const r = classifySecEntry(costco, null, { watch: map });
  assert.ok('item' in r);
  assert.deepEqual(r.item.tickers, [{ symbol: 'COST', name: 'Costco Wholesale Corp', exchange: 'Nasdaq' }]);
  for (const n of ['3.01', '4.01', '1.02']) {
    assert.deepEqual(classifySecEntry({ ...costco, items: items(n) }, null, { watch: map }), { skip: 'not_watch_item' }, n);
  }
  for (const n of ['1.01', '1.03', '1.05', '2.01', '2.02', '2.03', '2.04', '2.05', '2.06', '4.02', '5.02']) {
    assert.ok('item' in classifySecEntry({ ...costco, items: items(n) }, null, { watch: map }), n);
  }
});

test('submissions JSON (REAL Apple data): 8-Ks inside the lookback, Atom-style index URL and items', () => {
  const e = parseSubmissionsJson(APPLE, AUG5, 10);
  assert.equal(e.length, 1);
  assert.equal(e[0].form, '8-K');
  assert.equal(e[0].cik, '0000320193');
  assert.equal(e[0].accession, '0000320193-26-000018');
  assert.equal(e[0].url, 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/0000320193-26-000018-index.htm');
  assert.deepEqual(e[0].items.map((i) => i.number), ['2.02', '9.01']);
  assert.match(e[0].summary_text, /Item 2\.02: Results of Operations and Financial Condition/);
  assert.equal(parseSubmissionsJson(APPLE, new Date('2026-10-17T21:00:00Z'), 10).length, 0, 'nothing in the last 10 days');
  assert.equal(parseSubmissionsJson(APPLE, new Date('2026-09-05T00:00:00Z'), 10)[0].form, '8-K/A');
  assert.throws(() => parseSubmissionsJson('{"cik":"1"}', AUG5), /no filings\.recent/);
});

test('data.sec.gov is an API host only (never a page host)', () => {
  const u = config.secSubmissionsUrl.replace('{cik}', '0000320193');
  assert.doesNotThrow(() => assertAllowed(u, 'api'));
  assert.throws(() => assertAllowed(u, 'page'), /page host not allowed/);
});

// ---- routine 5.02 -----------------------------------------------------------------

test('director-only and pay-plan 5.02s are routine; CEO/CFO/chair/president changes are not', () => {
  const [, costco] = parseSec8kAtom(fx('sec-8k-feed.atom.xml'));
  assert.equal(isRoutine502(costco.items, costco.summary_text), true, 'Costco bonus criteria (feed text only)');
  const t = (s: string) => isRoutine502(items('5.02', '9.01'), `Item 5.02 Departure of Directors. ${s}`);
  assert.equal(t('On October 1, Jane Roe was appointed to the Board of Directors.'), true, 'director only');
  assert.equal(t('John Doe was appointed Senior Vice President, Sales.'), true, 'vice president is not a top role');
  assert.equal(t('The Committee approved bonus criteria for the named executive officers, including the Chief Executive Officer.'), true, 'pay plan');
  assert.equal(t('Jane Roe was appointed chair of the Audit Committee.'), true, 'committee chair');
  assert.equal(t('John Doe will retire as Chief Executive Officer on March 1.'), false, 'CEO retires');
  assert.equal(t('The Board appointed Mary Major as Chief Financial Officer.'), false, 'new CFO');
  assert.equal(t('Sam Lee resigned as President and a director.'), false, 'president resigns');
  assert.equal(t('Jane Roe will succeed John Doe as Chairman of the Board.'), false, 'new chair');
  assert.equal(isRoutine502(items('5.02', '2.02'), 'Item 5.02 Jane Roe joined the board.'), false, 'another card item: never routine');
});

test('pipeline: a director-only 5.02 is skipped after the page fetch and before any AI call', async () => {
  let calls = 0;
  const ai: Summarizer = { name: 'gemini', usesAi: true, async summarize() { calls++; throw new Error('must not be called'); } };
  const base = fixtureFetcher();
  const lines: string[] = [];
  const statuses: string[] = [];
  const dry = createDryRunPublisher();
  const publisher: Publisher = { ...dry.publisher, async setItemStatus(_id, status, note) { statuses.push(`${status}:${note}`); } };
  const deps: Deps = {
    fetchText: base, publisher, providers: [ai, templateSummarizer], counter: memoryCounter(), fredApiKey: null,
    now: new Date('2026-10-17T21:00:00Z'), log: (s) => lines.push(s),
  };
  const s = await runOnce(deps, { only: ['sec'] });
  assert.equal(calls, 0);
  assert.equal(s.published, 0);
  assert.ok(lines.includes('skip routine_5.02: Costco Wholesale Corp 8-K'));
  assert.deepEqual(statuses, ['skipped:routine_5.02']);
});

// ---- everyday relevance -------------------------------------------------------------

function appleRun(draft: Partial<SummaryDraft>) {
  const calls: number[] = [];
  const ai: Summarizer = {
    name: 'gemini', usesAi: true, model: 'm',
    async summarize(i) {
      calls.push(1);
      return { headline: 'Apple shares its latest results', body: 'Apple reported revenue of $102.5 billion for the quarter.', category: 'earnings', event_type: 'earnings', tickers: ['AAPL'], ...draft } as SummaryDraft;
    },
  };
  const lines: string[] = [];
  const statuses: string[] = [];
  const dry = createDryRunPublisher();
  const publisher: Publisher = { ...dry.publisher, async setItemStatus(_id, status, note) { statuses.push(`${status}:${note}`); } };
  const deps: Deps = {
    fetchText: fixtureFetcher(), publisher, providers: [ai, templateSummarizer], counter: memoryCounter(), fredApiKey: null,
    now: AUG5, log: (s) => lines.push(s),
  };
  return { deps, dry, lines, statuses, calls };
}

test('relevance below 3: one AI call, nothing published, logged as low_relevance, score kept in the item status note', async () => {
  const r = appleRun({ everyday_relevance: 2 });
  const s = await runOnce(r.deps, { only: ['sec'] });
  assert.equal(r.calls.length, 1, 'no retry, no second provider');
  assert.equal(s.published, 0);
  assert.equal(r.dry.cards.length, 0);
  assert.ok(r.lines.includes('skip low_relevance (2): Apple Inc. 8-K'), r.lines.join('\n'));
  assert.ok(r.statuses.includes('skipped:low_relevance (2)'));
});

test('relevance 3 or more is published (threshold from config)', async () => {
  assert.equal(config.minEverydayRelevance, 3);
  const r = appleRun({ everyday_relevance: 3 });
  const s = await runOnce(r.deps, { only: ['sec'] });
  assert.equal(s.published, 1);
  assert.equal(s.ai, 1);
  assert.equal(r.dry.cards[0].headline, 'Apple shares its latest results');
});

test('an AI draft without a valid score is rejected (retry, then the template: a figure-less Apple 2.02 template card is skipped, not published)', async () => {
  for (const bad of [undefined, 7, 2.5, '4']) {
    const r = appleRun({ everyday_relevance: bad as number | undefined });
    const s = await runOnce(r.deps, { only: ['sec'] });
    assert.equal(r.calls.length, 2, `retried once (${String(bad)})`);
    assert.equal(s.template, 0, 'the 2.02 template card has no figures, so it is never published');
    assert.equal(s.published, 0);
    assert.equal(r.dry.cards.length, 0);
    assert.ok(r.lines.includes('skip no_figures (earnings card without figures, template): Apple Inc. 8-K'), r.lines.join('\n'));
  }
});

test('chain: low score returns at once with low_relevance; no minRelevance = old behavior', async () => {
  const it = { source: 'fed_rss', license_class: 'public_domain', tickers: [], items: [] } as unknown as RawItem;
  let n = 0;
  const p: Summarizer = { name: 'gemini', usesAi: true, async summarize() { n++; return { headline: 'Fed ends a small enforcement action', body: null, category: 'policy', event_type: null, tickers: [], everyday_relevance: 1 }; } };
  const r = await summarizeWithChain({ item: it, text: 'Fed ends a small enforcement action' }, [p], memoryCounter(), { minRelevance: 3, requireRelevance: true });
  assert.equal(r.low_relevance, true);
  assert.equal(r.relevance, 1);
  assert.equal(n, 1);
  const r2 = await summarizeWithChain({ item: it, text: 'Fed ends a small enforcement action' }, [p], memoryCounter());
  assert.equal(r2.low_relevance, undefined);
  assert.equal(r2.provider, 'gemini');
});

// ---- template cards -------------------------------------------------------------------

test('template cards: Fed, BEA and watch-list 2.02/5.02/1.05/4.02/2.05 only; never Federal Register', () => {
  const sec = (...n: string[]) => ({ source: 'sec_8k', items: items(...n) }) as unknown as RawItem;
  assert.equal(templateAllowed({ source: 'fed_rss' } as RawItem), true);
  assert.equal(templateAllowed({ source: 'bea_rss' } as RawItem), true);
  assert.equal(templateAllowed({ source: 'fedreg' } as RawItem), false);
  for (const n of ['2.02', '5.02', '1.05', '4.02', '2.05']) assert.equal(templateAllowed(sec(n, '9.01')), true, n);
  for (const n of ['1.01', '2.01', '1.03']) assert.equal(templateAllowed(sec(n, '9.01')), false, n);
});

test('pipeline: template-only run publishes no Federal Register card (5 skipped, item status left "new" for a later AI run)', async () => {
  const lines: string[] = [];
  const statuses: string[] = [];
  const dry = createDryRunPublisher();
  const publisher: Publisher = { ...dry.publisher, async setItemStatus(_id, status, note) { statuses.push(`${status}:${note}`); } };
  const deps: Deps = {
    fetchText: fixtureFetcher(), publisher, providers: [templateSummarizer], counter: memoryCounter(), fredApiKey: null,
    now: new Date('2026-10-17T21:00:00Z'), log: (s) => lines.push(s),
  };
  const s = await runOnce(deps, { only: ['fedreg'] });
  assert.equal(s.published, 0);
  assert.equal(s.skipped, 5);
  assert.equal(lines.filter((l) => l.startsWith('skip template_not_allowed')).length, 5);
  assert.deepEqual(statuses, []);
});

test('template wording is plain (no item numbers or "8-K" in the headline)', () => {
  const it = { source: 'sec_8k', company: 'Apple Inc.', items: items('4.02'), tickers: [], category: 'earnings', event_type: 'earnings' } as unknown as RawItem;
  const d = templateDraft({ item: it, text: '' });
  assert.equal(d.headline, 'Apple Inc. says some past financial reports were wrong');
  assert.doesNotMatch(d.headline, /8-K|Item \d/);
  assert.match(d.body!, /can no longer be trusted/);
});

// ---- plain-language prompt --------------------------------------------------------------

test('prompt: college-student audience, 8th-grade plain language, explain jargon, what happened first, relevance rubric', () => {
  const it = { source: 'sec_8k', source_name: 'SEC', doc_label: 'Form 8-K', published_at: '2026-10-17T00:00:00Z', tickers: [], category: 'earnings', event_type: 'earnings' } as unknown as RawItem;
  const p = buildPrompt({ item: it, text: 'T' });
  assert.match(p, /college students and young adults/);
  assert.match(p, /8th-grade reading level/);
  assert.match(p, /short sentences\. No jargon/);
  assert.match(p, /explain it in a few plain words/);
  assert.match(p, /The headline says what happened\. Body sentence 1 does NOT say it again/);   // sum-v6: sentence 1 continues the headline
  assert.match(p, /ONLY if that follows directly from the facts/);
  assert.match(p, /aim for about 60/);
  assert.match(p, /"everyday_relevance": a whole number from 1 to 5/);
  assert.match(p, /student loans, rent and prices, gas, travel and airfares/);
  assert.match(p, /1 = institutional or routine paperwork/);
  assert.match(p, /HARD LIMITS.*headline at most 90 characters/);
  assert.ok(RESPONSE_SCHEMA.required.includes('everyday_relevance'));
  assert.equal(RESPONSE_SCHEMA.properties.everyday_relevance.type, 'INTEGER');
  assert.ok(GROQ_JSON_SCHEMA.schema.required.includes('everyday_relevance'));
  assert.equal(GROQ_JSON_SCHEMA.schema.properties.everyday_relevance.type, 'integer');
});
