import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  LAST_ERROR_KEY,
  claimChunkReload,
  crashRecord,
  installChunkReload,
  isChunkLoadError,
  readCrash,
  reloadForChunkError,
  sanitizeErrorText,
  saveCrash,
  type SessionLike,
} from '../shared/crashReport.ts';
import { parseFeedPage } from '../shared/types.ts';
import { card } from './helpers.ts';

function session(): SessionLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}
function fakeWindow() {
  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  const w = {
    sessionStorage: session(),
    reloads: 0,
    location: { pathname: '/search', reload: () => { w.reloads++; } },
    addEventListener: (t: string, fn: (ev: unknown) => void) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: (t: string, fn: (ev: unknown) => void) => listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)),
    fire: (t: string, ev: unknown) => (listeners.get(t) ?? []).forEach((f) => f(ev)),
  };
  return w;
}

// The real messages from the production web build (expo fetchThenEval.web + metro require).
const STALE_HTML = new Error('Requiring unknown module "1742".'); // old search-<hash>.js answered with index.html (200)
const STALE_404 = Object.assign(new Error('Loading module https://element-news.pages.dev/_expo/static/js/web/search-de0e.js failed.\n(error: ...)'), { name: 'AsyncRequireError' });

test('stale screen files are recognised as chunk-load errors', () => {
  assert.equal(isChunkLoadError(STALE_HTML), true);
  assert.equal(isChunkLoadError(STALE_404), true);
  assert.equal(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /x.js')), true);
  assert.equal(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' })), true);
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of null (reading 'map')")), false);
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError('Requiring unknown module "9"'), true);
});

test('a stale chunk reloads the page once, not in a loop', () => {
  const w = fakeWindow();
  const t0 = 1_000_000;
  assert.equal(reloadForChunkError(STALE_HTML, w, t0), true);
  assert.equal(w.reloads, 1);
  assert.equal(w.sessionStorage.getItem(CHUNK_RELOAD_KEY), String(t0));
  // the new page fails again within the window: no second reload, the error screen shows instead
  assert.equal(reloadForChunkError(STALE_HTML, w, t0 + 5_000), false);
  assert.equal(w.reloads, 1);
  // much later (a later deploy) it may reload again
  assert.equal(reloadForChunkError(STALE_404, w, t0 + CHUNK_RELOAD_WINDOW_MS + 1), true);
  assert.equal(w.reloads, 2);
});

test('ordinary errors and missing storage never reload', () => {
  const w = fakeWindow();
  assert.equal(reloadForChunkError(new Error('boom'), w), false);
  assert.equal(claimChunkReload(null), false);
  const throwing: SessionLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(claimChunkReload(throwing), false);
  assert.equal(w.reloads, 0);
});

test('an unhandled chunk rejection outside React reloads once and is recorded', () => {
  const w = fakeWindow();
  const off = installChunkReload(w);
  w.fire('unhandledrejection', { reason: STALE_HTML });
  w.fire('unhandledrejection', { reason: new Error('unrelated') });
  assert.equal(w.reloads, 1);
  assert.equal(readCrash(w.sessionStorage)?.chunk, true);
  off();
  w.fire('unhandledrejection', { reason: STALE_HTML });
  assert.equal(w.reloads, 1);
});

test('crash records keep the error and component stack but nothing private', () => {
  const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTYifQ', 'c2lnbmF0dXJlLXZhbHVl'].join('.'); // built at run time so the secret scan stays quiet
  const err = new Error('HTTP 401: JWT ' + fakeJwt + ' expired for drew@example.com at https://x.supabase.co/rest/v1/rpc/search?apikey=sb_publishable_abc123');
  const rec = crashRecord(err, { componentStack: '\n    at SearchResultCard\n    at SearchResults\n    at SearchScreen', where: 'search', now: new Date('2026-11-09T12:00:00Z'), path: '/search' });
  assert.equal(rec.where, 'search');
  assert.equal(rec.at, '2026-11-09T12:00:00.000Z');
  assert.match(rec.componentStack, /SearchResultCard/);
  assert.doesNotMatch(JSON.stringify(rec), /eyJhbGci|drew@example\.com|sb_publishable_abc123|apikey=sb/);
  assert.match(rec.message, /\[jwt\]/);
  assert.match(rec.message, /\[email\]/);
  assert.equal(sanitizeErrorText('Bearer abc.def.ghi'), 'Bearer [redacted]');
  assert.ok(sanitizeErrorText('x'.repeat(5000)).length <= 600);
  const s = session();
  saveCrash(s, rec);
  assert.ok(s.data.has(LAST_ERROR_KEY));
  assert.deepEqual(readCrash(s), rec);
  assert.equal(readCrash(session()), null);
});

// Search's data path: odd rows from the server are dropped instead of reaching a renderer.
test('search pages with unexpected shapes never throw and keep only renderable cards', () => {
  const good = card({ id: 'ok' });
  const page = parseFeedPage({
    items: [
      good,
      { ...good, id: 'nokind', kind: null },
      { ...good, id: 'linkout', kind: 'link_out' },
      { ...good, id: 'nomacro', macro: null },
      { ...good, id: 'notickers', tickers: null },
      { ...good, id: 'nosrc', sources: [] },
      { ...good, id: 'withimage', image: { url: 'https://example.com/i.png' } },
      { ...good, id: 'nulldetail', detail: null },
      null,
      'junk',
    ],
    next_cursor: 42,
  });
  assert.deepEqual(page.items.map((c) => c.id), ['ok', 'withimage', 'nulldetail']);
  assert.equal(page.next_cursor, null);
});
