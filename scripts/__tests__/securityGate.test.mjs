import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildHeadersFile, fullCsp, inlineScripts, parseHeadersFile, sha256Source } from '../security-headers.mjs';
import { checkBuildHeaders, checkGrants, checkHeaderSet, exitCode, parseDbOutput, readSecretValues, scanBundleText, ANON_API } from '../security-gate.mjs';

const html = '<html><head><script>var a=1</script><script src="/x.js"></script><script type="module" src="https://static.cloudflareinsights.com/beacon.min.js"></script></head><body><script>(function(){})()</script></body></html>';

test('inlineScripts keeps only scripts without src', () => {
  assert.deepEqual(inlineScripts(html), ['var a=1', '(function(){})()']);
  assert.match(sha256Source('var a=1'), /^'sha256-[A-Za-z0-9+/]+=*'$/);
});

test('built _headers passes the gate and covers every inline script', () => {
  const text = buildHeadersFile({ html, supabaseUrl: 'https://abc.supabase.co' });
  assert.deepEqual(checkBuildHeaders(text, html), []);
  const all = parseHeadersFile(text).find((r) => r.path === '/*').headers;
  assert.match(all.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(all.get('x-frame-options'), 'DENY');
  assert.match(all.get('content-security-policy-report-only'), /connect-src 'self' https:\/\/abc\.supabase\.co wss:\/\/abc\.supabase\.co/);
  assert.doesNotMatch(all.get('content-security-policy-report-only'), /script-src[^;]*unsafe-inline/);
});

test('enforced full CSP puts hashes in the enforced header', () => {
  const all = parseHeadersFile(buildHeadersFile({ html, enforceFull: true })).find((r) => r.path === '/*').headers;
  assert.ok(!all.has('content-security-policy-report-only'));
  assert.match(all.get('content-security-policy'), /script-src 'self' 'sha256-/);
});

test('gate flags missing headers, framing, uncovered inline scripts and unsafe-inline', () => {
  const old = '/_expo/static/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/\n  Cache-Control: public, max-age=0, must-revalidate\n';
  assert.match(checkBuildHeaders(old, html).join(), /no "\/\*" rule/);
  const bare = checkHeaderSet(new Map(), html).join('|');
  for (const p of ['x-content-type-options', 'referrer-policy', 'permissions-policy', 'strict-transport-security', 'framed', 'script-src']) assert.match(bare, new RegExp(p));
  const stale = new Map(parseHeadersFile(buildHeadersFile({ html: '<script>other</script>' })).find((r) => r.path === '/*').headers);
  assert.match(checkHeaderSet(stale, html).join(), /2 inline script\(s\) not covered/);
  stale.set('content-security-policy-report-only', fullCsp().replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"));
  assert.match(checkHeaderSet(stale, '').join(), /unsafe-inline/);
});

test('public/_headers fallback carries the security headers', () => {
  const text = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8');
  assert.deepEqual(checkBuildHeaders(text, ''), []);
});

test('bundle scan reports key shapes and server secret values by name only', () => {
  const secret = 'cron-secret-value-1234567890';
  const fakeKey = ['sb', 'secret', 'abcdefghijklmnopqrstuvwxyz'].join('_');   // built at runtime so the repo scan stays clean
  const hits = scanBundleText(`x="${secret}";y="${fakeKey}"`, { CRON_SECRET: secret, EMPTY: '' });
  assert.ok(hits.some((h) => /Supabase secret key/.test(h)));
  assert.ok(hits.includes('value of CRON_SECRET'));
  assert.ok(!hits.join().includes(secret));
  assert.deepEqual(scanBundleText('var key="sb_publishable_abc123"', { CRON_SECRET: secret }), []);
  assert.deepEqual(readSecretValues({ CRON_SECRET: ' v1 ' }, 'no-such-file.env'), { CRON_SECRET: 'v1' });
});

test('grant check: allowlisted RPCs pass, service-only and core exposure fail', () => {
  const fn = (s, name, anon, authd, extra = {}) => ({ k: 'fn', s, name, args: '', secdef: true, cfg: 'search_path=""', anon, authd, ...extra });
  const ok = [fn('api', 'feed', true, true), fn('api', 'track', false, true), fn('api', 'ml_v3_check', false, false), fn('core', 'diversify', false, false),
    { k: 'rel', s: 'core', name: 'blurbs', args: 'r', anon: false, authd: false, rls: true }, { k: 'schema', s: 'core', anon: false, authd: false }];
  assert.deepEqual(checkGrants(ok), { fail: [], warn: [] });
  const bad = checkGrants([fn('api', 'ml_v3_check', true, true), fn('api', 'ai_usage_take', false, true), fn('api', 'track', true, true),
    fn('core', 'invoke_function', false, true), fn('api', 'x', false, false, { cfg: '' }), fn('net', 'http_post', true, true),
    { k: 'rel', s: 'core', name: 'user_events', args: 'r', anon: true, authd: false, rls: false }, { k: 'schema', s: 'vault', anon: true, authd: false },
    fn('api', 'search', false, false)]);
  assert.equal(bad.fail.length, 9);
  assert.ok(bad.fail.some((f) => /anon can execute service-only api\.ml_v3_check/.test(f)));
  assert.ok(bad.fail.some((f) => /anon can execute service-only api\.track/.test(f)));
  assert.ok(bad.fail.some((f) => /without pinned search_path/.test(f)));
  assert.ok(bad.warn.some((w) => /net\.http_post/.test(w)));
  assert.ok(bad.warn.some((w) => /search/.test(w)));
  assert.ok(ANON_API.includes('ops_status'));
});

test('parseDbOutput skips the status line and rejects errors', () => {
  assert.deepEqual(parseDbOutput('Target: project x\n{"rows":[{"k":"fn"}]}'), [{ k: 'fn' }]);
  assert.throws(() => parseDbOutput('{"error":{"message":"nope"}}'), /nope/);
});

test('exit code is 1 only on FAIL', () => {
  assert.equal(exitCode([{ status: 'PASS' }, { status: 'WARN' }, { status: 'SKIP' }]), 0);
  assert.equal(exitCode([{ status: 'PASS' }, { status: 'FAIL' }]), 1);
});
