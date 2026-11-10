// Scale benchmark in PGlite (not a pass/fail check): the read RPCs on a synthetic corpus at N x the live size,
// before and after the 20261121* scale migrations, on the SAME data (the new migrations are applied on top).
// usage: node supabase/tests/eval/scale-bench.mjs [--scale 10] [--runs 3] [--events 2000] [--trgm]
//   --trgm: load PGlite's pg_trgm contrib (schema extensions), so search runs its pg_trgm typo path.
// Prints per RPC the median ms before and after, whether the results are the same, and the search battery's
// precision at 5 / 10 before and after. WebAssembly Postgres on one core: read ratios, not absolute times.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { root, rows, as } from './db.mjs';
import { synthCorpus, rng } from './corpus.mjs';
import { BATTERY, text } from './battery.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scale = Number(arg('--scale', 10));
const RUNS = Number(arg('--runs', 3));
const NEV = Number(arg('--events', 200 * scale));
const TRGM = process.argv.includes('--trgm');
const NEW = '20261121';

const migDir = path.join(root, 'supabase/migrations');
const all = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql') && !f.includes('cron')).sort();
const t0 = Date.now();
let db;
if (TRGM) {
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec('create schema extensions');
} else db = new PGlite();
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create publication supabase_realtime;`);
for (const f of all.filter((x) => x < NEW)) await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
await db.exec(`insert into auth.users (email) values ('element-test-a@example.com'), ('element-test-b@example.com');
update core.blurbs set status = 'hidden';
insert into core.categories (slug, name, sort_order) values ('world','World',20),('science','Science & Space',21),('safety','Recalls & Safety',22) on conflict (slug) do nothing;`);
console.log(`typo mode: ${(await rows(db, 'select core.search_typo_mode() m'))[0].m}`);

// bulk load (same columns and rank_score as corpus.mjs loadCards), 500 cards per statement
const cards = synthCorpus(7, scale);
for (let i = 0; i < cards.length; i += 500) {
  const chunk = cards.slice(i, i + 500).map((c) => ({
    k: c.dedupe_key, h: c.headline.slice(0, 90), b: c.body, c: c.category, e: c.event_type, a: c.attribution || null,
    t: (c.tickers || []).map((x) => ({ symbol: x.symbol, name: x.name })), m: (c.macro || []).map((x) => ({ series_id: x.series_id })),
    at: c.at, imp: c.importance, r: (Date.parse(c.at) / 3600e3 + 8 * Math.log2(c.importance)).toFixed(6),
    s: c.sources[0],
  }));
  await db.query(`
    with x as (select * from jsonb_to_recordset($1::jsonb) as x(k text, h text, b text, c text, e text, a text, t jsonb, m jsonb, at timestamptz, imp numeric, r numeric, s jsonb)),
    ins as (
      insert into core.blurbs (dedupe_key, kind, headline, body, category, event_type, status, attribution, tickers, macro, as_of, published_at, sort_at, importance, rank_score)
      select k, case when e = 'data' then 'data' else 'summary' end, h, b, c, e, 'published', a, t, m, at, at, at, imp, r from x
      on conflict (dedupe_key) do nothing returning id, dedupe_key)
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary, attribution, position)
    select ins.id, x.s->>'name', x.s->>'kind', x.s->>'url', x.s->>'license_class', true, x.s->>'attribution', 0 from ins join x on x.k = ins.dedupe_key`,
  [JSON.stringify(chunk)]);
}
await db.exec(`select core.backfill_recall_material(true); analyze;`);
const n = (await rows(db, `select count(*)::int n, count(*) filter (where sort_at > now() - interval '30 days')::int w from core.blurbs where status = 'published'`))[0];
console.log(`${scale}x: ${n.n} published cards (${n.w} in the 30-day For you window), load ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// one signed-in reader: follows Economy, NEV events (60 % views, 33 % dwells, 3 % details, 2 % likes, 2 % dislikes)
// on random cards, each event after its card was published, spread over the last 60 days
const uid = (await rows(db, `select id from auth.users where email = 'element-test-a@example.com'`))[0].id;
await db.query(`insert into core.user_prefs (user_id, followed_categories) values ($1, '{economy}') on conflict (user_id) do update set followed_categories = excluded.followed_categories`, [uid]);
await db.query(`
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at)
  select $1, b.id, k.kind, case when k.kind = 'dwell' then 1000 + (k.g * 7717) % 15000 end,
         greatest(b.published_at, now() - interval '60 days') + (now() - greatest(b.published_at, now() - interval '60 days')) * ((k.g * 0.6180339887) % 1)
    from (select g, case when g % 100 < 60 then 'view' when g % 100 < 93 then 'dwell' when g % 100 < 96 then 'open_detail'
                         when g % 100 < 98 then 'like' else 'dislike' end as kind from generate_series(1, $2::int) g) k
    join (select id, published_at, row_number() over (order by sort_at desc, id) rn, count(*) over () cnt from core.blurbs where status = 'published') b
      on b.rn = 1 + (k.g::bigint * 7919 + (k.g::bigint * k.g::bigint) % 104729) % b.cnt
  on conflict do nothing`, [uid, NEV]);
await db.exec('analyze core.user_events');
console.log(`reader: ${(await rows(db, 'select count(*)::int n from core.user_events'))[0].n} events`);

const corpus = await rows(db, `select id, headline, body, tickers from core.blurbs where status = 'published'`);
const setp = (k, v) => db.query(`insert into core.rank_params (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v]);

async function time(uidOrNull, sql, params = []) {
  const ts = []; let r;
  for (let i = 0; i < RUNS; i++) {
    const s = performance.now();
    r = await as(db, uidOrNull, () => rows(db, sql, params));
    ts.push(performance.now() - s);
  }
  ts.sort((a, b) => a - b);
  return { ms: ts[ts.length >> 1], r: r[0].r };
}
const ids = (r) => (r.items || r).map((c) => c.id).join(',');

async function measure(label) {
  const out = {};
  await setp('foryou_ml_mode', 0);
  let x = await time(null, `select api.feed('top', null, 20, null) r`); out['Trending p1'] = { ms: x.ms, ids: ids(x.r) };
  const cur = x.r.next_cursor;
  x = await time(null, `select api.feed('top', $1, 20, null) r`, [cur]); out['Trending p2'] = { ms: x.ms, ids: ids(x.r) };
  x = await time(null, `select api.feed('latest', null, 20, null) r`); out['Latest p1'] = { ms: x.ms, ids: ids(x.r) };
  x = await time(uid, `select api.feed_for_you(null, 20) r`); out['For you v5 p1'] = { ms: x.ms, ids: ids(x.r) };
  x = await time(uid, `select api.feed_for_you($1, 20) r`, [x.r.next_cursor]); out['For you v5 p2'] = { ms: x.ms, ids: ids(x.r) };
  await setp('foryou_ml_mode', 3); await setp('v3_holdout_pct', 0); await setp('v3_max_candidates', 1e6);
  x = await time(uid, `select api.feed_for_you(null, 20) r`); out['For you v3 p1 (guard off)'] = { ms: x.ms, ids: ids(x.r) };
  await setp('v3_max_candidates', 3000); await setp('foryou_ml_mode', 0);
  x = await time(null, `select api.following_feed(array['earnings'], '{}', array['AAPL','MSFT'], null, 20) r`); out['Following p1'] = { ms: x.ms, ids: ids(x.r) };
  x = await time(null, `select api.following_feed(array['energy'], '{}', array['JPM'], null, 20) r`); out['Following p1 (JPM+energy)'] = { ms: x.ms, ids: ids(x.r) };
  x = await time(null, `select api.companies_directory(null) r`); out['companies_directory'] = { ms: x.ms, ids: JSON.stringify(x.r.map((c) => [c.ticker, c.card_count])) };
  x = await time(null, `select api.search_companies('apple', 5) r`); out['search_companies apple'] = { ms: x.ms, ids: JSON.stringify(x.r.map((c) => [c.ticker, c.card_count])) };
  x = await time(null, `select api.company_cards('AAPL', null, 20) r`); out['company_cards AAPL'] = { ms: x.ms, ids: ids(x.r) + x.r.company.card_count };
  // search battery (guest), one run each
  const ms = []; const p = { p5: 0, p10: 0 }; const res = {};
  for (const [, q, re] of BATTERY) {
    const R = corpus.filter((c) => re.test(text(c))).length;
    const s = performance.now();
    const items = (await as(db, null, () => rows(db, `select api.search($1, null, 20) r`, [q])))[0].r.items;
    ms.push(performance.now() - s);
    const rel = items.map((c) => re.test(text(c)));
    const pk = (k) => (R === 0 ? (items.length === 0 ? 1 : 0) : rel.slice(0, k).filter(Boolean).length / Math.min(k, R));
    p.p5 += pk(5) / BATTERY.length; p.p10 += pk(10) / BATTERY.length; res[q] = { ids: items.slice(0, 10).map((c) => c.id).join(','), p5: pk(5), p10: pk(10) };
  }
  ms.sort((a, b) => a - b);
  out['search battery median'] = { ms: ms[ms.length >> 1] }; out['search battery p90'] = { ms: ms[Math.floor(ms.length * 0.9)] };
  out['search battery max'] = { ms: ms[ms.length - 1] };
  console.log(`[${label}] search P@5 ${p.p5.toFixed(3)} P@10 ${p.p10.toFixed(3)}`);
  return { out, res, p };
}

const before = await measure('before');
for (const f of all.filter((x) => x >= NEW)) {
  const s = Date.now();
  await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  console.log(`applied ${f} in ${((Date.now() - s) / 1000).toFixed(1)} s`);
}
await db.exec('analyze');
const after = await measure('after');

console.log(`\n${scale}x (${n.n} cards, ${NEV} events)   before ms   after ms   same result`);
for (const k of Object.keys(before.out)) {
  const b = before.out[k], a = after.out[k];
  console.log(`${k.padEnd(28)} ${b.ms.toFixed(0).padStart(9)} ${a.ms.toFixed(0).padStart(10)}   ${b.ids === undefined ? '' : b.ids === a.ids ? 'yes' : 'NO'}`);
}
const diff = BATTERY.filter(([, q]) => before.res[q].ids !== after.res[q].ids);
console.log(`search: P@5 ${before.p.p5.toFixed(3)} -> ${after.p.p5.toFixed(3)}, P@10 ${before.p.p10.toFixed(3)} -> ${after.p.p10.toFixed(3)}; top-10 changed for ${diff.length} of ${BATTERY.length} queries`);
for (const [, q] of diff) console.log(`   ${q.padEnd(26)} P@5 ${before.res[q].p5.toFixed(2)} -> ${after.res[q].p5.toFixed(2)}  P@10 ${before.res[q].p10.toFixed(2)} -> ${after.res[q].p10.toFixed(2)}`);
await db.close();
