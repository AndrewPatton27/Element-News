import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_NOTICE_FALLBACK,
  DISCLAIMER_FALLBACK,
  RENDERABLE_KINDS,
  cardLabels,
  cardNotices,
  howMadeText,
  isRenderableKind,
  noticesFor,
  shareAlikeCredit,
  sourcesText,
  CC_BY_SA_LICENSE_URL,
} from '../shared/labels.ts';
import { card, config, dataCard } from './helpers.ts';

test('exact fallback strings match the project rules', () => {
  assert.equal(DISCLAIMER_FALLBACK, 'Informational only · Not investment advice');
  assert.equal(AI_NOTICE_FALLBACK, 'AI-generated summary · may contain errors');
});

test('no card kind renders without the disclaimer', () => {
  const configs = [config(), null, undefined, config({ disclaimer: '' }), config({ disclaimer: '   ' })];
  for (const kind of RENDERABLE_KINDS) {
    for (const generated of [true, false]) {
      for (const cfg of configs) {
        const c = card({ kind, ai: { generated, label: generated ? 'x' : null } });
        const labels = cardLabels(c, cfg);
        assert.ok(labels.disclaimer.trim().length > 0, `kind=${kind} generated=${generated}`);
        if (!cfg || !cfg.disclaimer.trim()) assert.equal(labels.disclaimer, DISCLAIMER_FALLBACK);
      }
    }
  }
});

test('AI label comes from app_config, not from the card', () => {
  const c = card({ ai: { generated: true, label: 'something else' } });
  assert.equal(cardLabels(c, config({ ai_notice: 'Config notice' })).aiLabel, 'Config notice');
  assert.equal(cardLabels(c, null).aiLabel, AI_NOTICE_FALLBACK);
});

test('template cards (ai.generated false) carry no AI label', () => {
  assert.equal(cardLabels(card({ ai: { generated: false, label: null } }), config()).aiLabel, null);
});

test('only summary and data kinds render', () => {
  assert.equal(isRenderableKind('summary'), true);
  assert.equal(isRenderableKind('data'), true);
  assert.equal(isRenderableKind('link_out'), false);
  assert.equal(isRenderableKind('video'), false);
  assert.equal(isRenderableKind(undefined), false);
});

test('sources text counts extra outlets', () => {
  assert.equal(sourcesText(card()), 'SEC');
  assert.equal(sourcesText(card({ source_count: 3 })), 'SEC · +2 sources');
  assert.equal(sourcesText(card({ source_count: 2 })), 'SEC · +1 source');
});

test('FRED notice shows on FRED data cards only', () => {
  assert.deepEqual(
    cardNotices(dataCard(), config()).map((n) => n.key),
    ['fred'],
  );
  assert.deepEqual(cardNotices(dataCard({ macro: [] }), config()), []);
  assert.deepEqual(cardNotices(card(), config()), []);
  assert.deepEqual(
    noticesFor(config(), 'about').map((n) => n.key),
    ['takedown'],
  );
  assert.deepEqual(noticesFor(null, 'about'), []);
});

test('how-made text is honest about AI use', () => {
  assert.match(howMadeText(card()), /An AI wrote this summary/);
  assert.match(howMadeText(card({ ai: { generated: false, label: null } })), /No AI was used/);
  assert.match(howMadeText(dataCard()), /No AI was used/);
});

test('share-alike credit: shown for cc_by_sa sources with a license link', () => {
  const wiki = card({
    attribution: 'Adapted from Wikipedia ("Nobel Prize") · CC BY-SA 4.0',
    sources: [
      {
        name: 'Wikipedia',
        kind: 'news',
        doc_label: 'In the news',
        url: 'https://en.wikipedia.org/wiki/Nobel_Prize',
        published_at: '2026-10-17T12:00:00Z',
        license_class: 'cc_by_sa' as never,
        attribution: 'Adapted from Wikipedia ("Nobel Prize") · CC BY-SA 4.0',
        is_primary: true,
      },
    ],
  });
  const credit = shareAlikeCredit(wiki, null);
  assert.ok(credit);
  assert.equal(credit.text, 'Adapted from Wikipedia ("Nobel Prize") · CC BY-SA 4.0');
  assert.equal(credit.articleUrl, 'https://en.wikipedia.org/wiki/Nobel_Prize');
  assert.equal(credit.licenseUrl, CC_BY_SA_LICENSE_URL);
  const cfg = config({ required_notices: [{ key: 'cc_by_sa', text: 'x', url: 'https://example.org/by-sa', placements: ['about'] }] });
  assert.equal(shareAlikeCredit(wiki, cfg)?.licenseUrl, 'https://example.org/by-sa');
  const noAttr = { ...wiki, attribution: null, sources: [{ ...wiki.sources[0], attribution: null }] };
  assert.equal(shareAlikeCredit(noAttr, null)?.text, 'Adapted from Wikipedia · CC BY-SA 4.0');
  assert.equal(shareAlikeCredit(card(), cfg), null);
  // the disclaimer and AI label still apply to share-alike cards
  assert.equal(cardLabels(wiki, null).disclaimer, DISCLAIMER_FALLBACK);
  assert.equal(cardLabels(wiki, null).aiLabel, AI_NOTICE_FALLBACK);
});
