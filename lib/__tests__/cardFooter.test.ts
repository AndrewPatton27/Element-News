import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_SITE, delayedText, linkOutCredit, linkOutDelay, shareUrl } from '../../components/card/cardFooter.ts';

test('link-out delay text', () => {
  assert.equal(delayedText(12), 'Delayed 12 h');
  assert.equal(delayedText(null), null);
  assert.equal(delayedText(0), null);
  assert.equal(delayedText(Number.NaN), null);
});


test('link-out cards always carry "Delayed 12 h" and "via NewsData.io" (rule 7)', () => {
  assert.equal(linkOutDelay(null), 'Delayed 12 h');
  assert.equal(linkOutDelay(12), 'Delayed 12 h');
  assert.equal(linkOutCredit(null), 'via NewsData.io');
  assert.equal(linkOutCredit('Reuters'), 'via NewsData.io');
  assert.equal(linkOutCredit(' via NewsData.io '), 'via NewsData.io');
});

test('share link: https only, falls back to the public site, rejects odd paths', () => {
  assert.equal(shareUrl('/b/c1', 'https://element-news.pages.dev'), 'https://element-news.pages.dev/b/c1');
  assert.equal(shareUrl('/b/c1', 'http://localhost:8081'), `${PUBLIC_SITE}/b/c1`);
  assert.equal(shareUrl('/b/c1', null), `${PUBLIC_SITE}/b/c1`);
  assert.equal(shareUrl('/b/c1', 'http://x', 'http://y'), null);
  assert.equal(shareUrl('javascript:alert(1)', 'https://a.b'), null);
  assert.equal(shareUrl('/b/../x', 'https://a.b'), null);
  assert.equal(shareUrl(null, 'https://a.b'), null);
});
