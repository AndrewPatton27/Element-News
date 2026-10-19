import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDryRunPublisher, createSupabasePublisher } from '../src/publish.ts';
import { main, mlPurgeSafely } from '../src/main.ts';
import type { FetchLike } from '../src/allowlist.ts';

test('Supabase publisher calls api.ml_purge with an empty body', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ pages: 2, events: 0, runs: 1, db_mb: 41.2, stopped: false }), { status: 200 });
  };
  const pub = createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'sb_secret_test_not_real', fetchImpl: impl });
  const r = await pub.mlPurge!();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://abcd1234.supabase.co/rest/v1/rpc/ml_purge');
  assert.deepEqual(calls[0].body, {});
  assert.deepEqual(r, { pages: 2, events: 0, runs: 1, db_mb: 41.2, stopped: false });
});

test('mlPurgeSafely logs the result and warns when the storage stop rule fired', async () => {
  const lines: string[] = [];
  const impl: FetchLike = async () => new Response(JSON.stringify({ pages: 0, stopped: true }), { status: 200 });
  await mlPurgeSafely(createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'k', fetchImpl: impl }), (s) => lines.push(s));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^ml purge: /);
  assert.match(lines[1], /^warning: database over ml_db_stop_mb/);
});

test('mlPurgeSafely never fails the run (e.g. RPC missing before the migration)', async () => {
  const impl: FetchLike = async () => new Response(JSON.stringify({ message: 'Could not find the function api.ml_purge' }), { status: 404 });
  const lines: string[] = [];
  await mlPurgeSafely(createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'k', fetchImpl: impl }), (s) => lines.push(s));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^warning: ml purge failed .*404/);
});

test('a publisher without mlPurge is skipped silently', async () => {
  const lines: string[] = [];
  const { mlPurge: _drop, ...rest } = createDryRunPublisher().publisher;
  await mlPurgeSafely(rest, (s) => lines.push(s));
  assert.equal(lines.length, 0);
});

test('a dry run ends with exactly one purge call after the Trending refresh', async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (s: unknown) => { lines.push(String(s)); };
  try { assert.equal(await main(['--dry-run']), 0); } finally { console.log = orig; }
  const iTrend = lines.findIndex((l) => l.startsWith('trending refreshed: '));
  const iPurge = lines.findIndex((l) => l.startsWith('ml purge: '));
  assert.ok(iTrend >= 0 && iPurge > iTrend, 'purge runs after the trending refresh');
  assert.equal(lines.filter((l) => l.startsWith('ml purge: ')).length, 1);
});
