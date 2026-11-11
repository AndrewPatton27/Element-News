import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuItems } from '../feed/cardMenu.ts';
import { REPORT_REASONS, isValidReport, reportToast } from '../api/report.ts';
import { createSupabaseApi } from '../api/api.supabase.ts';
import { card, dataCard } from './helpers.ts';

test('menu: Fewer like this is first; Report a problem is last', () => {
  const items = menuItems(card(), { canHideSource: true });
  assert.deepEqual(items, ['fewer', 'hideTopic', 'hideSource', 'report']);
  assert.deepEqual(menuItems(card(), { canHideSource: false }), ['fewer', 'hideTopic', 'report']);
});

test('menu: no "Hide <topic> topics" on data (Treasury, BLS) cards', () => {
  assert.deepEqual(menuItems(dataCard(), { canHideSource: false }), ['fewer', 'report']);
});

test('report: only known reasons and sane ids are valid', () => {
  assert.ok(REPORT_REASONS.length >= 3);
  assert.ok(isValidReport('abc-123', 'broken_link'));
  assert.ok(!isValidReport('abc-123', 'drop table'));
  assert.ok(!isValidReport('', 'other'));
  assert.ok(!isValidReport('a b', 'other'));
});

test('report toast wording', () => {
  assert.match(reportToast({ ok: true, status: 'ok' }), /Thanks/);
  assert.match(reportToast({ ok: false, status: 'unavailable' }), /not available/);
  assert.match(reportToast({ ok: false, status: 'error' }), /Try again/);
});

function fake(status: number, record: { url?: string; body?: string; headers?: Record<string, string> }) {
  return (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    record.url = url; record.body = init.body; record.headers = init.headers;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

test('supabase reportBlurb: POSTs rpc report_blurb with p_id and p_reason, anon key only', async () => {
  const rec: { url?: string; body?: string; headers?: Record<string, string> } = {};
  const api = createSupabaseApi({ url: 'https://x.supabase.co', key: 'pub', fetchFn: fake(204, rec) });
  assert.deepEqual(await api.reportBlurb('abc-1', 'inaccurate'), { ok: true, status: 'ok' });
  assert.equal(rec.url, 'https://x.supabase.co/rest/v1/rpc/report_blurb');
  assert.deepEqual(JSON.parse(rec.body as string), { p_id: 'abc-1', p_reason: 'inaccurate' });
  assert.equal(rec.headers?.apikey, 'pub');
  assert.equal(rec.headers?.Authorization, undefined);
});

test('supabase reportBlurb: 404 is "unavailable", other failures "error", bad input never sends', async () => {
  const rec: { url?: string } = {};
  assert.deepEqual(await createSupabaseApi({ url: 'https://x.supabase.co', key: 'k', fetchFn: fake(404, rec) }).reportBlurb('a1', 'other'), { ok: false, status: 'unavailable' });
  assert.deepEqual(await createSupabaseApi({ url: 'https://x.supabase.co', key: 'k', fetchFn: fake(429, rec) }).reportBlurb('a1', 'other'), { ok: false, status: 'rate_limited' });
  const none: { url?: string } = {};
  assert.deepEqual(await createSupabaseApi({ url: 'https://x.supabase.co', key: 'k', fetchFn: fake(200, none) }).reportBlurb('a1', 'nope' as never), { ok: false, status: 'invalid' });
  assert.equal(none.url, undefined);
});
