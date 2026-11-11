-- NewsData.io query-set cron jobs (M9 supply, branch newsdata-queries-m9). Written, NOT applied. Run after
-- 20261201000000_newsdata_linkout.sql and 20261201000200_newsdata_topic_source.sql, and after the Edge Function secrets are set
-- (NEWSDATA_API_KEY, NEWSDATA_ENABLED=1). Until then every call just logs "skipping".
--
-- REPLACES the four earlier NewsData jobs (element-ingest-newsdata-market/-latest from 20261201000100 and element-fast-newsdata-market/
-- -latest from 20261142000100): this file unschedules them. If either older migration is re-run later it re-adds its jobs, so run this
-- file again afterwards. One job per query in config.newsdata.queries (ingest/src/config.ts), ONE NewsData credit per call.
--
-- Free plan = 200 credits/day, 12 h news delay. The delay moves US-daytime stories to 22:00-09:59 UTC, so every query polls the
-- hours 0-9 and 22-23 UTC (12 hours) instead of US market hours. Credits per day (the code stops at 195):
--   core  market 24 (:04 :34)   business 24 (:07 :37)   trusted outlets 24 (:12 :42)                         = 72
--   extra stocks 12 (:05)  inflation 12 (:11)  fed_rates 12 (:13)  trade 12 (:29)  energy 12 (:31)
--         earnings 12 (:41)  deals 12 (:43)  world_cb 12 (:53)  housing 6 (every 4 h :33)  crypto_reg 6 (every 4 h :35)   = 108
--   total 180 of 200 (195 hard cap in code). Every day, weekends too (a weekend simply returns fewer new stories).
-- The minutes avoid the other element-ingest-* / element-fast-* jobs (3, 9, 15, 18, 21, 24, 27, 39, 45, 51, 57 and the fast ones at 19, 34
-- of other sources do not matter: they hit other APIs). NewsData's own limit is 30 requests per 15 minutes; no two jobs share a minute.
-- The watchdog Worker counts cron jobs: EXPECTED_JOBS in workers/watchdog/src/logic.ts goes 38 -> 47 (4 old removed, 13 added).
-- Check:  select jobname, schedule from cron.job where jobname like 'element-newsdata-%';
-- Remove: select cron.unschedule(jobname) from cron.job where jobname like 'element-newsdata-%';

select cron.unschedule(jobname) from cron.job
 where jobname in ('element-ingest-newsdata-market', 'element-ingest-newsdata-latest', 'element-fast-newsdata-market', 'element-fast-newsdata-latest')
    or jobname like 'element-newsdata-%';

select cron.schedule('element-newsdata-market',     '4,34 0-9,22-23 * * *',  $$select core.invoke_function('ingest-source', '{"source":"newsdata_market","work_cap":10}')$$);
select cron.schedule('element-newsdata-business',   '7,37 0-9,22-23 * * *',  $$select core.invoke_function('ingest-source', '{"source":"newsdata_latest","work_cap":10}')$$);
select cron.schedule('element-newsdata-trusted',    '12,42 0-9,22-23 * * *', $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"trusted","work_cap":10}')$$);
select cron.schedule('element-newsdata-stocks',     '5 0-9,22-23 * * *',     $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"stocks","work_cap":10}')$$);
select cron.schedule('element-newsdata-inflation',  '11 0-9,22-23 * * *',    $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"inflation","work_cap":10}')$$);
select cron.schedule('element-newsdata-fed-rates',  '13 0-9,22-23 * * *',    $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"fed_rates","work_cap":10}')$$);
select cron.schedule('element-newsdata-trade',      '29 0-9,22-23 * * *',    $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"trade","work_cap":10}')$$);
select cron.schedule('element-newsdata-energy',     '31 0-9,22-23 * * *',    $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"energy","work_cap":10}')$$);
select cron.schedule('element-newsdata-earnings',   '41 0-9,22-23 * * *',    $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"earnings","work_cap":10}')$$);
select cron.schedule('element-newsdata-deals',      '43 0-9,22-23 * * *',    $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"deals","work_cap":10}')$$);
select cron.schedule('element-newsdata-world-cb',   '53 0-9,22-23 * * *',    $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"world_cb","work_cap":10}')$$);
select cron.schedule('element-newsdata-housing',    '33 1,5,9,13,17,21 * * *', $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"housing","work_cap":10}')$$);
select cron.schedule('element-newsdata-crypto-reg', '35 3,7,11,15,19,23 * * *', $$select core.invoke_function('ingest-source', '{"source":"newsdata_topic","query":"crypto_reg","work_cap":10}')$$);
