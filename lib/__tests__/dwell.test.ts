import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DWELL_MAX_MS, DwellTimer } from '../dwell.ts';

test('dwell is sent when the reader moves on, only if long enough', () => {
  const t = new DwellTimer();
  assert.equal(t.show('a', 0), null);
  assert.deepEqual(t.show('b', 4000), { cardId: 'a', ms: 4000 });
  assert.equal(t.show('c', 4200), null, 'a 200 ms scroll-by is not sent');
  assert.deepEqual(t.finish(4500), { cardId: 'c', ms: 300 }, '300 ms is the minimum that counts');
});

test('hidden tab, open sheet and other screens pause the clock', () => {
  const t = new DwellTimer();
  t.show('a', 0);
  t.pause('hidden', 1000); // 1 s seen
  assert.equal(t.elapsed(60_000), 1000, 'nothing counts while the tab is hidden');
  t.resume('hidden', 60_000);
  t.pause('sheet', 62_000); // +2 s
  t.pause('away', 63_000);
  t.resume('sheet', 70_000);
  assert.equal(t.elapsed(80_000), 3000, 'still paused: another screen is on top');
  t.resume('away', 80_000);
  assert.deepEqual(t.show('b', 81_000), { cardId: 'a', ms: 4000 });
});

test('a card shown while paused starts counting only after resume', () => {
  const t = new DwellTimer();
  t.pause('away', 0);
  t.show('a', 1000);
  assert.equal(t.elapsed(5000), 0);
  t.resume('away', 5000);
  assert.deepEqual(t.finish(7000), { cardId: 'a', ms: 2000 });
});

test('long looks are capped; showing the same card again changes nothing', () => {
  const t = new DwellTimer();
  t.show('a', 0);
  assert.equal(t.show('a', 5000), null, 'same card: still one look');
  assert.deepEqual(t.finish(DWELL_MAX_MS + 99_999), { cardId: 'a', ms: DWELL_MAX_MS });
  assert.equal(t.finish(1), null, 'nothing left after finish');
});
