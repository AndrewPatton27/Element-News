import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, groqDailyCap } from '../src/config.ts';

test('the code Groq cap follows the measured sum-v7 tokens (62; the live core.ai_caps row is still 74 until Drew applies it)', () => {
  assert.equal(groqDailyCap(), 62);
  assert.equal(config.groq.dailyCapCode, 80);
});
