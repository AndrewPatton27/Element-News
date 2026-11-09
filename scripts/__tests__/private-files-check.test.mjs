import test from 'node:test';
import assert from 'node:assert/strict';
import { findPrivate } from '../private-files-check.mjs';

test('flags notes, context, slides, data dumps and local task helpers', () => {
  const bad = findPrivate(['AGENTS.md', 'PAUSE-NOTES.md', 'a/PAUSE-NOTES.md', '.codex/x', 'context/todo.md', 'docs/PLAN.md',
    'Element_Slideshow_v4.pptx', 'fred_data.csv', 'ingest/run-brief-summary.cmd', '.env', '.env.local', 'CLAUDE.md']);
  assert.equal(bad.length, 12);
});

test('allows code, fixtures and the env example', () => {
  const ok = ['app/index.tsx', 'ingest/src/fixtures/treasury-par-yield-2026.csv', 'contract/fixtures/raw/treasury-par-yield-2026.csv',
    '.env.example', 'README.md', 'supabase/CUTOVER.md'];
  assert.deepEqual(findPrivate(ok), []);
});
