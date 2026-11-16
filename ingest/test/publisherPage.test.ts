import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowed, AllowlistError } from '../src/allowlist.ts';
import { extractArticleText, fetchPublisherText, robotsAllows } from '../src/publisherPage.ts';
import { checkLinkOut, validatePublish, assertSummarizable } from '../src/validate.ts';

const para = 'Shares of the company rose after the quarterly report showed revenue growth across every segment of the business.';
const page = `<html><head><title>x</title></head><body><nav>Menu Home</nav><article><p>${para}</p><p>${para} Analysts said the outlook improved.</p><p>${para} Management raised guidance.</p><p>${para} More detail followed.</p></article><footer>Copyright</footer></body></html>`;
const res = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

test('publisher kind refuses IPs, localhost, internal names and non-https', () => {
  for (const u of ['https://127.0.0.1/a', 'https://localhost/a', 'https://intranet/a', 'https://[::1]/a', 'https://x.internal/a', 'http://example.com/a'])
    assert.throws(() => assertAllowed(u, 'publisher'), AllowlistError, u);
  assert.doesNotThrow(() => assertAllowed('https://www.example.com/a', 'publisher'));
});

test('robotsAllows: specific group, wildcard, longest match', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private', '/news/a'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /news', '/news/a'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /news\nAllow: /news/open', '/news/open/a'), true);
  assert.equal(robotsAllows('User-agent: ElementNewsBot\nDisallow: /\nUser-agent: *\nAllow: /', '/a'), false);
  assert.equal(robotsAllows('', '/a'), true);
});

test('extractArticleText keeps article paragraphs, drops nav and footer', () => {
  const t = extractArticleText(page);
  assert.match(t, /revenue growth/);
  assert.doesNotMatch(t, /Menu Home|Copyright/);
});

test('extractArticleText drops repeated paragraphs', () => {
  const html = `<article><p>${para}</p><p>${para}</p><p>${para} Different ending here.</p></article>`;
  const t = extractArticleText(html);
  assert.equal(t.split('\n').filter((l) => l === para).length, 1);
  assert.equal(t.split('\n').length, 2);
});

test('fetchPublisherText returns text, honors robots, and returns "" for stubs and errors', async () => {
  const ok = async (u: string) => (u.endsWith('/robots.txt') ? res(404, '') : res(200, page));
  assert.match(await fetchPublisherText('https://news.example.com/a', { fetchImpl: ok }), /revenue growth/);
  const blocked = async (u: string) => (u.endsWith('/robots.txt') ? res(200, 'User-agent: *\nDisallow: /') : res(200, page));
  assert.equal(await fetchPublisherText('https://news.example.com/a', { fetchImpl: blocked }), '');
  const stub = async (u: string) => (u.endsWith('/robots.txt') ? res(404, '') : res(200, '<html><body><p>Subscribe to read.</p></body></html>'));
  assert.equal(await fetchPublisherText('https://news.example.com/a', { fetchImpl: stub }), '');
  const err = async (u: string) => (u.endsWith('/robots.txt') ? res(404, '') : res(500, 'x'));
  assert.equal(await fetchPublisherText('https://news.example.com/a', { fetchImpl: err }), '');
  assert.equal(await fetchPublisherText('https://127.0.0.1/a', { fetchImpl: ok }), '');
});

test('link_out card (D-297): only an AI summary with body and 3 key points; headline-only is refused', () => {
  const src = [{ name: 'Pub', kind: 'news', url: 'https://p.example.com/a', license_class: 'link_out', doc_label: null }] as never;
  const base = { origin: 'newsdata', headline: 'H', attribution: 'via NewsData.io', sources: src };
  const detail = { paragraphs: ['a', 'b'], key_points: ['x', 'y', 'z'] };
  assert.deepEqual(checkLinkOut({ ...base, ai_generated: true, body: 'Summary.', detail }, true), []);
  assert.ok(checkLinkOut({ ...base, ai_generated: false, body: null }, true).length);              // headline-only
  assert.ok(checkLinkOut({ ...base, ai_generated: true, body: null, detail }, true).length);        // no body
  assert.ok(checkLinkOut({ ...base, ai_generated: true, body: 'Summary.' }, true).length);          // no key points
  assert.ok(checkLinkOut({ ...base, ai_generated: true, body: 'S.', detail: { key_points: ['x'] } }, true).length);
  assert.ok(checkLinkOut({ ...base, origin: 'sec', ai_generated: true, body: 'x', detail }, true).length);
  assert.equal(validatePublish({ ...base, kind: 'link_out', ai_generated: true, body: 'S.', detail }, { linkOutEnabled: true }).ok, true);
  assert.equal(validatePublish({ ...base, kind: 'summary', ai_generated: true, body: 'S.' }, { linkOutEnabled: true }).ok, false);
});

test('license gate: link_out stays blocked, link_out_text is allowed', () => {
  assert.throws(() => assertSummarizable('link_out'));
  assert.doesNotThrow(() => assertSummarizable('link_out_text'));
});
