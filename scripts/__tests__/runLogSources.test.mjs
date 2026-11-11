// Review m9c: replaying the migrations in file order must leave ingest.run_log_source_check accepting every source the
// ingest function can run. PGlite skips the files with "cron" in their name, so this is a static replay of the three
// styles used: a hard-coded list (replaces the set) and the read-and-extend DO block (adds its array[...] names).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'supabase/migrations';
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

function replay() {
  let set = new Set();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8').replace(/^\s*--.*$/gm, '');
    if (!sql.includes('run_log_source_check')) continue;
    const hard = sql.match(/add constraint run_log_source_check\s*check\s*\(\s*source in \(([^)]*)\)\)/i);
    if (hard && !hard[1].includes('%s')) set = new Set([...hard[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    const ext = sql.match(/unnest\(names \|\| array\[([^\]]*)\]\)/i);
    if (ext) [...ext[1].matchAll(/'([^']+)'/g)].forEach((m) => set.add(m[1]));
  }
  return set;
}

test('the migration chain leaves run_log_source_check accepting every ingest source', () => {
  const src = readFileSync('ingest/src/pipeline.ts', 'utf8');
  const list = src.match(/SOURCE_NAMES: readonly SourceName\[\] = \[([^\]]*)\]/)[1];
  const names = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 20);
  const have = replay();
  const missing = [...names, 'brief-summary'].filter((n) => !have.has(n));
  assert.deepEqual(missing, []);
});
