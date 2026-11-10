import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card } from './helpers.ts';
import { escapeHtml, firstSentence, injectShareMeta, inlineScripts, isCardId, isPublishableKey, shareMeta, shareMetaTags, supabaseFromShell } from '../share/sharePage.ts';
import { securityHeaders } from '../share/shareHeaders.ts';
import { SHARE_CACHE_CONTROL, handleShareRequest, type ShareDeps } from '../share/shareFunction.ts';
// @ts-expect-error plain .mjs build script without types
import { securityHeaderLines } from '../../scripts/security-headers.mjs';

const ID = '3f2b8c1e-9d4a-4e6b-8a7c-1b2c3d4e5f60';
const SB = 'https://abcdefghij.supabase.co';
const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
const ANON = jwt({ role: 'anon', iss: 'supabase' });
const SHELL = `<!DOCTYPE html><html lang="en"><head><script>(function(){try{var u=${JSON.stringify(SB)},H=${JSON.stringify({ apikey: ANON, Accept: 'application/json' })};}catch(e){}})()</script>`
  + '<meta charset="utf-8" /><title>Element</title><meta name="description" content="old" /><meta property="og:title" content="old" />'
  + '<style id="s">#a{color:red}</style><script>window.x="</title><meta name=description>";</script></head><body><div id="root"></div><script src="/_expo/static/js/web/entry.js" defer></script></body></html>';

const HOSTILE = [
  '"><script>alert(1)</script>',
  `It's "quoted" & <b>bold</b> \`tick\``,
  'Café exports jump 5% — €2bn 📈 in 日本',
  '</title><script>alert(document.cookie)</script><title>',
];

test('share page: ids must be UUIDs', () => {
  assert.ok(isCardId(ID));
  assert.ok(isCardId(ID.toUpperCase()));
  for (const bad of ['', 'c1', `${ID}x`, `${ID}/../x`, '../../etc/passwd', `${ID}%00`, null, 5]) assert.ok(!isCardId(bad), String(bad));
});

test('share page: escapeHtml neutralises every character that can break out of text or attributes', () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&\`</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;');
  for (const h of HOSTILE) assert.ok(!/[<>"'`]/.test(escapeHtml(h)), h);
  assert.equal(escapeHtml('Café 📈 日本'), 'Café 📈 日本', 'unicode is kept as it is');
});

test('share page: description is the first sentence of the blurb', () => {
  assert.equal(firstSentence('The Fed held rates at 4.5%. Markets rose. More later.'), 'The Fed held rates at 4.5%.');
  assert.equal(firstSentence('Payrolls rose by 250,000 in May! Wages grew.'), 'Payrolls rose by 250,000 in May!');
  assert.equal(firstSentence('U.S. retail sales rose 0.4% in May.'), 'U.S. retail sales rose 0.4% in May.');
  assert.equal(firstSentence('One sentence only'), 'One sentence only');
  assert.equal(firstSentence(null), '');
  assert.equal(firstSentence('  line\nbreaks\u0000 and\ttabs.  Next. '), 'line breaks and tabs.');
  const long = firstSentence('word '.repeat(200));
  assert.ok(Array.from(long).length <= 300 && long.endsWith('…'));
  assert.ok(!/[\ud800-\udbff]$/.test(firstSentence('📈'.repeat(400)).slice(0, -1)), 'never cuts a surrogate pair');
});

test('share page: meta tags use the verbatim headline, escape hostile text and never carry an image (rule 9)', () => {
  for (const h of HOSTILE) {
    const meta = shareMeta({ headline: h, body: `${h}. Second sentence.` }, `https://element-news.pages.dev/b/${ID}`);
    assert.equal(meta.title, h, 'title is the headline as written');
    const tags = shareMetaTags(meta);
    assert.ok(!/<script/i.test(tags), tags);
    assert.ok(!/image/i.test(tags), 'no og:image / twitter:image');
    // every attribute value is closed by its own quote: no stray quote or angle bracket inside values
    for (const m of tags.matchAll(/content="([^"]*)"/g)) assert.ok(!/[<>'`]/.test(m[1]), m[1]);
    assert.ok(tags.includes(`content="${escapeHtml(h)}"`));
  }
  const capped = shareMeta({ headline: 'x'.repeat(500), body: '' }, 'https://a.b/b/1');
  assert.equal(Array.from(capped.title).length, 200);
  assert.ok(!shareMetaTags(capped).includes('description'), 'no empty description');
});

test('share page: injecting tags keeps every inline script byte for byte (CSP hashes still match)', async () => {
  for (const h of HOSTILE) {
    const out = injectShareMeta(SHELL, shareMeta({ headline: h, body: 'First. Second.' }, `https://element-news.pages.dev/b/${ID}`))!;
    assert.ok(out, 'has a head');
    assert.deepEqual(inlineScripts(out), inlineScripts(SHELL), 'inline scripts unchanged');
    assert.equal((out.match(/<title>/g) ?? []).length, 1, 'one title');
    assert.ok(out.includes(`<title>${escapeHtml(h)} · Element</title>`));
    assert.ok(!out.includes('content="old"'), 'old description / og tags removed');
    assert.ok(out.includes('window.x="</title><meta name=description>"'), 'text inside a script is not edited');
    assert.equal(out.match(/<script>alert/g), null, 'hostile headline never becomes markup');
    assert.ok(out.endsWith('<div id="root"></div><script src="/_expo/static/js/web/entry.js" defer></script></body></html>'));
    // same CSP headers as the build computed for the plain index.html
    assert.deepEqual(await securityHeaders(out, SB), await securityHeaders(SHELL, SB));
  }
  assert.equal(injectShareMeta('<html><body>no head</body></html>', shareMeta({ headline: 'x', body: '' }, 'https://a.b')), null);
});

test('share page: Function security headers equal scripts/security-headers.mjs for the same index.html', async () => {
  for (const [html, sb] of [[SHELL, SB], ['<html><head></head><body></body></html>', ''], [SHELL, 'not a url']] as const) {
    const ours = (await securityHeaders(html, sb)).map(([n, v]) => `${n}: ${v}`);
    assert.deepEqual(ours, securityHeaderLines({ html, supabaseUrl: sb }));
    assert.deepEqual((await securityHeaders(html, sb, true)).map(([n, v]) => `${n}: ${v}`), securityHeaderLines({ html, supabaseUrl: sb, enforceFull: true }));
  }
});

test('share page: only publishable keys are accepted (rule 10)', () => {
  assert.ok(isPublishableKey('sb_publishable_abcdefghijklmnopqrstuv'));
  assert.ok(isPublishableKey(ANON));
  assert.ok(!isPublishableKey('sb_secret_abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!isPublishableKey(jwt({ role: 'service_role' })));
  assert.ok(!isPublishableKey('short'));
  assert.ok(!isPublishableKey(undefined));
  assert.deepEqual(supabaseFromShell(SHELL), { url: SB, key: ANON });
  assert.equal(supabaseFromShell(SHELL.replace(ANON, jwt({ role: 'service_role' }))), null);
});

function deps(over: Partial<ShareDeps> & { cardJson?: unknown; status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fallback = new Response('FALLBACK', { status: 200 });
  const d: ShareDeps = {
    request: new Request(`https://element-news.pages.dev/b/${ID}`),
    id: ID,
    env: { SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijklmnopqrstuv' },
    asset: async () => new Response(SHELL, { status: 200 }),
    fallback: async () => fallback,
    fetchFn: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify('cardJson' in over ? over.cardJson : card({ id: ID, headline: HOSTILE[0], body: 'The Fed held rates. More text.' })), { status: over.status ?? 200 });
    }) as unknown as typeof fetch,
    ...over,
  };
  return { d, calls, fallback };
}

test('share Function: serves index.html with the card tags, security headers and a short cache', async () => {
  const { d, calls } = deps();
  const res = await handleShareRequest(d);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes(`<meta property="og:title" content="${escapeHtml(HOSTILE[0])}" />`));
  assert.ok(html.includes('<meta property="og:description" content="The Fed held rates." />'));
  assert.ok(html.includes(`<meta property="og:url" content="https://element-news.pages.dev/b/${ID}" />`));
  assert.ok(!/og:image|twitter:image/.test(html));
  assert.equal(res.headers.get('cache-control'), SHARE_CACHE_CONTROL);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('content-security-policy-report-only')!.includes("'sha256-"));
  // the Supabase call: publishable key only, the anonymous card RPC, the id in the body (never the URL)
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SB}/rest/v1/rpc/card_by_id`);
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.apikey, 'sb_publishable_abcdefghijklmnopqrstuv');
  assert.equal(h.Authorization, undefined);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { p_id: ID });
  assert.ok(calls[0].init.signal, 'has a timeout');
});

test('share Function: falls back to the plain page on every problem', async () => {
  const cases: [string, Partial<ShareDeps> & { cardJson?: unknown; status?: number }][] = [
    ['bad id', { id: 'not-a-uuid' }],
    ['path trick', { id: `${ID}/../x` }],
    ['POST', { request: new Request(`https://element-news.pages.dev/b/${ID}`, { method: 'POST' }) }],
    ['no config', { env: {}, asset: async () => new Response('<html><head></head><body></body></html>') }],
    ['secret key in env and none in the shell', { env: { SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abcdefghijklmnopqrstuvwxyz' }, asset: async () => new Response('<html><head></head></html>') }],
    ['card missing (null)', { cardJson: null }],
    ['server error', { status: 500 }],
    ['other card', { cardJson: card({ id: '00000000-0000-4000-8000-000000000000' }) }],
    ['not a card', { cardJson: { id: ID, headline: 'x' } }],
    ['shell missing', { asset: async () => new Response('nope', { status: 404 }) }],
    ['network throws', { fetchFn: (async () => { throw new Error('offline'); }) as unknown as typeof fetch }],
  ];
  for (const [name, over] of cases) {
    const { d, fallback } = deps(over);
    assert.equal(await handleShareRequest(d), fallback, name);
  }
});

test('share Function: a secret key in env is ignored; the publishable key from the shell is used instead', async () => {
  const { d, calls } = deps({ env: { SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abcdefghijklmnopqrstuvwxyz' } });
  const res = await handleShareRequest(d);
  assert.equal(res.status, 200);
  assert.equal((calls[0].init.headers as Record<string, string>).apikey, ANON);
});

test('share Function: a slow Supabase answer times out and falls back', async () => {
  const { d, fallback } = deps({
    timeoutMs: 20,
    fetchFn: ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch,
  });
  assert.equal(await handleShareRequest(d), fallback);
});

test('api.card (Supabase): anonymous card_by_id call; null for unknown / missing RPC; network errors throw', async () => {
  const { createSupabaseApi } = await import('../api/api.supabase.ts');
  let answer: { status: number; body: unknown } = { status: 200, body: card({ id: ID }) };
  const sent: { url: string; init: RequestInit }[] = [];
  const api = createSupabaseApi({
    url: SB, key: 'sb_publishable_abcdefghijklmnopqrstuv', getToken: async () => 'user-token',
    fetchFn: (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(JSON.stringify(answer.body), { status: answer.status }); }) as unknown as typeof fetch,
  });
  assert.equal((await api.card(ID))?.id, ID);
  assert.equal(sent[0].url, `${SB}/rest/v1/rpc/card_by_id`);
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, undefined, 'never sends the reader token');
  assert.equal(await api.card('c1'), null, 'not a UUID: no request');
  assert.equal(sent.length, 1);
  answer = { status: 200, body: null };
  assert.equal(await api.card(ID), null);
  answer = { status: 404, body: { message: 'Could not find the function api.card_by_id' } };
  assert.equal(await api.card(ID), null, 'RPC not applied yet');
  answer = { status: 503, body: {} };
  await assert.rejects(api.card(ID));
});
