-- M9c3 sources (part 2 of 2): four cron jobs. Written, NOT applied. Run after 20261138000000_m9c3_sources.sql (run_log must
-- accept the new names) and after 20261128000000_agency_sources_cron.sql (core.invoke_function and the Vault secrets come
-- from 20261019050000_cron_schedule.sql). Skipped by PGlite (pg_cron is not available there). Idempotent.
--   element-ingest-beige    6 20,23 * * *      daily 20:06 and 23:06 UTC: the Beige Book is released at 14:00 ET (19:00 UTC in
--                                              winter, 18:00 in summer), so both runs are after it. Outside the 3-day preview
--                                              window and the 4-day release window the run does nothing (no HTTP request). The
--                                              second run retries a summary page that was not up yet.
--   element-ingest-trade    48 14,20 * * 1-5   weekdays 14:48 and 20:48 UTC: one Federal Register API request per run (the
--                                              Register posts at 08:45 ET); at most 3 new cards a run; a rerun is a no-op
--   element-ingest-regpress 30 15,21 * * 1-5   weekdays 15:30 and 21:30 UTC: 3 RSS requests (CFTC, OCC, CFPB); crypto titles only
--   element-ingest-annual   6 16 * * *         daily 16:06 UTC: no HTTP at all (hand-verified list in code); OFF unless the secret
--                                              ANNUAL_FIGURES_ENABLED=1 is set, then at most 2 cards, once each
--   Minutes :06, :30, :48 stay clear of the hourly jobs (:03 :09 :15 :18 :21 :24 :27 :39 :45 :51 :57) and of :12 :42 :33 :54 :20 :36.
--   The watchdog Worker counts cron jobs: EXPECTED_JOBS in workers/watchdog/src/logic.ts goes up by 4 (26 -> 30) when this file
--   is applied. Change both in the same release.
-- Check:  select jobname, schedule from cron.job where jobname in ('element-ingest-beige', 'element-ingest-trade', 'element-ingest-regpress', 'element-ingest-annual');
-- Remove: select cron.unschedule('element-ingest-beige'); (same for the other three)

select cron.unschedule(jobname) from cron.job
 where jobname in ('element-ingest-beige', 'element-ingest-trade', 'element-ingest-regpress', 'element-ingest-annual');

select cron.schedule('element-ingest-beige',    '6 20,23 * * *',     $$select core.invoke_function('ingest-source', '{"source":"beige"}')$$);
select cron.schedule('element-ingest-trade',    '48 14,20 * * 1-5',  $$select core.invoke_function('ingest-source', '{"source":"trade"}')$$);
select cron.schedule('element-ingest-regpress', '30 15,21 * * 1-5',  $$select core.invoke_function('ingest-source', '{"source":"regpress"}')$$);
select cron.schedule('element-ingest-annual',   '6 16 * * *',        $$select core.invoke_function('ingest-source', '{"source":"annual"}')$$);
