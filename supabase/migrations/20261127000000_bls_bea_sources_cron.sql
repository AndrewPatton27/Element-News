-- BLS and BEA data sources (M9 workstream 1, D-113): wages (average hourly earnings), Employment Cost Index,
-- JOLTS job openings, PCE and core PCE inflation, personal income and GDP in dollars.
-- Written, NOT applied. Run after 20261111000000_finance_sources_cron.sql (it uses core.invoke_function, the
-- Vault secrets from 20261019050000_cron_schedule.sql and the series table).
--
-- What this does (re-runnable):
--   1. ingest.run_log.source accepts 'bls' and 'beadata'. The existing list is READ from the current constraint and
--      extended, so other source names added by other migrations are kept whatever the apply order.
--   2. core.macro_series.provider accepts 'bls' and 'bea' (same read-and-extend method).
--   3. core.macro_series gets the 7 series (none in the Numbers panel: in_numbers = false). Citations name the
--      agency (rule 8); there is no FRED involved.
--   4. Two cron jobs (UTC), each twice a day. The agencies release at 08:30 Eastern (12:30 UTC in summer, 13:30 UTC
--      in winter), so 14:xx catches the release in both seasons and 20:xx catches late revisions:
--        element-ingest-bls      12 14,20 * * *   3 requests per run (one per series): 6 a day, BLS v1 limit is 25/day
--        element-ingest-beadata  42 14,20 * * *   3 requests per run (one per table): 6 a day, BEA limit 100/minute
--      Minutes :12 and :42 stay clear of the hourly jobs (:03 :09 :15 :18 :21 :24 :27 :39 :45 :51 :57) and of :33 (treasury).
--   BEA stays OFF until Drew sets the secret BEA_DATA_ENABLED=1 (and BEA_API_KEY exists): the job runs and logs "disabled".
--   Expected volume: about 7 new data cards per month in total (monthly series on release day), not per day.
-- Check:  select jobname, schedule from cron.job where jobname in ('element-ingest-bls', 'element-ingest-beadata');
-- Remove: select cron.unschedule('element-ingest-bls'); select cron.unschedule('element-ingest-beadata');

-- 1. run_log accepts the new source names (read the current list, add ours)
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
  names := array(select distinct n from unnest(names || array['bls', 'beadata']) as n order by n);
  alter table ingest.run_log drop constraint if exists run_log_source_check;
  execute format('alter table ingest.run_log add constraint run_log_source_check check (source in (%s))',
                 (select string_agg(quote_literal(n), ',') from unnest(names) as n));
end $$;

-- 2. macro_series.provider accepts the new providers
do $$
declare
  cname text;
  def   text;
  names text[];
begin
  select c.conname, pg_get_constraintdef(c.oid) into cname, def
    from pg_constraint c
   where c.conrelid = 'core.macro_series'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) ilike '%provider%';
  select coalesce(array_agg(distinct m[1]), '{}') into names
    from regexp_matches(coalesce(def, ''), '''([^'']+)''', 'g') as m;
  names := array(select distinct n from unnest(names || array['fred', 'treasury', 'bls', 'bea']) as n order by n);
  if cname is not null then
    execute format('alter table core.macro_series drop constraint %I', cname);
  end if;
  execute format('alter table core.macro_series add constraint macro_series_provider_check check (provider in (%s))',
                 (select string_agg(quote_literal(n), ',') from unnest(names) as n));
end $$;

-- 3. series (citations name the original agency)
insert into core.macro_series (series_id, label, provider, source_name, source_short, source_url, unit, frequency, sort_order, in_numbers) values
  ('BLS_AHE',             'Hourly earnings (yearly)',   'bls', 'U.S. Bureau of Labor Statistics', 'BLS', 'https://www.bls.gov/news.release/empsit.nr0.htm', 'percent', 'monthly',   60, false),
  ('BLS_ECI',             'Employment costs (yearly)',  'bls', 'U.S. Bureau of Labor Statistics', 'BLS', 'https://www.bls.gov/eci/',                         'percent', 'quarterly', 61, false),
  ('BLS_JOLTS',           'Job openings',               'bls', 'U.S. Bureau of Labor Statistics', 'BLS', 'https://www.bls.gov/jlt/',                         'number',  'monthly',   62, false),
  ('BEA_PCE_YOY',         'PCE inflation (yearly)',     'bea', 'U.S. Bureau of Economic Analysis', 'BEA', 'https://www.bea.gov/data/personal-consumption-expenditures-price-index', 'percent', 'monthly', 63, false),
  ('BEA_CORE_PCE_YOY',    'Core PCE inflation (yearly)', 'bea', 'U.S. Bureau of Economic Analysis', 'BEA', 'https://www.bea.gov/data/personal-consumption-expenditures-price-index-excluding-food-and-energy', 'percent', 'monthly', 64, false),
  ('BEA_PERSONAL_INCOME', 'Personal income',            'bea', 'U.S. Bureau of Economic Analysis', 'BEA', 'https://www.bea.gov/data/income-saving/personal-income', 'usd', 'monthly', 65, false),
  ('BEA_GDP',             'GDP (dollars)',              'bea', 'U.S. Bureau of Economic Analysis', 'BEA', 'https://www.bea.gov/data/gdp/gross-domestic-product', 'usd', 'quarterly', 66, false)
on conflict (series_id) do update
   set label = excluded.label, provider = excluded.provider, source_name = excluded.source_name,
       source_short = excluded.source_short, source_url = excluded.source_url, unit = excluded.unit,
       frequency = excluded.frequency, sort_order = excluded.sort_order, in_numbers = excluded.in_numbers;

-- 4. cron jobs (idempotent: unschedule by name first)
select cron.unschedule(jobname) from cron.job
 where jobname in ('element-ingest-bls', 'element-ingest-beadata');

select cron.schedule('element-ingest-bls',     '12 14,20 * * *', $$select core.invoke_function('ingest-source', '{"source":"bls"}')$$);
select cron.schedule('element-ingest-beadata', '42 14,20 * * *', $$select core.invoke_function('ingest-source', '{"source":"beadata"}')$$);
