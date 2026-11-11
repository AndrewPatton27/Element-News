-- Brief window and never-empty fallback (release M9, workstream 7, D-119). Safe to replay.
--   * Daily window is 24 h; on Mondays (America/New_York) it is 72 h and the brief says "Since Friday".
--     The old "widen to 48/72 h when fewer than 12 cards" rule is gone: the span the reader sees is the real one.
--   * Never empty: when no eligible card exists in the window, the brief is built from the last cards that
--     do exist (window widened to reach them, at most 720 h) and flagged fallback = true with as_of = the
--     newest card's time, so the app can print "Updated <date>". Bounded: one max() over the
--     published/sort_at partial index, then the same brief_build as before.
--   * The stored AI summary falls back to the latest one (primary key kind, for_date) when today's is
--     missing; it carries for_date so the app can date it.
-- New keys on the brief JSON (old keys unchanged, old app builds keep working):
--   window_kind  '24h' | 'since_friday' | 'week'
--   brief_date   the New York calendar date the brief is for (YYYY-MM-DD)
--   fallback     true when the window had to be widened to the last good cards
--   as_of        timestamp of the newest card in the brief (null when there are no cards)
-- Internal helpers are private (no grants to app roles). Tunables in context/settings.md:
--   daily window 24, Monday window 72, fallback cap 720.

-- hours of the daily window for a moment: 72 on Monday in New York, else 24
create or replace function core.brief_window_hours(p_now timestamptz default now())
returns int language sql stable set search_path = '' as $$
  select case when extract(isodow from p_now at time zone 'America/New_York') = 1 then 72 else 24 end;
$$;
revoke all on function core.brief_window_hours(timestamptz) from public, anon, authenticated;

-- newest card a brief could show (same filters as brief_supply)
create or replace function core.brief_last_card_at()
returns timestamptz language sql stable security definer set search_path = '' as $$
  select max(b.sort_at)
    from core.blurbs b join core.app_config c on c.id
   where b.status = 'published' and b.published_at <= now()
     and (b.kind <> 'link_out' or c.linkout_cards)
     and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id);
$$;
revoke all on function core.brief_last_card_at() from public, anon, authenticated;

-- {hours, fallback, as_of} for a requested window
create or replace function core.brief_effective_window(p_hours int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_asof timestamptz; v_hours int := p_hours; v_fb boolean := false;
begin
  if core.brief_supply(p_hours) >= 1 then
    select max(b.sort_at) into v_asof from core.blurbs b
     where b.status = 'published' and b.published_at <= now() and b.sort_at >= now() - make_interval(hours => p_hours);
  else
    v_asof := core.brief_last_card_at();
    if v_asof is not null and v_asof >= now() - interval '720 hours' then
      v_fb := true;
      v_hours := least(720, greatest(p_hours, ceil(extract(epoch from now() - v_asof) / 3600)::int + 24));
    else
      v_asof := null;
    end if;
  end if;
  return jsonb_build_object('hours', v_hours, 'fallback', v_fb, 'as_of', v_asof);
end; $$;
revoke all on function core.brief_effective_window(int) from public, anon, authenticated;

create or replace function api.daily_brief() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_req int := core.brief_window_hours(now()); v_w jsonb; v_hours int; v_built jsonb; v_numbers jsonb; v_mnums jsonb; v_summary jsonb; v_market jsonb;
begin
 v_w := core.brief_effective_window(v_req);
 v_hours := (v_w->>'hours')::int;
 v_built := core.brief_build(v_hours, 6);
 select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_numbers from (select * from api.numbers_to_know order by sort_order limit 4) n;
 v_market := core.brief_market_pack(v_hours);
 select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_mnums from api.numbers_to_know n where n.series_id in ('DGS10','DGS2','DFF','DCOILWTICO');
 select jsonb_build_object('text',s.text,'generated_at',s.created_at,'model',s.model,'for_date',s.for_date) into v_summary
   from core.brief_summaries s where s.kind='daily' order by s.for_date desc limit 1;
 return jsonb_build_object('generated_at',now(),'window_hours',v_hours,
   'window_kind', case when v_req = 72 then 'since_friday' else '24h' end,
   'brief_date',(now() at time zone 'America/New_York')::date,'fallback',(v_w->>'fallback')::boolean,'as_of',v_w->'as_of',
   'headline_cards',v_built->'headline_cards',
   'sections',coalesce((select jsonb_agg(sec order by (sec->>'rank')::int) from jsonb_array_elements(v_built->'sections') sec where sec->>'category' not in ('markets','earnings','deals')),'[]'::jsonb),
   'numbers',v_numbers,'summary',v_summary,
   'markets',jsonb_build_object('cards',v_market->'cards','numbers',v_mnums,'total',(v_market->>'total')::int));
end $$;

create or replace function api.weekly_brief() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_w jsonb; v_hours int; v_built jsonb; v_numbers jsonb; v_mnums jsonb; v_summary jsonb; v_market jsonb;
begin
 v_w := core.brief_effective_window(168);
 v_hours := (v_w->>'hours')::int;
 v_built := core.brief_build(v_hours,8);
 select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_numbers from (select * from api.numbers_to_know order by sort_order limit 4) n;
 v_market := core.brief_market_pack(v_hours);
 select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_mnums from api.numbers_to_know n where n.series_id in ('DGS10','DGS2','DFF','DCOILWTICO');
 select jsonb_build_object('text',s.text,'generated_at',s.created_at,'model',s.model,'for_date',s.for_date) into v_summary
   from core.brief_summaries s where s.kind='weekly' order by s.for_date desc limit 1;
 return jsonb_build_object('generated_at',now(),'window_hours',v_hours,'window_kind','week',
   'brief_date',(now() at time zone 'America/New_York')::date,'fallback',(v_w->>'fallback')::boolean,'as_of',v_w->'as_of',
   'headline_cards',v_built->'headline_cards',
   'sections',coalesce((select jsonb_agg(sec order by (sec->>'rank')::int) from jsonb_array_elements(v_built->'sections') sec where sec->>'category' not in ('markets','earnings','deals')),'[]'::jsonb),
   'numbers',v_numbers,'summary',v_summary,
   'markets',jsonb_build_object('cards',v_market->'cards','numbers',v_mnums,'total',(v_market->>'total')::int),
   'movers',api.number_trends());
end $$;
revoke all on function api.daily_brief(),api.weekly_brief() from public;
grant execute on function api.daily_brief(),api.weekly_brief() to anon,authenticated;
