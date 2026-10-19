// "Deleted" confirmation: wording, what a clear removes, and the mock-mode account path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELETED_HOME, deletedContent } from '../account/deletedNotice.ts';
import { DEVICE_DATA_KEYS, clearAll } from '../storage/localPrefs.ts';
import { memoryStore } from '../storage/storage.ts';
import { createMockAccount } from '../account/account.ts';
import { DELETE_CONFIRM_WORD, deleteConfirmed } from '../account/session.ts';

test('titles name what was deleted, one primary button back to the feed', () => {
  assert.equal(deletedContent('account').title, 'Your account and data have been deleted');
  assert.equal(deletedContent('device').title, 'This device’s data has been deleted');
  for (const k of ['account', 'data', 'device'] as const) {
    assert.equal(deletedContent(k).button, 'Back to the feed');
    assert.ok(deletedContent(k).label.length > 0);
  }
  assert.equal(DELETED_HOME, '/');
});

test('clearAll removes every device key, including For you history, followed stories and the brief email', () => {
  const s = memoryStore();
  for (const k of DEVICE_DATA_KEYS) s.set(k, 'x');
  s.set('element.session.v1', 'keep'); // the login session is not device data
  clearAll(s);
  for (const k of DEVICE_DATA_KEYS) assert.equal(s.get(k), null, k);
  assert.equal(s.get('element.session.v1'), 'keep');
  for (const k of ['element.seen-stories', 'element.followedStories', 'element.brief-email', 'element.signin-prompt-dismissed']) {
    assert.ok((DEVICE_DATA_KEYS as readonly string[]).includes(k), k);
  }
});

test('typed confirmation still gates the account delete', () => {
  assert.equal(deleteConfirmed(''), false);
  assert.equal(deleteConfirmed(DELETE_CONFIRM_WORD), true);
});

test('mock account: deleting signs out and a second delete fails (so no notice would show)', async () => {
  const acct = createMockAccount(() => [], memoryStore());
  await acct.signIn('a@example.com', 'password123');
  assert.ok(acct.currentUser());
  await acct.deleteAccount();
  assert.equal(acct.currentUser(), null);
  await assert.rejects(acct.deleteAccount());
});
