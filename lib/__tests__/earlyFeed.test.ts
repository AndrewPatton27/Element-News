import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeEarlyFeed, EARLY_FEED_MAX_AGE_MS } from '../earlyFeed.ts';

const mk = (body = '{"a":1}', t = 1000) => ({ __elementEarly: { body, t, p: Promise.resolve({ ok: 1 }) } });

test('early feed: same body, signed out, fresh -> used once', async () => {
  const h = mk();
  const p = takeEarlyFeed(h, '{"a":1}', false, 2000);
  assert.deepEqual(await p, { ok: 1 });
  assert.equal(takeEarlyFeed(h, '{"a":1}', false, 2000), null);
});
test('early feed: different body, token or stale -> ignored and cleared', () => {
  assert.equal(takeEarlyFeed(mk(), '{"a":2}', false, 2000), null);
  assert.equal(takeEarlyFeed(mk(), '{"a":1}', true, 2000), null);
  assert.equal(takeEarlyFeed(mk(), '{"a":1}', false, 1000 + EARLY_FEED_MAX_AGE_MS + 1), null);
  assert.equal(takeEarlyFeed({}, '{"a":1}', false), null);
  assert.equal(takeEarlyFeed(undefined, '{"a":1}', false), null);
});
