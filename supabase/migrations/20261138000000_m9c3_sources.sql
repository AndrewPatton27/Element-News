-- M9c3 sources (part 1 of 2): run_log accepts the four new source names and the four BLS CPI component series are seeded.
-- Written, NOT applied. Idempotent. Run after 20261127000000_bls_bea_sources_cron.sql (provider 'bls', series table) and
-- before 20261138000100_m9c3_sources_cron.sql. PGlite runs this file (no pg_cron here).
--   1. ingest.run_log.source accepts beige, trade, regpress, annual. The current list is READ from the live constraint and
--      extended (never a hard-coded list: see the review-m9c fix in 20261128000000), so every other source name is kept
--      whatever the apply order.
--   2. core.macro_series gets BLS_CPI_FOOD_HOME, BLS_CPI_RENT, BLS_CPI_ELECTRICITY, BLS_CPI_MEDICAL (provider 'bls', cite
--      the Bureau of Labor Statistics by name, never FRED, not in the Numbers panel). They are fetched by the existing
--      element-ingest-bls job (4 more BLS requests per run: 14 a day against the v1 limit of 25, 7 per run, two runs).
-- Card keys (series-style, see 20261122000200_series_supersede.sql): the data cards BEIGE_BOOK:<date> (preview) and
-- BEIGE_BOOK:<date>b (release) share one series, so the release card replaces the preview; ANNUAL_<id>:<date> is its own
-- series per figure. Trade notices (FRTRADE:<doc>) and regulator releases (REGPRESS-<agency>-<hash>) are kind 'summary',
-- which the supersede trigger never touches (it fires for kind 'data' only), so each one stays live.
-- Check:  select source from ingest.run_log group by 1;  select series_id from core.macro_series where series_id like 'BLS_CPI%';

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
  names := array(select distinct n from unnest(names || array['beige', 'trade', 'regpress', 'annual']) as n order by n);
  alter table ingest.run_log drop constraint if exists run_log_source_check;
  execute format('alter table ingest.run_log add constraint run_log_source_check check (source in (%s))',
                 (select string_agg(quote_literal(n), ',') from unnest(names) as n));
end $$;

insert into core.macro_series (series_id, label, provider, source_name, source_short, source_url, unit, frequency, sort_order, in_numbers) values
  ('BLS_CPI_FOOD_HOME',   'Grocery prices (yearly)',        'bls', 'U.S. Bureau of Labor Statistics', 'BLS', 'https://www.bls.gov/cpi/', 'percent', 'monthly', 86, false),
  ('BLS_CPI_RENT',        'Rent (yearly)',                  'bls', 'U.S. Bureau of Labor Statistics', 'BLS', 'https://www.bls.gov/cpi/', 'percent', 'monthly', 87, false),
  ('BLS_CPI_ELECTRICITY', 'Electricity prices (yearly)',    'bls', 'U.S. Bureau of Labor Statistics', 'BLS', 'https://www.bls.gov/cpi/', 'percent', 'monthly', 88, false),
  ('BLS_CPI_MEDICAL',     'Medical care prices (yearly)',   'bls', 'U.S. Bureau of Labor Statistics', 'BLS', 'https://www.bls.gov/cpi/', 'percent', 'monthly', 89, false)
on conflict (series_id) do update
   set label = excluded.label, provider = excluded.provider, source_name = excluded.source_name,
       source_short = excluded.source_short, source_url = excluded.source_url, unit = excluded.unit,
       frequency = excluded.frequency, sort_order = excluded.sort_order, in_numbers = excluded.in_numbers;
