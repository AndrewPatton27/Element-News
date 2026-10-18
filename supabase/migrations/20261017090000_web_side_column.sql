-- =============================================================================
-- Element: web right column (2026-10-18)
--   api.top_stories()   the 5 best cards of the last 7 days, one per story
--   api.number_trends() 10-yr Treasury, CPI (yearly), unemployment, WTI crude with a 12-point
--                       history for the small charts
-- Both are read-only RPCs in the api schema (security definer, fixed search_path, no grants to
-- public), same pattern as api.feed. Nothing user specific is stored or read.
-- Requires 20261017000000_init, 20261017030000_accounts (core.cards_json) and
-- 20261017070000_trending_foryou (core.trend_generations / core.trend_boosts).
-- Idempotent: safe to run more than once.
-- =============================================================================

-- ---------- api.top_stories --------------------------------------------------
-- Score = rank_score + the newest trend boost (the same order as the Trending feed).
-- "One per story": walking down the score list a card is skipped when an earlier pick has the
-- same normalized headline, the same first company ticker, or (data cards) the same series.
create or replace function api.top_stories()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_gen    bigint;
  v_ids    uuid[] := '{}';
  v_seen   text[] := '{}';
  r        record;
  v_keys   text[];
begin
  select coalesce(max(gen), 0) into v_gen from core.trend_generations;

  for r in
    select b.id, b.kind, b.headline, b.dedupe_key,
           b.tickers -> 0 ->> 'symbol' as ticker
      from core.blurbs b
      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = b.id
     where b.status = 'published'
       and b.sort_at >= now() - interval '7 days'
     order by b.rank_score + coalesce(t.boost, 0) desc, b.id desc
     limit 200
  loop
    v_keys := array['h:' || lower(regexp_replace(r.headline, '[^a-zA-Z0-9]+', ' ', 'g'))];
    if r.ticker is not null then v_keys := v_keys || ('t:' || r.ticker); end if;
    if r.kind = 'data' then v_keys := v_keys || ('d:' || split_part(r.dedupe_key, ':', 1)); end if;
    if v_keys && v_seen then continue; end if;
    v_seen := v_seen || v_keys;
    v_ids  := v_ids || r.id;
    exit when cardinality(v_ids) >= 5;
  end loop;

  return coalesce((
    select jsonb_agg(x.c - 'my_reaction' order by x.o)
      from jsonb_array_elements(core.cards_json(v_ids, null)) with ordinality as x(c, o)
  ), '[]'::jsonb);
end;
$$;

revoke execute on function api.top_stories() from public;
grant  execute on function api.top_stories() to anon, authenticated, service_role;


-- ---------- api.number_trends ------------------------------------------------
-- points: up to 12 values, oldest first. Daily / weekly series: the last reading on or before
-- each of the last 12 week ends (counted back from the newest reading). Monthly / quarterly
-- series: the last 12 readings. Series with no stored readings are left out.
-- change: arrow + size of the move + "this week" (daily / weekly) or "since last month"
-- (monthly); "● unchanged" when the move rounds to 0.
create or replace function api.number_trends()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out  jsonb := '[]'::jsonb;
  s      record;
  v_last date;
  v_cur  numeric;
  v_prev numeric;
  v_pts  numeric[];
  v_d    numeric;
  v_dir  text;
  v_chg  text;
  v_disp text;
  v_fmt  text;
begin
  for s in
    select ms.series_id, ms.label, ms.source_name, ms.frequency, ms.unit
      from core.macro_series ms
     where ms.enabled and ms.series_id in ('DGS10', 'CPIAUCSL', 'UNRATE', 'DCOILWTICO')
     order by array_position(array['DGS10', 'CPIAUCSL', 'UNRATE', 'DCOILWTICO'], ms.series_id)
  loop
    select o.obs_date, o.value, o.display_value into v_last, v_cur, v_disp
      from core.macro_observations o where o.series_id = s.series_id
     order by o.obs_date desc limit 1;
    continue when v_last is null;

    if s.frequency in ('daily', 'weekly') then
      select array_agg(p.v order by p.k desc) into v_pts
        from (select k, (select o.value from core.macro_observations o
                          where o.series_id = s.series_id and o.obs_date <= v_last - 7 * k
                          order by o.obs_date desc limit 1) as v
                from generate_series(0, 11) k) p
       where p.v is not null;
      select o.value into v_prev from core.macro_observations o
       where o.series_id = s.series_id and o.obs_date <= v_last - 7
       order by o.obs_date desc limit 1;
    else
      select array_agg(p.value order by p.obs_date) into v_pts
        from (select o.obs_date, o.value from core.macro_observations o
               where o.series_id = s.series_id order by o.obs_date desc limit 12) p;
      select o.value into v_prev from core.macro_observations o
       where o.series_id = s.series_id and o.obs_date < v_last
       order by o.obs_date desc limit 1;
    end if;

    v_fmt := case when s.frequency in ('daily', 'weekly') then ' this week' else ' since last month' end;
    if v_prev is null then
      v_dir := 'flat'; v_chg := '';
    else
      v_d := round(v_cur - v_prev, case when s.unit = 'percent_yoy' then 1 else 2 end);
      v_dir := case when v_d > 0 then 'up' when v_d < 0 then 'down' else 'flat' end;
      v_chg := case v_dir
                 when 'up'   then '▲ ' || abs(v_d)::text || v_fmt
                 when 'down' then '▼ ' || abs(v_d)::text || v_fmt
                 else '● unchanged' end;
    end if;

    v_out := v_out || jsonb_build_object(
      'key', s.series_id, 'name', s.label, 'value', v_disp, 'change', v_chg,
      'direction', v_dir, 'source', s.source_name,
      'points', to_jsonb(coalesce(v_pts, '{}'::numeric[])));
  end loop;
  return v_out;
end;
$$;

revoke execute on function api.number_trends() from public;
grant  execute on function api.number_trends() to anon, authenticated, service_role;
