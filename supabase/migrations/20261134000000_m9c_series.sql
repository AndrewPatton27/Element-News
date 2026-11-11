-- M9c sources (part 1 of 2): run_log accepts the new source names blscal and mts, and core.macro_series gets 16 more
-- public-domain FRED series for the macro data cards (jobless claims, core CPI, PPI, PCE, Fed balance sheet, industrial
-- production, consumer credit, M2, permits, new home sales, durable goods and more). No cron here (see
-- 20261134000100_m9c_sources_cron.sql), so PGlite runs this file in test:sql. Written, NOT applied. Re-runnable.
--   1. ingest.run_log.source: the list is READ from the current constraint and extended, so source names added by other
--      migrations are kept whatever the apply order.
--   2. core.macro_series.provider is read and extended with fred, treasury, bls, bea.
--   3. The 16 series (in_numbers = false). Citations name the original agency and "via FRED" (rule 8), never bare "FRED".
--      The existing hourly element-ingest-macro job fetches them: no new job for them.

-- 1. run_log accepts the new source names (read the current list, add ours; also re-adds bls, beadata, eia, census,
--    auctions, fomc in case an older apply of 20261128000000 dropped them: review m9c)
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
  names := array(select distinct n from unnest(names || array['blscal', 'mts', 'bls', 'beadata', 'eia', 'census', 'auctions', 'fomc', 'brief-summary']) as n order by n);
  alter table ingest.run_log drop constraint if exists run_log_source_check;
  execute format('alter table ingest.run_log add constraint run_log_source_check check (source in (%s))',
                 (select string_agg(quote_literal(n), ',') from unnest(names) as n));
end $$;

-- 2a. macro_series.provider accepts 'fred' (read the current list, add ours)
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

-- 2b. the 16 series (citations name the original agency; link is the FRED series page that carries the number)
insert into core.macro_series (series_id, label, provider, source_name, source_short, source_url, unit, frequency, sort_order, in_numbers) values
  ('CCSA',     'Continued jobless claims',        'fred', 'U.S. Employment and Training Administration via FRED', 'Dept. of Labor via FRED', 'https://fred.stlouisfed.org/series/CCSA',     'number',  'weekly',  70, false),
  ('CIVPART',  'Labor force participation',       'fred', 'U.S. Bureau of Labor Statistics via FRED',             'BLS via FRED',            'https://fred.stlouisfed.org/series/CIVPART',  'percent', 'monthly', 71, false),
  ('U6RATE',   'Broad unemployment (U-6)',        'fred', 'U.S. Bureau of Labor Statistics via FRED',             'BLS via FRED',            'https://fred.stlouisfed.org/series/U6RATE',   'percent', 'monthly', 72, false),
  ('CPILFESL', 'Core CPI (yearly)',               'fred', 'U.S. Bureau of Labor Statistics via FRED',             'BLS via FRED',            'https://fred.stlouisfed.org/series/CPILFESL', 'percent', 'monthly', 73, false),
  ('PPIFIS',   'Producer prices (yearly)',        'fred', 'U.S. Bureau of Labor Statistics via FRED',             'BLS via FRED',            'https://fred.stlouisfed.org/series/PPIFIS',   'percent', 'monthly', 74, false),
  ('PCEPI',    'PCE inflation (yearly)',          'fred', 'U.S. Bureau of Economic Analysis via FRED',            'BEA via FRED',            'https://fred.stlouisfed.org/series/PCEPI',    'percent', 'monthly', 75, false),
  ('PCEPILFE', 'Core PCE inflation (yearly)',     'fred', 'U.S. Bureau of Economic Analysis via FRED',            'BEA via FRED',            'https://fred.stlouisfed.org/series/PCEPILFE', 'percent', 'monthly', 76, false),
  ('PSAVERT',  'Personal saving rate',            'fred', 'U.S. Bureau of Economic Analysis via FRED',            'BEA via FRED',            'https://fred.stlouisfed.org/series/PSAVERT',  'percent', 'monthly', 77, false),
  ('INDPRO',   'Industrial production (yearly)',  'fred', 'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/INDPRO',  'percent', 'monthly', 78, false),
  ('TCU',      'Capacity utilization',            'fred', 'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/TCU',     'percent', 'monthly', 79, false),
  ('TOTALSL',  'Consumer credit',                 'fred', 'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/TOTALSL', 'usd',     'monthly', 80, false),
  ('WALCL',    'Fed balance sheet',               'fred', 'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/WALCL',   'usd',     'weekly',  81, false),
  ('M2SL',     'Money supply M2 (yearly)',        'fred', 'Board of Governors of the Federal Reserve System (US) via FRED', 'Federal Reserve via FRED', 'https://fred.stlouisfed.org/series/M2SL',    'percent', 'monthly', 82, false),
  ('PERMIT',   'Building permits',                'fred', 'U.S. Census Bureau via FRED',                          'Census via FRED',         'https://fred.stlouisfed.org/series/PERMIT',   'number',  'monthly', 83, false),
  ('HSN1F',    'New home sales',                  'fred', 'U.S. Census Bureau via FRED',                          'Census via FRED',         'https://fred.stlouisfed.org/series/HSN1F',    'number',  'monthly', 84, false),
  ('DGORDER',  'Durable goods orders',            'fred', 'U.S. Census Bureau via FRED',                          'Census via FRED',         'https://fred.stlouisfed.org/series/DGORDER',  'usd',     'monthly', 85, false)
on conflict (series_id) do update
   set label = excluded.label, provider = excluded.provider, source_name = excluded.source_name,
       source_short = excluded.source_short, source_url = excluded.source_url, unit = excluded.unit,
       frequency = excluded.frequency, sort_order = excluded.sort_order, in_numbers = excluded.in_numbers;
