import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeedStatus } from '../shared/types.ts';
import { delayedBannerText } from '../status/statusLogic.ts';
import { mockFeedStatus } from '../api/mockStatus.ts';
import { createSupabaseApi } from '../api/api.supabase.ts';

const NOW = new Date('2026-11-08T12:00:00Z');

test('banner text: only when delayed, with the last-updated time when known', () => {
  assert.equal(delayedBannerText(null, NOW), null);
  assert.equal(delayedBannerText({ delayed: false, last_updated: '2026-11-08T11:00:00Z' }, NOW), null);
  assert.equal(delayedBannerText({ delayed: true, last_updated: '2026-11-08T07:00:00Z' }, NOW), 'Updates delayed · last updated 5 h ago');
  assert.equal(delayedBannerText({ delayed: true, last_updated: null }, NOW), 'Updates delayed');
  assert.equal(delayedBannerText({ delayed: true, last_updated: 'garbage' }, NOW), 'Updates delayed');
});

test('parseFeedStatus accepts an object or a one-row list and never throws', () => {
  assert.deepEqual(parseFeedStatus({ delayed: true, last_updated: '2026-11-08T07:00:00Z' }), { delayed: true, last_updated: '2026-11-08T07:00:00Z' });
  assert.deepEqual(parseFeedStatus([{ is_delayed: true, updated_at: '2026-11-08T07:00:00Z' }]), { delayed: true, last_updated: '2026-11-08T07:00:00Z' });
  assert.deepEqual(parseFeedStatus({ delayed: 'yes' }), { delayed: false, last_updated: null });
  for (const bad of [null, undefined, 3, 'x', [], {}]) assert.deepEqual(parseFeedStatus(bad), { delayed: false, last_updated: null });
});

test('mock feed_status: fresh by default, delayed with ?mock_delayed=1', () => {
  assert.equal(mockFeedStatus('', NOW.getTime()).delayed, false);
  assert.equal(mockFeedStatus(null, NOW.getTime()).delayed, false);
  const d = mockFeedStatus('?tab=latest&mock_delayed=1', NOW.getTime());
  assert.equal(d.delayed, true);
  assert.equal(delayedBannerText(d, NOW), 'Updates delayed · last updated 5 h ago');
});

test('supabase feedStatus tolerates a missing RPC and parses a real answer', async () => {
  const mk = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const url = 'https://abc123.supabase.co';
  const key = 'sb_publishable_testkey123';
  const missing = createSupabaseApi({ url, key, fetchFn: mk(404, { message: 'Could not find the function api.feed_status' }) as typeof fetch });
  assert.deepEqual(await missing.feedStatus(), { delayed: false, last_updated: null });
  const down = createSupabaseApi({ url, key, fetchFn: (async () => { throw new Error('offline'); }) as typeof fetch });
  assert.deepEqual(await down.feedStatus(), { delayed: false, last_updated: null });
  const ok = createSupabaseApi({ url, key, fetchFn: mk(200, { delayed: true, last_updated: '2026-11-08T07:00:00Z' }) as typeof fetch });
  assert.equal((await ok.feedStatus()).delayed, true);
});
