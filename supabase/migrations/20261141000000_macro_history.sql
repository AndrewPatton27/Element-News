-- M9c (chart cards): macro history for the small line charts on data cards. NOT applied. Idempotent.
-- Why: one card per data series (core.supersede_series) replaces the repeated per-reading cards; the older readings
-- now live as a chart on the live card. The history is core.macro_observations (public-domain agency numbers only,
-- already stored for the Numbers panel and the Trends column), so no new table.
--   api.macro_history(p_series text[])  anon + authenticated. One jsonb object:
--       { "DGS10": { "frequency": "daily", "points": [["2026-09-01", 4.12], ...] }, ... }
--     Bounded: at most 6 series, at most 120 points each, a window by frequency counted back from that series' newest
--     reading (daily 92 days, weekly 190, monthly 400, quarterly 800), oldest first. Only enabled series: never a
--     dev-only or disabled one. Reads the primary key (series_id, obs_date): one index range scan per series.
--   api.upsert_macro_batch(p jsonb)     service role only. A jsonb array (max 200 rows) of the api.upsert_macro shape,
--     one round trip per series so the ingest keeps the recent history filled without a separate backfill. Rows whose
--     numbers did not change are left alone (no write churn).
-- The card still names the agency and carries the FRED notice (rule 8): the chart only adds the shape of the numbers.
-- Settings: windows and caps above live in this function (context/settings.md, "Data card charts").

create or replace function api.macro_history(p_series text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  s record;
  v_latest date;
  v_days int;
  v_pts jsonb;
begin
  for s in
    select ms.series_id, ms.frequency
      from core.macro_series ms
     where ms.enabled
       and ms.series_id = any (coalesce((select array_agg(x) from (select distinct x from unnest(p_series) x limit 6) d), '{}'::text[]))
  loop
    select max(o.obs_date) into v_latest from core.macro_observations o where o.series_id = s.series_id;
    continue when v_latest is null;
    v_days := case s.frequency when 'daily' then 92 when 'weekly' then 190 when 'monthly' then 400 when 'quarterly' then 800 else 92 end;
    select coalesce(jsonb_agg(jsonb_build_array(to_char(q.obs_date, 'YYYY-MM-DD'), q.value) order by q.obs_date), '[]'::jsonb) into v_pts
      from (select o.obs_date, o.value from core.macro_observations o
             where o.series_id = s.series_id and o.obs_date >= v_latest - v_days
             order by o.obs_date desc limit 120) q;
    v_out := v_out || jsonb_build_object(s.series_id, jsonb_build_object('frequency', s.frequency, 'points', v_pts));
  end loop;
  return v_out;
end;
$$;
revoke all on function api.macro_history(text[]) from public;
grant execute on function api.macro_history(text[]) to anon, authenticated, service_role;

create or replace function api.upsert_macro_batch(p jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_n int;
begin
  if p is null or jsonb_typeof(p) <> 'array' then raise exception 'upsert_macro_batch: an array is required'; end if;
  if jsonb_array_length(p) > 200 then raise exception 'upsert_macro_batch: at most 200 rows'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p) r(series_id text)
      left join core.macro_series ms on ms.series_id = r.series_id and ms.enabled
     where ms.series_id is null
  ) then raise exception 'upsert_macro_batch: unknown or disabled series'; end if;
  insert into core.macro_observations (series_id, obs_date, value, display_value, change_text, direction, period_label)
  select r.series_id, r.obs_date, r.value, r.display_value, r.change_text, r.direction, r.period_label
    from jsonb_to_recordset(p) r(series_id text, obs_date date, value numeric, display_value text, change_text text, direction text, period_label text)
  on conflict (series_id, obs_date) do update
     set value = excluded.value, display_value = excluded.display_value, change_text = excluded.change_text,
         direction = excluded.direction, period_label = excluded.period_label, fetched_at = now()
   where (core.macro_observations.value, core.macro_observations.display_value, core.macro_observations.change_text,
          core.macro_observations.direction, core.macro_observations.period_label)
         is distinct from (excluded.value, excluded.display_value, excluded.change_text, excluded.direction, excluded.period_label);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function api.upsert_macro_batch(jsonb) from public, anon, authenticated;
grant execute on function api.upsert_macro_batch(jsonb) to service_role;

notify pgrst, 'reload schema';
