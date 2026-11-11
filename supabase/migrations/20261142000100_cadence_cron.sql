-- M9c cadence (part 2 of 2): cron jobs for a steady stream. Written, NOT applied. Needs 20261142000000_release_queue.sql
-- (core.release_queued_cards), 20261019050000_cron_schedule.sql (core.invoke_function, Vault secrets) and, for the NewsData
-- jobs, 20261201000100_newsdata_cron.sql (the hourly baseline). Skipped by PGlite (no pg_cron). Idempotent.
--
-- Market window in cron (UTC, no per-job time zone in pg_cron): hours 10-23 UTC, Monday-Friday. That is 06:00-18:59 ET in
-- summer and 05:00-17:59 ET in winter, i.e. the drip window (06:00-20:00 ET, core.drip_config) minus its last hour or two,
-- when almost no filings are filed. Outside it the hourly baseline jobs keep running all day, every day.
--
-- 1. Fast sources: the hourly baseline job of each source (at minute m) stays; a second job runs at m+15, m+30, m+45 inside the
--    window, so the union is one run every 15 minutes (no double run, no gap).
--      element-fast-sec        42,57,12  baseline :27   SEC 8-K feed (the largest licensed supply of company news)
--      element-fast-fed        24,39,54  baseline :09   Fed press releases (monetary releases publish at once, see the drip rules)
--      element-fast-fedreg     36,51,6   baseline :21   Federal Register
--      element-fast-secpress   39,54,9   baseline :24   SEC press releases
--      element-fast-fedspeech  33,48,3   baseline :18   Fed speeches and testimony
--    Runs that find nothing new cost one HTTP request to the agency and one Edge Function invocation.
-- 2. NewsData.io link-out (sources/newsdata.ts): baseline hourly /market at :04 and /latest at :07 (20261201000100), plus
--      element-fast-newsdata-market  19,34,49 10-23 * * 1-5   /market every 15 minutes in the window (+3 credits an hour)
--      element-fast-newsdata-latest  37 10-23 * * 1-5         /latest every 30 minutes in the window (+1 credit an hour)
--    Credits a weekday: 48 baseline + 42 + 14 = 104 (weekend 48). The code counts every call (core.ai_usage, provider
--    'newsdata', cap config.newsdata.dailyCreditCap 144 of the free plan's 200) and drops /latest first near the cap.
-- 3. element-release-queue  */15 * * * *   core.release_queued_cards(): lets one queued card out every 15 minutes in the drip window
--    (everything after the window). A plain SQL job: no Edge Function, no HTTP.
--
-- Capacity (free tier): Edge Functions 500,000 invocations a month. Added: 5 sources x 42 runs x ~22 weekdays = ~4,600, NewsData
-- 56 x 22 = ~1,200, so ~6,000 more on top of ~15,000 today. pg_cron: runs are short; the free project allows up to 32 jobs
-- at the same second and our jobs start at different minutes except a few that share one (they queue in pg_net).
-- The watchdog Worker counts cron jobs: EXPECTED_JOBS in workers/watchdog/src/logic.ts goes 30 -> 38 (+5 fast, +2 NewsData, +1 release).
-- Check:  select jobname, schedule from cron.job where jobname like 'element-fast-%' or jobname = 'element-release-queue';
-- Remove: select cron.unschedule('element-fast-sec'); (same for the other names)

select cron.unschedule(jobname) from cron.job
 where jobname in ('element-fast-sec', 'element-fast-fed', 'element-fast-fedreg', 'element-fast-secpress', 'element-fast-fedspeech',
                   'element-fast-newsdata-market', 'element-fast-newsdata-latest', 'element-release-queue');

select cron.schedule('element-fast-sec',       '12,42,57 10-23 * * 1-5', $$select core.invoke_function('ingest-source', '{"source":"sec"}')$$);
select cron.schedule('element-fast-fed',       '24,39,54 10-23 * * 1-5', $$select core.invoke_function('ingest-source', '{"source":"fed"}')$$);
select cron.schedule('element-fast-fedreg',    '6,36,51 10-23 * * 1-5',  $$select core.invoke_function('ingest-source', '{"source":"fedreg"}')$$);
select cron.schedule('element-fast-secpress',  '9,39,54 10-23 * * 1-5',  $$select core.invoke_function('ingest-source', '{"source":"secpress"}')$$);
select cron.schedule('element-fast-fedspeech', '3,33,48 10-23 * * 1-5',  $$select core.invoke_function('ingest-source', '{"source":"fedspeech"}')$$);

select cron.schedule('element-fast-newsdata-market', '19,34,49 10-23 * * 1-5', $$select core.invoke_function('ingest-source', '{"source":"newsdata_market","work_cap":10}')$$);
select cron.schedule('element-fast-newsdata-latest', '37 10-23 * * 1-5',       $$select core.invoke_function('ingest-source', '{"source":"newsdata_latest","work_cap":10}')$$);

select cron.schedule('element-release-queue', '*/15 * * * *', $$select core.release_queued_cards()$$);
