// Offline timing of the first page with and without seen-card exclusion, in PGlite (in-memory Postgres).
// Not a pass/fail check (it is not named *_check.sql, so npm run test:sql skips it).
//   node supabase/tests/bench-seen.mjs [events ...]      default: 10000 100000 1000000
// One reader owns all the events (the worst case: a long-lived heavy reader), spread over 400 days:
// 60 % views, 35 % dwells, 3 % opens, 2 % likes. 2000 published cards (under the 3000-candidate guard).
// Compares: seen_exclude_mode 0 (the old cost) against 1, for Trending, For you v5 (foryou_ml_mode 0) and
// For you v3 (foryou_ml_mode 3, no holdout). WebAssembly Postgres on one core: read the ratios, not the
// absolute milliseconds.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migDir = path.join(root, 'supabase/migrations');
const sizes = process.argv.slice(2).map(Number).filter(Boolean);
if (!sizes.length) sizes.push(10_000, 100_000, 1_000_000);

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
for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql') && !x.includes('cron')).sort()) await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
await db.exec(`insert into auth.users (email) values ('bench@example.com');
update core.blurbs set status = 'hidden';
insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
select 'bench-' || g, 'summary', 'Bench story ' || g, (array['markets','world','tech','policy','energy','deals'])[1 + g % 6], now(),
       now() - make_interval(secs => g * 1200), round((extract(epoch from now()) / 3600)::numeric, 6) + 20 - g * 0.01
  from generate_series(1, 2000) g;`);
const uid = (await db.query(`select id from auth.users where email = 'bench@example.com'`)).rows[0].id;

async function asReader() {
  await db.exec(`select set_config('role', 'authenticated', false); select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false);`);
}
async function asAdmin() { await db.exec(`select set_config('role', 'none', false);`); }
// Old and new alternate on the same connection (warm-up first), so drift and cache effects hit both alike.
async function abTime(sql, runs = 7) {
  const mode = async (m) => { await asAdmin(); await setParam('seen_exclude_mode', m); await asReader(); };
  for (const m of [0, 1]) { await mode(m); await db.query(sql); }
  const t = { 0: [], 1: [] };
  for (let i = 0; i < runs; i++) {
    for (const m of [0, 1]) {
      await mode(m);
      const a = performance.now(); await db.query(sql); t[m].push(performance.now() - a);
    }
  }
  await asAdmin();
  const med = (x) => x.sort((p, q) => p - q)[Math.floor(x.length / 2)];
  return [med(t[0]), med(t[1])];
}
async function setParam(key, value) { await db.query(`update core.rank_params set value = $2 where key = $1`, [key, value]); }

console.log('events      surface        old(ms)  new(ms)  ratio   (median of 7 alternating runs, first page of 20)');
for (const n of sizes) {
  await db.exec('delete from core.user_events');
  await db.query(`
    insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at)
    select $1, b.id, k.kind, case when k.kind = 'dwell' then 3000 end, now() - make_interval(secs => random() * 400 * 86400)
      from (select g, case when g % 100 < 60 then 'view' when g % 100 < 95 then 'dwell' when g % 100 < 98 then 'open_detail' else 'like' end as kind
              from generate_series(1, $2::int) g) k
      join (select id, row_number() over (order by id) as rn from core.blurbs where status = 'published' limit 2000) b on b.rn = 1 + (k.g::bigint * 7919) % 2000
    on conflict do nothing`, [uid, n]);
  await db.exec('analyze core.user_events');
  const have = (await db.query('select count(*)::int as n from core.user_events')).rows[0].n;
  const cases = [
    ['Trending', `select api.feed('top', null, 20)`, 0],
    ['For you v5', `select api.feed_for_you(null, 20)`, 0],
    ['For you v3', `select api.feed_for_you(null, 20)`, 3],
  ];
  for (const [name, sql, mode] of cases) {
    await setParam('foryou_ml_mode', mode); await setParam('v3_holdout_pct', 0);
    const [old, cur] = await abTime(sql);
    console.log(`${String(have).padEnd(11)} ${name.padEnd(13)} ${old.toFixed(0).padStart(8)} ${cur.toFixed(0).padStart(8)} ${(cur / old).toFixed(2).padStart(6)}`);
  }
  const t0 = performance.now();
  await db.query(`select core.seen_ids($1, clock_timestamp())`, [uid]);
  console.log(`            seen_ids alone ${(performance.now() - t0).toFixed(1)} ms`);
}
