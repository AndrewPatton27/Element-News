import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_SITE, delayedText, footerLabels, linkOutCredit, linkOutDelay, shareUrl } from '../../components/cardFooter.ts';

const D = 'Informational only · Not investment advice';
const AI = 'AI-generated summary · may contain errors';

// The disclaimer must appear exactly once per card, in either slot.
function count(l: { footer: string | null; below: string | null }): number {
  return [l.footer, l.below].filter((s) => s !== null && s.includes(D)).length;
}

test('phones: AI label in the footer, disclaimer once under the card', () => {
  assert.deepEqual(footerLabels(AI, D, false), { footer: AI, below: D });
  assert.deepEqual(footerLabels(null, D, false), { footer: null, below: D });
  assert.equal(count(footerLabels(AI, D, false)), 1);
});

test('wide: one footer line "AI label · disclaimer", nothing below', () => {
  assert.deepEqual(footerLabels(AI, D, true), { footer: `${AI} · ${D}`, below: null });
  assert.deepEqual(footerLabels('  ', D, true), { footer: D, below: null });
  assert.equal(count(footerLabels(AI, D, true)), 1);
  assert.equal(count(footerLabels(null, D, true)), 1);
});

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
