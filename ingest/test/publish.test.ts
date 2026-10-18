import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishPayload, createSupabasePublisher, SupabaseError } from '../src/publish.ts';
import { validatePublish } from '../src/validate.ts';
import { config } from '../src/config.ts';
import type { FetchLike } from '../src/allowlist.ts';
import type { RawItem } from '../src/types.ts';

const item: RawItem = {
  source: 'sec_8k', external_id: '0001500435-26-000064',
  url: 'https://www.sec.gov/Archives/edgar/data/1500435/000150043526000064/0001500435-26-000064-index.htm',
  title: 'GoPro, Inc. 8-K', published_at: '2026-10-16T21:30:16.000Z', license_class: 'company_filing',
  category: 'earnings', event_type: 'earnings', tickers: [{ symbol: 'GPRO', name: 'GoPro, Inc.', exchange: 'Nasdaq' }],
  source_name: 'SEC', source_kind: 'filing', doc_label: 'Form 8-K', company: 'GoPro, Inc.', items: [{ number: '2.02', title: 'Results of Operations and Financial Condition' }], summary_text: '',
};

function recorder(reply: { status: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  return { calls, impl };
}

test('payload: one primary source with URL, AI flag, prompt version, ticker details', () => {
  const p = buildPublishPayload(item, { headline: ' H ', body: 'B.', category: 'earnings', event_type: 'earnings', tickers: ['gpro'] }, { itemId: 'i1', aiGenerated: true, model: 'm' });
  assert.equal(p.dedupe_key, item.url);
  assert.equal(p.headline, 'H');
  assert.deepEqual(p.tickers, item.tickers);
  assert.equal(p.prompt_version, config.promptVersion);
  assert.equal(p.sources.length, 1);
  assert.equal(p.sources[0].is_primary, true);
  assert.deepEqual(validatePublish(p).errors, []);
  const t = buildPublishPayload(item, { headline: 'H', body: null, category: 'earnings', event_type: null, tickers: [] }, { aiGenerated: false, model: null });
  assert.equal(t.prompt_version, config.templateVersion, 'template cards carry the template version');
  assert.equal(t.event_type, 'earnings', 'Item 2.02 decides the event type');
});

test('publish_blurb goes to the api schema with the secret key in apikey only', async () => {
  const rec = recorder({ status: 200, body: { status: 'published', id: 'abc' } });
  const pub = createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'sb_secret_test_not_real', fetchImpl: rec.impl });
  const r = await pub.publishBlurb(buildPublishPayload(item, { headline: 'H', body: null, category: 'earnings', event_type: null, tickers: [] }, { aiGenerated: false, model: null }));
  assert.deepEqual(r, { status: 'published', id: 'abc' });
  const c = rec.calls[0];
  assert.equal(c.url, 'https://abcd1234.supabase.co/rest/v1/rpc/publish_blurb');
  assert.equal(c.headers['Content-Profile'], 'api');
  assert.equal(c.headers.apikey, 'sb_secret_test_not_real');
  assert.equal(c.headers.Authorization, undefined);
  assert.equal(c.body.p.kind, 'summary');
});

test('legacy JWT keys are also sent as Bearer', async () => {
  const rec = recorder({ status: 200, body: null });
  const pub = createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'eyJhbGciOi.test.notreal', fetchImpl: rec.impl });
  await pub.upsertMacro({ series_id: 'DGS10', obs_date: '2026-10-16', value: 5.09, display_value: '5.09%', change_text: '-0.01 pts', direction: 'down', period_label: null });
  assert.equal(rec.calls[0].headers.Authorization, 'Bearer eyJhbGciOi.test.notreal');
  assert.equal(rec.calls[0].body.p.series_id, 'DGS10');
});

test('errors report the PostgREST message but never the key', async () => {
  const rec = recorder({ status: 401, body: { message: 'permission denied for function publish_blurb' } });
  const pub = createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'sb_secret_test_not_real', fetchImpl: rec.impl });
  await assert.rejects(pub.upsertItem(item), (e: Error) => {
    assert.ok(e instanceof SupabaseError);
    assert.match(e.message, /rpc upsert_item: HTTP 401: permission denied/);
    assert.doesNotMatch(e.message, /sb_secret/);
    return true;
  });
  assert.equal(rec.calls[0].body.p.license_class, 'company_filing');
  assert.deepEqual(rec.calls[0].body.p.tickers, ['GPRO']);
});

test('the publisher refuses to send to any host but the configured Supabase project', async () => {
  const rec = recorder({ status: 200, body: null });
  const pub = createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'k', fetchImpl: rec.impl });
  await pub.upsertMacro({ series_id: 'X', obs_date: '2026-10-16', value: 1, display_value: '1', change_text: null, direction: null, period_label: null });
  assert.equal(new URL(rec.calls[0].url).hostname, 'abcd1234.supabase.co');
});
