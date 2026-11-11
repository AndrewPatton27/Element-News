// Runs supabase/tests/*_check.sql offline in PGlite (in-memory Postgres). Exit 0 only if every check passed.
// Usage: node supabase/tests/run-pglite.mjs [--trgm] [name-filter ...]     (e.g. node supabase/tests/run-pglite.mjs watchdog)
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
// --trgm: load PGlite's pg_trgm contrib (schema extensions, as on Supabase), so search runs its pg_trgm typo path
const trgm = process.argv.includes('--trgm');
const filters = process.argv.slice(2).filter((a) => a !== '--trgm');

let base;
if (trgm) {
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  base = new PGlite({ extensions: { pg_trgm } });
  await base.exec('create schema extensions');
} else base = new PGlite();
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
// Supply readout (supabase/tests/supply_readout.sql, scripts/supply-readout.mjs): every query must run on the migrated
// schema, with a few seeded rows, and return what it says. The rows are discarded with the clone.
let checks = files.length;
if (!filters.length || filters.some((x) => 'supply_readout'.includes(x) || x.includes('readout'))) {
  checks++;
  const { splitQueries, isReadOnlySql } = await import('../../scripts/supply-readout.mjs');
  const db = await base.clone();
  let verdict = null;
  try {
    await db.exec(`
      update core.blurbs set status = 'hidden';
      insert into ingest.items (source, url, title, license_class, status, status_note, fetched_at) values
        ('fed_rss', 'https://www.federalreserve.gov/a', 'A', 'public_domain', 'published', null, now()),
        ('sec_8k', 'https://www.sec.gov/b', 'B', 'company_filing', 'skipped', 'report_card_revise_failed', now() - interval '2 days'),
        ('sec_8k', 'https://www.sec.gov/c', 'C', 'company_filing', 'skipped', 'low_relevance (2)', now() - interval '3 days');
      insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, published_at, model)
        select 'ro-' || g, case when g = 1 then 'data' else 'summary' end, 'Card ' || g, (select slug from core.categories limit 1),
               now() - (g || ' hours')::interval, now() - (g || ' hours')::interval, now() - (g || ' hours')::interval,
               case g % 3 when 0 then null when 1 then 'gemini-2.5-flash-lite' else 'openai/gpt-oss-120b' end
          from generate_series(1, 6) g;
      insert into core.blurb_sources (blurb_id, item_id, name, kind, url, license_class, is_primary)
        select b.id, (select id from ingest.items where url = 'https://www.federalreserve.gov/a'), 'Federal Reserve', 'government',
               'https://www.federalreserve.gov/a', 'public_domain', true from core.blurbs b where b.dedupe_key = 'ro-2';
      insert into core.ai_usage (day, provider, calls) values ((now() at time zone 'utc')::date, 'groq', 74);`);
    const queries = splitQueries(fs.readFileSync(path.join(testDir, 'supply_readout.sql'), 'utf8'));
    const want = ['cards_per_day_by_source', 'cards_per_day_by_category', 'daily_totals_and_median', 'market_hour_gaps_14d', 'cards_by_et_hour_of_day_30d',
      'live_cards_by_topic', 'items_by_status', 'ai_usage_vs_caps', 'gemini_vs_groq_share_30d', 'pool_size'];
    const got = queries.map((q) => q.name);
    if (want.some((n) => !got.includes(n))) throw new Error('readout queries missing: ' + want.filter((n) => !got.includes(n)).join(', '));
    const out = {};
    for (const q of queries) {
      if (!isReadOnlySql(q.sql)) throw new Error(q.name + ': not read-only');
      out[q.name] = (await db.query(q.sql)).rows;
    }
    if (out.cards_per_day_by_source.reduce((n, r) => n + r.cards, 0) !== 6) throw new Error('cards_per_day_by_source total ' + JSON.stringify(out.cards_per_day_by_source));
    if (!out.cards_per_day_by_source.some((r) => r.source === 'fed_rss')) throw new Error('item source not joined');
    if (!out.daily_totals_and_median.some((r) => r.et_day === 'MEDIAN')) throw new Error('median row missing');
    if (out.daily_totals_and_median.length !== 31) throw new Error('daily rows ' + out.daily_totals_and_median.length);
    if (out.pool_size[0].live_total !== 6) throw new Error('pool_size ' + JSON.stringify(out.pool_size));
    if (!out.items_by_status.some((r) => r.status_note === 'report_card_revise_failed')) throw new Error('items_by_status reason missing');
    if (!out.ai_usage_vs_caps.some((r) => r.provider === 'groq' && r.pct_of_cap === 100)) throw new Error('ai_usage_vs_caps ' + JSON.stringify(out.ai_usage_vs_caps));
    if (out.gemini_vs_groq_share_30d.reduce((n, r) => n + r.pct, 0) < 99) throw new Error('share does not sum to 100');
    if (!out.live_cards_by_topic.length) throw new Error('live_cards_by_topic empty');
  } catch (e) { verdict = String(e.message || e); }
  await db.close();
  console.log(`${verdict ? 'FAIL' : 'PASS'}  supply_readout.sql (scripts/supply-readout.mjs queries)${verdict ? '\n      ' + verdict : ''}`);
  if (verdict) failed++;
}
// Requeue tool (scripts/requeue-skipped.sql): the dry run is read-only, the apply moves only the right rows and at most 100 a run.
if (!filters.length || filters.some((x) => 'requeue_skipped'.includes(x) || x.includes('requeue'))) {
  checks++;
  const db = await base.clone();
  let verdict = null;
  try {
    const text = fs.readFileSync(path.join(root, 'scripts/requeue-skipped.sql'), 'utf8');
    const dry = text.slice(text.indexOf('-- name: requeue_dry_run') + 'name: requeue_dry_run'.length + 3, text.indexOf('-- ---- step 2'));
    const applyBlock = text.slice(text.indexOf('-- name: requeue_apply') + '-- name: requeue_apply'.length);
    const apply = applyBlock.split('\n').map((l) => l.replace(/^-- ?/, '')).join('\n').trim();
    if (/^\s*(update|delete|insert)/im.test(dry.replace(/^--.*$/gm, ''))) throw new Error('the dry run must not write');
    await db.exec(`
      insert into ingest.items (source, url, title, license_class, status, status_note, fetched_at)
        select 'sec_8k', 'https://www.sec.gov/rq/' || g, 'T' || g, 'company_filing', 'skipped',
               case when g % 2 = 0 then 'report_card_revise_failed' else 'report_card_abandon' end, now() - interval '2 days'
          from generate_series(1, 250) g;
      insert into ingest.items (source, url, title, license_class, status, status_note, fetched_at) values
        ('sec_8k', 'https://www.sec.gov/rq/old', 'old', 'company_filing', 'skipped', 'report_card_abandon', now() - interval '20 days'),
        ('sec_8k', 'https://www.sec.gov/rq/dup', 'dup', 'company_filing', 'skipped', 'duplicate_story', now() - interval '1 day'),
        ('sec_8k', 'https://www.sec.gov/rq/low', 'low', 'company_filing', 'skipped', 'low_relevance (2)', now() - interval '1 day'),
        ('sec_8k', 'https://www.sec.gov/rq/new', 'new', 'company_filing', 'new', null, now() - interval '1 day'),
        ('sec_8k', 'https://www.sec.gov/rq/hascard', 'hascard', 'company_filing', 'skipped', 'report_card_abandon', now() - interval '1 day');
      insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, status)
        select 'rq-card', 'summary', 'A card', (select slug from core.categories limit 1), now(), now(), 'published';
      insert into core.blurb_sources (blurb_id, item_id, name, kind, url, license_class, is_primary)
        select b.id, i.id, 'SEC', 'filing', 'https://www.sec.gov/rq/hascard', 'company_filing', true
          from core.blurbs b, ingest.items i where b.dedupe_key = 'rq-card' and i.url = 'https://www.sec.gov/rq/hascard';`);
    const d = (await db.query(dry)).rows;
    if (d.reduce((n, r) => n + r.items, 0) !== 250) throw new Error('dry run counts ' + JSON.stringify(d));
    const left = async () => (await db.query(`select count(*)::int n from ingest.items where status = 'skipped' and status_note like 'report_card\\_%' escape '\\'`)).rows[0].n;
    if (await left() !== 252) throw new Error('setup: ' + await left());   // 250 + old + hascard
    const moved = [];
    for (let i = 0; i < 4; i++) moved.push((await db.query(apply)).rows.length);
    if (moved.join(',') !== '100,100,50,0') throw new Error('batches ' + moved.join(','));
    const rest = (await db.query(`select url, status from ingest.items where url like 'https://www.sec.gov/rq/%' and url !~ '/rq/[0-9]+$' order by url`)).rows;
    const st = Object.fromEntries(rest.map((r) => [r.url.split('/').pop(), r.status]));
    if (st.old !== 'skipped' || st.dup !== 'skipped' || st.low !== 'skipped' || st.hascard !== 'skipped' || st.new !== 'new') throw new Error('wrong rows moved ' + JSON.stringify(st));
    if ((await db.query(`select count(*)::int n from ingest.items where status_note = 'requeued' and status = 'new'`)).rows[0].n !== 250) throw new Error('requeued note');
  } catch (e) { verdict = String(e.message || e); }
  await db.close();
  console.log(`${verdict ? 'FAIL' : 'PASS'}  requeue-skipped.sql (scripts/requeue-skipped.sql)${verdict ? '\n      ' + verdict : ''}`);
  if (verdict) failed++;
}
await base.close();
console.log(`\n${checks - failed}/${checks} SQL checks passed`);
process.exit(failed || !checks ? 1 : 0);
