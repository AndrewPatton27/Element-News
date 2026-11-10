import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPIED, COPY_BY_HAND, COPY_FAILED, shareLink } from '../share/shareFlow.ts';

const url = 'https://element-news.pages.dev/b/abc';
const fail = async () => { throw new Error('denied'); };

test('system share sheet handles it: no toast', async () => {
  assert.equal(await shareLink('t', url, { share: async () => undefined }), null);
});

test('reader closes the share sheet: no toast, no copy', async () => {
  let copied = false;
  const r = await shareLink('t', url, {
    share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); },
    writeText: async () => { copied = true; },
  });
  assert.equal(r, null);
  assert.equal(copied, false);
});

test('no share API: clipboard copy', async () => {
  assert.equal(await shareLink('t', url, { writeText: async () => undefined }), COPIED);
});

test('share fails and clipboard is denied: legacy copy', async () => {
  assert.equal(await shareLink('t', url, { share: fail, writeText: fail, legacyCopy: () => true }), COPIED);
});

test('everything fails: manual copy box, then an honest failure message', async () => {
  let shown = '';
  assert.equal(await shareLink('t', url, { writeText: fail, legacyCopy: () => false, manualCopy: (t) => { shown = t; } }), COPY_BY_HAND);
  assert.equal(shown, url);
  assert.equal(await shareLink('t', url, {}), COPY_FAILED);
});
