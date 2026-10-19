-- api.numbers_to_know gains one trailing column, updated_at: when the ingest job last stored the
-- number (core.macro_observations.fetched_at). The app shows "All numbers updated ..." from it.
-- Same columns as before plus the new last one, so existing readers keep working.

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
       s.sort_order,
       o.fetched_at        as updated_at
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
