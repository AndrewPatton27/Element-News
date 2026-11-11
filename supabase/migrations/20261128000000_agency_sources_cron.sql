-- Agency data-card sources (D-113, 2026-11-10): EIA weekly reports, Treasury note/bond auctions, FOMC calendar
-- (and Census, which stays OFF in code until Drew confirms its terms). Written, NOT applied. Run after
-- 20261111000000_finance_sources_cron.sql (it uses core.invoke_function and the Vault secrets from
-- 20261019050000_cron_schedule.sql).
--
-- What this does:
--   1. ingest.run_log.source accepts the new source names (eia, census, auctions, fomc).
--   2. Three cron jobs (UTC), each one source per call like the existing element-ingest-* jobs:
--        element-ingest-eia       12 17 * * 3-5   Wed, Thu, Fri 17:12 UTC (12:12 EST / 13:12 EDT): after the Wednesday
--                                                 petroleum and Thursday gas-storage releases (both 10:30 ET); Friday
--                                                 is a catch-up. A rerun never duplicates (dedupe key = report week).
--        element-ingest-auctions  42 18 * * 1-5   weekdays 18:42 UTC (13:42 EST / 14:42 EDT): note and bond auctions
--                                                 close at 13:00 ET, results are posted within minutes
--        element-ingest-fomc      54 13 * * *     daily 13:54 UTC: the calendar card appears 7 days before a meeting
--      No cron job for census (disabled in code). With EIA_API_KEY unset the eia source logs "skipping".
--   3. The watchdog Worker counts cron jobs: EXPECTED_JOBS in workers/watchdog/src/logic.ts goes up by 3 when this
--      file is applied (eia, auctions, fomc). Change both in the same release.
-- Re-runnable. Check: select jobname, schedule from cron.job where jobname like 'element-ingest-%';
-- Remove: select cron.unschedule('element-ingest-eia'); (same for the other three)

-- 1. run_log accepts the new source names. The list is READ from the current constraint and extended (review m9c: the
--    old hard-coded list here dropped bls and beadata, added by 20261127000000, so those two sources could not log runs).
do $$
declare
  def   text;
  names text[];
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'ingest.run_log'::regclass and c.conname = 'run_log_source_check';
  select coalesce(array_agg(distinct m[1]), '{}') into names
    from regexp_matches(coalesce(def, ''), '''([^'']+)''', 'g') as m;
  names := array(select distinct n from unnest(names || array['eia', 'census', 'auctions', 'fomc', 'brief-summary']) as n order by n);
  alter table ingest.run_log drop constraint if exists run_log_source_check;
  execute format('alter table ingest.run_log add constraint run_log_source_check check (source in (%s))',
                 (select string_agg(quote_literal(n), ',') from unnest(names) as n));
end $$;

-- 2. cron jobs (idempotent: unschedule by name first)
select cron.unschedule(jobname) from cron.job
 where jobname in ('element-ingest-eia', 'element-ingest-auctions', 'element-ingest-fomc');

select cron.schedule('element-ingest-eia',      '12 17 * * 3-5', $$select core.invoke_function('ingest-source', '{"source":"eia"}')$$);
select cron.schedule('element-ingest-auctions', '42 18 * * 1-5', $$select core.invoke_function('ingest-source', '{"source":"auctions"}')$$);
select cron.schedule('element-ingest-fomc',     '54 13 * * *',   $$select core.invoke_function('ingest-source', '{"source":"fomc"}')$$);
