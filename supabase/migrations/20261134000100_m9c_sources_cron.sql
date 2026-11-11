-- M9c sources (part 2 of 2): two cron jobs. Written, NOT applied. Run after 20261134000000_m9c_series.sql (run_log must
-- accept the new names) and after 20261128000000_agency_sources_cron.sql (core.invoke_function and the Vault secrets come
-- from 20261019050000_cron_schedule.sql). Skipped by PGlite (pg_cron is not available there).
--   element-ingest-blscal  20 21 * * *    daily 21:20 UTC (16:20 EST / 17:20 EDT): one HTTP request for the BLS release
--                                         calendar (ICS); cards for major BLS releases due in the next 3 days; the dedupe
--                                         key (report + release date) makes a rerun a no-op
--   element-ingest-mts     36 19 * * 1-5  weekdays 19:36 UTC: the Monthly Treasury Statement is posted at 14:00 ET on the
--                                         8th business day; one request, one card a month, a rerun is a no-op
--   Minutes :20 and :36 stay clear of the hourly jobs (:03 :09 :15 :18 :21 :24 :27 :39 :45 :51 :57), :12, :42, :33, :54.
--   The watchdog Worker counts cron jobs: EXPECTED_JOBS in workers/watchdog/src/logic.ts goes up by 2 (22 -> 24) when this
--   file is applied. Change both in the same release.
-- Check:  select jobname, schedule from cron.job where jobname in ('element-ingest-blscal', 'element-ingest-mts');
-- Remove: select cron.unschedule('element-ingest-blscal'); select cron.unschedule('element-ingest-mts');

-- cron jobs (idempotent: unschedule by name first)
select cron.unschedule(jobname) from cron.job
 where jobname in ('element-ingest-blscal', 'element-ingest-mts');

select cron.schedule('element-ingest-blscal', '20 21 * * *',   $$select core.invoke_function('ingest-source', '{"source":"blscal"}')$$);
select cron.schedule('element-ingest-mts',    '36 19 * * 1-5', $$select core.invoke_function('ingest-source', '{"source":"mts"}')$$);
