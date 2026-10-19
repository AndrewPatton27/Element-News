// Signed-in "Brief by email" settings: tolerant parser, mock behaviour, and the Supabase calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFeatureApi } from '../api/api.mockFeatures.ts';
import { createSupabaseApi } from '../api/api.supabase.ts';
import { mySubscriptionTitle, parseMyBriefChange, parseMyBriefSubscriptions } from '../shared/types.ts';

const URL_ = 'https://example.supabase.co';

test('parser reads the migration shape and drops bad or cancelled rows', () => {
  const rows = parseMyBriefSubscriptions([
    { kind: 'daily', status: 'active', send_hour_local: 7, timezone: 'America/New_York', confirmed: true },
    { kind: 'weekly', status: 'pending', send_hour_local: 8, timezone: 'UTC', confirmed: false },
    { kind: 'both', status: 'active' },
    { kind: 'daily', status: 'unsubscribed' },
    'junk',
    null,
  ]);
  assert.deepEqual(rows, [
    { kind: 'daily', confirmed: true, hour: 7, tz: 'America/New_York' },
    { kind: 'weekly', confirmed: false, hour: 8, tz: 'UTC' },
  ]);
});

test('parser tolerates other field names and missing fields', () => {
  assert.deepEqual(parseMyBriefSubscriptions([{ kind: 'daily', status: 'active', send_time: '06:30:00', tz: 'Europe/Berlin' }]), [
    { kind: 'daily', confirmed: true, hour: 6, tz: 'Europe/Berlin' },
  ]);
  assert.deepEqual(parseMyBriefSubscriptions([{ kind: 'weekly' }]), [{ kind: 'weekly', confirmed: false, hour: null, tz: null }]);
  assert.deepEqual(parseMyBriefSubscriptions([{ kind: 'daily', send_hour: 99, confirmed: true }]), [{ kind: 'daily', confirmed: true, hour: null, tz: null }]);
  for (const bad of [null, undefined, {}, 'x', 5]) assert.deepEqual(parseMyBriefSubscriptions(bad), []);
});

test('change result parser', () => {
  assert.deepEqual(parseMyBriefChange({ ok: true, changed: true }), { ok: true, changed: true });
  assert.deepEqual(parseMyBriefChange({ ok: true, changed: false }), { ok: true, changed: false });
  assert.deepEqual(parseMyBriefChange({ ok: false, changed: false }), { ok: false, changed: false });
  assert.deepEqual(parseMyBriefChange(null), { ok: false, changed: false });
});

test('titles are plain', () => {
  assert.equal(mySubscriptionTitle('daily'), 'Daily brief');
  assert.match(mySubscriptionTitle('weekly'), /^Weekly brief/);
});

test('mock: list, change time (confirmed only), unsubscribe is idempotent', () => {
  const api = createMockFeatureApi([], [], []);
  assert.equal(api.mySubscriptions().length, 2);
  assert.deepEqual(api.updateMyTime('daily', 9, 'UTC'), { ok: true, changed: true });
  assert.equal(api.mySubscriptions().find((s) => s.kind === 'daily')?.hour, 9);
  assert.equal(api.updateMyTime('weekly', 9, 'UTC').ok, false); // still pending
  assert.equal(api.updateMyTime('daily', 24, 'UTC').ok, false);
  assert.deepEqual(api.unsubscribeMine('daily'), { ok: true, changed: true });
  assert.deepEqual(api.unsubscribeMine('daily'), { ok: true, changed: false });
  assert.equal(api.mySubscriptions().length, 1);
});

function fake(status: number, body: unknown, calls: { url: string; auth: string | null; body: string }[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization ?? null, body: String(init?.body ?? '') });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

test('supabase: sends the signed-in token and parses; a 404 means "not offered" (null)', async () => {
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const ok = createSupabaseApi({ url: URL_, key: 'k', getToken: async () => 'tok', fetchFn: fake(200, [{ kind: 'daily', status: 'active', send_hour_local: 7, timezone: 'UTC', confirmed: true }], calls) });
  assert.equal((await ok.mySubscriptions())?.length, 1);
  assert.match(calls[0].url, /rpc\/my_brief_subscriptions$/);
  assert.equal(calls[0].auth, 'Bearer tok');

  const missing = createSupabaseApi({ url: URL_, key: 'k', getToken: async () => 'tok', fetchFn: fake(404, { message: 'not found' }) });
  assert.equal(await missing.mySubscriptions(), null);
  assert.deepEqual(await missing.updateMyTime('daily', 8, 'UTC'), { ok: false, changed: false, status: 'unavailable' });
  assert.deepEqual(await missing.unsubscribeMine('daily'), { ok: false, changed: false, status: 'unavailable' });

  const signedOut = createSupabaseApi({ url: URL_, key: 'k', getToken: async () => null, fetchFn: fake(200, []) });
  assert.equal(await signedOut.mySubscriptions(), null);
});

test('supabase: unsubscribe and time change send the documented parameters', async () => {
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const api = createSupabaseApi({ url: URL_, key: 'k', getToken: async () => 'tok', fetchFn: fake(200, { ok: true, changed: true }, calls) });
  assert.deepEqual(await api.unsubscribeMine('weekly'), { ok: true, changed: true });
  assert.deepEqual(JSON.parse(calls[0].body), { p_kind: 'weekly' });
  assert.deepEqual(await api.updateMyTime('daily', 18, 'America/Chicago'), { ok: true, changed: true });
  assert.deepEqual(JSON.parse(calls[1].body), { p_kind: 'daily', p_send_hour: 18, p_timezone: 'America/Chicago' });
  assert.equal((await api.updateMyTime('daily', 30, 'UTC')).ok, false);
  assert.equal(calls.length, 2);
});
