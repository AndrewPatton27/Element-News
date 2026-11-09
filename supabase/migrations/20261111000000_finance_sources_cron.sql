-- Finance and rates sources (2026-11-08): Treasury FiscalData, Fed speeches, SEC press releases, extra FRED
-- series and the computed 10Y-2Y spread. Written, NOT applied. Run after 20261019050000_cron_schedule.sql
-- (it uses core.invoke_function and the Vault secrets set up there) and 20261017010000_more_series.sql.
--
-- What this does:
--   1. ingest.run_log.source accepts the three new source names (treasury, fedspeech, secpress).
--   2. core.macro_series gets the new series (none in the Numbers panel: in_numbers = false):
--        FRED / Federal Reserve Board H.15: DGS3MO, DGS5, DGS30, EFFR, DFEDTARU, DFEDTARL
--        computed by Element from DGS10 minus DGS2: SPREAD_10Y2Y (FRED's own T10Y2Y and SOFR are NOT used:
--        their pages carry a copyright flag)
--        Treasury FiscalData (provider 'treasury'): TREAS_AVG_BILLS, TREAS_AVG_NOTES, TREAS_AVG_BONDS, TREAS_DEBT
--      DREW: before running this in production, open each FRED series page (DGS3MO, DGS5, DGS30, EFFR,
--      DFEDTARU, DFEDTARL) and confirm its notes carry no "Copyright" line. If one does, delete its row
--      below and remove it from macroSeries in ingest/src/config.ts.
--   3. core.source_keys: SEC press releases count under the "SEC filings" source filter.
--   4. Three cron jobs (UTC), same pattern and 6-minute spacing rule as the existing hourly jobs:
--        element-ingest-fedspeech  18 * * * *      hourly at :18
--        element-ingest-secpress   24 * * * *      hourly at :24
--        element-ingest-treasury   33 22 * * *     daily 22:33 UTC (17:33 EST / 18:33 EDT), after the day's
--                                                  FiscalData update (monthly datasets change monthly)
--      FOMC statements and minutes need no new job: they come through press_monetary.xml, already read by
--      element-ingest-fed.
-- Re-runnable. Check: select jobname, schedule from cron.job where jobname like 'element-ingest-%';
-- Remove: select cron.unschedule('element-ingest-treasury'); (same for the other two)

-- 1. run_log accepts the new source names
alter table ingest.run_log drop constraint if exists run_log_source_check;
alter table ingest.run_log add constraint run_log_source_check
  check (source in ('macro','treasury','fed','fedspeech','secpress','bea','fedreg','sec','wiki','cpsc','usgs','nasa','brief-summary'));

-- 2. series (citations name the original agency; never bare "FRED")
insert into core.macro_series (series_id, label, provider, source_name, source_short, source_url, unit, frequency, sort_order, in_numbers) values
  ('DGS3MO',          '3-mo Treasury',               'fred',     'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/DGS3MO',    'percent',     'daily',   13, false),
  ('DGS5',            '5-yr Treasury',               'fred',     'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/DGS5',      'percent',     'daily',   14, false),
  ('DGS30',           '30-yr Treasury',              'fred',     'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/DGS30',     'percent',     'daily',   15, false),
  ('EFFR',            'Effective fed funds (EFFR)',  'fred',     'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/EFFR',      'percent',     'daily',   16, false),
  ('DFEDTARU',        'Fed rate target (upper)',     'fred',     'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/DFEDTARU',  'percent',     'daily',   17, false),
  ('DFEDTARL',        'Fed rate target (lower)',     'fred',     'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/DFEDTARL',  'percent',     'daily',   18, false),
  ('SPREAD_10Y2Y',    '10-yr minus 2-yr',            'fred',     'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/DGS10',     'percent',     'daily',   19, false),
  ('TREAS_AVG_BILLS', 'Avg rate on T-bills',         'treasury', 'U.S. Department of the Treasury, Fiscal Service',               'Treasury Fiscal Service',  'https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/', 'percent', 'monthly', 20, false),
  ('TREAS_AVG_NOTES', 'Avg rate on T-notes',         'treasury', 'U.S. Department of the Treasury, Fiscal Service',               'Treasury Fiscal Service',  'https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/', 'percent', 'monthly', 21, false),
  ('TREAS_AVG_BONDS', 'Avg rate on T-bonds',         'treasury', 'U.S. Department of the Treasury, Fiscal Service',               'Treasury Fiscal Service',  'https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/', 'percent', 'monthly', 22, false),
  ('TREAS_DEBT',      'National debt',               'treasury', 'U.S. Department of the Treasury, Fiscal Service',               'Treasury Fiscal Service',  'https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/',                         'usd',     'daily',   23, false)
on conflict (series_id) do update
   set label = excluded.label, provider = excluded.provider, source_name = excluded.source_name,
       source_short = excluded.source_short, source_url = excluded.source_url, unit = excluded.unit,
       frequency = excluded.frequency, sort_order = excluded.sort_order, in_numbers = excluded.in_numbers;

-- 3. SEC press releases use the existing "SEC filings" filter (Fed speeches already match "Federal Reserve Board")
update core.source_keys
   set match_names = array(select distinct n from unnest(match_names || '{"U.S. Securities and Exchange Commission"}'::text[]) as n)
 where key = 'sec';

-- 4. cron jobs (idempotent: unschedule by name first)
select cron.unschedule(jobname) from cron.job
 where jobname in ('element-ingest-fedspeech', 'element-ingest-secpress', 'element-ingest-treasury');

select cron.schedule('element-ingest-fedspeech', '18 * * * *',  $$select core.invoke_function('ingest-source', '{"source":"fedspeech"}')$$);
select cron.schedule('element-ingest-secpress',  '24 * * * *',  $$select core.invoke_function('ingest-source', '{"source":"secpress"}')$$);
select cron.schedule('element-ingest-treasury',  '33 22 * * *', $$select core.invoke_function('ingest-source', '{"source":"treasury"}')$$);
