// Runs supabase/tests/*_check.sql offline in PGlite (in-memory Postgres). Exit 0 only if every check passed.
// Usage: node supabase/tests/run-pglite.mjs [name-filter ...]     (e.g. node supabase/tests/run-pglite.mjs watchdog)
//
// Setup, once: stand-ins for Supabase's roles, auth.users, auth.uid() and the realtime publication, then every
// migration in order except the pg_cron / pg_net ones (not available in PGlite). The two test users the checks
// look up by email are inserted. Each check runs on a fresh clone of that database, so checks cannot affect each
// other. Every check ends with a deliberate error "ALL ... PASSED" (so its rows roll back); that message is
// the success signal. Any other error, or no such error, is a failure. Nothing is written to disk or the network.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migDir = path.join(root, 'supabase/migrations');
const testDir = path.join(root, 'supabase/tests');
const filters = process.argv.slice(2);

const base = new PGlite();
await base.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create publication supabase_realtime;`);
const migrations = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql') && !f.includes('cron')).sort();
for (const f of migrations) {
  try {
    await base.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  } catch (e) {
    console.error(`migration ${f} failed: ${e.message}`);
    process.exit(1);
  }
}
await base.exec(`insert into auth.users (email) values ('element-test-a@example.com'), ('element-test-b@example.com');`);

// compare-only report, not a pass/fail check: it must just run without error
const reportOnly = new Set(['cutover_compare.sql']);
const files = fs.readdirSync(testDir)
  .filter((f) => (f.endsWith('_check.sql') || reportOnly.has(f)) && (!filters.length || filters.some((x) => f.includes(x))))
  .sort();

let failed = 0;
for (const f of files) {
  const sql = fs.readFileSync(path.join(testDir, f), 'utf8');
  const db = await base.clone();
  let verdict;
  try {
    await db.exec(sql);
    verdict = reportOnly.has(f) ? null : 'finished without the closing "ALL ... PASSED" error';
  } catch (e) {
    const m = String(e.message || e);
    verdict = /ALL .*PASSED/.test(m) ? null : m;
  }
  await db.close();
  console.log(`${verdict ? 'FAIL' : 'PASS'}  ${f}${verdict ? `\n      ${verdict}` : ''}`);
  if (verdict) failed++;
}
await base.close();
console.log(`\n${files.length - failed}/${files.length} SQL checks passed`);
process.exit(failed || !files.length ? 1 : 0);
