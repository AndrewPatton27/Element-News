-- =============================================================================
-- Element: For you M9 batch 2 (ranking-m9b, 2026-11-10). NOT applied. Idempotent (safe to run twice).
--
-- Signed-in For you only. The guest feed (api.feed), Trending, Latest, Following and search are NOT changed.
-- Decisions: D-115 (fedreg_noneconomic_micro ON), D-116 (foryou_personal_scale stays 3), D-117
-- (ml_purge_events_days 60). Findings: algorithm-findings F7, F8, F10; master list A-03, A-09, A-14, A-15, A-16.
--
--   A  Settings (core.rank_params, insert ... on conflict do update; every row is in context/settings.md).
--   B  Indexes for the new reads (create index if not exists).
--   C  core.fy_followed_tickers(): the followed tickers of this request (they live on the device; the app sends
--      them to the new 4-argument api.feed_for_you, which puts them in the transaction setting element.fy_tickers,
--      upper-cased, de-duplicated, at most fy_follow_tickers_max).
--   D  core.feed_for_you_v5_base and core.v3_scores (the bodies from 20261121000000_foryou_scale.sql) with new
--      score terms, all in hours, all bounded:
--        + fy_follow_topic_hours (6) when the card's topic is followed (on top of the old 2 x scale 3 = 6 h).
--        + fy_follow_company_hours (24) when the card is tagged with a followed ticker (core.card_companies at
--          tag_min_confidence). Up to fy_follow_company_max (50) such cards join the candidates past the cut.
--        + "k:" ticker affinity: fy_ticker_like_hours (4) x my net reactions on cards tagged with the same ticker
--          (likes +1, dislikes -1, faded with signal_half_life_days), capped at +/- fy_ticker_cap_hours (8).
--        + fy_authority_hours (6) for cards from a fy_authority_source:<key> (bea, fed, bls, treasury) or of a
--          key series.
--        Release time (F7, A-15): a data card's sort_at is its PERIOD (CPI for September = Sep 1), so it looked
--        weeks old on the day it came out and monthly releases fell out of the 30-day window. For you now counts a
--        data card from its release (published_at, capped at fy_release_shift_max_hours = 60 days after the
--        period); every live data card released in the window is a candidate (one live card per series, so a few
--        dozen rows). News cards keep sort_at (the source's own time), so a late-ingested old story is not fresh.
--        Freshness: a live key-series card (fy_key_series:<series id>, e.g. CPIAUCSL, PAYEMS) uses the half-life
--        fy_key_series_half_life_hours (72) instead of the topic one, and stays a candidate up to
--        fy_key_series_max_days (120) after its release (sort_at = the release time), until superseded
--        (20261122000200_series_supersede.sql hides older readings). Economy half-life 8 -> 24 h.
--      Everything else (taste, explore, crowd, collab, seen, steps, cut, cursors, paging) is unchanged.
--   E  core.fy_post(page, user): on each For you page, (1) a short reason per card, from the reader's OWN
--      follows and signals only: {"code", "arg"} with code follow_company | follow_topic | liked_company |
--      liked_topic | key_release | authority | new_topic | top_story; the app renders "Because you follow
--      Economy" (lib/feed/reasonLine.ts). (2) A-14: in the first fy_company_cap_top (9) slots at most
--      fy_company_cap (1) single-company card in any fy_company_cap_window (3) in a row (soft: when no other card
--      is left, the next one is taken; cards of followed companies are exempt). Only the order inside the page
--      changes, so paging never repeats or loses a card. api.feed_for_you(text, int) calls it before the
--      ml_pages log (the v3 terms are permuted the same way); an error leaves the page as it was.
--   F  api.feed_for_you(text, int, uuid[], text[]): p_tickers = followed tickers (on the device). Old 2- and
--      3-argument calls work as before (no tickers: no company boost, no follow_company reason).
--   G  The grants allowlist (20261121000400_api_grants.sql) gets the new function: authenticated only.
--
-- Run after 20261122000200_series_supersede.sql. Check: supabase/tests/foryou_m9b_check.sql and
-- supabase/tests/foryou_m9b_scale_check.sql (100,000 cards, 20,000 readers).
-- =============================================================================

do $$
begin
  if to_regprocedure('core.feed_for_you_v5_base(text,integer)') is null
     or to_regprocedure('core.v3_scores(uuid,timestamp with time zone,bigint)') is null
     or to_regclass('core.card_companies') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'core' and table_name = 'blurbs' and column_name = 'superseded_by') then
    raise exception 'foryou_m9b: apply 20261121000000_foryou_scale.sql, 20261115000000_companies.sql and 20261122000200_series_supersede.sql first';
  end if;
end $$;

-- =============================================================================
-- A. SETTINGS
-- =============================================================================
insert into core.rank_params (key, value) values
  ('fedreg_noneconomic_micro',        1),    -- D-115: non-economic Federal Register cards share the micro page cap
  ('ml_purge_events_days',           60),    -- D-117: purge core.user_events older than 60 days (>= 31, > seen_exclude_days 14)
  ('foryou_personal_scale',           3),    -- D-116: stays 3 (offline 3 vs 6 comparison in lib/__tests__/m9bLedger.test.ts)
  ('foryou_half_life_economy',       24),    -- F7: macro news fades 3x slower than other news (8 h)
  ('fy_follow_topic_hours',           6),    -- A-03: visible boost for a followed topic (plus 2 x scale = 6 h before)
  ('fy_follow_company_hours',        24),    -- A-09: card tagged with a followed ticker (same as the device ranker's +24)
  ('fy_follow_company_max',          50),    -- followed-company cards added past the candidate cut (bound)
  ('fy_follow_tickers_max',         100),    -- followed tickers read from a request (bound)
  ('fy_ticker_like_hours',            4),    -- F8: per net (faded) like on cards with the same ticker
  ('fy_ticker_cap_hours',             8),    -- F8: cap, +/-
  ('fy_authority_hours',              6),    -- B-01: BLS / BEA / Fed / Treasury cards and key series
  ('fy_authority_source:bea',         1),
  ('fy_authority_source:bls',         1),
  ('fy_authority_source:fed',         1),
  ('fy_authority_source:treasury',    1),
  ('fy_key_series_half_life_hours',  72),    -- F7: evergreen key releases
  ('fy_key_series_max_days',        120),    -- F7: a live key-series card stays a candidate this long
  ('fy_release_shift_max_hours',   1440),    -- F7: a data card counts from its release (published_at), not its period
  ('fy_key_series:CPIAUCSL',          1),    -- CPI
  ('fy_key_series:CPILFESL',          1),    -- core CPI
  ('fy_key_series:PAYEMS',            1),    -- payrolls
  ('fy_key_series:UNRATE',            1),    -- unemployment
  ('fy_key_series:GDP',               1),
  ('fy_key_series:GDPC1',             1),
  ('fy_key_series:PCEPI',             1),
  ('fy_key_series:PCEPILFE',          1),
  ('fy_key_series:DFEDTARU',          1),    -- Fed target (upper)
  ('fy_key_series:FEDFUNDS',          1),
  ('fy_key_series:HOUST',             1),    -- housing starts
  ('fy_key_series:RSAFS',             1),    -- retail sales
  ('fy_company_cap',                  1),    -- A-14: at most 1 single-company card ...
  ('fy_company_cap_window',           3),    -- ... in any 3 in a row ...
  ('fy_company_cap_top',              9),    -- ... in the first 9 slots of a page
  ('fy_reason_on',                    1)     -- A-16: 1 = reason per card; 0 = no reason field (cap still applies)
on conflict (key) do update set value = excluded.value;

alter table core.rank_params drop constraint if exists rank_params_m9b_range;
alter table core.rank_params add constraint rank_params_m9b_range check (
      (key <> 'ml_purge_events_days' or value = 0 or value >= 31)
  and (key not in ('fy_follow_topic_hours', 'fy_follow_company_hours', 'fy_ticker_like_hours', 'fy_ticker_cap_hours',
                   'fy_authority_hours') or value between 0 and 48)
  and (key not in ('fy_follow_company_max', 'fy_follow_tickers_max') or value between 0 and 500)
  and (key <> 'fy_key_series_max_days' or value between 1 and 365)
  and (key <> 'fy_release_shift_max_hours' or value between 0 and 4320)
  and (key not in ('fy_company_cap', 'fy_company_cap_window', 'fy_company_cap_top') or value between 0 and 30)
  and (key <> 'fy_reason_on' or value in (0, 1)));

-- ml_purge_events_days must stay above seen_exclude_days (the seen exclusion reads that many days of views)
do $$
begin
  if (select value from core.rank_params where key = 'ml_purge_events_days') between 1 and
     coalesce((select value from core.rank_params where key = 'seen_exclude_days'), 14) then
    raise exception 'foryou_m9b: ml_purge_events_days must be above seen_exclude_days';
  end if;
end $$;

-- =============================================================================
-- B. INDEXES (the new reads; the rest already exist: user_events_user_time_idx, card_companies PK and
--    card_companies_ticker_sort, blurbs (sort_at desc, id desc) where published)
-- =============================================================================
create index if not exists blurbs_data_live_idx
  on core.blurbs (published_at desc)
  where kind = 'data' and status = 'published';
-- No new user_events index: every new read is one reader's events in a time window (user_events_user_time_idx).

-- =============================================================================
-- C. FOLLOWED TICKERS OF THIS REQUEST
-- =============================================================================
create or replace function core.fy_followed_tickers()
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(t order by n), '{}') from (
    select upper(btrim(x)) as t, min(n) as n
      from unnest(string_to_array(coalesce(current_setting('element.fy_tickers', true), ''), ',')) with ordinality as u(x, n)
     where btrim(x) <> '' and length(btrim(x)) <= 12
     group by upper(btrim(x))
     order by min(n)
     limit greatest(coalesce((select r.value from core.rank_params r where r.key = 'fy_follow_tickers_max'), 100), 0)::int) s;
$$;
revoke all on function core.fy_followed_tickers() from public, anon, authenticated;


-- =============================================================================
-- E. core.fy_post: reason per card + single-company cap, inside one page (at most 30 cards)
-- =============================================================================
create or replace function core.fy_post(p jsonb, p_uid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items  jsonb := coalesce(p -> 'items', '[]'::jsonb);
  v_n      int   := jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb));
  v_tick   text[] := core.fy_followed_tickers();
  v_fol    text[];
  v_taste  jsonb;
  v_tmin   numeric;
  v_days   numeric; v_chalf numeric; v_exmin numeric;
  v_cap    int; v_win int; v_top int; v_on boolean;
  v_asrc   text[];
  v_reason jsonb[];
  v_co     boolean[];
  v_left   int[];
  v_perm   int[] := '{}';
  v_pick   int;
  v_cnt    int;
  v_out    jsonb := '[]'::jsonb;
  v_nev    int;
  i        int;
begin
  if v_n = 0 or p_uid is null then return p; end if;
  select followed_categories into v_fol from core.user_prefs where user_id = p_uid;
  v_fol := coalesce(v_fol, '{}');
  select coalesce(max(value) filter (where key = 'affinity_days'), 30),
         coalesce(max(value) filter (where key = 'signal_half_life_days'), 14),
         coalesce(max(value) filter (where key = 'foryou_explore_min_events'), 5),
         greatest(coalesce(max(value) filter (where key = 'fy_company_cap'), 1), 0)::int,
         greatest(coalesce(max(value) filter (where key = 'fy_company_cap_window'), 3), 1)::int,
         greatest(coalesce(max(value) filter (where key = 'fy_company_cap_top'), 9), 0)::int,
         coalesce(max(value) filter (where key = 'fy_reason_on'), 1) = 1,
         coalesce(array_agg(substr(key, length('fy_authority_source:') + 1)) filter (where key like 'fy\_authority\_source:%' and value > 0), '{}')
    into v_days, v_chalf, v_exmin, v_cap, v_win, v_top, v_on, v_asrc
    from core.rank_params;
  v_tmin := coalesce((select value from core.company_params where key = 'tag_min_confidence'), 0.60);
  v_taste := core.user_taste(p_uid, clock_timestamp());
  select count(*) into v_nev from core.user_events e
   where e.user_id = p_uid and e.created_at > clock_timestamp() - make_interval(days => v_days::int);

  with it as (
    select x.c, x.o::int as o, (x.c ->> 'id')::uuid as id, x.c ->> 'category' as category
      from jsonb_array_elements(v_items) with ordinality as x(c, o)
  ), tk as (                                             -- company tags of the page cards
    select it.o, cc.ticker from it join core.card_companies cc on cc.blurb_id = it.id where cc.confidence >= v_tmin
  ), ktaste as (                                         -- my net reactions per ticker, only the page's tickers
    select cc.ticker,
           sum(case when e.kind = 'like' then 1 else -1 end
               * power(0.5::numeric, (extract(epoch from (clock_timestamp() - e.created_at)) / 86400.0)::numeric
                                     / greatest(v_chalf, 0.01))) as w
      from core.user_events e
      join core.card_companies cc on cc.blurb_id = e.blurb_id and cc.confidence >= v_tmin
     where e.user_id = p_uid and e.kind in ('like', 'dislike')
       and e.created_at > clock_timestamp() - make_interval(days => v_days::int)
       and cc.ticker in (select ticker from tk)
     group by cc.ticker
  ), sig as (                                            -- topics I already have signals in
    select distinct b.category
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = p_uid and e.created_at > clock_timestamp() - make_interval(days => v_days::int)
  ), r as (
    select it.o,
           (select t.ticker from tk t where t.o = it.o and t.ticker = any (v_tick) order by t.ticker limit 1) as fco,
           (select t.ticker from tk t join ktaste k on k.ticker = t.ticker
             where t.o = it.o and k.w > 0 order by k.w desc, t.ticker limit 1) as lco,
           it.category = any (v_fol) as ftop,
           coalesce((v_taste -> 'c' ->> it.category)::numeric, 0) > 0 as ltop,
           (b.kind = 'data' and exists (select 1 from core.rank_params rp
                                          where rp.key = 'fy_key_series:' || split_part(b.dedupe_key, ':', 1) and rp.value > 0)) as kser,
           (b.kind <> 'data' and core.source_key_of(b.kind, b.id) = any (v_asrc)) as auth,
           (v_nev >= v_exmin and not exists (select 1 from sig where sig.category = it.category)) as newt,
           (coalesce(it.c ->> 'kind', '') <> 'data'
            and jsonb_array_length(coalesce(it.c -> 'macro', '[]'::jsonb)) = 0
            and (jsonb_array_length(coalesce(it.c -> 'tickers', '[]'::jsonb)) > 0 or it.category in ('earnings', 'deals'))
            and not exists (select 1 from jsonb_array_elements(coalesce(it.c -> 'tickers', '[]'::jsonb)) s
                             where upper(s ->> 'symbol') = any (v_tick))
            and not exists (select 1 from tk t where t.o = it.o and t.ticker = any (v_tick))) as co
      from it left join core.blurbs b on b.id = it.id
  )
  select array_agg(case
           when r.fco is not null then jsonb_build_object('code', 'follow_company', 'arg', r.fco)
           when r.ftop            then jsonb_build_object('code', 'follow_topic', 'arg', it2.category)
           when r.lco is not null then jsonb_build_object('code', 'liked_company', 'arg', r.lco)
           when r.ltop            then jsonb_build_object('code', 'liked_topic', 'arg', it2.category)
           when r.kser            then jsonb_build_object('code', 'key_release', 'arg', null)
           when r.auth            then jsonb_build_object('code', 'authority', 'arg', null)
           when r.newt            then jsonb_build_object('code', 'new_topic', 'arg', it2.category)
           else                        jsonb_build_object('code', 'top_story', 'arg', null) end order by r.o),
         array_agg(coalesce(r.co, false) order by r.o)
    into v_reason, v_co
    from r join (select x.o::int as o, x.c ->> 'category' as category
                   from jsonb_array_elements(v_items) with ordinality as x(c, o)) it2 on it2.o = r.o;

  -- A-14: greedy, slot by slot; soft (no other card left: the next one is taken)
  v_left := array(select g from generate_series(1, v_n) g);
  while cardinality(v_left) > 0 loop
    v_pick := v_left[1];
    if cardinality(v_perm) < v_top and v_co[v_pick] then
      select count(*) into v_cnt
        from unnest(v_perm[greatest(cardinality(v_perm) - v_win + 2, 1):cardinality(v_perm)]) as q(k)
       where v_co[q.k];
      if v_cnt >= v_cap then
        select q.k into v_pick from unnest(v_left) with ordinality as q(k, o) where not v_co[q.k] order by q.o limit 1;
        v_pick := coalesce(v_pick, v_left[1]);
      end if;
    end if;
    v_perm := v_perm || v_pick;
    v_left := array_remove(v_left, v_pick);
  end loop;

  for i in 1 .. v_n loop
    v_out := v_out || jsonb_build_array(case when v_on then (v_items -> (v_perm[i] - 1)) || jsonb_build_object('reason', v_reason[v_perm[i]])
                                             else v_items -> (v_perm[i] - 1) end);
  end loop;
  return p || jsonb_build_object('items', v_out,
                                 '_perm', to_jsonb(array(select k - 1 from unnest(v_perm) with ordinality as q(k, o) order by q.o)));
end;
$$;
revoke all on function core.fy_post(jsonb, uuid) from public, anon, authenticated;

-- =============================================================================
-- D. RANKERS (bodies from 20261121000000_foryou_scale.sql; lines marked M9b are new) and api.feed_for_you(text, int)
--    (body from 20261113000000_seen_exclusion.sql; only the core.fy_post block is new)
-- =============================================================================

-- ---- core.feed_for_you_v5_base (from 20261121000000_foryou_scale.sql + M9b terms) ----
create or replace function core.feed_for_you_v5_base(p_cursor text default null, p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_limit   int  := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_key     numeric;
  v_id      uuid;
  v_gen     bigint;
  v_asof    timestamptz;
  v_state   jsonb := '{}';
  v_div     jsonb;
  v_carry   uuid[] := '{}';
  v_left    uuid[];
  v_fetch   int;
  v_extra   int;
  v_more    boolean := false;
  v_lastkey text;
  v_lastid  uuid;
  v_sx      uuid[] := '{}';
  v_fol     text[];
  v_hid     text[];
  v_hsrc    text[];
  v_taste   jsonb;
  v_window numeric; v_seen numeric; v_seenv numeric;
  v_explore numeric; v_exmin numeric; v_step numeric; v_days numeric; v_scale numeric;
  v_chalf   numeric; v_ch numeric; v_chalfs numeric; v_th numeric; v_capc numeric;
  v_llmax   numeric; v_llmin numeric; v_llpw numeric; v_walk numeric;
  v_h       numeric; v_cold numeric; v_coldn numeric; v_maxsc numeric;
  v_nev     int;
  v_ids     uuid[];
  v_keys    text[];
  v_out     uuid[];
  v_next    text;
  v_ftop    numeric; v_fco numeric; v_tk numeric; v_tkcap numeric; v_auth numeric;   -- M9b
  v_kshl    numeric; v_ksdays numeric; v_fcmax numeric; v_tmin numeric; v_rshmax numeric;
  v_tick    text[]; v_asrc text[];
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  if p_cursor is null then
    v_key := 1e12;
    v_id  := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  else
    begin
      v_key  := split_part(p_cursor, '|', 1)::numeric;
      v_id   := split_part(p_cursor, '|', 2)::uuid;
      v_gen  := nullif(split_part(p_cursor, '|', 3), '')::bigint;
      v_asof := nullif(split_part(p_cursor, '|', 4), '')::timestamptz;
      v_state := core.state_from_text(split_part(p_cursor, '|', 5));
      v_carry := coalesce(string_to_array(nullif(split_part(p_cursor, '|', 6), ''), ',')::uuid[], '{}');
    exception when others then
      raise exception 'invalid_cursor' using errcode = 'PT422';
    end;
  end if;
  v_asof := least(coalesce(v_asof, clock_timestamp()), clock_timestamp());
  if v_gen is null or not exists (select 1 from core.trend_generations where gen = v_gen) then
    select coalesce(max(gen), 0) into v_gen from core.trend_generations;
  end if;

  select followed_categories, hidden_categories, hidden_sources into v_fol, v_hid, v_hsrc
    from core.user_prefs where user_id = v_uid;
  v_fol  := coalesce(v_fol, '{}');
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');
  v_sx := coalesce(core.seen_ids(v_uid, clock_timestamp()), '{}');   -- seen-card exclusion (keys do not depend on it)

  select coalesce(max(value) filter (where key = 'for_you_window_days'), 30),
         coalesce(max(value) filter (where key = 'seen_penalty_hours'), 100),
         coalesce(max(value) filter (where key = 'seen_view_penalty_hours'), 24),
         coalesce(max(value) filter (where key = 'foryou_explore_hours'), 1),
         coalesce(max(value) filter (where key = 'foryou_explore_min_events'), 5),
         coalesce(max(value) filter (where key = 'foryou_category_step_hours'), 0.75),
         coalesce(max(value) filter (where key = 'affinity_days'), 30),
         coalesce(max(value) filter (where key = 'foryou_personal_scale'), 3),
         coalesce(max(value) filter (where key = 'signal_half_life_days'), 14),
         coalesce(max(value) filter (where key = 'collab_card_hours'), 4),
         coalesce(max(value) filter (where key = 'collab_card_half'), 0.5),
         coalesce(max(value) filter (where key = 'collab_topic_hours'), 2),
         coalesce(max(value) filter (where key = 'affinity_cap_hours'), 4),
         coalesce(max(value) filter (where key = 'dwell_long_ms'), 8000),
         coalesce(max(value) filter (where key = 'dwell_long_min_ms'), 6000),
         coalesce(max(value) filter (where key = 'dwell_ms_per_word'), 150),
         coalesce(max(value) filter (where key = 'dwell_walkaway_ms'), 120000),
         coalesce(max(value) filter (where key = 'half_life_hours'), 8),
         coalesce(max(value) filter (where key = 'foryou_cold_step_hours'), 4),
         coalesce(max(value) filter (where key = 'foryou_cold_events'), 5),
         greatest(coalesce(max(value) filter (where key = 'foryou_max_scored'), 1500), 1)
    into v_window, v_seen, v_seenv, v_explore, v_exmin, v_step, v_days, v_scale,
         v_chalf, v_ch, v_chalfs, v_th, v_capc, v_llmax, v_llmin, v_llpw, v_walk,
         v_h, v_cold, v_coldn, v_maxsc
    from core.rank_params;

  if cardinality(v_carry) > 0 then                       -- held back by the previous page
    select coalesce(array_agg(u.id order by u.o), '{}') into v_carry
      from unnest(v_carry) with ordinality as u(id, o)
      join core.blurbs b on b.id = u.id
     where b.status = 'published'
       and not (b.category = any (v_hid))
       and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike')
       and not (b.id = any (v_sx));
  end if;
  select coalesce(max(value), 3)::int into v_extra from core.rank_params where key = 'diversity_carry';
  v_fetch := greatest(v_limit + greatest(v_extra, 0) - cardinality(v_carry), 1);

  select count(*) into v_nev from core.user_events e
   where e.user_id = v_uid and e.created_at < v_asof
     and e.created_at > v_asof - make_interval(days => v_days::int);

  -- cold start (no follows yet): extra topic spread that fades out over the first few signals
  if cardinality(v_fol) = 0 then
    v_step := v_step + greatest(v_cold, 0) * greatest(1 - v_nev::numeric / greatest(v_coldn, 1), 0);
  end if;
  v_taste := core.user_taste(v_uid, v_asof);

  -- M9b (20261126000000): visible follow boosts, ticker affinity, authority boost, key-series freshness
  select coalesce(max(value) filter (where key = 'fy_follow_topic_hours'), 6),
         coalesce(max(value) filter (where key = 'fy_follow_company_hours'), 12),
         coalesce(max(value) filter (where key = 'fy_ticker_like_hours'), 4),
         greatest(coalesce(max(value) filter (where key = 'fy_ticker_cap_hours'), 8), 0),
         coalesce(max(value) filter (where key = 'fy_authority_hours'), 6),
         greatest(coalesce(max(value) filter (where key = 'fy_key_series_half_life_hours'), 72), 0.5),
         greatest(coalesce(max(value) filter (where key = 'fy_key_series_max_days'), 120), 1),
         greatest(coalesce(max(value) filter (where key = 'fy_follow_company_max'), 50), 0),
         greatest(coalesce(max(value) filter (where key = 'fy_release_shift_max_hours'), 1440), 0),
         coalesce(array_agg(substr(key, length('fy_authority_source:') + 1)) filter (where key like 'fy\_authority\_source:%' and value > 0), '{}')
    into v_ftop, v_fco, v_tk, v_tkcap, v_auth, v_kshl, v_ksdays, v_fcmax, v_rshmax, v_asrc
    from core.rank_params;
  v_tick := core.fy_followed_tickers();
  v_tmin := coalesce((select value from core.company_params where key = 'tag_min_confidence'), 0.60);

  with hl as materialized (                              -- freshness half-life per topic
    select substr(r.key, length('foryou_half_life_') + 1) as category, greatest(r.value, 0.5) as h
      from core.rank_params r where r.key like 'foryou\_half\_life\_%'
  ), ks as materialized (                                -- M9b: key series (newest card stays eligible)
    select substr(r.key, length('fy_key_series:') + 1) as series
      from core.rank_params r where r.key like 'fy\_key\_series:%' and r.value > 0
  ), cand0a as materialized (                            -- point 2: the window, cut by the reader-independent score
    select b.id, b.category, b.rank_score, b.sort_at, b.kind, b.word_count, coalesce(b.event_type, b.kind) as typ,
           (b.kind = 'data' and split_part(b.dedupe_key, ':', 1) in (select series from ks)) as kser,
           case when b.kind = 'data' then least(greatest(b.published_at, b.sort_at), v_asof) else b.sort_at end as rat,
           case when b.kind = 'data'
                then least(greatest(extract(epoch from (least(b.published_at, v_asof) - b.sort_at)) / 3600.0, 0), v_rshmax)::numeric
                else 0 end as shift
      from core.blurbs b
      left join hl on hl.category = b.category
      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = b.id
     where b.status = 'published'
       and b.published_at <= v_asof
       and b.sort_at > v_asof - make_interval(days => v_window::int)
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike')
     order by b.rank_score + coalesce(t.boost, 0)
                + case when b.kind = 'data'
                       then least(greatest(extract(epoch from (least(b.published_at, v_asof) - b.sort_at)) / 3600.0, 0), v_rshmax)::numeric
                       else 0 end
                - greatest(extract(epoch from (v_asof - case when b.kind = 'data' then least(greatest(b.published_at, b.sort_at), v_asof)
                                                          else b.sort_at end)) / 3600.0, 0)::numeric
                  * (v_h / coalesce(case when b.kind = 'data' and split_part(b.dedupe_key, ':', 1) in (select series from ks)
                                         then v_kshl end, hl.h, v_h) - 1) desc,
              b.id desc
     limit (v_maxsc + cardinality(v_sx))::int
  ), cand0x as materialized (                            -- M9b: past the cut (bounded): live key-series cards, followed companies
    select b.id, b.category, b.rank_score, b.sort_at, b.kind, b.word_count, coalesce(b.event_type, b.kind) as typ,
           (b.kind = 'data' and split_part(b.dedupe_key, ':', 1) in (select series from ks)) as kser,
           case when b.kind = 'data' then least(greatest(b.published_at, b.sort_at), v_asof) else b.sort_at end as rat,
           case when b.kind = 'data'
                then least(greatest(extract(epoch from (least(b.published_at, v_asof) - b.sort_at)) / 3600.0, 0), v_rshmax)::numeric
                else 0 end as shift
      from core.blurbs b
     where b.kind = 'data' and b.status = 'published'                 -- one live card per series: a few dozen rows
       and b.published_at <= v_asof
       and (b.published_at > v_asof - make_interval(days => v_window::int)
            or (b.published_at > v_asof - make_interval(days => v_ksdays::int)
                and split_part(b.dedupe_key, ':', 1) in (select series from ks)))
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike')
    union
    select b.id, b.category, b.rank_score, b.sort_at, b.kind, b.word_count, coalesce(b.event_type, b.kind) as typ,
           (b.kind = 'data' and split_part(b.dedupe_key, ':', 1) in (select series from ks)) as kser,
           case when b.kind = 'data' then least(greatest(b.published_at, b.sort_at), v_asof) else b.sort_at end as rat,
           case when b.kind = 'data'
                then least(greatest(extract(epoch from (least(b.published_at, v_asof) - b.sort_at)) / 3600.0, 0), v_rshmax)::numeric
                else 0 end as shift
      from (select cc.blurb_id from core.card_companies cc
             where cardinality(v_tick) > 0 and cc.ticker = any (v_tick) and cc.confidence >= v_tmin
               and cc.sort_at > v_asof - make_interval(days => v_window::int)
             order by cc.sort_at desc limit v_fcmax::int) f
      join core.blurbs b on b.id = f.blurb_id
     where b.status = 'published' and b.published_at <= v_asof
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike')
  ), cand0 as materialized (
    select * from cand0a union select * from cand0x
  ), sig as materialized (
    select distinct b.category
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
       and e.created_at > v_asof - make_interval(days => v_days::int)
  ), shown as materialized (                             -- point 3: candidate cards only, bounded window
    select e.blurb_id,
           bool_or(e.kind = 'open_detail'
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(v_llmax, greatest(v_llmin, coalesce(c.word_count, 0) * v_llpw)))) as was_read
      from core.user_events e join cand0 c on c.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
       and e.created_at > v_asof - make_interval(days => greatest(v_window, v_days)::int)
       and e.kind in ('view', 'dwell', 'open_detail', 'open_source')
     group by e.blurb_id
  ), seeds as materialized (                                          -- my positive cards, faded
    select e.blurb_id,
           power(0.5::numeric, (extract(epoch from (v_asof - max(e.created_at))) / 86400.0)::numeric
                               / greatest(v_chalf, 0.01)) as w
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
       and e.created_at > v_asof - make_interval(days => v_days::int)
     group by e.blurb_id
    having bool_or(e.kind in ('like', 'open_detail', 'open_source')
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(v_llmax, greatest(v_llmin, coalesce(b.word_count, 0) * v_llpw))
                       and e.dwell_ms <= v_walk))
       and not bool_or(e.kind = 'dislike')
  ), co as materialized (                                             -- "readers who engaged with X also engaged with Y"
    select n.neighbor_id, sum(n.sim * s.w) as x
      from seeds s join core.collab_cards n on n.gen = v_gen and n.blurb_id = s.blurb_id
     group by n.neighbor_id
  ), mytopics as materialized (                                       -- follows (1) and liked topics (conf x aff / cap)
    select k, max(w) as w from (
      select unnest(v_fol) as k, 1::numeric as w
      union all
      select t.key, least(t.value::numeric / greatest(v_capc, 0.01), 1)
        from jsonb_each_text(v_taste -> 'c') t where t.value::numeric > 0
    ) t group by k
  ), crowd as materialized (                                          -- crowd guess per topic (lift -1 .. 1)
    select c.topic_b as category, sum(m.w * c.lift) / sum(m.w) as lift
      from mytopics m join core.collab_topics c on c.gen = v_gen and c.topic_a = m.k and c.topic_b <> m.k
     group by c.topic_b
  ), crowd_all as materialized (
    select c.topic_b as category, c.lift from core.collab_topics c where c.gen = v_gen and c.topic_a = '*'
  ), srckey as materialized (                            -- point 1: = core.source_key_of for the candidates only
    select distinct on (s.blurb_id) s.blurb_id, k.key
      from cand0 c
      join core.blurb_sources s on s.blurb_id = c.id
      join core.source_keys k on s.name = any (k.match_names)
     order by s.blurb_id, s.is_primary desc, s.position, s.id
  ), cand as materialized (                              -- candidate cards
    select c.id, c.category, c.rank_score, c.sort_at, c.typ, c.kser, c.rat, c.shift,
           case when c.kind = 'data' then 'fred' else sk.key end as skey
      from cand0 c
      left join srckey sk on sk.blurb_id = c.id
  ), ctk as materialized (                               -- M9b: company tags of the candidates (PK blurb_id, ticker)
    select cc.blurb_id, cc.ticker from cand c join core.card_companies cc on cc.blurb_id = c.id
     where cc.confidence >= v_tmin
  ), ktaste as materialized (                            -- M9b "k:" feature: my net reactions per ticker, faded
    select cc.ticker,
           sum(case when e.kind = 'like' then 1 else -1 end
               * power(0.5::numeric, (extract(epoch from (v_asof - e.created_at)) / 86400.0)::numeric
                                     / greatest(v_chalf, 0.01))) as w
      from core.user_events e
      join core.card_companies cc on cc.blurb_id = e.blurb_id and cc.confidence >= v_tmin
     where e.user_id = v_uid and e.created_at < v_asof
       and e.created_at > v_asof - make_interval(days => v_days::int)
       and e.kind in ('like', 'dislike')
     group by cc.ticker
  ), m9 as materialized (                                -- M9b: ticker affinity (capped) + followed company
    select t.blurb_id as id,
           greatest(least(coalesce(sum(k.w), 0) * v_tk, v_tkcap), -v_tkcap)
           + case when bool_or(t.ticker = any (v_tick)) then v_fco else 0 end as h
      from ctk t left join ktaste k on k.ticker = t.ticker
     group by t.blurb_id
  ), base as (
    select b.id, b.category,
           b.rank_score + coalesce(t.boost, 0) + b.shift                 -- M9b: data cards from their release time
             - greatest(extract(epoch from (v_asof - b.rat)) / 3600.0, 0)::numeric
               * (v_h / coalesce(case when b.kser then v_kshl end, hl.h, v_h) - 1)
             + v_scale * (
                 core.taste_hours(v_taste, b.category, b.typ, b.skey)
               + case when v_nev >= v_exmin and not (b.category = any (v_fol))
                           and not exists (select 1 from sig where sig.category = b.category)
                      then v_explore else 0 end
               + v_th * coalesce(cr.lift, ca.lift, 0) * (1 - coalesce((v_taste -> 'k' ->> b.category)::numeric, 0)))
             + coalesce(v_ch * co.x / (co.x + greatest(v_chalfs, 0.0001)), 0)
             + case when b.category = any (v_fol) then v_ftop else 0 end      -- M9b: visible follow boost
             + coalesce(m9.h, 0)
             + case when b.kser or b.skey = any (v_asrc) then v_auth else 0 end  -- M9b: macro authority
             - case when sh.was_read then v_seen
                    when sh.blurb_id is not null then v_seenv else 0 end as s0
      from cand b
      left join hl        on hl.category = b.category
      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = b.id
      left join co        on co.neighbor_id = b.id
      left join crowd cr  on cr.category = b.category
      left join crowd_all ca on ca.category = b.category
      left join shown sh  on sh.blurb_id = b.id
      left join m9        on m9.id = b.id
     where (cardinality(v_hsrc) = 0 or not (b.skey = any (v_hsrc)))
  ), scored as (
    select x.id, x.category,
           round(x.s0 - v_step * (row_number() over (partition by x.category order by x.s0 desc, x.id desc) - 1), 6) as ps
      from base x
  ), sx as materialized (                                -- point 4: seen cards, hashed anti-join
    select distinct u.id from unnest(v_sx) as u(id)
  ), page as (
    select s.id, s.category, s.ps from scored s
     where (s.ps, s.id) < (v_key, v_id)
       and not exists (select 1 from sx where sx.id = s.id)
     order by s.ps desc, s.id desc
     limit v_fetch + 1
  )
  select array_agg(p.id order by p.ps desc, p.id desc),
         array_agg(p.ps::text order by p.ps desc, p.id desc)
    into v_ids, v_keys
    from page p;

  v_ids := coalesce(v_ids, '{}');
  if cardinality(v_ids) > v_fetch then
    v_more := true; v_ids := v_ids[1:v_fetch]; v_keys := v_keys[1:v_fetch];
  end if;
  if cardinality(v_ids) > 0 then
    v_lastkey := v_keys[cardinality(v_ids)]; v_lastid := v_ids[cardinality(v_ids)];
  else
    v_lastkey := v_key::text; v_lastid := v_id;
  end if;
  v_ids := v_carry || v_ids;

  v_out := '{}';
  if cardinality(v_ids) > 0 then
    v_div  := core.diversify(v_ids, v_state, v_limit);
    v_out  := array(select x::uuid from jsonb_array_elements_text(v_div -> 'ids') with ordinality as t(x, o) order by o);
    v_left := array(select x::uuid from jsonb_array_elements_text(v_div -> 'left') with ordinality as t(x, o) order by o);
    if v_more or cardinality(v_left) > 0 then
      v_next := v_lastkey || '|' || v_lastid || '|' || v_gen || '|'
                || to_char(v_asof at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                || '|' || core.state_to_text(v_div -> 'state') || '|' || array_to_string(v_left, ',');
    end if;
  end if;

  return jsonb_build_object('items', core.cards_json(v_out, v_uid), 'next_cursor', v_next);
end;
$$;

revoke all on function core.feed_for_you_v5_base(text, int) from public, anon, authenticated;

-- ---- core.v3_scores (from 20261121000000_foryou_scale.sql + M9b terms) ----
create or replace function core.v3_scores(p_user uuid, p_asof timestamptz, p_gen bigint)
returns table (o_id uuid, o_category text, o_s0 numeric, o_v3 numeric, o_ps numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fol     text[];
  v_hid     text[];
  v_hsrc    text[];
  v_taste   jsonb;
  v_window numeric; v_seen numeric; v_seenv numeric;
  v_explore numeric; v_exmin numeric; v_step numeric; v_days numeric; v_scale numeric;
  v_chalf   numeric; v_ch numeric; v_chalfs numeric; v_th numeric; v_capc numeric;
  v_llmax   numeric; v_llmin numeric; v_llpw numeric; v_walk numeric;
  v_h       numeric; v_cold numeric; v_coldn numeric;
  v_nev     int;
  v_fj      text[];
  v_fw      double precision[];
  v_hpr     double precision; v_cap double precision; v_neg double precision; v_xstep numeric; v_xcold numeric;
  v_maxsc   numeric;
  v_ftop    numeric; v_fco numeric; v_tk numeric; v_tkcap numeric; v_auth numeric;   -- M9b
  v_kshl    numeric; v_ksdays numeric; v_fcmax numeric; v_tmin numeric; v_rshmax numeric;
  v_tick    text[]; v_asrc text[];
begin
  select followed_categories, hidden_categories, hidden_sources into v_fol, v_hid, v_hsrc
    from core.user_prefs where user_id = p_user;
  v_fol  := coalesce(v_fol, '{}');
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');

  select coalesce(max(value) filter (where key = 'for_you_window_days'), 30),
         coalesce(max(value) filter (where key = 'seen_penalty_hours'), 100),
         coalesce(max(value) filter (where key = 'seen_view_penalty_hours'), 24),
         coalesce(max(value) filter (where key = 'foryou_explore_hours'), 1),
         coalesce(max(value) filter (where key = 'foryou_explore_min_events'), 5),
         coalesce(max(value) filter (where key = 'foryou_category_step_hours'), 0.75),
         coalesce(max(value) filter (where key = 'affinity_days'), 30),
         coalesce(max(value) filter (where key = 'foryou_personal_scale'), 3),
         coalesce(max(value) filter (where key = 'signal_half_life_days'), 14),
         coalesce(max(value) filter (where key = 'collab_card_hours'), 4),
         coalesce(max(value) filter (where key = 'collab_card_half'), 0.5),
         coalesce(max(value) filter (where key = 'collab_topic_hours'), 2),
         coalesce(max(value) filter (where key = 'affinity_cap_hours'), 4),
         coalesce(max(value) filter (where key = 'dwell_long_ms'), 8000),
         coalesce(max(value) filter (where key = 'dwell_long_min_ms'), 6000),
         coalesce(max(value) filter (where key = 'dwell_ms_per_word'), 150),
         coalesce(max(value) filter (where key = 'dwell_walkaway_ms'), 120000),
         coalesce(max(value) filter (where key = 'half_life_hours'), 8),
         coalesce(max(value) filter (where key = 'foryou_cold_step_hours'), 4),
         coalesce(max(value) filter (where key = 'foryou_cold_events'), 5),
         coalesce(max(value) filter (where key = 'v3_hours_per_reward'), 36)::double precision,
         greatest(coalesce(max(value) filter (where key = 'v3_cap_hours'), 30), 0)::double precision,
         coalesce(max(value) filter (where key = 'v3_neg_mult'), 1)::double precision,
         coalesce(max(value) filter (where key = 'v3_step_extra'), 2.5),
         coalesce(max(value) filter (where key = 'v3_step_extra_cold'), 0),
         greatest(coalesce(max(value) filter (where key = 'foryou_max_scored'), 1500), 1)
           + case when coalesce(max(value) filter (where key = 'seen_exclude_mode'), 0) <> 0
                  then greatest(coalesce(max(value) filter (where key = 'seen_exclude_max'), 800), 0) else 0 end
    into v_window, v_seen, v_seenv, v_explore, v_exmin, v_step, v_days, v_scale,
         v_chalf, v_ch, v_chalfs, v_th, v_capc, v_llmax, v_llmin, v_llpw, v_walk,
         v_h, v_cold, v_coldn, v_hpr, v_cap, v_neg, v_xstep, v_xcold, v_maxsc
    from core.rank_params;

  select count(*) into v_nev from core.user_events e
   where e.user_id = p_user and e.created_at < p_asof
     and e.created_at > p_asof - make_interval(days => v_days::int);
  if cardinality(v_fol) = 0 then                         -- cold start: v5's extra topic spread
    v_step := v_step + greatest(v_cold, 0) * greatest(1 - v_nev::numeric / greatest(v_coldn, 1), 0);
  end if;
  v_taste := core.user_taste(p_user, p_asof);

  -- M9b (20261126000000): visible follow boosts, ticker affinity, authority boost, key-series freshness
  select coalesce(max(value) filter (where key = 'fy_follow_topic_hours'), 6),
         coalesce(max(value) filter (where key = 'fy_follow_company_hours'), 12),
         coalesce(max(value) filter (where key = 'fy_ticker_like_hours'), 4),
         greatest(coalesce(max(value) filter (where key = 'fy_ticker_cap_hours'), 8), 0),
         coalesce(max(value) filter (where key = 'fy_authority_hours'), 6),
         greatest(coalesce(max(value) filter (where key = 'fy_key_series_half_life_hours'), 72), 0.5),
         greatest(coalesce(max(value) filter (where key = 'fy_key_series_max_days'), 120), 1),
         greatest(coalesce(max(value) filter (where key = 'fy_follow_company_max'), 50), 0),
         greatest(coalesce(max(value) filter (where key = 'fy_release_shift_max_hours'), 1440), 0),
         coalesce(array_agg(substr(key, length('fy_authority_source:') + 1)) filter (where key like 'fy\_authority\_source:%' and value > 0), '{}')
    into v_ftop, v_fco, v_tk, v_tkcap, v_auth, v_kshl, v_ksdays, v_fcmax, v_rshmax, v_asrc
    from core.rank_params;
  v_tick := core.fy_followed_tickers();
  v_tmin := coalesce((select value from core.company_params where key = 'tag_min_confidence'), 0.60);

  -- the reader's per-feature weights, already times the group weight (empty = cold start: v5 exactly)
  select array_agg(w.o_feature),
         array_agg(w.o_b * coalesce((select r.value from core.rank_params r
                                      where r.key = case split_part(w.o_feature, ':', 1)
                                                      when 'c' then 'v3_w_topic' when 't' then 'v3_w_type'
                                                      when 's' then 'v3_w_source' else 'v3_w_tag' end),
                                     case split_part(w.o_feature, ':', 1) when 't' then 0.5 when 's' then 0.5 else 1 end)::double precision)
    into v_fj, v_fw
    from core.v3_reader_weights(p_user, p_asof) w;
  if v_fj is not null or v_xcold > 0 then v_step := v_step + greatest(v_xstep, 0); end if;

  return query
  with hl as materialized (                              -- freshness half-life per topic
    select substr(r.key, length('foryou_half_life_') + 1) as category, greatest(r.value, 0.5) as h
      from core.rank_params r where r.key like 'foryou\_half\_life\_%'
  ), ks as materialized (                                -- M9b: key series (newest card stays eligible)
    select substr(r.key, length('fy_key_series:') + 1) as series
      from core.rank_params r where r.key like 'fy\_key\_series:%' and r.value > 0
  ), cand0a as materialized (                            -- point 2: the window, cut by the reader-independent score
    select b.id, b.category, b.rank_score, b.sort_at, b.kind, b.word_count, coalesce(b.event_type, b.kind) as typ,
           b.headline, b.macro,
           (b.kind = 'data' and split_part(b.dedupe_key, ':', 1) in (select series from ks)) as kser,
           case when b.kind = 'data' then least(greatest(b.published_at, b.sort_at), p_asof) else b.sort_at end as rat,
           case when b.kind = 'data'
                then least(greatest(extract(epoch from (least(b.published_at, p_asof) - b.sort_at)) / 3600.0, 0), v_rshmax)::numeric
                else 0 end as shift
      from core.blurbs b
      left join hl on hl.category = b.category
      left join core.trend_boosts t on t.gen = p_gen and t.blurb_id = b.id
     where b.status = 'published'
       and b.published_at <= p_asof
       and b.sort_at > p_asof - make_interval(days => v_window::int)
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = p_user and d.blurb_id = b.id and d.kind = 'dislike')
     order by b.rank_score + coalesce(t.boost, 0)
                + case when b.kind = 'data'
                       then least(greatest(extract(epoch from (least(b.published_at, p_asof) - b.sort_at)) / 3600.0, 0), v_rshmax)::numeric
                       else 0 end
                - greatest(extract(epoch from (p_asof - case when b.kind = 'data' then least(greatest(b.published_at, b.sort_at), p_asof)
                                                          else b.sort_at end)) / 3600.0, 0)::numeric
                  * (v_h / coalesce(case when b.kind = 'data' and split_part(b.dedupe_key, ':', 1) in (select series from ks)
                                         then v_kshl end, hl.h, v_h) - 1) desc,
              b.id desc
     limit v_maxsc::int
  ), cand0x as materialized (                            -- M9b: past the cut (bounded): live key-series cards, followed companies
    select b.id, b.category, b.rank_score, b.sort_at, b.kind, b.word_count, coalesce(b.event_type, b.kind) as typ,
           b.headline, b.macro,
           (b.kind = 'data' and split_part(b.dedupe_key, ':', 1) in (select series from ks)) as kser,
           case when b.kind = 'data' then least(greatest(b.published_at, b.sort_at), p_asof) else b.sort_at end as rat,
           case when b.kind = 'data'
                then least(greatest(extract(epoch from (least(b.published_at, p_asof) - b.sort_at)) / 3600.0, 0), v_rshmax)::numeric
                else 0 end as shift
      from core.blurbs b
     where b.kind = 'data' and b.status = 'published'                 -- one live card per series: a few dozen rows
       and b.published_at <= p_asof
       and (b.published_at > p_asof - make_interval(days => v_window::int)
            or (b.published_at > p_asof - make_interval(days => v_ksdays::int)
                and split_part(b.dedupe_key, ':', 1) in (select series from ks)))
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = p_user and d.blurb_id = b.id and d.kind = 'dislike')
    union
    select b.id, b.category, b.rank_score, b.sort_at, b.kind, b.word_count, coalesce(b.event_type, b.kind) as typ,
           b.headline, b.macro,
           (b.kind = 'data' and split_part(b.dedupe_key, ':', 1) in (select series from ks)) as kser,
           case when b.kind = 'data' then least(greatest(b.published_at, b.sort_at), p_asof) else b.sort_at end as rat,
           case when b.kind = 'data'
                then least(greatest(extract(epoch from (least(b.published_at, p_asof) - b.sort_at)) / 3600.0, 0), v_rshmax)::numeric
                else 0 end as shift
      from (select cc.blurb_id from core.card_companies cc
             where cardinality(v_tick) > 0 and cc.ticker = any (v_tick) and cc.confidence >= v_tmin
               and cc.sort_at > p_asof - make_interval(days => v_window::int)
             order by cc.sort_at desc limit v_fcmax::int) f
      join core.blurbs b on b.id = f.blurb_id
     where b.status = 'published' and b.published_at <= p_asof
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = p_user and d.blurb_id = b.id and d.kind = 'dislike')
  ), cand0 as materialized (
    select * from cand0a union select * from cand0x
  ), sig as materialized (
    select distinct b.category
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = p_user and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => v_days::int)
  ), shown as materialized (                             -- point 3
    select e.blurb_id,
           bool_or(e.kind = 'open_detail'
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(v_llmax, greatest(v_llmin, coalesce(c.word_count, 0) * v_llpw)))) as was_read
      from core.user_events e join cand0 c on c.id = e.blurb_id
     where e.user_id = p_user and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => greatest(v_window, v_days)::int)
       and e.kind in ('view', 'dwell', 'open_detail', 'open_source')
     group by e.blurb_id
  ), seeds as materialized (                             -- my positive cards, faded
    select e.blurb_id,
           power(0.5::numeric, (extract(epoch from (p_asof - max(e.created_at))) / 86400.0)::numeric
                               / greatest(v_chalf, 0.01)) as w
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = p_user and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => v_days::int)
     group by e.blurb_id
    having bool_or(e.kind in ('like', 'open_detail', 'open_source')
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(v_llmax, greatest(v_llmin, coalesce(b.word_count, 0) * v_llpw))
                       and e.dwell_ms <= v_walk))
       and not bool_or(e.kind = 'dislike')
  ), co as materialized (
    select n.neighbor_id, sum(n.sim * s.w) as x
      from seeds s join core.collab_cards n on n.gen = p_gen and n.blurb_id = s.blurb_id
     group by n.neighbor_id
  ), mytopics as materialized (
    select k, max(w) as w from (
      select unnest(v_fol) as k, 1::numeric as w
      union all
      select t.key, least(t.value::numeric / greatest(v_capc, 0.01), 1)
        from jsonb_each_text(v_taste -> 'c') t where t.value::numeric > 0
    ) t group by k
  ), crowd as materialized (
    select c.topic_b as category, sum(m.w * c.lift) / sum(m.w) as lift
      from mytopics m join core.collab_topics c on c.gen = p_gen and c.topic_a = m.k and c.topic_b <> m.k
     group by c.topic_b
  ), crowd_all as materialized (
    select c.topic_b as category, c.lift from core.collab_topics c where c.gen = p_gen and c.topic_a = '*'
  ), srckey as materialized (                            -- point 1: candidates only
    select distinct on (s.blurb_id) s.blurb_id, k.key
      from cand0 c
      join core.blurb_sources s on s.blurb_id = c.id
      join core.source_keys k on s.name = any (k.match_names)
     order by s.blurb_id, s.is_primary desc, s.position, s.id
  ), cand as materialized (
    select c.id, c.category, c.rank_score, c.sort_at, c.typ, c.kser, c.rat, c.shift,
           case when c.kind = 'data' then 'fred' else sk.key end as skey,
           c.headline, c.macro
      from cand0 c
      left join srckey sk on sk.blurb_id = c.id
  ), ctk as materialized (                               -- M9b: company tags of the candidates (PK blurb_id, ticker)
    select cc.blurb_id, cc.ticker from cand c join core.card_companies cc on cc.blurb_id = c.id
     where cc.confidence >= v_tmin
  ), ktaste as materialized (                            -- M9b "k:" feature: my net reactions per ticker, faded
    select cc.ticker,
           sum(case when e.kind = 'like' then 1 else -1 end
               * power(0.5::numeric, (extract(epoch from (p_asof - e.created_at)) / 86400.0)::numeric
                                     / greatest(v_chalf, 0.01))) as w
      from core.user_events e
      join core.card_companies cc on cc.blurb_id = e.blurb_id and cc.confidence >= v_tmin
     where e.user_id = p_user and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => v_days::int)
       and e.kind in ('like', 'dislike')
     group by cc.ticker
  ), m9 as materialized (                                -- M9b: ticker affinity (capped) + followed company
    select t.blurb_id as id,
           greatest(least(coalesce(sum(k.w), 0) * v_tk, v_tkcap), -v_tkcap)
           + case when bool_or(t.ticker = any (v_tick)) then v_fco else 0 end as h
      from ctk t left join ktaste k on k.ticker = t.ticker
     group by t.blurb_id
  ), base as (
    select b.id, b.category,
           b.rank_score + coalesce(t.boost, 0) + b.shift                 -- M9b: data cards from their release time
             - greatest(extract(epoch from (p_asof - b.rat)) / 3600.0, 0)::numeric
               * (v_h / coalesce(case when b.kser then v_kshl end, hl.h, v_h) - 1)
             + v_scale * (
                 core.taste_hours(v_taste, b.category, b.typ, b.skey)
               + case when v_nev >= v_exmin and not (b.category = any (v_fol))
                           and not exists (select 1 from sig where sig.category = b.category)
                      then v_explore else 0 end
               + v_th * coalesce(cr.lift, ca.lift, 0) * (1 - coalesce((v_taste -> 'k' ->> b.category)::numeric, 0)))
             + coalesce(v_ch * co.x / (co.x + greatest(v_chalfs, 0.0001)), 0)
             + case when b.category = any (v_fol) then v_ftop else 0 end      -- M9b: visible follow boost
             + coalesce(m9.h, 0)
             + case when b.kser or b.skey = any (v_asrc) then v_auth else 0 end  -- M9b: macro authority
             - case when sh.was_read then v_seen
                    when sh.blurb_id is not null then v_seenv else 0 end as s0
      from cand b
      left join hl        on hl.category = b.category
      left join core.trend_boosts t on t.gen = p_gen and t.blurb_id = b.id
      left join co        on co.neighbor_id = b.id
      left join crowd cr  on cr.category = b.category
      left join crowd_all ca on ca.category = b.category
      left join shown sh  on sh.blurb_id = b.id
      left join m9        on m9.id = b.id
     where (cardinality(v_hsrc) = 0 or not (b.skey = any (v_hsrc)))
  ), w as materialized (
    select u.j, u.w from unnest(coalesce(v_fj, '{}'), coalesce(v_fw, '{}')) as u(j, w)
  ), v3 as (                                             -- only when the reader has evidence
    select c.id,
           round(greatest(least(case when v_hpr * sum(w.w) < 0 then v_hpr * sum(w.w) * v_neg
                                     else v_hpr * sum(w.w) end, v_cap), -v_cap)::numeric, 6) as h
      from cand c
      left join core.card_features cf on cf.blurb_id = c.id
      cross join lateral unnest(coalesce(cf.features,           -- precomputed; computed only if missing
                                         core.v2_features(c.category, c.typ, c.skey, c.headline, c.macro))) as u(j)
      join w on w.j = u.j
     where v_fj is not null
     group by c.id
  ), tot as (
    select x.id, x.category, x.s0, coalesce(v3.h, 0) as h, x.s0 + coalesce(v3.h, 0) as s
      from base x left join v3 on v3.id = x.id
  )
  select t.id, t.category, t.s0, t.h,
         round(t.s - v_step * (row_number() over (partition by t.category order by t.s desc, t.id desc) - 1), 6)
    from tot t;
end;
$$;

revoke all on function core.v3_scores(uuid, timestamptz, bigint) from public, anon, authenticated;

-- ---- api.feed_for_you(text, int) (from 20261113000000_seen_exclusion.sql + core.fy_post) ----
create or replace function api.feed_for_you(p_cursor text default null, p_limit int default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r      jsonb;
  v_uid    uuid := auth.uid();
  v_raw    numeric;
  v_mode   int;
  v_cmode  int;
  v_tmp    int;
  v_pno    int := 0;
  v_gen    bigint;
  v_asof   timestamptz;
  v_ids    uuid[];
  v_max    numeric;
  v_n      int;
  v_page   uuid;
  v_v6     boolean := false;
  v_v7     boolean := false;
  v_hold   boolean := false;
  v_hmode  int := 2;
  v_model  bigint;
  v_crun   bigint;
  v_seed   bigint;
  v_cseed  bigint;
  v_terms  jsonb;
  v_lim    int := least(greatest(coalesce(p_limit, 20), 10), 30);
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;
  if p_cursor like 'S|%' then                                             -- seen-cards tail (all caught up)
    return core.seen_tail(v_uid, null, p_cursor, v_lim, true);
  end if;

  select coalesce(max(value), 0) into v_raw from core.rank_params where key = 'foryou_ml_mode';
  v_mode  := case when v_raw = 0 then 0 else 1 end;
  v_cmode := v_mode;
  if p_cursor is not null then                                           -- fields 7-10 (absent = old cursor)
    begin
      v_pno   := coalesce(nullif(split_part(p_cursor, '|', 8), '')::int, 0);
      v_tmp   := nullif(split_part(p_cursor, '|', 9), '')::int;
      v_cmode := case when v_tmp is null then v_mode when v_tmp = 0 then 0 else 1 end;
    exception when others then v_pno := 0; v_cmode := v_mode; v_tmp := null;
    end;
    if v_pno < 0 then v_pno := 0; end if;
    begin
      v_crun  := nullif(split_part(p_cursor, '|', 7), '')::bigint;
      v_cseed := nullif(split_part(p_cursor, '|', 10), '')::bigint;
    exception when others then v_crun := null; v_cseed := null;
    end;
  end if;

  -- a v6 or v7 cursor keeps its algorithm (and v6 its model and seed) to the end of its scroll
  if p_cursor is not null and v_tmp = 2 and v_crun is not null and v_cseed is not null
     and exists (select 1 from core.ml_models m where m.model_id = v_crun) then
    v_v6 := true; v_model := v_crun; v_seed := v_cseed;
  elsif p_cursor is not null and v_tmp = 3 then
    v_v7 := true;
  elsif p_cursor is null and v_raw = 2 then
    v_model := core.v2_active_model();
    if v_model is not null and core.v2_holdout(v_uid) then
      v_hold := true;
    elsif v_model is not null then
      v_v6 := true; v_seed := floor(random() * 2147483647)::bigint;
    end if;
  elsif p_cursor is null and v_raw = 3 then
    if 100 * (core.v2_uniforms(v_uid::text || '|v3holdout'))[1]
       < coalesce((select r.value from core.rank_params r where r.key = 'v3_holdout_pct'), 10)::double precision then
      v_hold := true; v_hmode := 3;
    else
      v_v7 := true;
    end if;
  elsif v_raw = 2 and core.v2_active_model() is not null and core.v2_holdout(v_uid) then
    v_hold := true;                                                      -- later pages of a holdout scroll
  elsif v_raw = 3 and 100 * (core.v2_uniforms(v_uid::text || '|v3holdout'))[1]
                      < coalesce((select r.value from core.rank_params r where r.key = 'v3_holdout_pct'), 10)::double precision then
    v_hold := true; v_hmode := 3;
  end if;

  if (v_v6 or v_v7) and (select count(*) from core.blurbs b
                          where b.status = 'published'
                            and b.sort_at > clock_timestamp() - make_interval(days => coalesce(
                                  (select r.value from core.rank_params r where r.key = 'for_you_window_days'), 30)::int))
                        > coalesce((select r.value from core.rank_params r
                                     where r.key = case when v_v7 then 'v3_max_candidates' else 'v2_max_candidates' end), 3000) then
    v_v6 := false; v_v7 := false;                                        -- cost guard: too many cards
  end if;
  if v_v6 then
    begin
      v_r := core.feed_for_you_v6(p_cursor, p_limit, v_model, v_seed);
    exception
      when query_canceled then v_v6 := false; v_r := null;              -- statement timeout
      when others then v_v6 := false; v_r := null;
    end;
  elsif v_v7 then
    begin
      v_r := core.feed_for_you_v7(p_cursor, p_limit);
      v_terms := v_r -> 'terms';
      v_r := v_r - 'terms';
    exception
      when query_canceled then v_v7 := false; v_r := null;              -- statement timeout
      when others then v_v7 := false; v_r := null;
    end;
  end if;

  if v_v6 then
    if v_r ->> 'next_cursor' is not null then
      v_r := jsonb_set(v_r, '{next_cursor}', to_jsonb((v_r ->> 'next_cursor') || '|' || v_model || '|' || (v_pno + 1) || '|2|' || v_seed));
    end if;
  elsif v_v7 then
    if v_r ->> 'next_cursor' is not null then
      v_r := jsonb_set(v_r, '{next_cursor}', to_jsonb((v_r ->> 'next_cursor') || '||' || (v_pno + 1) || '|3'));
    end if;
  else
    if v_tmp in (2, 3) then v_cmode := v_mode; end if;                   -- a v6/v7 cursor that fell back: current mode
    v_r := core.feed_for_you_v5(p_cursor, p_limit);
    if v_r ->> 'next_cursor' is not null then                            -- field 7 (ml_run) stays empty
      v_r := jsonb_set(v_r, '{next_cursor}', to_jsonb((v_r ->> 'next_cursor') || '||' || (v_pno + 1) || '|' || v_cmode));
    end if;
  end if;

  begin                                                                  -- M9b: reason line + company cap (never breaks the feed)
    v_r := core.fy_post(v_r, v_uid);
    if jsonb_typeof(v_terms) = 'array' and jsonb_typeof(v_r -> '_perm') = 'array'
       and jsonb_array_length(v_terms) = jsonb_array_length(v_r -> '_perm') then
      v_terms := (select jsonb_agg(v_terms -> (x.p::int) order by x.o)
                    from jsonb_array_elements_text(v_r -> '_perm') with ordinality as x(p, o));
    end if;
  exception when others then null;
  end;
  v_r := v_r - '_perm';
  if v_mode = 0 or jsonb_array_length(v_r -> 'items') = 0 then
    return core.seen_fill(v_r, v_uid, null, v_lim, true);
  end if;
  begin
    select coalesce(max(value), 60) into v_max from core.rank_params where key = 'ml_pages_max_per_hour';
    select count(*) into v_n from core.ml_pages where user_id = v_uid and shown_at > now() - interval '1 hour';
    if v_n < v_max then
      begin
        v_asof := nullif(split_part(coalesce(v_r ->> 'next_cursor', p_cursor), '|', 4), '')::timestamptz;
        v_gen  := nullif(split_part(coalesce(v_r ->> 'next_cursor', p_cursor), '|', 3), '')::bigint;
      exception when others then v_asof := null; v_gen := null;
      end;
      v_asof := least(coalesce(v_asof, now()), clock_timestamp());
      if v_gen is null or not exists (select 1 from core.trend_generations where gen = v_gen) then
        select coalesce(max(gen), 0) into v_gen from core.trend_generations;
      end if;
      v_ids := array(select (x.c ->> 'id')::uuid from jsonb_array_elements(v_r -> 'items') with ordinality as x(c, o) order by x.o);
      insert into core.ml_pages (user_id, surface, ranker, ml_mode, ml_run, holdout, page_no, gen, as_of, prefs_at,
                                 card_ids, live_scores, ml_terms)
      values (v_uid, 'for_you', case when v_v6 then 'fy-ts-v6' when v_v7 then 'fy-v3' else 'fy-formula-v4' end,
              case when v_v6 then 2 when v_v7 then 3 when v_hold then v_hmode else v_mode end,
              case when v_v6 then v_model end, v_hold, v_pno, v_gen, v_asof,
              (select p.updated_at from core.user_prefs p where p.user_id = v_uid),
              v_ids,
              array(select coalesce(b.rank_score + coalesce(t.boost, 0), 0)
                      from unnest(v_ids) with ordinality as u(id, o)
                      left join core.blurbs b on b.id = u.id
                      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = u.id
                     order by u.o),
              case when v_v7 and jsonb_typeof(v_terms) = 'array' and jsonb_array_length(v_terms) = cardinality(v_ids)
                   then array(select x::numeric from jsonb_array_elements_text(v_terms) with ordinality as t(x, o) order by o) end)
      returning page_id into v_page;
    end if;
  exception when others then
    v_page := null;                                                      -- never break the feed
  end;
  if v_page is not null then v_r := v_r || jsonb_build_object('page_id', v_page); end if;
  return core.seen_fill(v_r, v_uid, null, v_lim, true);
end;
$$;

revoke all on function api.feed_for_you(text, int) from public, anon;
grant execute on function api.feed_for_you(text, int) to authenticated;

-- =============================================================================
-- F. api.feed_for_you(text, int, uuid[], text[]): followed stories AND followed tickers (both on the device)
-- =============================================================================
create or replace function api.feed_for_you(p_cursor text, p_limit int, p_followed uuid[], p_tickers text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;
  perform set_config('element.fy_tickers',
    coalesce(array_to_string(p_tickers[1:greatest(coalesce((select r.value from core.rank_params r
                                                            where r.key = 'fy_follow_tickers_max'), 100), 0)::int], ','), ''), true);
  v_r := api.feed_for_you(p_cursor, p_limit, coalesce(p_followed, '{}'::uuid[]));
  perform set_config('element.fy_tickers', '', true);
  return v_r;
end;
$$;

-- =============================================================================
-- G. GRANTS (same as the allowlist in 20261121000400_api_grants.sql; tests/api_grants_check.sql lists it)
-- =============================================================================
revoke all on function api.feed_for_you(text, int, uuid[], text[]) from public, anon;
grant execute on function api.feed_for_you(text, int, uuid[], text[]) to authenticated;
revoke all on function api.feed_for_you(text, int) from public, anon;
grant execute on function api.feed_for_you(text, int) to authenticated;
revoke all on function core.feed_for_you_v5_base(text, int) from public, anon, authenticated;
revoke all on function core.v3_scores(uuid, timestamptz, bigint) from public, anon, authenticated;

-- the macro_focus wrappers must still be in place (this file replaces only the *_base / v3_scores bodies)
do $$
begin
  if (select prosrc from pg_proc where oid = to_regprocedure('core.feed_for_you_v5(text,integer)')) not like '%macro_focus_wrapper%' then
    raise exception 'foryou_m9b: core.feed_for_you_v5 is not wrapped by macro_focus; re-run 20261116000000_macro_focus.sql';
  end if;
end $$;

notify pgrst, 'reload schema';

-- HOW TO CHECK: paste this file twice (expected "Success. No rows returned" both times), then run
-- supabase/tests/foryou_m9b_check.sql, foryou_m9b_scale_check.sql and every older check.
