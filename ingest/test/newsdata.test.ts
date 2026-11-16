// NewsData.io link-out source: rule 7 (verbatim headline, 200-char cap, publisher URL, "via NewsData.io", no description or image),
// the standing content rule, dedupe, the credit budget, and the locks (switch off = nothing, no key = no-op, link_out only from newsdata).
// Offline: a fixture and fake fetchers. No key value appears in any log line or card.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed, AllowlistError } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { runOnce, SOURCE_NAMES, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { isNearDuplicate, newsdataPayload, newsdataToItem, newsdataUrl, parseNewsdata, redactKey, relevanceScore, type NewsdataArticle } from '../src/sources/newsdata.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import type { RawItem } from '../src/types.ts';
import { checkLinkOut, SUMMARIZABLE, validatePublish } from '../src/validate.ts';

const body = readFileSync(new URL('./fixtures/newsdata-market.json', import.meta.url), 'utf8');
const NOW = new Date('2026-11-11T08:00:00Z');
const KEY = 'pub_SECRETKEY123456';

function fakeDeps(fetchText: Deps['fetchText'], over: Partial<Deps> = {}) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  // D-296: link-out cards need a full summary, so the default deps have an AI provider and a readable publisher page
  const withPages: Deps['fetchText'] = async (u, kind, ttl) => (kind === 'publisher' ? pageFetch(articleHtml)(u, kind, ttl) : fetchText(u, kind, ttl));
  const deps: Deps = { fetchText: withPages, publisher: dry.publisher, providers: [summaryProvider([])] as never, counter: memoryCounter(), fredApiKey: null, now: NOW, log: (l) => lines.push(l), ...over };
  return { dry, lines, deps };
}
const ok = (text = body) => async () => text;
const on = { newsdata: { apiKey: KEY, enabled: true } };
const firstItem = () => (newsdataToItem(parseNewsdata(body)[0], NOW) as { item: RawItem }).item;

test('the flag constant is ON in the shipped config (cadence), and the sources are registered', () => {
  assert.equal(config.newsdata.enabled, true);
  assert.ok((SOURCE_NAMES as readonly string[]).includes('newsdata_market'));
  assert.ok((SOURCE_NAMES as readonly string[]).includes('newsdata_latest'));
  assert.equal(config.newsdata.attribution, 'via NewsData.io');
  assert.equal(config.newsdata.headlineMaxChars, 200);
  assert.equal(config.newsdata.dailyCreditCap, 144);
});

test('allowlist: newsdata.io is an API host only; the article host is not', () => {
  assert.doesNotThrow(() => assertAllowed(newsdataUrl('market', KEY), 'api'));
  assert.throws(() => assertAllowed(newsdataUrl('market', KEY), 'page'), AllowlistError);
  assert.throws(() => assertAllowed('https://www.example-times.com/business/fed-holds', 'api'), AllowlistError);
});

test('parse keeps only whitelisted fields: no description, content, image or AI summary', () => {
  const list = parseNewsdata(body);
  assert.equal(list.length, 9);
  assert.deepEqual(Object.keys(list[0]).sort(), ['article_id', 'link', 'pubDate', 'source_name', 'symbols', 'title']);
  assert.ok(!JSON.stringify(list).includes('SECRET'));
  assert.throws(() => parseNewsdata('not json'), /not JSON/);
  assert.throws(() => parseNewsdata('{"status":"error","results":{"message":"bad key"}}'), /API status error \(bad key\)/);
});

test('item: verbatim headline, publisher name and URL, link_out license, attribution, no text kept', () => {
  const it = firstItem();
  assert.equal(it.title, 'Fed holds rates steady as inflation cools to 2.9%');
  assert.equal(it.source_name, 'Example Times');
  assert.equal(it.url, 'https://www.example-times.com/business/fed-holds');
  assert.equal(it.license_class, 'link_out');
  assert.equal(it.summary_text, '');
  assert.equal(it.published_at, '2026-11-10T20:00:00.000Z');
  assert.equal(it.attribution, 'via NewsData.io');
});

test('headline over 200 chars is cut to the 200-char cap', () => {
  const long = `Stocks rally ${'x'.repeat(300)}`;
  const r = newsdataToItem({ article_id: 'l', title: long, link: 'https://example.com/l', pubDate: '2026-11-10 20:00:00', source_name: 'E', symbols: [] }, NOW);
  assert.ok('item' in r);
  assert.equal((r as { item: { title: string } }).item.title.length, 200);
});

test('content rule: finance only; recalls, micro-cap, sports/celebrity, advice, old and insecure links are skipped', () => {
  const skip = (title: string, link = 'https://example.com/x', pubDate = '2026-11-10 20:00:00') =>
    (newsdataToItem({ article_id: 'x', title, link, pubDate, source_name: 'E', symbols: [] }, NOW) as { skip?: string }).skip;
  assert.equal(skip('Acme Widgets recalls 400 desk lamps over fire risk'), 'not_finance');
  assert.equal(skip('Acme stock recalls 400 lamps, shares drop'), 'micro_or_recall');
  assert.equal(skip('Penny stock XYZQ soars on OTC markets'), 'micro_or_recall');
  assert.equal(skip('Celebrity couple buys mansion, stocks rise'), 'off_topic');
  assert.equal(skip('Time to buy Nvidia stock before earnings'), 'advice_language');
  assert.equal(skip('Cute puppy video goes viral'), 'not_finance');
  assert.equal(skip('Treasury yields climb', 'http://insecure.example.com/y'), 'bad_url');
  assert.equal(skip('Oil prices fall on OPEC news', 'https://example.com/o', '2026-11-01 13:00:00'), 'too_old');
  assert.equal(skip('Treasury yields climb', 'https://newsdata.io/x'), 'bad_url');
  assert.equal(skip('Treasury yields climb', 'https://example.com/x', 'yesterday'), 'bad_date');
  // a watch-list company is material even in a recall headline
  assert.equal(skip('Home Depot recalls ladders; shares slip after earnings'), undefined);
});

test('base payload is link_out: no body or detail yet, one link_out source with the credit (not publishable without a summary)', () => {
  const it = firstItem();
  const p = newsdataPayload(it, 'id1');
  assert.equal(p.kind, 'link_out');
  assert.equal(p.origin, 'newsdata');
  assert.equal(p.body, null);
  assert.equal(p.detail, null);
  assert.equal(p.ai_generated, false);
  assert.equal(p.attribution, 'via NewsData.io');
  assert.equal(p.sort_at, it.published_at);
  assert.equal(p.sources.length, 1);
  assert.deepEqual([p.sources[0].license_class, p.sources[0].kind, p.sources[0].is_primary], ['link_out', 'news', true]);
  assert.match(validatePublish(p, { linkOutEnabled: true }).errors.join(), /must carry an AI summary/);   // D-296: never headline-only
  assert.ok(!JSON.stringify(p).includes('SECRET'));
  assert.ok(!/image|description/i.test(Object.keys(p).join(',')));
});

test('validatePublish: link_out refused when the flag is off, from another origin, with a body, long headline or wrong credit', () => {
  const p = newsdataPayload(firstItem());
  assert.match(validatePublish(p).errors.join(), /disabled in this build/);
  assert.match(validatePublish(p, { linkOutEnabled: false }).errors.join(), /disabled/);
  assert.match(validatePublish({ ...p, origin: 'cpsc' }, { linkOutEnabled: true }).errors.join(), /only allowed from the newsdata source/);
  assert.match(validatePublish({ ...p, origin: undefined }, { linkOutEnabled: true }).errors.join(), /only allowed from the newsdata source/);
  assert.match(validatePublish({ ...p, body: 'A description.' }, { linkOutEnabled: true }).errors.join(), /must carry an AI summary/);
  assert.match(validatePublish({ ...p, headline: 'x'.repeat(201) }, { linkOutEnabled: true }).errors.join(), /longer than 200/);
  assert.match(validatePublish({ ...p, attribution: null }, { linkOutEnabled: true }).errors.join(), /via NewsData\.io/);
  assert.match(validatePublish({ ...p, ai_generated: true }, { linkOutEnabled: true }).errors.join(), /needs its summary body/);
  assert.match(validatePublish({ ...p, ai_generated: true, body: 'S.', detail: { paragraphs: ['a', 'b'], key_points: ['x'] } }, { linkOutEnabled: true }).errors.join(), /at least 3 key points/);
  assert.match(checkLinkOut({ ...p, sources: [{ ...p.sources[0], license_class: 'public_domain' }] }, true).join(), /not link_out/);
  // a summary card is unaffected by the new option
  assert.deepEqual(validatePublish({ kind: 'summary', ai_generated: false, sources: [{ name: 'SEC', kind: 'filing', url: 'https://www.sec.gov/x', license_class: 'company_filing' }] }).errors, []);
});

test('rule 1: link_out text can never reach the AI (not a summarizable license class)', () => {
  assert.ok(!(SUMMARIZABLE as readonly string[]).includes('link_out'));
  const p = { kind: 'summary', ai_generated: true, sources: [{ name: 'E', kind: 'news', url: 'https://e.com/x', license_class: 'link_out' }] };
  assert.match(validatePublish(p).errors.join(), /may not be summarized/);
});

test('flag OFF: nothing is fetched, nothing published (even with a key)', async () => {
  const f = fakeDeps(async () => { throw new Error('must not fetch'); }, { newsdata: { apiKey: KEY, enabled: false } });
  await runOnce(f.deps, { only: ['newsdata_market', 'newsdata_latest'] });
  assert.equal(f.dry.cards.length, 0);
  assert.equal(f.dry.items.length, 0);
  assert.ok(f.lines.some((l) => /switched off/.test(l)));
});

test('no key: no-op, nothing fetched', async () => {
  const f = fakeDeps(async () => { throw new Error('must not fetch'); }, { newsdata: { apiKey: null, enabled: true } });
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.equal(f.dry.cards.length, 0);
  assert.ok(f.lines.some((l) => /NEWSDATA_API_KEY not set/.test(l)));
  const g = fakeDeps(async () => { throw new Error('must not fetch'); });   // deps.newsdata missing altogether
  await runOnce(g.deps, { only: ['newsdata_latest'] });
  assert.equal(g.dry.cards.length, 0);
});

test('on: publishes only filtered, de-duplicated link_out cards; the key is never logged; a rerun gives no new cards', async () => {
  const urls: string[] = [];
  const f = fakeDeps(async (u) => { urls.push(u); return body; }, on);
  f.dry.publisher.recentHeadlines = async () => f.dry.cards.map((c) => c.headline);   // what the live feed page would return
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/newsdata\.io\/api\/1\/market\?/);
  // the Fed story and the Home Depot item publish; the second Fed story is the same news; recall, penny stock, celebrity, advice, http and old are filtered
  assert.deepEqual(f.dry.cards.map((c) => c.headline).sort(), [
    'Fed holds rates steady as inflation cools to 2.9%',
    'Home Depot recalls ladders; shares slip after earnings',
  ]);
  for (const c of f.dry.cards) {
    assert.equal(c.kind, 'link_out');
    assert.ok(c.body && c.ai_generated && (c.detail?.key_points.length ?? 0) >= 3);   // D-296: full summary
    assert.equal(c.attribution, 'via NewsData.io');
    assert.equal(c.sources[0].license_class, 'link_out');
    assert.deepEqual(validatePublish(c, { linkOutEnabled: true }).errors, []);
    assert.ok(c.headline.length <= 200);
  }
  const blob = JSON.stringify([f.dry.cards, f.dry.items, f.lines]);
  assert.ok(!blob.includes(KEY));
  assert.ok(!blob.includes('SECRET'));
  assert.ok(!/image_url|\.jpg/.test(blob));
  assert.ok(f.dry.items.every((i) => i.license_class === 'link_out' && i.summary_text === ''));
  const before = f.dry.cards.length;
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.equal(f.dry.cards.length, before);
});

test('dedupe against cards already live (headlines of the newest live cards)', async () => {
  const f = fakeDeps(ok(), on);
  f.dry.publisher.recentHeadlines = async () => ['Fed holds rates steady as inflation cools to 2.9 percent'];
  await runOnce(f.deps, { only: ['newsdata_latest'] });
  assert.ok(!f.dry.cards.some((c) => c.headline.startsWith('Fed holds')));
  assert.ok(isNearDuplicate('Fed holds rates steady as inflation cools', ['Fed holds rates steady as inflation cools to 2.9 percent']));
  assert.ok(!isNearDuplicate('Oil prices fall on OPEC supply news', ['Fed holds rates steady as inflation cools']));
});

test('credit budget: one credit per request, stops at the daily cap; a refused take means no request', async () => {
  const counter = memoryCounter();
  for (let i = 0; i < config.newsdata.dailyCreditCap - 1; i++) counter.add('newsdata');
  let calls = 0;
  const f = fakeDeps(async () => { calls++; return body; }, { ...on, counter });
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.equal(calls, 1);
  assert.equal(counter.used('newsdata'), config.newsdata.dailyCreditCap);
  await runOnce(f.deps, { only: ['newsdata_market', 'newsdata_latest'] });
  assert.equal(calls, 1, 'at the cap: no more requests');
  assert.ok(f.lines.some((l) => /daily credit cap 144 reached/.test(l)));
  let taken = 0;
  const g = fakeDeps(async () => { throw new Error('must not fetch'); }, { newsdata: { apiKey: KEY, enabled: true, takeCredit: async () => { taken++; return false; } } });
  await runOnce(g.deps, { only: ['newsdata_latest'] });
  assert.equal(taken, 1);
});

test('request failures are logged without the key', async () => {
  const f = fakeDeps(async (u) => { throw new Error(`HTTP 401 from newsdata.io ${u}`); }, on);
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.equal(f.dry.cards.length, 0);
  assert.ok(f.lines.some((l) => /request failed/.test(l)));
  assert.ok(!f.lines.join('\n').includes(KEY));
  assert.equal(redactKey(`GET https://newsdata.io/api/1/latest?apikey=${KEY}&x=1`, KEY), 'GET https://newsdata.io/api/1/latest?apikey=[redacted]&x=1');
});

test('database flag off: the publisher refuses link_out; the item stays retryable (not marked failed)', async () => {
  const f = fakeDeps(ok(), on);
  const statuses: string[] = [];
  f.deps.publisher = { ...f.dry.publisher, async publishBlurb() { throw new Error('rpc publish_blurb: HTTP 400: publish_blurb: link_out cards are disabled'); }, async setItemStatus(_i, s) { statuses.push(s); } };
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.deepEqual(statuses, []);
  assert.ok(f.lines.some((l) => /link_out cards are disabled/.test(l)));
});

// ---- cadence (D-270): relevance score without AI, credit pacing, default on ----
const art = (title: string, link = 'https://example.com/x', symbols: string[] = []): NewsdataArticle => ({ article_id: 'a', title, link, pubDate: '2026-11-10 20:00:00', source_name: 'E', symbols });

test('relevance score: macro first, then markets and corporate; listicles, promo outlets and generic words sink', () => {
  assert.ok(relevanceScore(art('Fed signals rate cut as inflation cools')) >= 3);
  assert.ok(relevanceScore(art('Fed signals rate cut', 'https://www.reuters.com/a')) > relevanceScore(art('Fed signals rate cut')), 'trusted outlet +1');
  assert.ok(relevanceScore(art('Fed signals rate cut', 'https://www.fool.com/a')) < relevanceScore(art('Fed signals rate cut')), 'promo outlet -2');
  assert.ok(relevanceScore(art('Nvidia earnings beat estimates; stocks jump')) >= 4);
  assert.ok(relevanceScore(art('Company CEO speaks at conference')) < config.newsdata.minScore, 'generic word only');
  assert.ok(relevanceScore(art('5 stocks to watch as the Fed meets')) < relevanceScore(art('Stocks to watch as the Fed meets')), 'listicle -3');
  assert.ok(relevanceScore(art('Quarterly revenue up', 'https://example.com/y', ['ACME'])) > relevanceScore(art('Quarterly revenue up')), 'ticker +1');
  assert.equal(relevanceScore(art('Cute puppy video goes viral')), 0);
});

test('a generic-only headline is skipped as not_finance; a macro headline passes', () => {
  const sk = (t: string) => (newsdataToItem(art(t), NOW) as { skip?: string }).skip;
  assert.equal(sk('Local bank CEO named to charity board'), 'not_finance');
  assert.equal(sk('Treasury yields climb after strong jobs report'), undefined);
});

test('within a run the most relevant headlines are processed first', async () => {
  const mk = (id: string, title: string, h: number) => ({ article_id: id, title, link: `https://example.com/${id}`, pubDate: `2026-11-10 ${String(h).padStart(2, '0')}:00:00`, source_name: 'E' });
  const json = JSON.stringify({ status: 'success', results: [mk('1', 'Banks name new CEO as shares inch up', 22), mk('2', 'Fed holds rates as inflation cools; stocks rally', 10)] });
  const f = fakeDeps(async () => json, on);
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.equal(f.dry.cards[0]?.headline, 'Fed holds rates as inflation cools; stocks rally');
});

test('credit pacing: at 80% of the daily cap /latest pauses (no request, no credit), /market keeps going', async () => {
  const counter = memoryCounter();
  const stop = Math.floor(config.newsdata.dailyCreditCap * config.newsdata.latestStopFraction);
  for (let i = 0; i < stop; i++) counter.add('newsdata');
  let calls = 0;
  const f = fakeDeps(async () => { calls++; return body; }, { ...on, counter });
  await runOnce(f.deps, { only: ['newsdata_latest'] });
  assert.equal(calls, 0);
  assert.equal(counter.used('newsdata'), stop);
  assert.ok(f.lines.some((l) => /\/latest paused/.test(l)));
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.equal(calls, 1);
});

test('default on: deps.newsdata.enabled unset follows the code default, but no key still means no request', async () => {
  const f = fakeDeps(async () => body, { newsdata: { apiKey: KEY } });
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.ok(f.dry.cards.length >= 1, 'default on + key = cards');
  const g = fakeDeps(async () => { throw new Error('must not fetch'); }, { newsdata: { apiKey: null } });
  await runOnce(g.deps, { only: ['newsdata_market'] });
  assert.ok(g.lines.some((l) => /NEWSDATA_API_KEY not set/.test(l)));
});

test('repairMojibake undoes UTF-8 read as Windows-1252 and leaves clean text alone', async () => {
  const { repairMojibake } = await import('../src/sources/newsdata.ts');
  assert.equal(repairMojibake('McDonald\u2019s proposal sparks debate over Seattle\u2019s Chinatown\u00e2\u20ac\u2018International District'), 'McDonald\u2019s proposal sparks debate over Seattle\u2019s Chinatown\u2011International District');
  assert.equal(repairMojibake('Caf\u00c3\u00a9 chain posts record sales'), 'Caf\u00e9 chain posts record sales');
  assert.equal(repairMojibake('Fed holds rates; \u201cpatience\u201d urged'), 'Fed holds rates; \u201cpatience\u201d urged');
  assert.equal(repairMojibake('Plain headline'), 'Plain headline');
  assert.equal(repairMojibake('Odd \u00e2 letter alone'), 'Odd \u00e2 letter alone');
});

test('junk headlines (crime, fund-holding spam, head-to-head comparisons, advice explainers) are skipped as off_topic', async () => {
  const { config } = await import('../src/config.ts');
  const p = config.newsdata.offTopicPattern2;
  for (const t of ['Woman arrested for stealing 15 sovereigns of gold jewellery from cousin’s house', '30,112 RB Global, Inc. $RBA Shares Sold by Riverbridge Partners LLC',
    'iShares Core S&P 500 ETF $IVV Shares Purchased by Silver Grove Financial Group', 'Head to Head Comparison: Bayerische Motoren Werke (OTCMKTS:BAMXF) versus Ford Motor',
    'How Much Capital Gains Tax Does a 61-Year-Old Owe on $750,000 of Inherited Apple Stock']) assert.ok(p.test(t), t);
  for (const t of ['Thomson Reuters unveils $500 million share buyback plan', 'EasyJet shareholders approve £5.7 billion Apollo takeover', 'Fed holds rates steady as inflation cools',
    'Unilever/McCormick merger: UK regulator seeks remedies to allay competition fears']) assert.ok(!p.test(t), t);
});

// ---- D-296: AI summary from the publisher page --------------------------------------------------------------------
const articleParas = [
  'Federal Reserve officials left the benchmark interest rate unchanged on Wednesday, saying inflation has eased toward their target while hiring remains solid across most of the country.',
  'Chair remarks stressed that policymakers will watch incoming data on prices and wages before deciding whether any further change is warranted at upcoming meetings of the committee.',
  'Mortgage lenders and car dealers said borrowing costs for households are likely to stay near current levels for now, which keeps monthly payments for new loans roughly where they were.',
  'Economists surveyed ahead of the decision had expected no change, and bond markets barely moved after the statement was released to the public in the afternoon.',
];
const articleHtml = `<html><body><nav>Home</nav><article>${articleParas.map((p) => `<p>${p}</p>`).join('')}</article></body></html>`;
const DETAIL = {
  paragraphs: ['Policymakers said they will watch incoming price and wage data before deciding on any further change.', 'Lenders and car dealers expect borrowing costs for households to stay near current levels for now.'],
  key_points: ['Officials kept the benchmark rate unchanged on Wednesday', 'Inflation has eased toward the target', 'Bond markets barely moved after the statement'],
};
const summaryProvider = (calls: string[], over: Partial<{ body: string | null; detail: typeof DETAIL | null }> = {}) => ({
  name: 'gemini', usesAi: true as const, model: 'test-model',
  async summarize(i: { item: RawItem; text: string }) {
    calls.push(`${i.item.license_class}|${i.text.length}`);
    return {
      headline: 'Ignored AI headline', body: over.body === undefined ? 'The Federal Reserve left interest rates unchanged and said inflation has eased. Officials will wait for more data before changing course.' : over.body,
      category: 'economy', event_type: null, tickers: [], everyday_relevance: 4,
      detail: over.detail === undefined ? DETAIL : over.detail,
    };
  },
});
const pageFetch = (html: string): Deps['fetchText'] => async (u, kind) => {
  if (kind === 'api') return body;
  if (u.endsWith('/robots.txt')) throw new Error('HTTP 404');
  return html;
};

test('D-296: a publisher page gives a link_out card a full summary (body + key points); the headline stays verbatim; the source stays link_out', async () => {
  const calls: string[] = [];
  const f = fakeDeps(pageFetch(articleHtml), { ...on, providers: [summaryProvider(calls)] as never });
  f.dry.publisher.recentHeadlines = async () => f.dry.cards.map((c) => c.headline);
  await runOnce(f.deps, { only: ['newsdata_market'] });
  const fed = f.dry.cards.find((c) => /Fed holds rates/.test(c.headline))!;
  assert.ok(fed, f.lines.join(String.fromCharCode(10)));
  assert.equal(fed.kind, 'link_out');
  assert.equal(fed.headline, 'Fed holds rates steady as inflation cools to 2.9%');   // not the AI's headline
  assert.equal(fed.ai_generated, true);
  assert.match(fed.body ?? '', /interest rates unchanged/);
  assert.equal(fed.detail?.key_points.length, 3);
  assert.equal(fed.model, 'test-model');
  assert.equal(fed.sources[0].license_class, 'link_out');
  assert.equal(fed.attribution, 'via NewsData.io');
  assert.deepEqual(validatePublish(fed, { linkOutEnabled: true }).errors, []);
  assert.ok(calls.every((c) => c.startsWith('link_out_text|')));
  assert.ok(f.dry.items.every((i) => i.license_class === 'link_out' && i.summary_text === ''), 'page text is never stored');
});

test('D-296: no usable page, a rejected draft, or a draft without key points = nothing published, item closed as skipped', async () => {
  const stub = '<html><body><p>Subscribe to read.</p></body></html>';
  const cases: [string, Partial<{ body: string | null; detail: typeof DETAIL | null }>][] = [
    [stub, {}], [articleHtml, { body: 'Buy this stock now, it will double.' }], [articleHtml, { detail: null }],
  ];
  for (const [html, over] of cases) {
    const f = fakeDeps(pageFetch(html), { ...on, fetchText: pageFetch(html), providers: [summaryProvider([], over)] as never });
    const statuses: string[] = [];
    const set = f.dry.publisher.setItemStatus.bind(f.dry.publisher);
    f.dry.publisher.setItemStatus = async (i, st, n) => { statuses.push(`${st}:${n}`); return set(i, st, n); };
    await runOnce(f.deps, { only: ['newsdata_market'] });
    assert.equal(f.dry.cards.length, 0, JSON.stringify(over));
    assert.ok(statuses.length >= 1 && statuses.every((x) => x.startsWith('skipped:')), statuses.join());
  }
});

test('D-296: summaries off (config) or no AI provider = the source publishes nothing and never fetches a page', async () => {
  const fetched: string[] = [];
  const track: Deps['fetchText'] = async (u, kind) => { if (kind === 'publisher') fetched.push(u); return body; };
  const off = fakeDeps(track, { newsdata: { apiKey: KEY, enabled: true, summarize: false } });
  await runOnce(off.deps, { only: ['newsdata_market'] });
  const none = fakeDeps(track, { ...on, providers: [] });
  await runOnce(none.deps, { only: ['newsdata_market'] });
  assert.equal(off.dry.cards.length + none.dry.cards.length, 0);
  assert.equal(fetched.length, 0);
  assert.ok(none.lines.some((l) => /no AI summarizer available/.test(l)));
});

test('D-296: at most aiPerRun page fetches + AI calls per run; the rest are left for the next run (not recorded)', async () => {
  const calls: string[] = [];
  const f = fakeDeps(pageFetch(articleHtml), { ...on, providers: [summaryProvider(calls)] as never });
  const nd = config.newsdata as { aiPerRun: number };   // config is readonly in its type; the test changes it temporarily
  const saved = nd.aiPerRun;
  nd.aiPerRun = 1;
  try { await runOnce(f.deps, { only: ['newsdata_market'] }); } finally { nd.aiPerRun = saved; }
  assert.equal(calls.length, 1);
  assert.equal(f.dry.items.length, 1);
});
