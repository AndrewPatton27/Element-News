-- =============================================================================
-- Element: ranking v2 (2026-10-18). Cheapest change that measurably improves For you.
-- Free, deterministic, plain SQL; no new service, no new table, no app change.
--
--   A  tunable values (core.rank_params)
--   B  one personal-affinity helper for every personal feed:
--        core.user_taste(user, as_of) -> jsonb   the user's follows + confidence-weighted learned
--                                                hours per topic / card type / source (from
--                                                core.user_affinity_dims, unchanged weights)
--        core.taste_hours(taste, topic, type, source) -> hours   the one formula:
--            follow (boost_followed_hours) + conf x topic + conf x type + conf x source
--      For you, search and the following feed all call these two; none repeats the math.
--   C  api.feed_for_you v4 = v3 (080000) plus
--        0. "not for me" counts double: negative learned hours x foryou_negative_scale (2),
--           capped as before (in core.user_taste, so search and Following get it too)
--        1. freshness by topic (mechanism, shipped OFF): a card's value halves every
--           foryou_half_life_<topic> hours instead of the global half_life_hours (8).
--           In the stored rank_score units this is  - age_hours x (8 / H_topic - 1),
--           computed at the cursor's frozen "as of" time, so paging stays stable.
--        2. topic spread: foryou_category_step_hours 0.5 -> 0.75 (each better card of the same
--           topic ahead costs 0.75 h instead of 0.5 h)
--        3. cold start: a reader with no follows and few signals gets an extra spread
--           foryou_cold_step_hours (4) x (1 - signals / foryou_cold_events (5)), i.e. Trending
--           order but one card per topic first; gone after 5 signals (when exploration starts)
--      Cursor format, card keys, hidden topics / sources, crowd parts and breadth rules unchanged.
--   D  api.search: same text ranking; the personal part now comes from core.taste_hours
--   E  api.following_feed: signed-in readers get the same personal hours, converted with the
--      feed's own 12 h half-life (an hour of liking = an hour of freshness); guests unchanged
--
-- api.feed (guest Trending / Latest) is NOT changed. Idempotent. Requires every earlier migration
-- (last: 20261018000000_brief_search_follow.sql). Never applied automatically.
-- =============================================================================


-- =============================================================================
-- A. TUNABLE VALUES (change with UPDATE core.rank_params; no code change)
-- A topic without a foryou_half_life_<topic> row uses half_life_hours (8 h) = no change.
-- Freshness per topic ships OFF (every row 8 h): offline, fast business news (6 h) plus slow
-- recalls/science (16 h) made For you fresher (stale share 0.2% -> 0.0%) but cost precision
-- (P@10 0.474 -> 0.469; with sparse news it fell below today's 0.375 -> 0.365), so it did not
-- pass the "every metric improves" bar. Turn on per topic with an UPDATE when there is more
-- news per hour (docs/work/algo-results.md, "algo v2").
-- foryou_negative_scale 2: a topic, card type or source the reader turns away from (quick skips,
-- dislikes) counts twice as much in ranking, within the same caps. api.get_prefs keeps showing
-- the raw learned numbers (unchanged readout). This is the change that moved precision most.
-- =============================================================================

insert into core.rank_params (key, value) values
  ('foryou_half_life_markets',   8),     -- 8 = same as half_life_hours = off (see A)
  ('foryou_half_life_earnings',  8),
  ('foryou_half_life_deals',     8),
  ('foryou_half_life_insider',   8),
  ('foryou_half_life_economy',   8),
  ('foryou_half_life_safety',    8),
  ('foryou_half_life_science',   8),
  ('foryou_cold_step_hours',     4),
  ('foryou_cold_events',         5),
  ('foryou_negative_scale',      2),
  ('following_half_life_hours',  12)
on conflict (key) do nothing;

-- 0.5 h was too gentle to spread a page over topics (offline test, see docs). Only changed if it
-- is still the old default, so a hand-tuned value is kept.
update core.rank_params set value = 0.75 where key = 'foryou_category_step_hours' and value = 0.5;


-- =============================================================================
-- B. SHARED PERSONAL AFFINITY (private)
-- core.user_taste(user, as_of) = {"f": [followed topics], "fh": follow hours,
--   "c": {topic: conf x hours}, "t": {type: conf x hours}, "s": {source: conf x hours},
--   "k": {topic: conf}}           (null user -> empty taste, every lookup gives 0)
-- core.taste_hours(taste, topic, type, source) = personal hours before foryou_personal_scale.
-- =============================================================================

create or replace function core.user_taste(p_user uuid, p_asof timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select coalesce(max(value) filter (where key = 'foryou_negative_scale'),  2) as neg,
           coalesce(max(value) filter (where key = 'affinity_cap_hours'),     4) as c_cat,
           coalesce(max(value) filter (where key = 'aff_cap_type_hours'),     1) as c_typ,
           coalesce(max(value) filter (where key = 'aff_cap_source_hours'),   1) as c_src
      from core.rank_params
  ), d as materialized (                -- learned hours x confidence; a dislike side counts x neg,
    select a.dim, a.key, a.conf,       -- still within the same cap (-4 h topic, -1 h type / source)
           case when a.hours >= 0 then a.conf * a.hours
                else greatest(a.conf * a.hours * greatest(p.neg, 0),
                              -case a.dim when 'category' then p.c_cat when 'type' then p.c_typ else p.c_src end) end as h
      from core.user_affinity_dims(p_user, p_asof) a cross join p
     where p_user is not null
  )
  select jsonb_build_object(
    'fh', (select coalesce(max(value), 2) from core.rank_params where key = 'boost_followed_hours'),
    'f',  coalesce((select to_jsonb(coalesce(up.followed_categories, '{}'))
                      from core.user_prefs up where up.user_id = p_user), '[]'::jsonb),
    'c',  coalesce((select jsonb_object_agg(d.key, round(d.h, 6)) from d where d.dim = 'category'), '{}'::jsonb),
    't',  coalesce((select jsonb_object_agg(d.key, round(d.h, 6)) from d where d.dim = 'type'),     '{}'::jsonb),
    's',  coalesce((select jsonb_object_agg(d.key, round(d.h, 6)) from d where d.dim = 'source'),   '{}'::jsonb),
    'k',  coalesce((select jsonb_object_agg(d.key, d.conf) from d where d.dim = 'category'), '{}'::jsonb));
$$;

create or replace function core.taste_hours(p_taste jsonb, p_category text, p_type text, p_source text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when p_taste is null then 0::numeric else
      case when p_category is not null and coalesce(p_taste -> 'f', '[]'::jsonb) ? p_category
           then coalesce((p_taste ->> 'fh')::numeric, 0) else 0 end
    + coalesce((p_taste -> 'c' ->> p_category)::numeric, 0)
    + coalesce((p_taste -> 't' ->> p_type)::numeric, 0)
    + coalesce((p_taste -> 's' ->> p_source)::numeric, 0) end;
$$;

revoke all on function core.user_taste(uuid, timestamptz)           from public, anon, authenticated;
revoke all on function core.taste_hours(jsonb, text, text, text)    from public, anon, authenticated;


-- =============================================================================
-- C. api.feed_for_you v4 (same signature, cursor and card shape as 080000)
-- score = rank_score + trend boost (gen)
--       - age_hours x (half_life_hours / foryou_half_life_<topic> - 1)          (NEW: freshness)
--       + scale x (taste_hours + explore + collab_topic_hours x crowd prior x (1 - topic conf))
--       + card-neighbour boost (gen)
--       - seen penalties
--       - (category step + cold step) x (number of better same-topic cards)      (NEW: cold step)
--       then core.diversify (unchanged)
-- =============================================================================

create or replace function api.feed_for_you(p_cursor text default null, p_limit int default 20)
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
         coalesce(max(value) filter (where key = 'foryou_cold_events'), 5)
    into v_window, v_seen, v_seenv, v_explore, v_exmin, v_step, v_days, v_scale,
         v_chalf, v_ch, v_chalfs, v_th, v_capc, v_llmax, v_llmin, v_llpw, v_walk,
         v_h, v_cold, v_coldn
    from core.rank_params;

  if cardinality(v_carry) > 0 then                       -- held back by the previous page
    select coalesce(array_agg(u.id order by u.o), '{}') into v_carry
      from unnest(v_carry) with ordinality as u(id, o)
      join core.blurbs b on b.id = u.id
     where b.status = 'published'
       and not (b.category = any (v_hid))
       and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike');
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
  ), sig as materialized (
    select distinct b.category
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
       and e.created_at > v_asof - make_interval(days => v_days::int)
  ), shown as materialized (                             -- long look = core.long_look_ms(words), inlined
    select e.blurb_id,
           bool_or(e.kind = 'open_detail'
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(v_llmax, greatest(v_llmin, coalesce(b.word_count, 0) * v_llpw)))) as was_read
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
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
  ), srckey as materialized (                            -- = core.source_key_of, worked out for all cards at once
    select distinct on (s.blurb_id) s.blurb_id, k.key
      from core.blurb_sources s
      join core.source_keys k on s.name = any (k.match_names)
     order by s.blurb_id, s.is_primary desc, s.position, s.id
  ), cand as materialized (                              -- candidate cards
    select b.id, b.category, b.rank_score, b.sort_at, coalesce(b.event_type, b.kind) as typ,
           case when b.kind = 'data' then 'fred' else sk.key end as skey
      from core.blurbs b
      left join srckey sk on sk.blurb_id = b.id
     where b.status = 'published'
       and b.published_at <= v_asof
       and b.sort_at > v_asof - make_interval(days => v_window::int)
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike')
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
  ), page as (
    select s.id, s.category, s.ps from scored s
     where (s.ps, s.id) < (v_key, v_id)
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

revoke all on function api.feed_for_you(text, int) from public, anon;
grant execute on function api.feed_for_you(text, int) to authenticated;


-- =============================================================================
-- D. api.search: same as 20261018000000, personal part from core.taste_hours
-- score x (1 + search_personal_weight 0.15 x clamp(taste_hours / affinity_cap_hours, 0, 1))
-- =============================================================================

create or replace function api.search(p_q text, p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c_personal_weight constant numeric := 0.15;   -- settings.md: search_personal_weight
  v_uid uuid := auth.uid();
  v_q text := left(btrim(coalesce(p_q, '')), 80);
  v_ts tsquery;
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 30);
  v_key numeric := 1e30;
  v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_asof timestamptz := now();
  v_cap numeric;
  v_taste jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_next text;
begin
  if char_length(v_q) < 2 then return jsonb_build_object('items', '[]'::jsonb, 'next_cursor', null); end if;
  v_ts := websearch_to_tsquery('english', v_q);
  if p_cursor is not null then
    begin
      v_key := split_part(p_cursor, '|', 1)::numeric; v_id := split_part(p_cursor, '|', 2)::uuid;
      v_asof := least(coalesce(nullif(split_part(p_cursor, '|', 3), '')::timestamptz, v_asof), v_asof);
    exception when others then raise exception 'invalid_cursor' using errcode = 'PT422'; end;
  end if;
  if v_uid is not null then
    select coalesce(max(value) filter (where key = 'affinity_cap_hours'), 4) into v_cap from core.rank_params;
    v_taste := core.user_taste(v_uid, v_asof);
  end if;
  with cfg as (select linkout_cards from core.app_config where id),
  matched as (
    select b.id, b.category, b.sort_at, b.importance,
      case when b.kind = 'data' then 'fred' else sk.key end as skey,
      coalesce(b.event_type, b.kind) as typ,
      ts_rank(to_tsvector('english', coalesce(b.headline,'') || ' ' || coalesce(b.body,'') || ' ' || coalesce(b.detail::text,'') || ' ' || coalesce(b.tickers::text,'') || ' ' || coalesce(b.category,'')), v_ts) as tr
    from core.blurbs b cross join cfg c
    left join lateral (
      select k.key from core.blurb_sources s join core.source_keys k on s.name = any (k.match_names)
       where s.blurb_id = b.id and v_uid is not null order by s.is_primary desc, s.position, s.id limit 1) sk on true
    where b.status = 'published' and b.published_at <= now()
      and (b.kind <> 'link_out' or c.linkout_cards)
      and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)
      and (to_tsvector('english', coalesce(b.headline,'') || ' ' || coalesce(b.body,'') || ' ' || coalesce(b.detail::text,'') || ' ' || coalesce(b.tickers::text,'') || ' ' || coalesce(b.category,'')) @@ v_ts
        or position(lower(v_q) in lower(coalesce(b.headline,'') || ' ' || coalesce(b.body,'') || ' ' || coalesce(b.detail::text,'') || ' ' || coalesce(b.tickers::text,'') || ' ' || coalesce(b.category,''))) > 0
        or exists (select 1 from core.blurb_sources s where s.blurb_id = b.id and position(lower(v_q) in lower(s.name)) > 0))
  ), candidates as (
    select m.id,
      (0.72 * m.tr + 0.28 / (1 + greatest(extract(epoch from (v_asof - m.sort_at)) / 3600, 0) / 72))
       * (1 + ln(greatest(m.importance, 0.1)) / 20)
       * (1 + c_personal_weight * case when v_uid is null then 0 else
            least(greatest(core.taste_hours(v_taste, m.category, m.typ, m.skey), 0) / greatest(v_cap, 0.01), 1) end) as score
    from matched m
  ), page as (
    select id, round(score::numeric, 8) as score from candidates
    where (round(score::numeric, 8), id) < (v_key, v_id)
    order by score desc, id desc limit v_limit + 1
  ), chosen as (
    select * from page order by score desc, id desc limit v_limit
  )
  select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb),
         case when (select count(*) from page) > v_limit then
           (select score::text || '|' || id::text || '|' || to_char(v_asof at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              from chosen order by score asc, id asc limit 1) end
    into v_rows, v_next
    from jsonb_array_elements(core.cards_json((select array_agg(id order by score desc, id desc) from chosen), null)) with ordinality x(c,o);
  return jsonb_build_object('items', coalesce(v_rows,'[]'::jsonb), 'next_cursor', v_next);
end; $$;
revoke all on function api.search(text,text,int) from public;
grant execute on function api.search(text,text,int) to anon, authenticated;


-- =============================================================================
-- E. api.following_feed: same as 20261018000000; signed-in readers' score is multiplied by
--    2 ^ (foryou_personal_scale x taste_hours / following_half_life_hours), i.e. the same personal
--    hours For you adds, in this feed's own half-life. Guests (no auth.uid()) are unchanged.
-- =============================================================================

create or replace function api.following_feed(p_topics text[], p_sources text[], p_tickers text[], p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_topics text[] := coalesce(p_topics, '{}'); v_sources text[] := coalesce(p_sources, '{}'); v_tickers text[] := coalesce(p_tickers, '{}');
  v_limit int := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_key numeric := 1e30; v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'; v_asof timestamptz := now(); v_next text; v_items jsonb;
  v_uid uuid := auth.uid(); v_taste jsonb; v_scale numeric; v_half numeric;
begin
  if cardinality(v_topics) + cardinality(v_sources) + cardinality(v_tickers) = 0 then
    return api.feed('top', p_cursor, p_limit, null);
  end if;
  if p_cursor is not null then
    begin v_key := split_part(p_cursor, '|', 1)::numeric; v_id := split_part(p_cursor, '|', 2)::uuid;
      v_asof := least(coalesce(nullif(split_part(p_cursor, '|', 3), '')::timestamptz, v_asof), v_asof);
    exception when others then raise exception 'invalid_cursor' using errcode = 'PT422'; end;
  end if;
  select coalesce(max(value) filter (where key = 'foryou_personal_scale'), 3),
         coalesce(max(value) filter (where key = 'following_half_life_hours'), 12)
    into v_scale, v_half from core.rank_params;
  if v_uid is not null then v_taste := core.user_taste(v_uid, v_asof); end if;
  with direct as (
    select b.id, b.category, b.dedupe_key, b.sort_at, b.importance,
      case when b.category = any(v_topics) then 1.0
           when exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name = any(v_sources)) then 1.0
           when exists(select 1 from jsonb_array_elements(b.tickers) t where t->>'symbol' = any(v_tickers)) then 1.0 else 0.0 end rel,
      case when b.category = any(v_topics) then 'Because you follow ' || b.category
           when exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name = any(v_sources)) then 'Because you follow ' || (select s.name from core.blurb_sources s where s.blurb_id=b.id and s.name=any(v_sources) limit 1)
           else 'Because you follow ' || coalesce((select t->>'symbol' from jsonb_array_elements(b.tickers) t where t->>'symbol'=any(v_tickers) limit 1), v_tickers[1]) end reason
    from core.blurbs b join core.app_config cfg on cfg.id
    where b.status='published' and b.published_at<=now() and (b.kind<>'link_out' or cfg.linkout_cards)
      and exists(select 1 from core.blurb_sources bs where bs.blurb_id=b.id)
      and (b.category = any(v_topics)
      or exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name = any(v_sources))
      or exists(select 1 from jsonb_array_elements(b.tickers) t where t->>'symbol' = any(v_tickers)))
  ), candidates as (
    select d.id, d.dedupe_key, d.rel, d.reason, d.sort_at, d.importance from direct d
    union all
    select b.id, b.dedupe_key, 0.6, 'Related to ' || coalesce((select t->>'symbol' from jsonb_array_elements(b.tickers) t where exists(select 1 from direct d, core.blurbs db, jsonb_array_elements(db.tickers) dt where db.id=d.id and dt->>'symbol'=t->>'symbol') limit 1), b.category), b.sort_at, b.importance
    from core.blurbs b
    where not exists(select 1 from direct d where d.id=b.id)
      and (exists(select 1 from direct d join core.blurbs db on db.id=d.id where db.category=b.category)
        or exists(select 1 from jsonb_array_elements(b.tickers) t join direct d on exists(select 1 from core.blurbs db, jsonb_array_elements(db.tickers) dt where db.id=d.id and dt->>'symbol'=t->>'symbol'))
        or exists(select 1 from direct d join core.blurbs db on db.id=d.id where split_part(db.dedupe_key,':',1)=split_part(b.dedupe_key,':',1))
        or exists(select 1 from jsonb_array_elements(b.macro) m join direct d on exists(select 1 from core.blurbs db,jsonb_array_elements(db.macro) dm where db.id=d.id and dm->>'series_id'=m->>'series_id')))
  ), cfg as (select linkout_cards from core.app_config where id), eligible as (
    select c.*, c.rel * exp(-greatest(extract(epoch from (v_asof-c.sort_at)),0)/3600/greatest(v_half, 0.5) * ln(2)) * greatest(c.importance,0.1)
             * case when v_taste is null then 1 else
                 power(2::numeric, least(greatest(v_scale * core.taste_hours(v_taste, b.category, coalesce(b.event_type, b.kind),
                       case when b.kind = 'data' then 'fred' else core.source_key_of(b.kind, b.id) end), -48), 48)
                       / greatest(v_half, 0.5)) end score,
           row_number() over(partition by c.dedupe_key order by c.rel desc, c.sort_at desc, c.id desc) dedupe_n
    from candidates c join core.blurbs b on b.id=c.id cross join cfg
    where b.status='published' and b.published_at<=now() and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id)
      and (b.kind<>'link_out' or cfg.linkout_cards)
  ), page as (
    select e.id,e.reason,round(e.score::numeric,8) as score from eligible e where e.dedupe_n=1 and (round(e.score::numeric,8),e.id)<(v_key,v_id) order by 3 desc,1 desc limit v_limit+1
  ), chosen as (select * from page order by score desc,id desc limit v_limit), rendered as (
    select c.id,c.reason,c.score from chosen c
  )
  select coalesce(jsonb_agg((x.c - 'my_reaction') || jsonb_build_object('follow_reason',r.reason) order by x.o),'[]'::jsonb),
         case when (select count(*) from page)>v_limit then (select score::text||'|'||id::text||'|'||to_char(v_asof at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from chosen order by score asc,id asc limit 1) end
    into v_items,v_next
    from jsonb_array_elements(core.cards_json((select array_agg(id order by score desc,id desc) from rendered),null)) with ordinality x(c,o)
    join rendered r on r.id=(x.c->>'id')::uuid;
  return jsonb_build_object('items',coalesce(v_items,'[]'::jsonb),'next_cursor',v_next);
end; $$;
revoke all on function api.following_feed(text[],text[],text[],text,int) from public;
grant execute on function api.following_feed(text[],text[],text[],text,int) to anon, authenticated;

notify pgrst, 'reload schema';

-- HOW TO CHECK: paste after 20261018000000_brief_search_follow.sql ("Success. No rows returned";
-- a second run gives the same), then run supabase/tests/algo_v2_check.sql and the older checks.
-- Switch For you back to the 080000 scores with rank_params only (offline: identical pages):
--   update core.rank_params set value = 1   where key = 'foryou_negative_scale';
--   update core.rank_params set value = 0   where key = 'foryou_cold_step_hours';
--   update core.rank_params set value = 0.5 where key = 'foryou_category_step_hours';
-- Turn freshness per topic on (tested values; costs some precision offline):
--   update core.rank_params set value = 6  where key in ('foryou_half_life_markets', 'foryou_half_life_earnings',
--     'foryou_half_life_deals', 'foryou_half_life_insider', 'foryou_half_life_economy');
--   update core.rank_params set value = 16 where key in ('foryou_half_life_safety', 'foryou_half_life_science');
-- =============================================================================
