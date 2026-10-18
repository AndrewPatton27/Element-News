import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createSupabaseApi } from '../api.supabase.ts';
import { AccountError, createSupabaseAccount, planRpc } from '../account.ts';
import { GENERIC_MESSAGE, NETWORK_MESSAGE, friendlyHttpError, isInvalidCursor, parseErrorBody, rawDetail, userMessage } from '../errors.ts';
import { memoryStore } from '../storage.ts';

const URL_ = 'https://abc123.supabase.co';
const KEY = 'sb_publishable_testkey123';
const NOW = 1_800_000_000;

const json = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

test('friendlyHttpError: statuses and PostgREST codes become short sentences', () => {
  assert.equal(friendlyHttpError(0), NETWORK_MESSAGE);
  assert.match(friendlyHttpError(400, 'invalid_cursor'), /feed changed/);
  assert.match(friendlyHttpError(400, 'unknown_card'), /no longer available/);
  assert.equal(friendlyHttpError(401, 'whatever'), 'Please sign in again.');
  assert.equal(friendlyHttpError(400, 'JWT expired', 'PGRST301'), 'Please sign in again.');
  assert.match(friendlyHttpError(403, 'permission denied for table x', '42501'), /do not have access/);
  assert.match(friendlyHttpError(404, null, 'PGRST202'), /not available yet/);
  assert.match(friendlyHttpError(404), /could not find/);
  assert.match(friendlyHttpError(429), /Too many requests/);
  assert.match(friendlyHttpError(504), /too long/);
  assert.match(friendlyHttpError(500, 'boom'), /server had a problem/);
  assert.match(friendlyHttpError(400, 'something odd'), /could not be completed/);
  assert.equal(friendlyHttpError(418), GENERIC_MESSAGE);
});

test('friendly messages never contain raw server text, status codes or words like "Server returned"', () => {
  const raws = ['invalid_cursor', 'unknown_card', 'permission denied for table core.blurbs', 'JWT expired', 'relation "x" does not exist', 'boom'];
  for (const status of [0, 400, 401, 403, 404, 408, 422, 429, 500, 502, 504, 418]) {
    for (const raw of raws) {
      const m = friendlyHttpError(status, raw, 'PGRST000');
      assert.ok(!/Server returned/i.test(m), m);
      assert.ok(!/\b\d{3}\b/.test(m), `no status code in: ${m}`);
      for (const bad of ['invalid_cursor', 'unknown_card', 'core.blurbs', 'relation', 'PGRST']) assert.ok(!m.includes(bad), `${bad} leaked in: ${m}`);
    }
  }
});

test('isInvalidCursor only for a 400 that names the cursor', () => {
  assert.equal(isInvalidCursor(400, 'invalid_cursor'), true);
  assert.equal(isInvalidCursor(400, 'HTTP 400: invalid_cursor'), true);
  assert.equal(isInvalidCursor(500, 'invalid_cursor'), false);
  assert.equal(isInvalidCursor(400, 'other'), false);
  assert.equal(isInvalidCursor(400, undefined), false);
});

test('parseErrorBody and userMessage tolerate any shape', () => {
  assert.deepEqual(parseErrorBody({ message: 'm', code: 'c' }), { message: 'm', code: 'c' });
  assert.deepEqual(parseErrorBody(null), { message: null, code: null });
  assert.deepEqual(parseErrorBody([1]), { message: null, code: null });
  assert.deepEqual(parseErrorBody({ message: 5, code: {} }), { message: null, code: null });
  assert.equal(userMessage(new ApiError('Friendly.', 500, 'raw')), 'Friendly.');
  assert.equal(userMessage(new AccountError('Friendly too.', 400)), 'Friendly too.');
  // A plain Error (parse failure, TypeError) must not leak its text.
  assert.equal(userMessage(new Error('Feed response has no items array.')), GENERIC_MESSAGE);
  assert.equal(userMessage(new TypeError('x is undefined'), 'Could not load numbers.'), 'Could not load numbers.');
  assert.equal(userMessage('weird'), GENERIC_MESSAGE);
});

test('feed API: a 400 invalid_cursor shows a friendly line; the raw text is only on .detail', async () => {
  const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: json(400, { message: 'invalid_cursor', code: 'P0001' }) });
  await assert.rejects(api.feed({ mode: 'top', cursor: 'bad' }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.ok(!/invalid_cursor|Server returned|400/.test(err.message), err.message);
    assert.match(rawDetail(err) ?? '', /invalid_cursor/);
    assert.ok(!(rawDetail(err) ?? '').includes(KEY));
    return true;
  });
  const down = createSupabaseApi({ url: URL_, key: KEY, fetchFn: json(503, 'not json at all') });
  await assert.rejects(down.categories(), (err: unknown) => err instanceof ApiError && err.status === 503 && /server had a problem/.test(err.message));
});

function accountWith(fetchFn: typeof fetch, expiresAt = NOW + 3600) {
  const store = memoryStore();
  store.set('element.session.v1', JSON.stringify({ access_token: 'acc-1', refresh_token: 'ref-1', expires_at: expiresAt, user: { id: 'u1', email: 'a@b.co' } }));
  return createSupabaseAccount({ url: URL_, key: KEY, fetchFn, store, now: () => NOW });
}

test('account RPC errors are friendly; delete_account has its own wording', async () => {
  const feed = accountWith(json(400, { message: 'invalid_cursor' }));
  await assert.rejects(feed.feedForYou('bad'), (e: unknown) => e instanceof AccountError && !/invalid_cursor|Server returned/.test(e.message) && /feed changed/.test(e.message));
  const del = accountWith(json(403, { message: 'permission denied for table users', code: '42501' }));
  await assert.rejects(del.deleteAccount(), (e: unknown) => e instanceof AccountError && /could not delete the account/.test(e.message) && !/permission denied/.test(e.message));
  const down = accountWith((async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch);
  await assert.rejects(down.getPrefs(), (e: unknown) => e instanceof AccountError && e.status === 0 && e.message === NETWORK_MESSAGE);
});

test('planRpc: same headers as a normal call; keepalive only when asked', () => {
  const normal = planRpc(URL_, KEY, 'tok', 'track', { p_blurb: 'c1' });
  assert.equal(normal.url, `${URL_}/rest/v1/rpc/track`);
  assert.equal(normal.init.headers.Authorization, 'Bearer tok');
  assert.equal(normal.init.headers['Content-Profile'], 'api');
  assert.equal('keepalive' in normal.init, false);
  const exit = planRpc(URL_, KEY, 'tok', 'track', { p_blurb: 'c1' }, true);
  assert.equal(exit.init.keepalive, true);
  assert.equal(exit.init.headers.Authorization, 'Bearer tok');
});

test('trackDwellOnExit sends the dwell with keepalive and the auth header, and never refreshes or throws', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const acct = accountWith(fn);
  acct.trackDwellOnExit('c1', 4200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${URL_}/rest/v1/rpc/track`);
  assert.equal(calls[0].init.keepalive, true);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer acc-1');
  assert.equal((calls[0].init.headers as Record<string, string>).apikey, KEY);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { p_blurb: 'c1', p_kind: 'dwell', p_ms: 4200 });

  // expired token: no request (a refresh cannot finish while the page unloads)
  calls.length = 0;
  accountWith(fn, NOW - 5).trackDwellOnExit('c1', 4200);
  assert.equal(calls.length, 0);

  // a rejecting or throwing fetch never surfaces
  const bad = accountWith((() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch);
  assert.doesNotThrow(() => bad.trackDwellOnExit('c1', 500));
  const throwing = accountWith((() => {
    throw new TypeError('sync');
  }) as unknown as typeof fetch);
  assert.doesNotThrow(() => throwing.trackDwellOnExit('c1', 500));
  await new Promise((r) => setTimeout(r, 0));
});

test('trackDwellOnExit does nothing when signed out', () => {
  const calls: unknown[] = [];
  const acct = createSupabaseAccount({ url: URL_, key: KEY, fetchFn: (async (...a: unknown[]) => void calls.push(a)) as unknown as typeof fetch, store: memoryStore(), now: () => NOW });
  acct.trackDwellOnExit('c1', 1000);
  assert.equal(calls.length, 0);
});
