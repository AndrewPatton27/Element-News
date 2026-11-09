// Parity runner for ml/tests/test_bandit.py: applies every migration in PGlite (an in-memory Postgres),
// loads a fixture and prints what core.v2_scores, core.v2_features and core.v2_normal return, as JSON.
// usage: node pglite_parity.mjs <repo root> <fixture.json>
// PGlite is found through the PGLITE_PACKAGE_JSON environment variable: the path of a package.json
// whose node_modules contains @electric-sql/pglite. No network, nothing written outside memory.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [repo, fixturePath] = process.argv.slice(2);
const require = createRequire(process.env.PGLITE_PACKAGE_JSON);
const { PGlite } = require('@electric-sql/pglite');
const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const db = new PGlite();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create publication supabase_realtime;`);
const migs = fs.readdirSync(path.join(repo, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql') && !f.includes('cron_schedule')).sort();      // pg_cron is not in PGlite
for (const f of migs) await db.exec(fs.readFileSync(path.join(repo, 'supabase/migrations', f), 'utf8'));

for (const [k, v] of Object.entries(fx.params || {})) {
  await q('insert into core.rank_params (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, v]);
}
await q('insert into auth.users (id, email) values ($1, $2)', [fx.user, 'parity@example.com']);
await q('insert into core.user_prefs (user_id, followed_categories, hidden_categories, hidden_sources) values ($1, $2, $3, $4)',
  [fx.user, fx.prefs.followed, fx.prefs.hidden_categories, fx.prefs.hidden_sources]);
await q(`update core.blurbs set status = 'hidden'`);
for (const c of fx.cards) {
  await q(`insert into core.blurbs (id, dedupe_key, kind, headline, body, category, event_type, status, as_of, sort_at,
                                    published_at, rank_score, macro)
           values ($1::uuid, $1::uuid::text, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz, $9::timestamptz, $10, $11::jsonb)`,
    [c.id, c.kind, c.headline, c.body, c.category, c.event_type, c.status, c.sort_at, c.published_at, c.rank_score,
     JSON.stringify(c.series.map((s) => ({ series_id: s })))]);
  if (c.source_name) {
    await q(`insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
             values ($1::uuid, $2, 'government', 'https://www.sec.gov/p/' || $1::uuid::text, 'public_domain', true)`, [c.id, c.source_name]);
  }
}
for (const e of fx.events) {
  await q('insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at, slot) values ($1, $2, $3, $4, $5, $6)',
    [fx.user, e.blurb_id, e.kind, e.dwell_ms, e.created_at, e.slot]);
}
const m = await q(`select (api.ml_write_weights($1::jsonb, $2::jsonb) ->> 'model_id')::bigint as id`,
  [JSON.stringify({ version: 'parity', gate_passed: true }), JSON.stringify(fx.model_rows)]);
const model = m[0].id;
const out = {
  model,
  written: (await q('select count(*)::int as n from core.ml_weights where model_id = $1', [model]))[0].n,
  scores: await q(`select o_id::text as id, o_category as category, o_s0::float8 as s0, o_bandit::float8 as bandit, o_ps::float8 as ps
                     from core.v2_scores($1, $2::timestamptz, $3, $4) order by o_ps desc, o_id desc`, [fx.user, fx.asof, model, fx.seed]),
  cards: await q(`select b.id::text as id, b.word_count,
                         case when b.kind = 'data' then 'fred' else core.source_key_of(b.kind, b.id) end as skey,
                         core.v2_features(b.category, coalesce(b.event_type, b.kind),
                                          case when b.kind = 'data' then 'fred' else core.source_key_of(b.kind, b.id) end,
                                          b.headline, b.macro) as features
                    from core.blurbs b where b.status = 'published' or b.id = any ($1::uuid[])`, [fx.cards.map((c) => c.id)]),
  normals: await q(`select f, core.v2_normal($1, f, $2) as z from unnest($3::text[]) f`, [fx.user, fx.seed, fx.normal_features]),
  holdout: (await q('select core.v2_holdout($1) as h', [fx.user]))[0].h,
  tag_rules: await q('select match_kind, pattern, tag from core.tag_rules order by id'),
};
process.stdout.write(JSON.stringify(out));
