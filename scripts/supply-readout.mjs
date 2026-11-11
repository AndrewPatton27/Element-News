// Supply readout: prints card supply facts (cards per ET day by source and category, gaps by hour, live cards per
// topic, items by status and reason, AI use vs caps, Gemini vs Groq share). READ-ONLY.
//   node scripts/supply-readout.mjs                 run every query in supabase/tests/supply_readout.sql through
//                                                   `npx supabase db query --remote --read-only` (needs `supabase login` + link)
//   node scripts/supply-readout.mjs --only items_by_status,pool_size     only these queries
//   node scripts/supply-readout.mjs --print-sql     print the queries (paste them into the Supabase SQL editor)
//   node scripts/supply-readout.mjs --json          machine-readable output
// No keys are read or written here; the Supabase CLI uses Drew's own login. Each query is one `select`, sent as
// its own request (the CLI shows only the last statement of a file).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SQL_FILE = resolve(here, '..', 'supabase', 'tests', 'supply_readout.sql');

/** Splits the SQL file on "-- name: x" lines. Returns [{ name, sql }]; text before the first marker is dropped. */
export function splitQueries(text) {
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^--\s*name:\s*([a-z0-9_]+)\s*$/.exec(line);
    if (m) { cur = { name: m[1], lines: [] }; out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return out.map((q) => ({ name: q.name, sql: q.lines.join('\n').trim() })).filter((q) => q.sql);
}

/** True only for a single read-only statement (select or with ... select), so the script can never write. */
export function isReadOnlySql(sql) {
  const body = sql.replace(/--[^\n]*/g, '').trim().replace(/;\s*$/, '');
  if (body.includes(';')) return false;
  if (!/^(select|with)\b/i.test(body)) return false;
  return !/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do)\b/i.test(body.replace(/'[^']*'/g, "''"));
}

/** The CLI prints {"rows":[...]} (maybe after some log text). */
export function parseRows(text) {
  const i = text.indexOf('{');
  const j = JSON.parse(i >= 0 ? text.slice(i) : text);
  if (!Array.isArray(j.rows)) throw new Error(j.error?.message ? `query failed: ${j.error.message}` : 'no rows in query output');
  return j.rows;
}

/** Plain-text table. */
export function formatTable(rows) {
  if (!rows.length) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const cell = (v) => (v === null || v === undefined ? '' : String(v));
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(w[i])).join('  ').trimEnd();
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
}

/** Real runner: one `supabase db query --remote --read-only` call per query. */
export function cliRunner(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'element-readout-'));
  const file = join(dir, 'q.sql');
  try {
    writeFileSync(file, sql);
    const win = process.platform === 'win32';
    const q = spawnSync(win ? 'npx.cmd' : 'npx', ['supabase', 'db', 'query', '--remote', '--read-only', '-f', file, '--output-format', 'json'],
      { encoding: 'utf8', shell: win, maxBuffer: 64 * 1024 * 1024 });
    if (q.status !== 0) throw new Error(`supabase db query exited ${q.status}: ${(q.stderr || '').slice(0, 300)}`);
    return q.stdout;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Runs the selected queries with `run(sql) -> output text`. Never throws for one failing query. */
export function runReadout(queries, run, only = null) {
  const results = [];
  for (const q of queries) {
    if (only && !only.includes(q.name)) continue;
    if (!isReadOnlySql(q.sql)) { results.push({ name: q.name, error: 'refused: not a single read-only select' }); continue; }
    try { results.push({ name: q.name, rows: parseRows(run(q.sql)) }); } catch (e) { results.push({ name: q.name, error: e.message }); }
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? String(args[args.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : null;
  const queries = splitQueries(readFileSync(SQL_FILE, 'utf8'));
  if (args.includes('--print-sql')) {
    for (const q of queries) if (!only || only.includes(q.name)) console.log(`-- ${q.name}\n${q.sql}\n`);
    return;
  }
  const results = runReadout(queries, cliRunner, only);
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) console.log(`\n== ${r.name}\n${r.error ? `ERROR: ${r.error}` : formatTable(r.rows)}`);
  process.exit(results.some((r) => r.error) ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
