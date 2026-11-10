// The tour preload in scripts/fix-pages-assets.mjs must use the same "seen" key and skipped paths
// as lib/tutorial/tutorialLogic.ts, or first-time readers lose the preload (or returning readers
// download a chunk they never run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../fix-pages-assets.mjs', import.meta.url), 'utf8');
const logic = readFileSync(new URL('../../lib/tutorial/tutorialLogic.ts', import.meta.url), 'utf8');

test('tour preload uses the tutorial seen key', () => {
  const version = logic.match(/TUTORIAL_VERSION = (\d+)/)?.[1];
  assert.ok(logic.includes('`element.tutorial-seen.v${TUTORIAL_VERSION}`'));
  assert.ok(script.includes(`const TOUR_SEEN_KEY = 'element.tutorial-seen.v${version}';`));
});

test('tour preload skips the same paths as shouldAutoShow', () => {
  const paths = logic.match(/const NO_AUTO_SHOW = (\[[^\]]*\])/)?.[1];
  assert.ok(paths);
  assert.ok(script.includes(`const TOUR_NO_AUTO_SHOW = ${paths};`));
});
