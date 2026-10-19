// Brief summary + Markets section + email subscription contract (spec-brief-email.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card } from './helpers.ts';
import { BRIEF_CAPS, createMockFeatureApi } from '../api/api.mockFeatures.ts';
import { createSupabaseApi } from '../api/api.supabase.ts';
import { normalizeBriefEmail, parseBriefMarkets, parseBriefSummary, parseSubscribeResult } from '../shared/types.ts';
import type { MacroFact } from '../../contract/types.ts';

const URL_ = 'https://example.supabase.co';
const KEY = 'sb_publishable_test';
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const fact = (series_id: string): MacroFact => ({ series_id, label: series_id, value: '1', change: null, direction: null, as_of: '2026-10-17', source_name: 'Agency', source_short: 'AG', source_url: 'https://example.com/' } as MacroFact);
const IN = { kind: 'daily' as const, hour: 7, tz: 'America/New_York' };

function fakeFetch(status: number, body: unknown, calls: { url: string; body: string }[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

test('mock brief: market cards move to Markets (max 6, one per story) and leave topic sections', async () => {
  const cards = [
    ...Array.from({ length: 8 }, (_, i) => card({ id: `m${i}`, category: i % 3 === 0 ? 'markets' : i % 3 === 1 ? 'earnings' : 'deals', importance: 50 - i, sort_at: hoursAgo(1) })),
    ...Array.from({ length: 6 }, (_, i) => card({ id: `w${i}`, category: 'world', importance: 10 - i, sort_at: hoursAgo(1) })),
  ];
  const api = createMockFeatureApi(cards, [fact('DGS10'), fact('CPIAUCSL'), fact('DFF'), fact('DGS2'), fact('DCOILWTICO')], []);
  const daily = api.dailyBrief();
  assert.equal(daily.markets?.cards.length, 6);
  assert.equal(daily.markets?.total, 8);
  assert.deepEqual(daily.markets?.cards.map((c) => c.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'], 'trending order');
  assert.deepEqual(daily.markets?.numbers.map((n) => n.series_id), ['DGS10', 'DFF', 'DGS2', 'DCOILWTICO']);
  assert.ok(daily.sections.every((s) => !['markets', 'earnings', 'deals'].includes(s.category)));
  assert.ok(daily.summary?.text.startsWith('[SAMPLE]'));
  assert.equal(api.weeklyBrief().markets?.cards.length, 6);
});

test('mock brief: no market cards gives an empty Markets list (UI hides it); no cards = no summary', () => {
  const daily = createMockFeatureApi([card({ id: 'a', category: 'world', sort_at: hoursAgo(1) })], [], []).dailyBrief();
  assert.deepEqual(daily.markets?.cards, []);
  assert.equal(createMockFeatureApi([], [], []).dailyBrief().summary, null);
});

test('email validation: trimmed, lowercased, <= 254, simple pattern', () => {
  assert.equal(normalizeBriefEmail('  Drew@Example.COM '), 'drew@example.com');
  for (const bad of ['', 'no-at', 'a@b', 'a b@c.de', `${'x'.repeat(250)}@e.co`, 42, null]) assert.equal(normalizeBriefEmail(bad), null, String(bad));
});

test('mock subscriptions: constant pending, confirm, change, idempotent unsubscribe, caps', () => {
  const api = createMockFeatureApi([], [], []);
  assert.deepEqual(api.subscribeBrief({ email: 'bad', ...IN }), { ok: false, status: 'invalid' });
  assert.deepEqual(api.subscribeBrief({ email: 'a@example.com', ...IN, hour: 24 }), { ok: false, status: 'invalid' });
  assert.deepEqual(api.subscribeBrief({ email: 'A@example.com', ...IN }), { ok: true, status: 'pending' });
  assert.deepEqual(api.subscribeBrief({ email: 'a@example.com', ...IN }), { ok: true, status: 'pending' }, 'same answer for an existing address');
  const token = api.subscriptions()[0]!.token;
  assert.deepEqual(api.confirmBrief(token), { ok: true });
  assert.deepEqual(api.subscribeBrief({ email: 'a@example.com', ...IN }), { ok: true, status: 'pending' }, 'active address: still pending, no leak');
  assert.equal(api.subscriptions()[0]!.status, 'active');
  assert.deepEqual(api.updateBriefSubscription(token, { kind: 'both', hour: 18, tz: 'Europe/Berlin' }), { ok: true });
  assert.equal(api.subscriptions()[0]!.hour, 18);
  assert.deepEqual(api.unsubscribeBrief(token), { ok: true });
  assert.deepEqual(api.unsubscribeBrief(token), { ok: true }, 'idempotent');
  assert.deepEqual(api.confirmBrief(token), { ok: false }, 'old token cannot re-activate');
  assert.deepEqual(api.unsubscribeBrief('00000000-0000-4000-8000-ffffffffffff'), { ok: true }, 'unknown token looks the same');
  // per-email cap: 3 attempts used above, 2 more allowed, then limited
  api.subscribeBrief({ email: 'a@example.com', ...IN });
  api.subscribeBrief({ email: 'a@example.com', ...IN });
  assert.deepEqual(api.subscribeBrief({ email: 'a@example.com', ...IN }), { ok: false, status: 'limited' });
  const g = createMockFeatureApi([], [], []);
  for (let i = 0; i < BRIEF_CAPS.globalPerHour; i++) g.subscribeBrief({ email: `u${i}@example.com`, ...IN });
  assert.deepEqual(g.subscribeBrief({ email: 'late@example.com', ...IN }), { ok: false, status: 'limited' });
});

test('supabase client: subscribe sends a lowercased email to the RPC and parses the answer', async () => {
  const calls: { url: string; body: string }[] = [];
  const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(200, { ok: true, status: 'pending' }, calls) });
  assert.deepEqual(await api.subscribeBrief({ email: ' Me@Example.com', ...IN }), { ok: true, status: 'pending' });
  assert.equal(calls[0]!.url, `${URL_}/rest/v1/rpc/subscribe_brief`);
  assert.deepEqual(JSON.parse(calls[0]!.body), { p_email: 'me@example.com', p_kind: 'daily', p_hour: 7, p_tz: 'America/New_York' });
  assert.deepEqual(await api.subscribeBrief({ email: 'nope', ...IN }), { ok: false, status: 'invalid' });
  assert.equal(calls.length, 1, 'invalid input never reaches the server');
});

test('supabase client: missing RPC / errors give unavailable, never throw', async () => {
  const tok = '11111111-2222-4333-8444-555555555555';
  for (const f of [fakeFetch(404, { code: 'PGRST202', message: 'Could not find the function' }), fakeFetch(500, {}), (async () => { throw new TypeError('x'); }) as unknown as typeof fetch]) {
    const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: f });
    assert.deepEqual(await api.subscribeBrief({ email: 'a@example.com', ...IN }), { ok: false, status: 'unavailable' });
    assert.deepEqual(await api.confirmBrief(tok), { ok: false, status: 'unavailable' });
    assert.deepEqual(await api.updateBriefSubscription(tok, IN), { ok: false, status: 'unavailable' });
    assert.deepEqual(await api.unsubscribeBrief(tok), { ok: false, status: 'unavailable' });
  }
  const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(200, { ok: true }) });
  assert.deepEqual(await api.confirmBrief('not-a-uuid'), { ok: false });
  assert.deepEqual(await api.unsubscribeBrief(tok), { ok: true });
});

test('parsers: summary, markets and subscribe result are defensive', () => {
  assert.equal(parseBriefSummary(null), null);
  assert.equal(parseBriefSummary({ text: '  ' }), null);
  assert.deepEqual(parseBriefSummary({ text: 'Hi.', generated_at: 'g', model: 'm' }), { text: 'Hi.', generated_at: 'g', model: 'm' });
  assert.deepEqual(parseBriefMarkets(undefined), { cards: [], numbers: [], total: 0 });
  const m = parseBriefMarkets({ cards: [card(), { id: 'bad' }], numbers: [fact('DGS10'), { x: 1 }], total: 9 });
  assert.equal(m.cards.length, 1);
  assert.equal(m.numbers.length, 1);
  assert.equal(m.total, 9);
  assert.deepEqual(parseSubscribeResult({ ok: true, status: 'weird' }), { ok: false, status: 'unavailable' });
  assert.deepEqual(parseSubscribeResult({ ok: true, status: 'limited' }), { ok: false, status: 'limited' });
});

test('supabase client: brief carries summary and markets when the server sends them', async () => {
  const api = createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(200, { generated_at: 'g', window_hours: 24, headline_cards: [], sections: [], numbers: [], summary: { text: 'Day.', generated_at: 'g', model: 'gemini' }, markets: { cards: [card()], numbers: [], total: 1 } }) });
  const b = await api.dailyBrief();
  assert.equal(b.summary?.text, 'Day.');
  assert.equal(b.markets?.cards.length, 1);
  const old = await createSupabaseApi({ url: URL_, key: KEY, fetchFn: fakeFetch(200, { generated_at: 'g', window_hours: 24, headline_cards: [], sections: [], numbers: [] }) }).dailyBrief();
  assert.equal(old.summary, null);
  assert.deepEqual(old.markets?.cards, []);
});
