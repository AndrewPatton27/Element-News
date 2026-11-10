import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEED_AI_NOTICE, cardLabels, disclaimerText, feedNoticeText } from '../shared/labels.ts';
import { card, config, dataCard } from './helpers.ts';

// D-80: feed-style screens show one persistent strip with the AI notice and the
// disclaimer (components/shell/FeedNotice.tsx); standalone views keep both per card.
test('the feed notice strip carries the AI notice and the disclaimer, once each, even without config', () => {
  for (const cfg of [config(), config({ disclaimer: '' }), config({ disclaimer: '   ' }), null, undefined]) {
    const line = feedNoticeText(cfg);
    assert.equal(line, 'AI-generated summaries may contain errors · Informational only · Not investment advice');
    assert.equal(line.split('Not investment advice').length - 1, 1);
    assert.equal(line.split('may contain errors').length - 1, 1);
  }
  assert.equal(FEED_AI_NOTICE, 'AI-generated summaries may contain errors');
});

test('every kind of card gets a non-empty disclaimer, even with an empty or missing config', () => {
  for (const c of [card(), dataCard(), card({ ai: { generated: false, label: null } })]) {
    for (const cfg of [config(), config({ disclaimer: '' }), config({ disclaimer: '   ' }), null, undefined]) {
      const labels = cardLabels(c, cfg);
      assert.equal(labels.disclaimer, disclaimerText(cfg));
      assert.match(labels.disclaimer, /Not investment advice/);
    }
  }
});

test('AI label appears only on AI-written cards and the disclaimer is independent of it', () => {
  assert.ok(cardLabels(card(), config()).aiLabel);
  assert.equal(cardLabels(dataCard(), config()).aiLabel, null);
  assert.ok(cardLabels(dataCard(), config()).disclaimer);
});
