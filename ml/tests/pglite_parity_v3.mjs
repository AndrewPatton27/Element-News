// Parity runner for ml/tests/test_v3_sql.py: applies every migration in PGlite (an in-memory Postgres),
// loads a fixture and prints what core.v3_reader_weights, core.v3_scores, core.feed_for_you_v5 and
// core.feed_for_you_v7 return, as JSON.
// usage: node pglite_parity_v3.mjs <repo root> <fixture.json>
// PGlite is found through PGLITE_PACKAGE_JSON (a package.json whose node_modules has @electric-sql/pglite).
// No network, nothing written outside memory.
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
  .filter((f) => f.endsWith('.sql') && !f.includes('cron')).sort();      // pg_cron is not in PGlite
for (const f of migs) await db.exec(fs.readFileSync(path.join(repo, 'supabase/migrations', f), 'utf8'));

const params = {};
for (const r of await q(`select key, value::float8 as value from core.rank_params where key like 'v3\\_%'`)) params[r.key] = r.value;
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

const c0 = `1e12|ffffffff-ffff-ffff-ffff-ffffffffffff||${fx.asof}||`;
const pages = async (fn) => {                                        // a whole scroll, ids in order
  await db.exec(`set request.jwt.claims = '${JSON.stringify({ sub: fx.user, role: 'authenticated' })}'`);
  const ids = []; let cur = c0;
  for (let n = 0; n < 10 && cur; n++) {
    const r = (await q(`select ${fn}($1, 10) as r`, [cur]))[0].r;
    ids.push(...r.items.map((x) => x.id)); cur = r.next_cursor;
  }
  await db.exec(`reset request.jwt.claims`);
  return ids;
};
const out = {
  defaults: params,
  weights: await q(`select o_feature as j, o_n as n, o_b as b, o_rbar as rbar from core.v3_reader_weights($1, $2::timestamptz)
                     order by o_feature`, [fx.user, fx.asof]),
  scores: await q(`select o_id::text as id, o_category as category, o_s0::float8 as s0, o_v3::float8 as v3, o_ps::float8 as ps
                     from core.v3_scores($1, $2::timestamptz, 0) order by o_ps desc, o_id desc`, [fx.user, fx.asof]),
  cards: await q(`select b.id::text as id, b.word_count, cf.features
                    from core.blurbs b join core.card_features cf on cf.blurb_id = b.id where b.id = any ($1::uuid[])`,
    [fx.cards.map((c) => c.id)]),
  v5: await pages('core.feed_for_you_v5'),
  v7: await pages('core.feed_for_you_v7'),
};
await q(`update core.rank_params set value = 0 where key in ('v3_hours_per_reward', 'v3_step_extra')`);
out.v7_off = await pages('core.feed_for_you_v7');                   // H = 0 and no extra step: must be v5
process.stdout.write(JSON.stringify(out));
