-- More FRED series (2026-10-17): gas price, jobless claims, retail sales, housing starts,
-- payrolls, real GDP growth. Each series page on FRED is tagged "Public Domain: Citation
-- Requested"; the citation names the original agency, "via FRED" (never bare "FRED").
-- MORTGAGE30US is deliberately absent (Freddie Mac copyright).
--
-- The numbers panel (api.numbers_to_know) keeps a top set for everyday readers through the
-- new in_numbers column; the other series still store observations and get data cards.
-- Panel (8): 10-yr Treasury, fed funds, CPI, unemployment, WTI oil, gas price, payrolls, GDP.
-- Not in the panel: 2-yr Treasury, jobless claims, retail sales, housing starts.
--
-- Idempotent: safe to run more than once.

alter table core.macro_series add column if not exists in_numbers boolean not null default true;

insert into core.macro_series (series_id, label, provider, source_name, source_short, source_url, unit, frequency, sort_order, in_numbers) values
  ('GASREGW',         'Gas price (regular)',      'fred', 'U.S. Energy Information Administration via FRED',                                    'EIA via FRED',            'https://fred.stlouisfed.org/series/GASREGW',         'usd_per_gallon', 'weekly',    7,  true),
  ('ICSA',            'Jobless claims (weekly)',  'fred', 'U.S. Employment and Training Administration via FRED',                               'Dept. of Labor via FRED', 'https://fred.stlouisfed.org/series/ICSA',            'number',         'weekly',    8,  false),
  ('RSAFS',           'Retail sales (monthly)',   'fred', 'U.S. Census Bureau via FRED',                                                        'Census via FRED',         'https://fred.stlouisfed.org/series/RSAFS',           'usd_millions',   'monthly',   9,  false),
  ('HOUST',           'Housing starts',           'fred', 'U.S. Census Bureau and U.S. Department of Housing and Urban Development via FRED',   'Census via FRED',         'https://fred.stlouisfed.org/series/HOUST',           'number',         'monthly',   10, false),
  ('PAYEMS',          'Payroll jobs',             'fred', 'U.S. Bureau of Labor Statistics via FRED',                                           'BLS via FRED',            'https://fred.stlouisfed.org/series/PAYEMS',          'number',         'monthly',   11, true),
  ('A191RL1Q225SBEA', 'GDP growth (annual rate)', 'fred', 'U.S. Bureau of Economic Analysis via FRED',                                          'BEA via FRED',            'https://fred.stlouisfed.org/series/A191RL1Q225SBEA', 'percent',        'quarterly', 12, true)
on conflict (series_id) do update
   set label = excluded.label, provider = excluded.provider, source_name = excluded.source_name,
       source_short = excluded.source_short, source_url = excluded.source_url, unit = excluded.unit,
       frequency = excluded.frequency, sort_order = excluded.sort_order, in_numbers = excluded.in_numbers;

-- The 2-yr Treasury stays collected (data cards on big moves) but leaves the panel.
update core.macro_series set in_numbers = false where series_id = 'DGS2';

-- Same columns as before (contract shape unchanged); only the panel filter is new.
create or replace view api.numbers_to_know as
select s.series_id,
       s.label,
       o.display_value     as value,
       o.change_text       as change,
       o.direction,
       o.period_label      as period,
       o.obs_date::text    as as_of,
       s.source_name,
       s.source_short,
       s.source_url,
       s.sort_order
  from core.macro_series s
  join lateral (
        select * from core.macro_observations mo
         where mo.series_id = s.series_id
         order by mo.obs_date desc
         limit 1
       ) o on true
 where s.enabled and s.in_numbers
 order by s.sort_order;

revoke all on api.numbers_to_know from public;
grant select on api.numbers_to_know to anon, authenticated, service_role;
