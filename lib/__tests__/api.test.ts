import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiConfig } from '../config.ts';
import { ApiError, createSupabaseApi, planRequest } from '../api.supabase.ts';
import { card, config } from './helpers.ts';
import { createMockFeatureApi } from '../api.mockFeatures.ts';

const URL_ = 'https://abc123.supabase.co';
const KEY = 'sb_publishable_testkey123';

test('config: mock is the default; supabase needs URL and key', () => {
  assert.deepEqual(resolveApiConfig({}), { ok: true, mode: 'mock' });
  assert.deepEqual(resolveApiConfig({ EXPO_PUBLIC_API_MODE: 'mock' }), { ok: true, mode: 'mock' });
  const missing = resolveApiConfig({ EXPO_PUBLIC_API_MODE: 'supabase' });
  assert.equal(missing.ok, false);
  const placeholder = resolveApiConfig({
    EXPO_PUBLIC_API_MODE: 'supabase',
    EXPO_PUBLIC_SUPABASE_URL: 'https://your-project.supabase.co',
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: KEY,
  });
  assert.equal(placeholder.ok, false);
  const good = resolveApiConfig({
    EXPO_PUBLIC_API_MODE: 'supabase',
    EXPO_PUBLIC_SUPABASE_URL: URL_ + '/',
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: KEY,
  });
  assert.deepEqual(good, { ok: true, mode: 'supabase', url: URL_, key: KEY });
  assert.equal(resolveApiConfig({ EXPO_PUBLIC_API_MODE: 'live' }).ok, false);
});

test('config: a secret key is refused', () => {
  const r = resolveApiConfig({
    EXPO_PUBLIC_API_MODE: 'supabase',
    EXPO_PUBLIC_SUPABASE_URL: URL_,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc',
  });
  assert.equal(r.ok, false);
});

test('feed request targets the api schema with a clamped limit', () => {
  const p = planRequest(URL_, KEY, 'feed', { mode: 'latest', limit: 99, category: 'tech' });
  assert.equal(p.url, `${URL_}/rest/v1/rpc/feed`);
  assert.equal(p.init.method, 'POST');
  assert.equal(p.init.headers['Content-Profile'], 'api');
  assert.equal(p.init.headers['Accept-Profile'], 'api');
  assert.equal(p.init.headers.apikey, KEY);
  assert.deepEqual(JSON.parse(p.init.body as string), { p_mode: 'latest', p_cursor: null, p_limit: 30, p_category: 'tech' });
});

test('reads use GET with Accept-Profile api', () => {
  for (const [op, path] of [
    ['config', '/rest/v1/app_config?'],
    ['categories', '/rest/v1/categories?'],
    ['numbers', '/rest/v1/numbers_to_know?'],
  ] as const) {
    const p = planRequest(URL_, KEY, op);
    assert.equal(p.init.method, 'GET');
    assert.ok(p.url.startsWith(URL_ + path), p.url);
    assert.equal(p.init.headers['Accept-Profile'], 'api');
  }
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

test('supabase api parses responses through the guards', async () => {
  const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(200, { items: [card(), { id: 'bad' }], next_cursor: 'abc' }) });
  const page = await api.feed({ mode: 'top' });
  assert.equal(page.items.length, 1);
  assert.equal(page.next_cursor, 'abc');
  assert.equal(api.sample, false);
  const cfgApi = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(200, [config()]) });
  assert.equal((await cfgApi.appConfig()).disclaimer, 'Informational only · Not investment advice');
});

test('errors carry status and never the key', async () => {
  const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(401, { message: 'Invalid API key' }) });
  await assert.rejects(api.feed({ mode: 'top' }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 401);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
  const down = createSupabaseApi({
    url: URL_,
    key: KEY,
    fetchFn: (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
  });
  await assert.rejects(down.categories(), (err: unknown) => err instanceof ApiError && err.status === 0);
});

const TREND = { key: 'DGS10', name: '10-year Treasury yield', value: '5.10%', change: '▼ 0.09 this week', direction: 'down', source: 'U.S. Treasury', points: [4.9, 5.1] };

test('side column requests are RPC calls in the api schema', () => {
  for (const op of ['top_stories', 'number_trends'] as const) {
    const p = planRequest(URL_, KEY, op);
    assert.equal(p.url, `${URL_}/rest/v1/rpc/${op}`);
    assert.equal(p.init.method, 'POST');
    assert.equal(p.init.headers['Content-Profile'], 'api');
    assert.equal(p.init.body, '{}');
  }
});

test('search and following requests send the documented RPC parameters', () => {
  const search = planRequest(URL_, KEY, 'search', { mode: 'top', q: 'AAPL', cursor: 'next', limit: 12 });
  assert.equal(search.url, `${URL_}/rest/v1/rpc/search`);
  assert.deepEqual(JSON.parse(search.init.body as string), { p_q: 'AAPL', p_cursor: 'next', p_limit: 12 });
  const following = planRequest(URL_, KEY, 'following_feed', { mode: 'top', topics: ['Fed'], sources: ['SEC'], tickers: ['AAPL'], cursor: null, limit: 15 });
  assert.deepEqual(JSON.parse(following.init.body as string), { p_topics: ['Fed'], p_sources: ['SEC'], p_tickers: ['AAPL'], p_cursor: null, p_limit: 15 });
});

test('topStories and numberTrends parse good rows and skip bad ones', async () => {
  const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(200, [card(), { id: 'bad' }]) });
  assert.equal((await api.topStories()).length, 1);
  const many = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(200, Array.from({ length: 8 }, () => card())) });
  assert.equal((await many.topStories()).length, 5);
  const tr = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(200, [TREND, { key: 'x' }, { ...TREND, points: Array.from({ length: 15 }, (_, i) => i) }]) });
  const got = await tr.numberTrends();
  assert.equal(got.length, 2);
  assert.equal(got[1]!.points.length, 12);
});

test('new mock endpoints provide searchable, related, following and brief data', async () => {
  const api = createMockFeatureApi([card(), card({ id: 'c2', headline: '[SAMPLE] Northwind raises outlook', category: 'markets' }), card({ id: 'c3', headline: '[SAMPLE] Another company beats estimates', category: 'earnings' })], [], []);
  assert.equal((await api.search('Northwind')).items.length, 3);
  assert.deepEqual(await api.search('x'), { items: [], next_cursor: null });
  assert.ok((await api.relatedCards('c1')).every((c) => c.id !== 'c1'));
  const followed = await api.followingFeed({ topics: ['earnings'], sources: [], tickers: [] });
  assert.ok(followed.items.length > 0);
  assert.ok(followed.items[0]?.follow_reason);
  assert.ok((await api.followingFeed({ topics: [], sources: [], tickers: [] })).items.length > 0);
  const daily = await api.dailyBrief();
  assert.ok([48, 72].includes(daily.window_hours), 'thin supply widens the daily window');
  assert.ok(daily.headline_cards.length > 0);
  assert.equal(new Set(daily.headline_cards.map((c) => c.category)).size, daily.headline_cards.length, 'brief headlines cover different topics');
  assert.equal((await api.weeklyBrief()).window_hours, 168);
});

test('missing optional brief/search RPCs return empty values without throwing', async () => {
  const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(404, { message: 'Could not find the function' }) });
  assert.deepEqual(await api.search('Fed'), { items: [], next_cursor: null });
  assert.deepEqual(await api.relatedCards('missing'), []);
  assert.deepEqual(await api.followingFeed({ topics: [], sources: [], tickers: [] }), { items: [], next_cursor: null });
  assert.deepEqual((await api.dailyBrief()).headline_cards, []);
  assert.deepEqual((await api.weeklyBrief()).movers, []);
});

test('topStories and numberTrends return [] on a missing RPC, an error or a network failure', async () => {
  for (const f of [
    fakeFetch(404, { code: 'PGRST202', message: 'Could not find the function' }),
    fakeFetch(500, { message: 'boom' }),
    fakeFetch(200, { not: 'a list' }),
    (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
  ]) {
    const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: f });
    assert.deepEqual(await api.topStories(), []);
    assert.deepEqual(await api.numberTrends(), []);
  }
});
