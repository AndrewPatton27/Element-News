import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastFeedTab, rememberFeedTab, resetLastFeedTab, startFeedTab } from '../feed/lastTab.ts';

test('first launch opens Trending', () => {
  resetLastFeedTab();
  assert.equal(lastFeedTab(), 'top');
  assert.equal(startFeedTab(undefined), 'top');
});

test('the last-used tab comes back when the link names none', () => {
  resetLastFeedTab();
  rememberFeedTab('latest');
  assert.equal(startFeedTab(undefined), 'latest');
  rememberFeedTab('for_you');
  assert.equal(startFeedTab(''), 'for_you');
});

test('a tab named in the link wins; junk is ignored', () => {
  resetLastFeedTab();
  rememberFeedTab('latest');
  assert.equal(startFeedTab('top'), 'top');
  assert.equal(startFeedTab(['for_you']), 'for_you');
  rememberFeedTab('nonsense');
  assert.equal(startFeedTab('zzz'), 'latest');
});
