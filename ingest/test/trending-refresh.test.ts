import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDryRunPublisher, createSupabasePublisher } from '../src/publish.ts';
import { refreshTrendingSafely } from '../src/main.ts';
import type { FetchLike } from '../src/allowlist.ts';

test('Supabase publisher calls api.refresh_trending with an empty body', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ generation: 7, boosted: 3, top_boost: 4.03 }), { status: 200 });
  };
  const pub = createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'sb_secret_test_not_real', fetchImpl: impl });
  const r = await pub.refreshTrending!();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://abcd1234.supabase.co/rest/v1/rpc/refresh_trending');
  assert.deepEqual(calls[0].body, {});
  assert.deepEqual(r, { generation: 7, boosted: 3, top_boost: 4.03 });
});

test('refreshTrendingSafely logs the result', async () => {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  await refreshTrendingSafely(dry.publisher, (s) => lines.push(s));
  assert.equal(dry.trending.refreshes, 1);
  assert.match(lines[0], /^trending refreshed: /);
});

test('refreshTrendingSafely never fails the run (e.g. RPC missing before the migration)', async () => {
  const impl: FetchLike = async () => new Response(JSON.stringify({ message: 'Could not find the function api.refresh_trending' }), { status: 404 });
  const pub = createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'k', fetchImpl: impl });
  const lines: string[] = [];
  await refreshTrendingSafely(pub, (s) => lines.push(s));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^warning: trending refresh failed .*404/);
});

test('a publisher without refreshTrending is skipped silently', async () => {
  const lines: string[] = [];
  const { refreshTrending: _drop, ...rest } = createDryRunPublisher().publisher;
  await refreshTrendingSafely(rest, (s) => lines.push(s));
  assert.equal(lines.length, 0);
});
