import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeEarly, EARLY_FEED_MAX_AGE_MS } from '../feed/earlyFeed.ts';

const K = 'k|{"a":1}';
const mk = (n = 1, t = 1000) => ({ __elementEarly: { [K]: { t, n, p: Promise.resolve({ ok: 1 }) } } });

test('early: same key, signed out, fresh -> used once', async () => {
  const h = mk();
  assert.deepEqual(await takeEarly(h, K, false, 2000), { ok: 1 });
  assert.equal(takeEarly(h, K, false, 2000), null);
});
test('early: n=2 serves two callers, then is gone', async () => {
  const h = mk(2);
  assert.deepEqual(await takeEarly(h, K, false, 2000), { ok: 1 });
  assert.deepEqual(await takeEarly(h, K, false, 2000), { ok: 1 });
  assert.equal(takeEarly(h, K, false, 2000), null);
});
test('early: other key keeps the entry; token or stale -> ignored', () => {
  const h = mk();
  assert.equal(takeEarly(h, 'k|{"a":2}', false, 2000), null);
  assert.notEqual(takeEarly(h, K, false, 2000), null);
  assert.equal(takeEarly(mk(), K, true, 2000), null);
  assert.equal(takeEarly(mk(), K, false, 1000 + EARLY_FEED_MAX_AGE_MS + 1), null);
  assert.equal(takeEarly({}, K, false), null);
  assert.equal(takeEarly(undefined, K, false), null);
});
