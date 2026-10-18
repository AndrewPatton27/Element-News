// The Brief summary is about 250 words in 3 to 4 paragraphs (Drew, 2026-10-18).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSummaryText, validateBriefSummary, templateBriefSummary } from '../src/briefSummary.ts';

const WORDS = ('river harbor orchard lantern meadow copper violin glacier compass thunder velvet marble falcon ember prairie quartz ' +
  'saddle tundra willow zephyr anchor bronze cinder dune fjord granite hollow island jungle kettle lagoon mosaic nectar oasis pebble ' +
  'quiver ribbon summit timber umbra valley wagon yonder zenith acorn basalt canyon dahlia eagle fennel gable heron indigo jasmine ' +
  'kernel lichen mango nutmeg opal paprika quince radish sorrel thistle upland vervain walnut xenon yarrow zinnia').split(' ');

/** n words from the list, made into distinct sentences of 10 words. */
function paragraph(startWord: number, sentences: number): string {
  const out: string[] = [];
  for (let s = 0; s < sentences; s++) {
    const ws: string[] = [];
    for (let i = 0; i < 10; i++) ws.push(WORDS[(startWord + s * 7 + i * 3) % WORDS.length]!);
    out.push(`${ws.join(' ')}.`.replace(/^./, (c) => c.toUpperCase()));
  }
  return out.join(' ');
}
const SOURCE = 'BRIEF:\nSTORY nothing numeric here';

test('about 250 words in 3 paragraphs passes the length and paragraph rules', () => {
  const text = [paragraph(0, 8), paragraph(11, 8), paragraph(23, 8)].join('\n\n'); // 240 words
  const errors = validateBriefSummary(text, SOURCE).filter((e) => /^(shorter than|longer than|needs )/.test(e));
  assert.deepEqual(errors, []);
});

test('a short, one-paragraph summary is rejected', () => {
  const text = paragraph(0, 4);
  const errors = validateBriefSummary(text, SOURCE).join('; ');
  assert.match(errors, /shorter than/);
  assert.match(errors, /paragraphs/);
});

test('a summary over the word limit is rejected', () => {
  const text = [paragraph(0, 12), paragraph(11, 12), paragraph(23, 12)].join('\n\n'); // 360 words
  assert.match(validateBriefSummary(text, SOURCE).join('; '), /longer than/);
});

test('cleaning keeps paragraph breaks and squeezes other whitespace', () => {
  assert.equal(cleanSummaryText('One   two\n\n\n  three  four\nfive'), 'One two\n\nthree four five');
});

test('the template fallback also comes out in separate paragraphs', () => {
  const brief = { headline_cards: [{ headline: 'A' }, { headline: 'B' }, { headline: 'C' }], sections: [{ label: 'X', cards: [{}] }, { label: 'Y', cards: [{}] }] } as never;
  assert.ok(templateBriefSummary('daily', brief).includes('\n\n'));
});
