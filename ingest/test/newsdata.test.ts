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
import { dedupeArticles, isNearDuplicate, NEWSDATA_PARAMS, newsdataPayload, newsdataToItem, newsdataUrl, parseNewsdata, redactKey, relevanceScore, type NewsdataArticle } from '../src/sources/newsdata.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import type { RawItem } from '../src/types.ts';
import { checkLinkOut, SUMMARIZABLE, validatePublish } from '../src/validate.ts';

const body = readFileSync(new URL('./fixtures/newsdata-market.json', import.meta.url), 'utf8');
const NOW = new Date('2026-11-11T08:00:00Z');
const KEY = 'pub_SECRETKEY123456';

function fakeDeps(fetchText: Deps['fetchText'], over: Partial<Deps> = {}) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = { fetchText, publisher: dry.publisher, providers: [], counter: memoryCounter(), fredApiKey: null, now: NOW, log: (l) => lines.push(l), ...over };
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
  assert.equal(config.newsdata.dailyCreditCap, 195);
  assert.ok((SOURCE_NAMES as readonly string[]).includes('newsdata_topic'));
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

test('payload is link_out: no body, no detail, not AI, one link_out source with the credit', () => {
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
  assert.deepEqual(validatePublish(p, { linkOutEnabled: true }).errors, []);
  assert.ok(!JSON.stringify(p).includes('SECRET'));
  assert.ok(!/image|description/i.test(Object.keys(p).join(',')));
});

test('validatePublish: link_out refused when the flag is off, from another origin, with a body, long headline or wrong credit', () => {
  const p = newsdataPayload(firstItem());
  assert.match(validatePublish(p).errors.join(), /disabled in this build/);
  assert.match(validatePublish(p, { linkOutEnabled: false }).errors.join(), /disabled/);
  assert.match(validatePublish({ ...p, origin: 'cpsc' }, { linkOutEnabled: true }).errors.join(), /only allowed from the newsdata source/);
  assert.match(validatePublish({ ...p, origin: undefined }, { linkOutEnabled: true }).errors.join(), /only allowed from the newsdata source/);
  assert.match(validatePublish({ ...p, body: 'A description.' }, { linkOutEnabled: true }).errors.join(), /no body or description/);
  assert.match(validatePublish({ ...p, headline: 'x'.repeat(201) }, { linkOutEnabled: true }).errors.join(), /longer than 200/);
  assert.match(validatePublish({ ...p, attribution: null }, { linkOutEnabled: true }).errors.join(), /via NewsData\.io/);
  assert.match(validatePublish({ ...p, ai_generated: true }, { linkOutEnabled: true }).errors.join(), /never AI/);
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
    assert.equal(c.body, null);
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
  assert.ok(f.lines.some((l) => /daily credit cap 195 reached/.test(l)));
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

test('credit pacing: at 95% of the daily cap the extra topic queries pause (no request, no credit), core queries keep going', async () => {
  const counter = memoryCounter();
  const stop = Math.floor(config.newsdata.dailyCreditCap * config.newsdata.extraPauseFraction);
  for (let i = 0; i < stop; i++) counter.add('newsdata');
  let calls = 0;
  const f = fakeDeps(async () => { calls++; return body; }, { ...on, counter });
  await runOnce(f.deps, { only: ['newsdata_topic'], newsdataQuery: 'fed_rates' });
  assert.equal(calls, 0);
  assert.equal(counter.used('newsdata'), stop);
  assert.ok(f.lines.some((l) => /extra queries paused/.test(l)));
  await runOnce(f.deps, { only: ['newsdata_market'] });
  await runOnce(f.deps, { only: ['newsdata_latest'] });
  await runOnce(f.deps, { only: ['newsdata_topic'], newsdataQuery: 'trusted' });
  assert.equal(calls, 3);
});

// ---- query set (config.newsdata.queries) ----
const q = config.newsdata.queries;

// Fires per day of a cron like "4,34 0-9,22-23 * * *" (minute and hour lists/ranges only; day, month, weekday are *).
function firesPerDay(cron: string): number {
  const [min, hour, dom, mon, dow] = cron.split(' ');
  assert.deepEqual([dom, mon, dow], ['*', '*', '*'], cron);
  const count = (field: string) => field.split(',').reduce((n, part) => {
    const m = /^(\d+)-(\d+)$/.exec(part);
    return n + (m ? Number(m[2]) - Number(m[1]) + 1 : 1);
  }, 0);
  return count(min) * count(hour);
}

test('query set: ids unique, credits match each cron, total under the cap and the free plan, free-plan params only', () => {
  assert.equal(new Set(q.map((x) => x.id)).size, q.length);
  assert.ok(q.some((x) => x.id === 'market') && q.some((x) => x.id === 'business'));
  let total = 0;
  for (const x of q) {
    assert.equal(firesPerDay(x.cron), x.creditsPerDay, `${x.id}: creditsPerDay must equal the cron fires per day`);
    total += x.creditsPerDay;
    for (const [k, v] of Object.entries(x.params)) {
      assert.ok((NEWSDATA_PARAMS as readonly string[]).includes(k), `${x.id}: ${k}`);
      if (k === 'qInTitle') assert.ok(v.length <= 100, `${x.id}: free plan keyword limit is 100 characters (${v.length})`);
      if (k === 'domainurl' || k === 'category' || k === 'country') assert.ok(v.split(',').length <= 5, `${x.id}: at most 5 values`);
    }
    assert.ok(!('q' in x.params) && !('qInMeta' in x.params), 'q cannot be combined with qInTitle');
    assert.ok(x.endpoint === 'latest' || !Object.keys(x.params).some((k) => k === 'qInTitle'), 'market queries carry no keyword');
  }
  assert.equal(total, 180);
  assert.ok(total <= config.newsdata.dailyCreditCap && config.newsdata.dailyCreditCap <= 195, 'cap leaves at least 5 of the 200 credits spare');
  const core = q.filter((x) => x.tier === 'core').reduce((n, x) => n + x.creditsPerDay, 0);
  assert.ok(core <= Math.floor(config.newsdata.dailyCreditCap * config.newsdata.extraPauseFraction), 'core queries fit under the extras pause line');
  // distinct (minute, hour) slots so the NewsData 30 requests / 15 min limit is never approached
  const minutes = q.flatMap((x) => x.cron.split(' ')[0].split(','));
  assert.equal(new Set(minutes).size, minutes.length, 'no two query jobs share a minute');
});

test('request URL: configured params, free-plan only, key only in apikey', () => {
  const u = new URL(newsdataUrl(q.find((x) => x.id === 'fed_rates')!, KEY));
  assert.equal(u.origin + u.pathname, 'https://newsdata.io/api/1/latest');
  assert.equal(u.searchParams.get('size'), '10');
  assert.equal(u.searchParams.get('removeduplicate'), '1');
  assert.match(u.searchParams.get('qInTitle')!, /"Federal Reserve"/);
  assert.equal(u.searchParams.get('q'), null);
  assert.equal(u.searchParams.get('image'), null);
  const t = new URL(newsdataUrl(q.find((x) => x.id === 'trusted')!, KEY));
  assert.match(t.searchParams.get('domainurl')!, /reuters\.com/);
  assert.equal(new URL(newsdataUrl('market', KEY)).pathname, '/api/1/market');
  assert.equal(new URL(newsdataUrl('latest', KEY)).searchParams.get('category'), 'business');
  assert.throws(() => newsdataUrl({ ...q[0], params: { timeframe: '6' } }, KEY), /not allowed/);
  assert.throws(() => newsdataUrl({ ...q[0], params: { full_content: '1' } }, KEY), /not allowed/);
});

test('dedupe across articles: same article_id or same URL (query string, www, trailing slash ignored) appears once', () => {
  const a = (id: string, link: string, title = 'Fed holds rates'): NewsdataArticle => ({ article_id: id, title, link, pubDate: '2026-11-10 20:00:00', source_name: 'E', symbols: [] });
  const list = [
    a('1', 'https://www.example.com/fed/'), a('1', 'https://other.com/x'), a('2', 'https://example.com/fed?utm_source=x'), a('3', 'https://example.com/oil'),
  ];
  assert.deepEqual(dedupeArticles(list).map((x) => x.article_id), ['1', '3']);
  const seen = { ids: new Set<string>(), urls: new Set<string>() };
  assert.equal(dedupeArticles([a('1', 'https://example.com/fed')], seen).length, 1);
  assert.equal(dedupeArticles([a('9', 'https://example.com/fed')], seen).length, 0, 'same URL from a second query');
  assert.equal(dedupeArticles([a('1', 'https://example.com/z')], seen).length, 0, 'same article_id from a second query');
  const r = newsdataToItem({ ...a('5', 'https://example.com/stocks?utm_source=tw&id=7#top', 'Stocks rally as Fed holds'), pubDate: '2026-11-10 20:00:00' }, NOW) as { item: RawItem };
  assert.equal(r.item.url, 'https://example.com/stocks?id=7', 'tracking parameters and fragment removed, other parameters kept');
});

test('a topic query runs through newsdata_topic: its own params, one credit, dedupe against another query', async () => {
  const urls: string[] = [];
  const counter = memoryCounter();
  const f = fakeDeps(async (u) => { urls.push(u); return body; }, { ...on, counter });
  f.dry.publisher.recentHeadlines = async () => f.dry.cards.map((c) => c.headline);
  await runOnce(f.deps, { only: ['newsdata_topic'], newsdataQuery: 'inflation' });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /qInTitle=/);
  assert.equal(counter.used('newsdata'), 1);
  const first = f.dry.cards.length;
  assert.ok(first >= 1);
  await runOnce(f.deps, { only: ['newsdata_topic'], newsdataQuery: 'fed_rates' });   // same articles again from another query
  assert.equal(counter.used('newsdata'), 2);
  assert.equal(f.dry.cards.length, first, 'no duplicate cards');
  assert.ok(f.dry.cards.every((c) => c.kind === 'link_out' && c.attribution === 'via NewsData.io' && c.body === null));
  assert.ok(!JSON.stringify([f.dry.cards, f.lines]).includes(KEY));
});

test('a topic run with a missing or unknown query id makes no request and spends no credit', async () => {
  const counter = memoryCounter();
  const f = fakeDeps(async () => { throw new Error('must not fetch'); }, { ...on, counter });
  await runOnce(f.deps, { only: ['newsdata_topic'] });
  await runOnce(f.deps, { only: ['newsdata_topic'], newsdataQuery: 'nope' });
  assert.equal(counter.used('newsdata'), 0);
  assert.equal(f.lines.filter((l) => /unknown or missing query id/.test(l)).length, 2);
});

test('hard guard: a taker that always says yes still cannot push the counter past the cap', async () => {
  const counter = memoryCounter();
  for (let i = 0; i < config.newsdata.dailyCreditCap; i++) counter.add('newsdata');
  let calls = 0;
  const f = fakeDeps(async () => { calls++; return body; }, { newsdata: { apiKey: KEY, enabled: true, takeCredit: async () => true }, counter });
  for (const id of ['market', 'business', 'trusted', 'stocks']) {
    await runOnce(f.deps, { only: id === 'market' ? ['newsdata_market'] : ['newsdata_topic'], newsdataQuery: id });
  }
  assert.equal(calls, 0);
});

test('every credit is counted: a full day of cron fires stays inside the cap', async () => {
  const counter = memoryCounter();
  let calls = 0;
  const f = fakeDeps(async () => { calls++; return JSON.stringify({ status: 'success', results: [] }); }, { ...on, counter });
  // fire every configured query twice as often as scheduled: the cap, not the schedule, is the limit
  for (const x of q) {
    for (let i = 0; i < x.creditsPerDay * 2; i++) await runOnce(f.deps, x.id === 'market' ? { only: ['newsdata_market'] } : { only: ['newsdata_topic'], newsdataQuery: x.id });
  }
  assert.ok(counter.used('newsdata') <= config.newsdata.dailyCreditCap);
  assert.equal(calls, counter.used('newsdata'), 'one request per counted credit');
});

test('default on: deps.newsdata.enabled unset follows the code default, but no key still means no request', async () => {
  const f = fakeDeps(async () => body, { newsdata: { apiKey: KEY } });
  await runOnce(f.deps, { only: ['newsdata_market'] });
  assert.ok(f.dry.cards.length >= 1, 'default on + key = cards');
  const g = fakeDeps(async () => { throw new Error('must not fetch'); }, { newsdata: { apiKey: null } });
  await runOnce(g.deps, { only: ['newsdata_market'] });
  assert.ok(g.lines.some((l) => /NEWSDATA_API_KEY not set/.test(l)));
});
