import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedApi, assertAllowedPage, AllowlistError, fetchAllowed, type FetchLike } from '../src/allowlist.ts';

test('page allowlist accepts the three government hosts', () => {
  for (const u of [
    'https://www.sec.gov/Archives/edgar/data/1500435/000150043526000064/0001500435-26-000064-index.htm',
    'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261017a.htm',
    'https://www.bls.gov/news.release/cpi.nr0.htm',
    'https://WWW.SEC.GOV/cgi-bin/browse-edgar?action=getcurrent',
  ]) {
    assert.doesNotThrow(() => assertAllowedPage(u), u);
  }
});

test('page allowlist rejects other hosts and tricks', () => {
  for (const u of [
    'http://www.sec.gov/',                         // not https
    'https://sec.gov/',                            // not the exact host
    'https://www.sec.gov.evil.com/',               // suffix trick
    'https://evil.com/www.sec.gov/',               // path trick
    'https://www.sec.gov@evil.com/',               // userinfo trick (host is evil.com)
    'https://user:pw@www.sec.gov/',                // credentials
    'https://www.sec.gov:8443/',                   // other port
    'https://www.reuters.com/markets/',            // news site
    'https://www.theguardian.com/business/x',
    'https://newsdata.io/article',
    'https://api.stlouisfed.org/fred/series',      // an API host is not a page host
    'not a url',
  ]) {
    assert.throws(() => assertAllowedPage(u), AllowlistError, u);
  }
});

test('API allowlist accepts FRED, Treasury, Gemini and the Supabase host only', () => {
  assert.doesNotThrow(() => assertAllowedApi('https://api.stlouisfed.org/fred/series/observations?series_id=DGS10'));
  assert.doesNotThrow(() => assertAllowedApi('https://home.treasury.gov/resource-center/x.csv'));
  assert.doesNotThrow(() => assertAllowedApi('https://abc.supabase.co/rest/v1/rpc/publish_blurb', ['abc.supabase.co']));
  assert.throws(() => assertAllowedApi('https://abc.supabase.co/rest/v1/rpc/x'), AllowlistError);
  assert.throws(() => assertAllowedApi('https://www.sec.gov/'), AllowlistError);
});

test('Groq API host is a data-API host only, never a page host', () => {
  assert.doesNotThrow(() => assertAllowedApi('https://api.groq.com/openai/v1/chat/completions'));
  assert.throws(() => assertAllowedPage('https://api.groq.com/openai/v1/chat/completions'), AllowlistError);
  assert.throws(() => assertAllowedApi('https://groq.com/'), AllowlistError);              // only the exact API host
  assert.throws(() => assertAllowedApi('https://api.groq.com.evil.com/x'), AllowlistError);
  assert.throws(() => assertAllowedApi('http://api.groq.com/openai/v1/models'), AllowlistError);
});

function recorder(responses: Record<string, { status: number; location?: string; body?: string }>) {
  const calls: string[] = [];
  const impl: FetchLike = async (url) => {
    calls.push(url);
    const r = responses[url] ?? { status: 404 };
    const headers = new Headers();
    if (r.location) headers.set('location', r.location);
    return new Response(r.status >= 300 && r.status < 400 ? null : (r.body ?? ''), { status: r.status, headers });
  };
  return { calls, impl };
}

test('fetchAllowed never sends a request to a disallowed URL', async () => {
  const rec = recorder({});
  await assert.rejects(fetchAllowed('https://www.bloomberg.com/news/x', { kind: 'page', fetchImpl: rec.impl }), AllowlistError);
  assert.equal(rec.calls.length, 0);
});

test('fetchAllowed follows a redirect within the allowlist and sends the User-Agent', async () => {
  let ua = '';
  const rec = recorder({
    'https://www.sec.gov/a': { status: 301, location: '/b' },
    'https://www.sec.gov/b': { status: 200, body: 'filing text' },
  });
  const impl: FetchLike = async (url, init) => {
    ua = (init.headers as Record<string, string>)['User-Agent'];
    return rec.impl(url, init);
  };
  const r = await fetchAllowed('https://www.sec.gov/a', { kind: 'page', fetchImpl: impl, userAgent: 'Test app test@example.edu', perSecond: 1000 });
  assert.equal(r.text, 'filing text');
  assert.equal(r.url, 'https://www.sec.gov/b');
  assert.deepEqual(rec.calls, ['https://www.sec.gov/a', 'https://www.sec.gov/b']);
  assert.equal(ua, 'Test app test@example.edu');
});

test('fetchAllowed refuses a redirect to another host before requesting it', async () => {
  const rec = recorder({ 'https://www.federalreserve.gov/x': { status: 302, location: 'https://tracker.example.com/y' } });
  await assert.rejects(fetchAllowed('https://www.federalreserve.gov/x', { kind: 'page', fetchImpl: rec.impl, perSecond: 1000 }), AllowlistError);
  assert.deepEqual(rec.calls, ['https://www.federalreserve.gov/x']);
});
