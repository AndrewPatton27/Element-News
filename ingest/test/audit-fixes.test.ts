// Audit quick fixes (2026-10-18): earnings figures (EX-99.1 + no_figures), FAA directive cap and ranking,
// sentence-case headlines, no product codes in headline/summary, prompt/template versions. All offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.ts';
import { DRY_NOW, fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher, type Publisher } from '../src/publish.ts';
import { importance, type RankInput } from '../src/ranking.ts';
import { runRewrite } from '../src/rewrite.ts';
import { secFilingPageText, wantsExhibit } from '../src/sec-text.ts';
import { cpscToItem, cpscUrl, parseCpscJson } from '../src/sources/cpsc.ts';
import { isAirworthinessDirective } from '../src/sources/fedreg.ts';
import { classifySecEntry, findExhibitUrl, parseSec8kAtom } from '../src/sources/sec.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { buildPrompt } from '../src/summarizer/gemini.ts';
import { templateDraft, templateSummarizer } from '../src/summarizer/template.ts';
import { mentionsProductCodes, sentenceCase } from '../src/text.ts';
import type { RawItem, RevisableCard, Summarizer, SummaryDraft } from '../src/types.ts';
import { hasFigures, requiresFigures, validateDraft } from '../src/validate.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const items = (...n: string[]) => n.map((number) => ({ number, title: `Item ${number}` }));
const SRC = { text: 'Revenue was $102.5 billion, up 6 percent. Northwind Corp reported results.', licenseClass: 'company_filing', tickers: [] as string[] };
const DRAFT: SummaryDraft = { headline: 'Northwind reports results', body: 'Revenue was $102.5 billion.', category: 'earnings', event_type: 'earnings', tickers: [] };

// ---- (a) validator: no_figures ------------------------------------------------------------

test('validator: an earnings card whose body has no digit is rejected with no_figures; with a figure it passes', () => {
  assert.deepEqual(validateDraft(DRAFT, SRC).errors, []);
  for (const body of [null, 'Northwind shared its latest results with the SEC.']) {
    const r = validateDraft({ ...DRAFT, body }, SRC);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /^no_figures/);
  }
  // other event types are untouched
  assert.equal(validateDraft({ ...DRAFT, event_type: 'deal', body: null }, SRC).ok, true);
  // the real event type set in code wins over the draft's own
  assert.equal(validateDraft({ ...DRAFT, event_type: null, body: null }, { ...SRC, requireFigures: true }).ok, false);
  assert.equal(validateDraft({ ...DRAFT, body: null }, { ...SRC, requireFigures: false }).ok, true);
  assert.equal(hasFigures('no numbers'), false);
  assert.equal(hasFigures('up 6%'), true);
});

test('requiresFigures: 2.02 earnings yes; 4.02 / 4.01-only restatement and auditor notices exempt; other event types no', () => {
  const sec = (event_type: string | null, ...n: string[]) => ({ source: 'sec_8k', event_type, items: items(...n) });
  assert.equal(requiresFigures(sec('earnings', '2.02', '9.01')), true);
  assert.equal(requiresFigures(sec('earnings', '2.02', '4.02')), true);
  assert.equal(requiresFigures(sec('earnings', '4.02')), false);
  assert.equal(requiresFigures(sec('earnings', '4.01', '9.01')), false);
  assert.equal(requiresFigures(sec('deal', '1.01')), false);
  assert.equal(requiresFigures(sec(null, '1.03', '2.02')), false);
  assert.equal(requiresFigures({ source: 'fed_rss', event_type: 'earnings' }), true);
  assert.equal(requiresFigures({ source: 'fed_rss', event_type: null }), false);
});

// ---- (a) EX-99.1 selection and fetch ------------------------------------------------------------

const INDEX_URL = 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/0000320193-26-000018-index.htm';

test('EX-99.1 is chosen from the filing index fixture; the primary document is not; other exhibits are ignored', () => {
  assert.equal(findExhibitUrl(fx('sec-filing-index.html'), INDEX_URL),
    'https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/ex99-1.htm');
  const row = (type: string, href: string) => `<tr><td>1</td><td>x</td><td><a href="${href}">d</a></td><td>${type}</td><td>1</td></tr>`;
  const table = (...rows: string[]) => `<table>${rows.join('')}</table>`;
  assert.equal(findExhibitUrl(table(row('8-K', 'a.htm'), row('EX-99.2', 'slides.htm')), INDEX_URL), null, 'EX-99.2 is not the press release');
  assert.equal(findExhibitUrl(table(row('EX-99.2', 'slides.htm'), row('EX-99.1', '/Archives/edgar/data/1/2/pr.htm')), INDEX_URL),
    'https://www.sec.gov/Archives/edgar/data/1/2/pr.htm');
  assert.equal(findExhibitUrl(table(row('EX-99.1', 'pr.pdf')), INDEX_URL), null, 'html pages only');
  assert.equal(findExhibitUrl(table(row('EX-99.1', 'https://evil.example/pr.htm')), INDEX_URL), null, 'only www.sec.gov /Archives/');
  assert.equal(findExhibitUrl(table(row('EX-99', 'old.htm'), row('EX-99.01', 'b.htm')), INDEX_URL),
    'https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/b.htm', 'preference order EX-99.1, EX-99.01, EX-99');
});

test('secFilingPageText: Item 2.02 reads the exhibit first (page host, via fetchText), then a capped primary; other items do not fetch it', async () => {
  const base = fixtureFetcher();
  const requested: string[] = [];
  const fetchText: Deps['fetchText'] = async (url, kind, ttl) => { requested.push(`${kind} ${url.split('/').pop()}`); return base(url, kind, ttl); };
  const mk = (...n: string[]) => ({ url: INDEX_URL, title: 'Apple Inc. 8-K', items: items(...n) }) as unknown as RawItem;
  assert.equal(wantsExhibit(mk('2.02')), true);
  assert.equal(wantsExhibit(mk('5.02')), false);

  const text = await secFilingPageText(fetchText, mk('2.02', '9.01'));
  assert.ok(text.startsWith('Exhibit 99.1'), 'press release first');
  assert.match(text, /Quarterly revenue of \$102\.5 billion/);
  assert.match(text, /FORM 8-K/, 'then the primary document');
  assert.deepEqual(requested, ['page 0000320193-26-000018-index.htm', 'page primary-8k.htm', 'page ex99-1.htm']);

  requested.length = 0;
  const other = await secFilingPageText(fetchText, mk('5.02'));
  assert.doesNotMatch(other, /102\.5/);
  assert.deepEqual(requested, ['page 0000320193-26-000018-index.htm', 'page primary-8k.htm']);

  // a failing exhibit never stops the card: primary only, one logged line
  const lines: string[] = [];
  const flaky: Deps['fetchText'] = async (url, kind, ttl) => { if (url.endsWith('ex99-1.htm')) throw new Error('HTTP 503'); return base(url, kind, ttl); };
  const fallback = await secFilingPageText(flaky, mk('2.02'), (l) => lines.push(l));
  assert.match(fallback, /FORM 8-K/);
  assert.ok(lines.some((l) => /EX-99\.1 press release unavailable/.test(l)), lines.join('\n'));
});

test('secFilingPageText: the exhibit text is capped like the primary document', async () => {
  const big = `<html><body><p>${'word 1.5 '.repeat(5000)}</p></body></html>`;
  const base = fixtureFetcher();
  const fetchText: Deps['fetchText'] = async (url, kind, ttl) => (url.endsWith('ex99-1.htm') ? big : base(url, kind, ttl));
  const text = await secFilingPageText(fetchText, { url: INDEX_URL, title: 't', items: items('2.02') } as unknown as RawItem);
  assert.ok(text.length <= config.sourceTextMaxChars + 2 + config.secExhibit.primaryMaxChars, `length ${text.length}`);
});

// ---- (a) pipeline: no_figures -------------------------------------------------------------------

function appleRun(providers: Summarizer[]) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const statuses: string[] = [];
  const publisher: Publisher = { ...dry.publisher, async setItemStatus(_id, status, note) { statuses.push(`${status}:${note}`); } };
  const deps: Deps = { fetchText: fixtureFetcher(), publisher, providers, counter: memoryCounter(), fredApiKey: null, now: new Date('2026-08-05T12:00:00Z'), log: (s) => lines.push(s) };
  return { deps, dry, lines, statuses };
}
const aiDraft = (body: string | null): Summarizer => ({
  name: 'gemini', usesAi: true, model: 'm',
  async summarize() { return { headline: 'Apple shares its latest results', body, category: 'earnings', event_type: 'earnings', tickers: ['AAPL'], everyday_relevance: 4 }; },
});

test('pipeline: the AI sees the EX-99.1 figures and the card states them', async () => {
  const seen: string[] = [];
  const spy: Summarizer = { ...aiDraft('Apple reported revenue of $102.5 billion.'), async summarize(i) { seen.push(i.text); return aiDraft('Apple reported revenue of $102.5 billion.').summarize(i); } };
  const r = appleRun([spy, templateSummarizer]);
  const s = await runOnce(r.deps, { only: ['sec'] });
  assert.equal(s.published, 1);
  assert.match(seen[0], /Quarterly revenue of \$102\.5 billion/);
  assert.equal(r.dry.cards[0].body, 'Apple reported revenue of $102.5 billion.');
});

test('pipeline: AI drafts without figures are rejected twice, nothing is published, the item is closed as no_figures', async () => {
  const r = appleRun([aiDraft('Apple shared its latest results with the SEC.'), templateSummarizer]);
  const s = await runOnce(r.deps, { only: ['sec'] });
  assert.equal(s.published, 0);
  assert.equal(s.skipped, 2, 'Apple no_figures + the routine Costco 5.02 in the feed');
  assert.equal(r.dry.cards.length, 0);
  assert.ok(r.lines.includes('skip no_figures (earnings card without figures, template): Apple Inc. 8-K'), r.lines.join('\n'));
  assert.deepEqual(r.statuses.filter((x) => !x.includes('routine')), ['skipped:no_figures']);
});

test('pipeline: template-only run never publishes a figure-less earnings card (item stays new for a later AI run)', async () => {
  const r = appleRun([templateSummarizer]);
  const s = await runOnce(r.deps, { only: ['sec'] });
  assert.equal(s.published, 0);
  assert.equal(r.dry.cards.length, 0);
  assert.ok(r.lines.some((l) => l.startsWith('skip no_figures')));
  assert.deepEqual(r.statuses.filter((x) => !x.includes('routine')), []);
});

// ---- (a) rewrite --------------------------------------------------------------------------------

const appleCard = (over: Partial<RevisableCard> = {}): RevisableCard => ({
  ...(JSON.parse(fx('rewrite-cards.json')).cards[1] as RevisableCard), ai_generated: true, prompt_version: 'sum-v4', ...over,
});

function rewriteRun(cards: RevisableCard[], providers: Summarizer[], fetchOverride?: (url: string) => string | null) {
  const dry = createDryRunPublisher(cards);
  const lines: string[] = [];
  const base = fixtureFetcher();
  const deps: Deps = {
    fetchText: async (url, kind, ttl) => fetchOverride?.(url) ?? base(url, kind, ttl),
    publisher: dry.publisher, providers, counter: memoryCounter(), fredApiKey: null, now: new Date('2026-08-05T12:00:00Z'), log: (s) => lines.push(s),
  };
  return { deps, dry, lines };
}

test('rewrite: an earnings AI card gets the figures from EX-99.1; if the AI cannot, the figure-less card is hidden, not kept', async () => {
  const ok = rewriteRun([appleCard({ body: 'Apple filed a report.' })], [aiDraft('Apple reported revenue of $102.5 billion.')]);
  const s = await runRewrite(ok.deps);
  assert.equal(s.revised, 1);
  const [p] = ok.dry.revisions;
  assert.ok(p.action === 'revise' && p.body === 'Apple reported revenue of $102.5 billion.' && p.prompt_version === 'sum-v6');

  const bad = rewriteRun([appleCard({ body: 'Apple filed a report.' })], [aiDraft('Apple shared results.'), templateSummarizer]);
  const s2 = await runRewrite(bad.deps);
  assert.equal(s2.hidden, 1);
  assert.equal(s2.kept, 0);
  assert.deepEqual(bad.dry.revisions, [{ id: appleCard().id, action: 'hide', note: 'no_figures' }]);

  // an old card that already has figures stays when the AI only fails
  const keep = rewriteRun([appleCard({ body: 'Apple reported $102.5 billion in revenue.' })], [aiDraft('Apple shared results.'), templateSummarizer]);
  const s3 = await runRewrite(keep.deps);
  assert.equal(s3.kept, 1);
  assert.equal(keep.dry.revisions.length, 0);
});

test('rewrite: a published low-interest quake is hidden; a recall is re-read from the CPSC list (cpsc and nasa are supported now)', async () => {
  const quake: RevisableCard = {
    ...appleCard({ body: 'x', ai_generated: false, prompt_version: 'tpl-v4' }), id: 'q1',
    item: { source: 'usgs', external_id: 'us6000u214', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u214', title: 'M 6.8', license_class: 'public_domain' },
  };
  const q = rewriteRun([quake], [templateSummarizer]);
  const s = await runRewrite({ ...q.deps, now: DRY_NOW });
  assert.equal(s.hidden, 1);
  assert.deepEqual(q.dry.revisions, [{ id: 'q1', action: 'hide', note: 'low_interest (green alert, at sea or no country)' }]);

  const list = parseCpscJson(fx('cpsc-recalls-2026-10-03.json'));
  const recall = list[0];
  const card: RevisableCard = {
    ...appleCard({ body: 'x', headline: 'Old Title Case Headline', category: 'safety', event_type: 'recall' }), id: 'r1',
    item: { source: 'cpsc', external_id: String(recall.RecallNumber), url: String(recall.URL), title: recall.Title!, license_class: 'public_domain' },
  };
  const seen: string[] = [];
  const spy: Summarizer = { name: 'gemini', usesAi: true, model: 'm', async summarize(i) {
    seen.push(i.text);
    return { headline: 'Acme recalls a product', body: 'The company recalled a product.', category: 'policy', event_type: null, tickers: [], everyday_relevance: 4 };
  } };
  const requested: string[] = [];
  const r = rewriteRun([card], [spy], (url) => { requested.push(url); return url === cpscUrl(DRY_NOW, config.cpsc.rewriteLookbackDays) ? fx('cpsc-recalls-2026-10-03.json') : null; });
  const s2 = await runRewrite({ ...r.deps, now: DRY_NOW });
  assert.equal(s2.revised, 1, r.lines.join('\n'));
  assert.ok(requested.includes(cpscUrl(DRY_NOW, 120)));
  assert.ok(seen[0].startsWith(recall.Title!));
});

// ---- (b) FAA directive cap and ranking ---------------------------------------------------------------

const frDoc = (n: number, title: string) => ({
  document_number: `2026-3000${n}`, title, abstract: `The agency issued rule number ${n}.`,
  html_url: `https://www.federalregister.gov/documents/2026/10/16/2026-3000${n}/x`, publication_date: `2026-10-${String(16 - n).padStart(2, '0')}`,
  type: 'Rule', agencies: [{ name: 'Federal Aviation Administration', parent_id: 492 }],
});

test('FAA cap: only 1 airworthiness directive per run becomes a candidate; the rest are skipped with a logged reason; other rules are unaffected', async () => {
  assert.equal(config.fedRegister.maxAirworthinessPerRun, 1);
  const docs = [
    frDoc(1, 'Airworthiness Directives; The Boeing Company Airplanes'),
    frDoc(2, 'Airworthiness Directives; Pratt & Whitney Engines'),
    frDoc(3, 'Revision of Class E Airspace'),
    frDoc(4, 'Airworthiness Directive; Boeing 787'),
  ];
  const seen: string[] = [];
  const ai: Summarizer = { name: 'gemini', usesAi: true, model: 'm', async summarize(i) {
    seen.push(i.item.title);
    return { headline: 'The FAA changes a rule', body: 'The agency issued a rule.', category: 'policy', event_type: null, tickers: [], everyday_relevance: 4 };
  } };
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = { fetchText: async () => JSON.stringify({ count: 4, results: docs }), publisher: dry.publisher, providers: [ai], counter: memoryCounter(), fredApiKey: null, now: new Date('2026-10-17T21:00:00Z'), log: (l) => lines.push(l) };
  const s = await runOnce(deps, { only: ['fedreg'] });
  assert.deepEqual(seen, ['Airworthiness Directives; The Boeing Company Airplanes', 'Revision of Class E Airspace']);
  assert.equal(s.published, 2);
  assert.equal(s.skipped, 2);
  assert.equal(lines.filter((l) => l.startsWith('skip faa_directive_cap')).length, 2, lines.join('\n'));
  assert.ok(isAirworthinessDirective('Airworthiness Directive; X') && !isAirworthinessDirective('Airspace rule'));
});

test('ranking: an airworthiness directive is capped at config importance 1.5 and stops outranking a normal policy card', () => {
  assert.equal(config.ranking.airworthinessImportance, 1.5);
  const card: RankInput = { id: 'a', kind: 'summary', event_type: null, sort_at: '2026-10-17T12:00:00Z', sources: [{ name: 'Federal Register', kind: 'government' }] };
  assert.equal(importance(card), 2.5, 'default weight 2 x government 1.25');
  assert.equal(importance({ ...card, title: 'Airworthiness Directives; The Boeing Company Airplanes' }), 1.5);
  assert.equal(importance({ ...card, title: 'Revision of Class E Airspace' }), 2.5);
  assert.equal(importance({ ...card, event_type: 'recall', title: 'Airworthiness Directives; X' }), 1.5, 'never raised, only capped');
});

// ---- (d) product codes -------------------------------------------------------------------------------

test('product codes: validator rejects model number / SKU / UPC / lot number in headline or body (key points are fine)', () => {
  const src = { text: 'Acme recalls heaters. Model number HT-4410, UPC 012345678905, lot number 7731. Stop using them.', licenseClass: 'public_domain', category: 'safety' };
  const ok: SummaryDraft = { headline: 'Acme recalls space heaters', body: 'Stop using them.', category: 'tech', event_type: null, tickers: [] };
  assert.deepEqual(validateDraft(ok, src).errors, []);
  for (const bad of ['Acme recalls heaters with model number HT-4410.', 'Check the UPC on the box.', 'Look for lot number 7731.', 'Item SKU is listed.']) {
    const r = validateDraft({ ...ok, body: bad }, src);
    assert.match(r.errors.join(), /product codes in headline or body/, bad);
  }
  assert.match(validateDraft({ ...ok, headline: 'Acme recalls heaters, SKU HT-4410' }, src).errors.join(), /product codes/);
  assert.deepEqual(mentionsProductCodes('Boeing 737 Model 3 and Item 2.02'), [], 'a bare model name or 8-K item is not a product code');
});

test('prompt: no model numbers/SKUs/UPCs/lot numbers in headline or body; key points only', () => {
  const it = { source: 'cpsc', source_name: 'CPSC', doc_label: 'Recall', published_at: '2026-10-17T00:00:00Z', tickers: [], category: 'safety', event_type: 'recall' } as unknown as RawItem;
  const p = buildPrompt({ item: it, text: 'T' });
  assert.match(p, /Never include model numbers, SKUs, UPCs or lot numbers in the headline or the body/);
  assert.match(p, /put them in "detail"\.key_points only/);
});

test('CPSC template card: generic wording, no title, model numbers, SKUs or digits', () => {
  const recall = parseCpscJson(fx('cpsc-recalls-2026-10-03.json')).find((r) => /\d/.test(r.Title ?? '')) ?? parseCpscJson(fx('cpsc-recalls-2026-10-03.json'))[0];
  const it = (cpscToItem(recall, DRY_NOW) as { item: RawItem }).item;
  const d = templateDraft({ item: it, text: '' });
  assert.equal(d.headline, 'A product recall was announced');
  assert.doesNotMatch(`${d.headline} ${d.body}`, /\d/);
  assert.equal(d.category, 'safety');
  assert.deepEqual(mentionsProductCodes(`${d.headline} ${d.body}`), []);
});

// ---- (e) sentence case ------------------------------------------------------------------------------

test('sentence case: Title Case headlines are fixed, proper nouns, tickers and acronyms are never lowercased', () => {
  assert.equal(sentenceCase('Gross Domestic Product, 2nd Quarter 2026 (Third Estimate)'), 'Gross domestic product, 2nd quarter 2026 (third estimate)');
  assert.equal(sentenceCase('U.S. International Trade in Goods and Services, August 2026'), 'U.S. international trade in goods and services, August 2026');
  assert.equal(sentenceCase('Fed Holds Rates Steady After Meeting'), 'Fed holds rates steady after meeting');
  assert.equal(sentenceCase('Apple Reports Third Quarter Earnings'), 'Apple reports third quarter earnings');
  assert.equal(sentenceCase('Goldman Sachs Reports Quarterly Results For AAPL and NVDA'), 'Goldman Sachs reports quarterly results for AAPL and NVDA');
  assert.equal(sentenceCase('Federal Reserve Board Announces Minutes of Open Market Committee Meeting'), 'Federal Reserve Board announces minutes of Open Market Committee meeting');
  // already sentence case or mixed: unchanged
  for (const h of ['Federal Reserve issues FOMC statement', 'Primark recalls children\'s coin purses', 'Magnitude 5.7 earthquake hits Pakistan', 'The FAA issues a safety order for Boeing planes']) {
    assert.equal(sentenceCase(h), h);
  }
});

test('template headlines are sentence case: Fed/BEA titles, SEC, Federal Register, quakes and data cards', () => {
  const fed = { source: 'fed_rss', title: 'Federal Reserve Board Announces Final Rule On Interest Rates', category: 'policy', event_type: null, tickers: [] } as unknown as RawItem;
  assert.equal(templateDraft({ item: fed, text: '' }).headline, 'Federal Reserve Board announces final rule on interest rates');
  const bea = { source: 'bea_rss', title: 'Personal Income and Outlays, September 2026', category: 'economy', event_type: 'macro_release', tickers: [] } as unknown as RawItem;
  assert.equal(templateDraft({ item: bea, text: '' }).headline, 'Personal income and outlays, September 2026');
  const heads = [
    templateDraft({ item: { source: 'sec_8k', company: 'Costco Wholesale Corp', items: items('5.02'), tickers: [], category: 'markets', event_type: 'exec_change' } as unknown as RawItem, text: '' }).headline,
    templateDraft({ item: { source: 'fedreg', title: 'Airworthiness Directives; The Boeing Company Airplanes', agency: 'Federal Aviation Administration', tickers: [], category: 'policy', event_type: null } as unknown as RawItem, text: '' }).headline,
  ];
  for (const h of heads) {
    // no word after the first starts with a capital unless it is a name, ticker, agency or company
    const stray = h.split(' ').slice(1).filter((w) => /^[A-Z][a-z]+$/.test(w) && !['Costco', 'Wholesale', 'Corp', 'Boeing', 'FAA'].includes(w));
    assert.deepEqual(stray, [], h);
  }
});

test('prompt: sentence-case headline rule', () => {
  const it = { source: 'fed_rss', source_name: 'Fed', doc_label: 'Press release', published_at: '2026-10-17T00:00:00Z', tickers: [], category: 'policy', event_type: null } as unknown as RawItem;
  const p = buildPrompt({ item: it, text: 'T' });
  assert.match(p, /Use sentence case in the headline: capitalise only the first word and proper nouns/);
  assert.match(p, /not "Primark Recalls Children's Coin Purses"/);
});

test('prompt: earnings cards must state figures; retry hint names no_figures; other cards do not get the block', () => {
  const gopro = classifySecEntry(parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'))[0], null);
  assert.ok('item' in gopro);
  const p = buildPrompt({ item: (gopro as { item: RawItem }).item, text: 'T' });
  assert.match(p, /THIS IS AN EARNINGS CARD\. The body MUST state the real figures/);
  assert.match(p, /never the filing itself/);
  const retry = buildPrompt({ item: (gopro as { item: RawItem }).item, text: 'T', retryErrors: ['no_figures: an earnings card must state real figures'] });
  assert.match(retry, /Put the key figures from the source/);
  const restate = { ...(gopro as { item: RawItem }).item, items: items('4.02') };
  assert.doesNotMatch(buildPrompt({ item: restate, text: 'T' }), /EARNINGS CARD/);
});

// ---- (f) versions ---------------------------------------------------------------------------------

test('versions: prompt sum-v6 and template tpl-v5 (the next --rewrite revisits every older card)', () => {
  assert.equal(config.promptVersion, 'sum-v6');
  assert.equal(config.templateVersion, 'tpl-v5');
});
