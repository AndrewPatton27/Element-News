-- =============================================================================
-- Element: For you scales to ~100x the cards and events (SQL scale audit, 2026-11-09). NOT applied.
--
-- Same results as before on today's data; only the work per page is bounded. Replaces the bodies of
--   core.feed_for_you_v5_base (the live For you, foryou_ml_mode 0; also the fallback of every other mode),
--   core.v3_scores and core.feed_for_you_v7_base (ranking v3, mode 3, OFF).
-- The *_base functions are the ones 20261116000000_macro_focus.sql wraps: the wrappers (core.feed_for_you_v5 /
-- v7, macro_focus_wrapper) are NOT recreated here and keep calling the bases by name, so no re-wrap is needed.
-- Signatures, grants (none to clients), cursors and paging rules are unchanged.
--
-- What was unbounded, and the fix:
--   1. srckey (the source key of each candidate) did a DISTINCT ON over every row of core.blurb_sources, all
--      time. Now only the candidate cards' sources are read (index blurb_sources_blurb_idx).
--   2. Every card in the 30-day window was scored (taste, collab, trend, v3 features). Now the window is first
--      cut to the foryou_max_scored (1500) best by the part of the score that is the same for every reader
--      (rank_score + trend boost - the per-topic freshness term), plus room for the reader's seen cards (they are
--      scored and then left out, as before). The rest of the score (taste, explore, crowd, collab: at most about
--      +30 h, and the seen penalty, which only lowers a card) cannot lift a card from below that cut into the
--      first pages. With fewer cards in the window than the cut (today: about 140; 10x: about 1200) nothing
--      is cut and the order is identical. Setting: core.rank_params foryou_max_scored (> 0).
--   3. shown (the seen penalty) read every event of the reader, all time. Now only events on the candidate
--      cards inside max(for_you_window_days, affinity_days) days (index user_events_user_time_idx). A card can
--      only be a candidate when it is in the window, so older events could only be on cards whose sort_at was
--      moved forward after the view (a revised story), which the seen exclusion also treats as new.
--   4. The seen-card test was "id = any(800-element array)" per candidate. Now a hashed anti-join.
-- micro_fill (macro_focus) still calls the base up to micro_gate_max_calls (4) times per page; each call is now
-- bounded by points 1-4. The v3_max_candidates guard in api.feed_for_you is unchanged (a setting; see
-- supabase.md).
--
-- Idempotent. Run after 20261120000400_following_speed.sql. Check: supabase/tests/foryou_scale_check.sql
-- =============================================================================

do $$
begin
  if to_regprocedure('core.feed_for_you_v5_base(text,integer)') is null
     or to_regprocedure('core.feed_for_you_v7_base(text,integer)') is null then
    raise exception 'foryou_scale: core.feed_for_you_v5_base / v7_base missing; apply 20261116000000_macro_focus.sql first';
  end if;
end $$;

insert into core.rank_params (key, value) values
  ('foryou_max_scored', 1500)    -- For you scores at most this many window cards (+ the reader's seen cards)
on conflict (key) do nothing;

alter table core.rank_params drop constraint if exists rank_params_foryou_scale_range;
alter table core.rank_params add constraint rank_params_foryou_scale_range
  check (key <> 'foryou_max_scored' or value > 0);


-- -----------------------------------------------------------------------------
-- core.feed_for_you_v5_base: 20261113000000_seen_exclusion.sql F2 (renamed by macro_focus), points 1-4 above.
-- -----------------------------------------------------------------------------
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

  with hl as materialized (                              -- freshness half-life per topic
    select substr(r.key, length('foryou_half_life_') + 1) as category, greatest(r.value, 0.5) as h
      from core.rank_params r where r.key like 'foryou\_half\_life\_%'
  ), cand0 as materialized (                             -- point 2: the window, cut by the reader-independent score
    select b.id, b.category, b.rank_score, b.sort_at, b.kind, b.word_count, coalesce(b.event_type, b.kind) as typ
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
                - greatest(extract(epoch from (v_asof - b.sort_at)) / 3600.0, 0)::numeric * (v_h / coalesce(hl.h, v_h) - 1) desc,
              b.id desc
     limit (v_maxsc + cardinality(v_sx))::int
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
    select c.id, c.category, c.rank_score, c.sort_at, c.typ,
           case when c.kind = 'data' then 'fred' else sk.key end as skey
      from cand0 c
      left join srckey sk on sk.blurb_id = c.id
  ), base as (
    select b.id, b.category,
           b.rank_score + coalesce(t.boost, 0)
             - greatest(extract(epoch from (v_asof - b.sort_at)) / 3600.0, 0)::numeric
               * (v_h / coalesce(hl.h, v_h) - 1)
             + v_scale * (
                 core.taste_hours(v_taste, b.category, b.typ, b.skey)
               + case when v_nev >= v_exmin and not (b.category = any (v_fol))
                           and not exists (select 1 from sig where sig.category = b.category)
                      then v_explore else 0 end
               + v_th * coalesce(cr.lift, ca.lift, 0) * (1 - coalesce((v_taste -> 'k' ->> b.category)::numeric, 0)))
             + coalesce(v_ch * co.x / (co.x + greatest(v_chalfs, 0.0001)), 0)
             - case when sh.was_read then v_seen
                    when sh.blurb_id is not null then v_seenv else 0 end as s0
      from cand b
      left join hl        on hl.category = b.category
      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = b.id
      left join co        on co.neighbor_id = b.id
      left join crowd cr  on cr.category = b.category
      left join crowd_all ca on ca.category = b.category
      left join shown sh  on sh.blurb_id = b.id
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


-- -----------------------------------------------------------------------------
-- core.v3_scores: 20261112000000_ranking_v3.sql E, points 1-3 above. The seen cards are not known here (v7
-- leaves them out), so the cut leaves room for seen_exclude_max of them while the exclusion is on.
-- -----------------------------------------------------------------------------
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
  ), cand0 as materialized (                             -- point 2: the window, cut by the reader-independent score
    select b.id, b.category, b.rank_score, b.sort_at, b.kind, b.word_count, coalesce(b.event_type, b.kind) as typ,
           b.headline, b.macro
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
                - greatest(extract(epoch from (p_asof - b.sort_at)) / 3600.0, 0)::numeric * (v_h / coalesce(hl.h, v_h) - 1) desc,
              b.id desc
     limit v_maxsc::int
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
    select c.id, c.category, c.rank_score, c.sort_at, c.typ,
           case when c.kind = 'data' then 'fred' else sk.key end as skey,
           c.headline, c.macro
      from cand0 c
      left join srckey sk on sk.blurb_id = c.id
  ), base as (
    select b.id, b.category,
           b.rank_score + coalesce(t.boost, 0)
             - greatest(extract(epoch from (p_asof - b.sort_at)) / 3600.0, 0)::numeric
               * (v_h / coalesce(hl.h, v_h) - 1)
             + v_scale * (
                 core.taste_hours(v_taste, b.category, b.typ, b.skey)
               + case when v_nev >= v_exmin and not (b.category = any (v_fol))
                           and not exists (select 1 from sig where sig.category = b.category)
                      then v_explore else 0 end
               + v_th * coalesce(cr.lift, ca.lift, 0) * (1 - coalesce((v_taste -> 'k' ->> b.category)::numeric, 0)))
             + coalesce(v_ch * co.x / (co.x + greatest(v_chalfs, 0.0001)), 0)
             - case when sh.was_read then v_seen
                    when sh.blurb_id is not null then v_seenv else 0 end as s0
      from cand b
      left join hl        on hl.category = b.category
      left join core.trend_boosts t on t.gen = p_gen and t.blurb_id = b.id
      left join co        on co.neighbor_id = b.id
      left join crowd cr  on cr.category = b.category
      left join crowd_all ca on ca.category = b.category
      left join shown sh  on sh.blurb_id = b.id
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


-- -----------------------------------------------------------------------------
-- core.feed_for_you_v7_base: 20261113000000_seen_exclusion.sql F4 (renamed by macro_focus), point 4 above.
-- -----------------------------------------------------------------------------
create or replace function core.feed_for_you_v7_base(p_cursor text, p_limit int)
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
  v_hid     text[];
  v_hsrc    text[];
  v_ids     uuid[];
  v_keys    text[];
  v_hall    jsonb;
  v_out     uuid[];
  v_next    text;
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

  select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = v_uid;
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');
  v_sx := coalesce(core.seen_ids(v_uid, clock_timestamp()), '{}');

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

  with s as materialized (
    select x.o_id, x.o_ps, x.o_v3 from core.v3_scores(v_uid, v_asof, v_gen) x
  ), sx as materialized (                                -- point 4: seen cards, hashed anti-join
    select distinct u.id from unnest(v_sx) as u(id)
  ), pg as (
    select s.o_id, s.o_ps from s
     where (s.o_ps, s.o_id) < (v_key, v_id)
       and not exists (select 1 from sx where sx.id = s.o_id)
     order by s.o_ps desc, s.o_id desc
     limit v_fetch + 1
  )
  select (select array_agg(pg.o_id order by pg.o_ps desc, pg.o_id desc) from pg),
         (select array_agg(pg.o_ps::text order by pg.o_ps desc, pg.o_id desc) from pg),
         (select jsonb_object_agg(s.o_id::text, s.o_v3) from s
           where s.o_id in (select pg.o_id from pg) or s.o_id = any (v_carry))
    into v_ids, v_keys, v_hall;

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

  return jsonb_build_object('items', core.cards_json(v_out, v_uid), 'next_cursor', v_next,
                            'terms', to_jsonb(array(select coalesce((v_hall ->> u.id::text)::numeric, 0)
                                                      from unnest(v_out) with ordinality as u(id, o) order by u.o)));
end;
$$;

revoke all on function core.feed_for_you_v7_base(text, int) from public, anon, authenticated;
