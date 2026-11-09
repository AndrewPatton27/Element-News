import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxAgeHours, checkTitle, findBundle, checkFreshness, checkFeedStatus, checkCards, checkNotice, FEED_NOTICE_MARKER, runSmoke } from '../prod-smoke.mjs';

const NOW = new Date('2026-11-10T12:00:00Z'); // Tuesday
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const card = (over = {}) => ({ id: 'c1', published_at: hoursAgo(1), sources: [{ url: 'https://www.sec.gov/x' }], ai: { generated: true, label: 'AI-generated summary' }, ...over });

test('maxAgeHours: 6 weekdays, 48 weekends, override wins', () => {
  assert.equal(maxAgeHours(NOW), 6);
  assert.equal(maxAgeHours(new Date('2026-11-14T12:00:00Z')), 48);
  assert.equal(maxAgeHours(new Date('2026-11-15T12:00:00Z')), 48);
  assert.equal(maxAgeHours(NOW, '12'), 12);
  assert.equal(maxAgeHours(NOW, 'abc'), 6);
});

test('title and bundle parsing', () => {
  assert.equal(checkTitle('<title>Element</title>', 'element'), null);
  assert.match(checkTitle('<title>Other</title>', 'Element'), /does not contain/);
  assert.match(checkTitle('<html></html>', 'Element'), /no <title>/);
  assert.equal(findBundle('<script src="/_expo/static/js/web/entry-1.js" defer></script>', 'https://x.dev/'), 'https://x.dev/_expo/static/js/web/entry-1.js');
  assert.equal(findBundle('<p>none</p>', 'https://x.dev/'), null);
});

test('freshness uses the newest card', () => {
  assert.equal(checkFreshness([card({ published_at: hoursAgo(9) }), card({ published_at: hoursAgo(2) })], NOW, 6), null);
  assert.match(checkFreshness([card({ published_at: hoursAgo(9) })], NOW, 6), /9\.0 h old/);
  assert.match(checkFreshness([], NOW, 6), /no cards/);
});

test('feed status', () => {
  assert.equal(checkFeedStatus({ delayed: false }), null);
  assert.equal(checkFeedStatus([{ delayed: false }]), null);
  assert.match(checkFeedStatus({ delayed: true }), /delayed/);
  assert.match(checkFeedStatus(null), /nothing readable/);
});

test('card contract rules', () => {
  assert.deepEqual(checkCards([card()], { disclaimer: 'Informational only' }), []);
  const bad = checkCards([card({ sources: [] }), card({ id: 'c2', ai: { generated: true, label: null } })], { disclaimer: ' ' });
  assert.equal(bad.length, 3);
});

test('feed notice strip text must ship in the bundle (D-80)', () => {
  assert.equal(checkNotice(`x ${FEED_NOTICE_MARKER} · Informational only`), null);
  assert.match(checkNotice('x'.repeat(2000)), /notice strip/);
  assert.match(checkNotice(undefined), /notice strip/);
});

function fakeFetch({ status = 200, cards = [card()], delayed = false, statusCode = 200, cfg = { disclaimer: 'Informational only' }, body = 'x'.repeat(2000) + FEED_NOTICE_MARKER } = {}) {
  const json = (data, s = 200) => ({ ok: s < 400, status: s, json: async () => data, text: async () => JSON.stringify(data) });
  return async (url) => {
    const u = String(url);
    if (u.endsWith('/rpc/feed')) return json({ items: cards, next_cursor: null });
    if (u.endsWith('/rpc/feed_status')) return json({ delayed }, statusCode);
    if (u.includes('/app_config')) return json([cfg]);
    if (u.endsWith('.js')) return { ok: true, status: 200, text: async () => body };
    return { ok: status === 200, status, text: async () => '<title>Element</title><script src="/a.js"></script>' };
  };
}
const run = (f, extra = {}) => runSmoke({ supabaseUrl: 'https://p.supabase.co', key: 'k', now: NOW, fetchFn: f, ...extra });

test('runSmoke all good', async () => {
  const r = await run(fakeFetch());
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
});

test('runSmoke reports each failure', async () => {
  assert.equal((await run(fakeFetch({ status: 503 })))[0].ok, false);
  assert.equal((await run(fakeFetch({ cards: [card({ published_at: hoursAgo(30) })] }))).find((x) => x.name.startsWith('newest')).ok, false);
  assert.equal((await run(fakeFetch({ delayed: true }))).find((x) => x.name.includes('feed_status')).ok, false);
  assert.equal((await run(fakeFetch({ cards: [card({ sources: [] })] }))).at(-1).ok, false);
  assert.equal((await run(fakeFetch({ body: 'tiny' }))).find((x) => x.name.includes('bundle')).ok, false);
  assert.equal((await run(fakeFetch({ body: 'x'.repeat(2000) }))).at(-1).ok, false);
});

test('missing feed_status is skipped, network error is a failure not a crash', async () => {
  const r = await run(fakeFetch({ statusCode: 404 }));
  const fs = r.find((x) => x.name.includes('feed_status'));
  assert.ok(fs.ok && fs.skipped);
  const r2 = await run(async () => { throw new Error('offline'); });
  assert.ok(r2.every((x) => !x.ok));
});
