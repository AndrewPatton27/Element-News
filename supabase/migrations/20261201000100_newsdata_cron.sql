-- NewsData.io cron jobs (M9 supply, branch m9c-linkout). Written, NOT applied. Run after 20261201000000_newsdata_linkout.sql
-- and after the Edge Function secrets are set (NEWSDATA_API_KEY, NEWSDATA_ENABLED=1). Until then every call just logs
-- "skipping", so applying early is harmless but pointless.
--
-- Two jobs (UTC), one ingest-source call each, ONE NewsData credit per call:
--   element-ingest-newsdata-market  4 * * * *   /market hourly = 24 credits/day (baseline, every day)
--   element-ingest-newsdata-latest  7 * * * *   /latest hourly = 24 credits/day (baseline, every day)
--   20261142000100_cadence_cron.sql adds the weekday market-hours jobs (/market every 15 min, /latest every 30 min):
--   104 credits on a weekday, 48 on a weekend (free plan: 200). The code counts each call (core.ai_usage, provider 'newsdata', cap 144) and stops
--   at the cap. The minutes (4, 7, 19, 34, 37, 49) avoid the other element-ingest-* jobs (3, 9, 15, 18, 21, 24, 27, 39, 45, 51, 57).
--   work_cap 10 = at most 10 new link-out cards per call.
-- The watchdog Worker counts cron jobs: EXPECTED_JOBS in workers/watchdog/src/logic.ts (30) already counts these 2.
-- Check:  select jobname, schedule from cron.job where jobname like 'element-ingest-newsdata-%';
-- Remove: select cron.unschedule('element-ingest-newsdata-market'); select cron.unschedule('element-ingest-newsdata-latest');

select cron.unschedule(jobname) from cron.job
 where jobname in ('element-ingest-newsdata-market', 'element-ingest-newsdata-latest');

select cron.schedule('element-ingest-newsdata-market', '4 * * * *', $$select core.invoke_function('ingest-source', '{"source":"newsdata_market","work_cap":10}')$$);
select cron.schedule('element-ingest-newsdata-latest', '7 * * * *',       $$select core.invoke_function('ingest-source', '{"source":"newsdata_latest","work_cap":10}')$$);
