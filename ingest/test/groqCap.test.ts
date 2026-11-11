import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, groqCapFromMeasuredTokens, groqDailyCap } from '../src/config.ts';

test('groqCapFromMeasuredTokens: TPD x 0.9 / tokens per call, limited by RPD; bad input gives 0', () => {
  const g = { freeRpd: 1000, freeTpd: 200_000 };
  assert.equal(groqCapFromMeasuredTokens(3200, g), 56);
  assert.equal(groqCapFromMeasuredTokens(2700, g, 1), 74, 'safety 1 reproduces the current 74');
  assert.equal(groqCapFromMeasuredTokens(100, { freeRpd: 1000, freeTpd: 200_000 }), 1000, 'RPD binds for a tiny call');
  assert.equal(groqCapFromMeasuredTokens(100, { freeRpd: 50, freeTpd: null }), 50);
  for (const bad of [0, -5, NaN, null, undefined]) assert.equal(groqCapFromMeasuredTokens(bad as number, g), 0);
  assert.equal(groqCapFromMeasuredTokens(3000, { freeRpd: null, freeTpd: null }), 0, 'no limits known: no computed cap');
});

test('the live Groq cap is unchanged (74)', () => {
  assert.equal(groqDailyCap(), 74);
  assert.equal(config.groq.dailyCapCode, 80);
});
