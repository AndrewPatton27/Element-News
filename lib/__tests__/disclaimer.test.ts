import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disclaimerPlacement, disclaimerText, cardLabels } from '../labels.ts';
import { card, config, dataCard } from './helpers.ts';

// Card.tsx renders the disclaimer from disclaimerPlacement: count the slots it fills.
const slotsFilled = (hasReactions: boolean): number => {
  const p = disclaimerPlacement(hasReactions);
  return Number(p.inline) + Number(p.below);
};

test('disclaimer is rendered exactly once, with or without reaction buttons', () => {
  assert.equal(slotsFilled(false), 1);
  assert.equal(slotsFilled(true), 1);
  assert.deepEqual(disclaimerPlacement(false), { inline: true, below: false });
  assert.deepEqual(disclaimerPlacement(true), { inline: false, below: true });
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
