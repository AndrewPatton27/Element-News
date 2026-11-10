// Shared PGlite setup for the offline evaluations (search-eval.mjs, feed-eval.mjs).
// Same stand-ins as run-pglite.mjs (roles, auth.users, auth.uid()), then every migration except the pg_cron ones.
// In memory only: nothing is written to disk or the network.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// p_skip: migration file names (or name fragments) to leave out, to measure "before" a change.
export async function makeDb({ skip = [] } = {}) {
  const db = new PGlite();
  await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create publication supabase_realtime;`);
  const dir = path.join(root, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && !f.includes('cron') && !skip.some((s) => f.includes(s))).sort();
  for (const f of files) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { throw new Error(`migration ${f}: ${e.message}`); }
  }
  await db.exec(`insert into auth.users (email) values ('element-test-a@example.com'), ('element-test-b@example.com')`);
  return db;
}

export const rows = (db, sql, params = []) => db.query(sql, params).then((r) => r.rows);

// Run fn as a signed-in reader (role authenticated + JWT claims) or as a guest (uid null), then reset.
export async function as(db, uid, fn) {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role: 'authenticated' }) : '']);
  try { return await fn(); } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); }
}

export async function rpc(db, uid, sql, params = []) {
  return as(db, uid, async () => (await db.query(sql, params)).rows[0]);
}
