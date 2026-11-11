import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAiTrailers, findMojibake, inMojibakeScope } from '../commit-guard.mjs';

test('AI Co-Authored-By trailers are found, human ones are not', () => {
  assert.equal(findAiTrailers('Fix\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>').length, 1);
  assert.equal(findAiTrailers('x\nco-authored-by: GitHub Copilot <copilot@github.com>').length, 1);
  assert.equal(findAiTrailers('x\nCo-authored-by: ChatGPT <bot@openai.com>').length, 1);
  assert.equal(findAiTrailers('x\nGenerated with [Claude Code](https://claude.com/claude-code)').length, 1);
  assert.deepEqual(findAiTrailers('Fix\n\nCo-Authored-By: Pat Smith <pat@example.com>'), []);
  assert.deepEqual(findAiTrailers('Explains the Claude prompt in docs'), []);
});

test('mojibake found by code point, clean text is not', () => {
  const bad = ['a ' + String.fromCharCode(0xc2, 0xb7) + ' b', 'it' + String.fromCharCode(0xe2, 0x20ac) + String.fromCharCode(0x2122) + 's', 'caf' + String.fromCharCode(0xc3, 0xa9)];
  assert.deepEqual(findMojibake(['ok', ...bad].join('\n')), [2, 3, 4]);
  assert.deepEqual(findMojibake('Fine · text ’ café — done'), []);
});

test('mojibake scope is the source folders only', () => {
  assert.ok(inMojibakeScope('lib/feed/x.ts'));
  assert.ok(inMojibakeScope('supabase/migrations/a.sql'));
  assert.ok(!inMojibakeScope('docs/a.md'));
  assert.ok(!inMojibakeScope('lib/img.png'));
  assert.ok(!inMojibakeScope('lib/__tests__/companyLogic.test.ts'));
});
