// Companies in the app: parsing the RPC answers, grouping by sector (followed first), the
// "About: Apple" chips, the sample-mode company API (same rules as the SQL), request batching,
// and the Supabase request shapes. Also a guard against stray encoding characters in the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  aboutChips, cardCountText, companyCardsFirst, companyFilterScore, companyHref, companyResultLine, companyRowsFor, groupCompanies,
  normalizeCompanyTicker, parseCardCompanies, parseCompanyList, parseCompanyPage, parseCompanySummary, type CompanySummary,
} from '../companies/companyLogic.ts';
import { createMockCompanyApi, createSupabaseCompanyApi, SAMPLE_COMPANIES, tagSampleCards } from '../companies/companyApi.ts';
import { createTagBatcher } from '../companies/tagBatcher.ts';
import { parseFeedPage } from '../shared/types.ts';
import type { BlurbCard } from '../../contract/types.ts';
import { card } from './helpers.ts';

const root = new URL('../../', import.meta.url);
const fixtureCards = (): BlurbCard[] => {
  const seen = new Set<string>();
  const out: BlurbCard[] = [];
  for (const f of ['feed.page1.json', 'feed.page2.json']) {
    for (const c of parseFeedPage(JSON.parse(readFileSync(new URL(`contract/fixtures/${f}`, root), 'utf8'))).items) {
      if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
    }
  }
  return out;
};

const co = (over: Partial<CompanySummary> = {}): CompanySummary => ({
  ticker: 'AAPL', name: 'Apple Inc.', short_name: 'Apple', exchange: 'Nasdaq', sector: 'tech', industry: 'Consumer electronics', card_count: 3, days: 30, ...over,
});

test('normalizeCompanyTicker: route and query text to a directory ticker', () => {
  assert.equal(normalizeCompanyTicker(' aapl '), 'AAPL');
  assert.equal(normalizeCompanyTicker('$tsla'), 'TSLA');
  assert.equal(normalizeCompanyTicker('brk.b'), 'BRK-B');
  for (const bad of [null, 42, '', 'apple inc', 'TOOLONG', '../x']) assert.equal(normalizeCompanyTicker(bad), null, String(bad));
});

test('parsers drop bad rows and keep only the public fields', () => {
  assert.equal(parseCompanySummary({ ticker: 'bad ticker', name: 'X' }), null);
  assert.equal(parseCompanySummary({ ticker: 'AAPL' }), null);
  const c = parseCompanySummary({ ticker: 'aapl', name: 'Apple Inc.', short_name: 'Apple', sector: 'tech', industry: 'x', card_count: 12, days: 30, score: 1, match: 'ticker', price: 200 });
  assert.equal(c?.ticker, 'AAPL');
  assert.equal(c?.match, 'ticker');
  assert.equal((c as unknown as Record<string, unknown>).price, undefined, 'no prices');
  assert.equal(parseCompanySummary({ ticker: 'F', name: 'Ford', card_count: -3, match: 'weird' })?.card_count, 0);
  assert.deepEqual(parseCompanyList([{ ticker: 'F', name: 'Ford' }, { ticker: 'F', name: 'Dup' }, null, 'x']).map((x) => x.name), ['Ford']);
  assert.deepEqual(parseCompanyList({ not: 'a list' }), []);
  const page = parseCompanyPage({ company: { ticker: 'NWND', name: 'Northwind Corp' }, items: [card(), { id: 'broken' }], next_cursor: '' });
  assert.equal(page.company?.ticker, 'NWND');
  assert.equal(page.items.length, 1);
  assert.equal(page.next_cursor, null);
  assert.deepEqual(parseCompanyPage(null), { company: null, items: [], next_cursor: null });
  assert.deepEqual(parseCardCompanies([{ id: 'c1', companies: [{ ticker: 'AAPL', name: 'Apple Inc.', short_name: 'Apple', confidence: 0.8 }, { ticker: '', name: 'x' }] }, { id: 7 }]),
    { c1: [{ ticker: 'AAPL', name: 'Apple Inc.', short_name: 'Apple', confidence: 0.8 }] });
});

test('wording: counts, the search row and the company link', () => {
  assert.equal(cardCountText({ card_count: 12, days: 30 }), '12 cards in 30 days');
  assert.equal(cardCountText({ card_count: 1, days: 1 }), '1 card in 1 day');
  assert.equal(cardCountText({ card_count: 0, days: 30 }), 'No cards in 30 days');
  assert.equal(companyResultLine(co({ card_count: 12 })), 'Apple Inc. · AAPL · 12 cards');
  assert.equal(companyResultLine(co({ card_count: 0 })), 'Apple Inc. · AAPL · No recent cards');
  assert.equal(companyHref('BRK-B'), '/company/BRK-B');
});

test('groupCompanies: followed first, then sectors in screen order, most cards first, optional filters', () => {
  const list = [
    co({ ticker: 'AAPL', short_name: 'Apple', sector: 'tech', card_count: 3 }),
    co({ ticker: 'MSFT', short_name: 'Microsoft', name: 'Microsoft Corp.', sector: 'tech', card_count: 9 }),
    co({ ticker: 'F', short_name: 'Ford', name: 'Ford Motor Co.', sector: 'autos', card_count: 0, industry: 'Carmakers' }),
    co({ ticker: 'JPM', short_name: 'JPMorgan', name: 'JPMorgan Chase', sector: 'finance', card_count: 1 }),
  ];
  const g = groupCompanies(list, ['F']);
  assert.deepEqual(g.map((s) => s.key), ['following', 'tech', 'finance']);
  assert.deepEqual(g[0].companies.map((c) => c.ticker), ['F']);
  assert.deepEqual(g[1].companies.map((c) => c.ticker), ['MSFT', 'AAPL']);
  // only companies with cards, but a followed one always stays
  assert.deepEqual(groupCompanies(list, ['F'], { onlyWithCards: true }).flatMap((s) => s.companies.map((c) => c.ticker)), ['F', 'MSFT', 'AAPL', 'JPM']);
  assert.deepEqual(groupCompanies(list, [], { onlyWithCards: true }).flatMap((s) => s.companies.map((c) => c.ticker)), ['MSFT', 'AAPL', 'JPM']);
  // filter: ticker, name, typo, industry words
  assert.deepEqual(groupCompanies(list, [], { query: 'msft' }).flatMap((s) => s.companies.map((c) => c.ticker)), ['MSFT']);
  assert.deepEqual(groupCompanies(list, [], { query: 'mircosoft' }).flatMap((s) => s.companies.map((c) => c.ticker)), ['MSFT']);
  assert.deepEqual(groupCompanies(list, [], { query: 'carmak' }).flatMap((s) => s.companies.map((c) => c.ticker)), ['F']);
  assert.equal(companyFilterScore('zzzz', list[0]), 0);
});

test('aboutChips: server tags win, card tickers fill in until they load, at most two', () => {
  const c = card({ tickers: [{ symbol: 'NWND', name: 'Northwind Corp', exchange: 'Nasdaq', quote: null }] });
  assert.deepEqual(aboutChips(c, undefined).map((x) => x.label), ['About: Northwind Corp']);
  assert.deepEqual(aboutChips(c, [{ ticker: 'NWND', name: 'Northwind Corp', short_name: 'Northwind', confidence: 1 }]).map((x) => x.label), ['About: Northwind']);
  const three = [1, 2, 3].map((i) => ({ ticker: `T${'ABC'[i - 1]}`, name: `Co ${i}`, short_name: `Co ${i}`, confidence: 0.8 }));
  assert.equal(aboutChips(c, three).length, 2);
  assert.deepEqual(aboutChips(card({ tickers: [] }), []), []);
  assert.match(aboutChips(c, undefined)[0].a11y, /Opens the Northwind Corp page/);
});

test('search helpers: exact matches get the row, company cards go first without repeats', () => {
  const r = [co({ ticker: 'AAPL', match: 'name' }), co({ ticker: 'APLE', match: 'prefix' })];
  assert.deepEqual(companyRowsFor(r).map((c) => c.ticker), ['AAPL']);
  assert.deepEqual(companyRowsFor([co({ ticker: 'X', match: 'typo' })]).map((c) => c.ticker), ['X']);
  const a = card({ id: 'a' }), b = card({ id: 'b' }), d = card({ id: 'd' });
  assert.deepEqual(companyCardsFirst([b], [a, b, d]).map((c) => c.id), ['b', 'a', 'd']);
});

test('sample mode: tags fixture cards with the same matcher; Northwind Island is not Northwind Corp', () => {
  const cards = fixtureCards();
  const tags = tagSampleCards(cards);
  const island = cards.find((c) => /Northwind Island/.test(c.headline))!;
  assert.ok(island, 'fixture has the Northwind Island card');
  assert.deepEqual(tags.get(island.id), []);
  const nw = cards.find((c) => c.tickers.some((t) => t.symbol === 'NWND'))!;
  assert.equal(tags.get(nw.id)?.[0]?.ticker, 'NWND');
  // every fixture ticker is in the sample directory
  const dir = new Set(SAMPLE_COMPANIES.map((c) => c.ticker));
  for (const c of cards) for (const t of c.tickers) assert.ok(dir.has(t.symbol), t.symbol);
});

test('sample mode API: search order, company page paging, directory and tags', async () => {
  const cards = fixtureCards();
  const api = createMockCompanyApi(cards, () => Date.parse('2026-10-18T00:00:00Z'));
  const s = await api.search('adtb');
  assert.equal(s[0].ticker, 'ADTB');
  assert.equal(s[0].match, 'ticker');
  assert.equal((await api.search('woodgrov'))[0].ticker, 'WGFN');
  assert.equal((await api.search('Adatum Bnak'))[0]?.ticker, 'ADTB', 'typo');
  assert.deepEqual(await api.search(''), []);
  const p1 = await api.cards('ADTB', null, 1);
  assert.equal(p1.company?.ticker, 'ADTB');
  assert.equal(p1.items.length, 1);
  assert.ok(p1.next_cursor);
  const p2 = await api.cards('ADTB', p1.next_cursor, 1);
  assert.notEqual(p2.items[0].id, p1.items[0].id);
  assert.ok(Date.parse(p1.items[0].sort_at) >= Date.parse(p2.items[0].sort_at), 'newest first');
  assert.deepEqual(await api.cards('NOPE'), { company: null, items: [], next_cursor: null });
  const dir = await api.directory();
  assert.equal(dir.length, SAMPLE_COMPANIES.length);
  assert.ok(dir.find((c) => c.ticker === 'ADTB')!.card_count >= 2);
  const t = await api.tags([p1.items[0].id, 'unknown']);
  assert.deepEqual(Object.keys(t), [p1.items[0].id]);
});

test('tag batcher: one request per window, cached answers, failures cache empty', async () => {
  const calls: string[][] = [];
  const queue: (() => void)[] = [];
  const b = createTagBatcher(async (ids) => {
    calls.push(ids);
    if (ids.includes('boom')) throw new Error('network');
    return Object.fromEntries(ids.map((id) => [id, [{ ticker: 'AAPL', name: 'Apple Inc.', short_name: 'Apple', confidence: 1 }]]));
  }, { schedule: (fn) => queue.push(fn), maxIds: 2 });
  const got: Record<string, number> = {};
  for (const id of ['a', 'b', 'c']) b.request(id, (t) => { got[id] = t.length; });
  b.request('a', () => { got.a2 = 1; });
  assert.equal(queue.length, 1, 'one timer for the window');
  queue.shift()!();
  assert.deepEqual(calls, [['a', 'b']], 'capped at maxIds');
  queue.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [['a', 'b'], ['c']]);
  assert.deepEqual(got, { a: 1, b: 1, c: 1, a2: 1 });
  assert.equal(b.get('a')?.length, 1);
  b.request('a', () => undefined);
  assert.equal(queue.length, 0, 'cached: no new request');
  b.request('boom', (t) => { got.boom = t.length; });
  queue.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(got.boom, 0);
  assert.deepEqual(b.get('boom'), []);
});

test('Supabase company API: RPC names, bounded arguments, safe fallbacks, cards errors surface', async () => {
  const sent: [string, Record<string, unknown>][] = [];
  let fail = false;
  const api = createSupabaseCompanyApi(async (name, body) => {
    sent.push([name, body]);
    if (fail) throw new Error('HTTP 404');
    if (name === 'search_companies') return [{ ticker: 'AAPL', name: 'Apple Inc.', match: 'ticker', card_count: 2 }];
    if (name === 'company_cards') return { company: { ticker: 'AAPL', name: 'Apple Inc.' }, items: [card()], next_cursor: 'x|y' };
    if (name === 'card_companies') return [{ id: 'c1', companies: [{ ticker: 'AAPL', name: 'Apple Inc.', short_name: 'Apple', confidence: 1 }] }];
    return [];
  });
  assert.equal((await api.search('  aapl  ', 99))[0].ticker, 'AAPL');
  assert.deepEqual(sent[0], ['search_companies', { p_q: 'aapl', p_limit: 10 }]);
  assert.deepEqual(await api.search('   '), []);
  assert.equal(sent.length, 1, 'blank query sends nothing');
  const page = await api.cards('aapl', null, 500);
  assert.deepEqual(sent[1], ['company_cards', { p_ticker: 'AAPL', p_cursor: null, p_limit: 30 }]);
  assert.equal(page.next_cursor, 'x|y');
  assert.deepEqual(await api.cards('not a ticker'), { company: null, items: [], next_cursor: null });
  const ids = Array.from({ length: 80 }, (_, i) => `id${i}`);
  await api.tags([...ids, 'id1']);
  assert.equal((sent.at(-1)![1].p_ids as string[]).length, 50);
  fail = true;
  assert.deepEqual(await api.search('x'), []);
  assert.deepEqual(await api.directory(), []);
  // tags rejects so the batcher can expire the failure and ask again (P2-10)
  await assert.rejects(api.tags(['a']), /404/);
  await assert.rejects(api.cards('AAPL'), /404/);
});

test('tag batcher: a failed request expires after 60 s, then the ids are asked for again (P2-10)', async () => {
  let t = 1_000;
  let fail = true;
  const calls: string[][] = [];
  const queue: (() => void)[] = [];
  const b = createTagBatcher(async (ids) => {
    calls.push(ids);
    if (fail) throw new Error('network');
    return Object.fromEntries(ids.map((id) => [id, [{ ticker: 'AAPL', name: 'Apple Inc.', short_name: 'Apple', confidence: 1 }]]));
  }, { schedule: (fn) => queue.push(fn), now: () => t });
  b.request('x', () => undefined);
  queue.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(b.get('x'), [], 'failure answers no tags for now');
  t += 59_000;
  b.request('x', () => undefined);
  assert.equal(queue.length, 0, 'still inside the 60 s window: no new request');
  t += 1_000;
  assert.equal(b.get('x'), undefined, 'expired after 60 s');
  fail = false;
  let got = -1;
  b.request('x', (tags) => { got = tags.length; });
  queue.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(got, 1);
  assert.equal(calls.length, 2);
  t += 10 * 60_000;
  assert.equal(b.get('x')?.length, 1, 'successful answers never expire');
});

test('no stray encoding characters (Â·, â€) in app, component or library source', () => {
  const bad = /Â·|Â®|â€[™œ”“˜]|â€"/;
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(path); continue; }
      if (!/\.(tsx?|json)$/.test(name)) continue;
      if (bad.test(readFileSync(path, 'utf8'))) hits.push(path);
    }
  };
  for (const d of ['app', 'components', 'lib', 'contract']) walk(new URL(d, root).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.deepEqual(hits, []);
});

test('sample Following: a followed company brings cards that mention it, with a company note; capped at 100 tickers', async () => {
  const { createMockFeatureApi } = await import('../api/api.mockFeatures.ts');
  const cards = fixtureCards();
  const f = createMockFeatureApi(cards, [], []);
  const recall = cards.find((c) => /Contoso recalls/.test(c.headline))!;
  assert.ok(recall && recall.tickers.length === 0, 'fixture recall has no tickers of its own');
  const items = f.followingFeed({ topics: [], sources: [], tickers: ['ctse'], limit: 30 }).items;
  const hit = items.find((c) => c.id === recall.id);
  assert.equal(hit?.follow_match, 'company');
  assert.equal(hit?.follow_ticker, 'CTSE');
  assert.equal(hit?.follow_reason, 'Because you follow CTSE (mentions Contoso)');
  // the company's own-ticker card keeps the plain reason
  const own = items.find((c) => c.tickers.some((t) => t.symbol === 'CTSE'));
  assert.equal(own?.follow_reason, 'Because you follow CTSE');
  assert.equal(own?.follow_match, 'ticker');
  // Northwind Island is a place: following Northwind Corp does not make it a direct match
  const island = cards.find((c) => /Northwind Island/.test(c.headline))!;
  const nw = f.followingFeed({ topics: [], sources: [], tickers: ['NWND'], limit: 30 }).items.find((c) => c.id === island.id);
  assert.notEqual(nw?.follow_match, 'company');
  // only the first 100 followed tickers count
  const junk = Array.from({ length: 120 }, (_, i) => `Q${i}`);
  assert.equal(f.followingFeed({ topics: [], sources: [], tickers: [...junk, 'CTSE'], limit: 30 }).items.find((c) => c.id === recall.id)?.follow_match, undefined);
  assert.equal(f.followingFeed({ topics: [], sources: [], tickers: ['CTSE', ...junk], limit: 30 }).items.find((c) => c.id === recall.id)?.follow_match, 'company');
});
