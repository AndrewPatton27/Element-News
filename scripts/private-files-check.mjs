// Fails if a local-only file is tracked by git: agent notes, context and docs, slideshows, data dumps,
// local task helpers, env files (Drew, 2026-11-09: never push these).
// Usage: node scripts/private-files-check.mjs   (exit 1 and the offending paths if any)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Paths (git ls-files style, forward slashes) that must never be tracked. Fixture CSVs are code and allowed. */
const PRIVATE = [
  /^AGENTS\.md$/i,
  /^CLAUDE\.md$/,
  /(^|\/)PAUSE-NOTES\.md$/i,
  /^\.codex\//,
  /^context\//,
  /^docs\//,
  /(^|\/)\.env(\..*)?$/,
  /\.(pptx|potx|ppt|key)$/i,
  /^[^/]+\.csv$/i,
  /^ingest\/run-[^/]*\.cmd$/i,
];
const ALLOWED = [/^\.env\.example$/, /(^|\/)\.env\.example$/];

export function findPrivate(paths) {
  return paths.filter((p) => PRIVATE.some((r) => r.test(p)) && !ALLOWED.some((r) => r.test(p)));
}

export function trackedFiles() {
  const r = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ls-files failed');
  return r.stdout.split('\n').filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = findPrivate(trackedFiles());
  if (bad.length) {
    console.error('Private or local-only files are tracked by git:\n' + bad.map((p) => '  ' + p).join('\n'));
    console.error('Remove them from the index (git rm --cached <file>) and add them to .gitignore.');
    process.exit(1);
  }
  console.log('private-files-check: no local-only files tracked');
}
