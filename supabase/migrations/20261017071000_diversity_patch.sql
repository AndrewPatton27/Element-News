-- =============================================================================
-- Element: breadth patch (2026-10-18, D-44 follow-up)
--
-- Live problem: Trending opened with FAA rule, FAA rule, quake, FAA rule, FAA rule. The four
-- Federal Register rules have no event_type, so the "same story type" rule did not see them as
-- alike, and "max 2 in a row per category" alone allows that pattern.
--
-- core.diversify is replaced (now with a p_take page size and a "left" list; the 2-argument
-- form still works). Rules for the next card on a page, best card first (looking at most
-- diversity_lookahead cards ahead):
--   1. not a 3rd card in a row from one category                         (diversity_max_run 2)
--   2. not the same story type as the card before; story type = category + event_type, and
--      a missing event_type counts as its own type ("<category>/:none")
--   3. no company ticker shared with the card before
--   4. not the same source cluster as the card before: Federal Register cards cluster by the
--      issuing agency (the card's attribution, e.g. "Federal Register, Federal Aviation
--      Administration"); every other card clusters by its source key (sec, fed, usgs, ...)
--   5. at most diversity_max_per_source (2) cards from one source in any diversity_window (5)
--      cards in a row
-- When no card passes everything, rules are dropped in this order: first 1 and 5, then 4,
-- then everything (best remaining card). Rules 2 and 3 (truly similar stories) are kept longest.
-- A story type that fills half or more of the rest of the page goes first (so 5 quakes come
-- out every other card), but only if that card passes rules 2-5.
-- Carry-over (new): a Trending / For you page now considers diversity_carry (3) more cards than
-- it shows. Cards it holds back (showing them now would put similar cards together) travel in
-- the cursor and are placed first-in-line on the next page, so nothing is lost or repeated.
-- The last card's state (category run, story type, tickers, source cluster, last 4 sources)
-- also travels in the cursor. Older cursors without the new fields still work.
-- api.feed and api.feed_for_you are recreated (same as 070000 plus carry-over); Latest unchanged.
-- Idempotent. Run after 20261017070000_trending_foryou.sql.
-- =============================================================================

insert into core.rank_params (key, value) values
  ('diversity_max_per_source', 2),
  ('diversity_window',         5),
  ('diversity_carry',          3)
on conflict (key) do nothing;

-- p_take: how many cards to place (the page size); the rest are returned as 'left' (score order)
create or replace function core.diversify(p_ids uuid[], p_state jsonb, p_take int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_maxrun int;
  v_look   int;
  v_maxsrc int;
  v_win    int;
  v_cat    text   := coalesce(p_state ->> 'c', '');
  v_run    int    := coalesce((p_state ->> 'r')::int, 0);
  v_clu    text   := coalesce(p_state ->> 'k', '');
  v_scl    text   := coalesce(p_state ->> 's', '');
  v_tick   text[] := coalesce(array(select jsonb_array_elements_text(
                        case when jsonb_typeof(p_state -> 't') = 'array' then p_state -> 't' else '[]'::jsonb end)), '{}');
  v_recent text[] := coalesce(array(select jsonb_array_elements_text(
                        case when jsonb_typeof(p_state -> 'w') = 'array' then p_state -> 'w' else '[]'::jsonb end)), '{}');
  v_ids    uuid[];
  v_cats   text[];
  v_clus   text[];
  v_ticks  jsonb[];
  v_skeys  text[];
  v_scls   text[];
  v_n      int;
  v_used   boolean[];
  v_out    uuid[] := '{}';
  v_pick   int;
  v_seen   int;
  v_force  text;
  v_ok_cat boolean;
  v_ok_typ boolean;
  v_ok_tik boolean;
  v_ok_scl boolean;
  v_ok_win boolean;
begin
  select coalesce(max(value) filter (where key = 'diversity_max_run'), 2)::int,
         coalesce(max(value) filter (where key = 'diversity_lookahead'), 8)::int,
         coalesce(max(value) filter (where key = 'diversity_max_per_source'), 2)::int,
         coalesce(max(value) filter (where key = 'diversity_window'), 5)::int
    into v_maxrun, v_look, v_maxsrc, v_win
    from core.rank_params;

  select array_agg(b.id order by u.o),
         array_agg(b.category order by u.o),
         array_agg(b.category || '/' || coalesce(b.event_type, ':none') order by u.o),
         array_agg(coalesce((select jsonb_agg(t ->> 'symbol') from jsonb_array_elements(b.tickers) t
                              where t ->> 'symbol' is not null), '[]'::jsonb) order by u.o),
         array_agg(sk.k order by u.o),
         array_agg(case when sk.k = 'fedreg'
                        then 'fedreg:' || lower(coalesce(nullif(b.attribution, ''), sk.attr, ''))
                        else sk.k end order by u.o)
    into v_ids, v_cats, v_clus, v_ticks, v_skeys, v_scls
    from unnest(p_ids) with ordinality as u(id, o)
    join core.blurbs b on b.id = u.id
    cross join lateral (
      select coalesce(core.source_key_of(b.kind, b.id),
                      'name:' || coalesce((select s.name from core.blurb_sources s where s.blurb_id = b.id
                                            order by s.is_primary desc, s.position, s.id limit 1), '?')) as k,
             (select s.attribution from core.blurb_sources s where s.blurb_id = b.id
               order by s.is_primary desc, s.position, s.id limit 1) as attr
    ) sk;

  v_n := coalesce(cardinality(v_ids), 0);
  v_used := array_fill(false, array[greatest(v_n, 1)]);
  for slot in 1 .. least(v_n, greatest(coalesce(p_take, v_n), 0)) loop
    v_pick := null;

    -- spread a crowded story type (only with a card that passes rules 2-5)
    select x.k into v_force
      from (select v_clus[j] as k, count(*) as c, min(j) as first_j
              from generate_series(1, v_n) j
             where not v_used[j] and v_clus[j] <> v_clu
             group by v_clus[j]) x
     where 2 * x.c - 1 >= least(v_n, coalesce(p_take, v_n)) - slot + 1
     order by x.c desc, x.first_j
     limit 1;
    if found then
      select j into v_pick from generate_series(1, v_n) j
       where not v_used[j] and v_clus[j] = v_force
         and v_scls[j] <> v_scl
         and (select count(*) from unnest(v_recent[greatest(cardinality(v_recent) - (v_win - 2), 1):]) r where r = v_skeys[j]) < v_maxsrc
         and not exists (select 1 from jsonb_array_elements_text(v_ticks[j]) s where s = any (v_tick))
       order by j
       limit 1;
    end if;

    for tier in 1 .. 4 loop
      exit when v_pick is not null;
      v_seen := 0;
      for j in 1 .. v_n loop
        continue when v_used[j];
        v_seen := v_seen + 1;
        exit when v_seen > greatest(v_look, 1);
        v_ok_cat := v_cats[j] <> v_cat or v_run < v_maxrun;
        v_ok_typ := v_clus[j] <> v_clu;
        v_ok_tik := not exists (select 1 from jsonb_array_elements_text(v_ticks[j]) s where s = any (v_tick));
        v_ok_scl := v_scls[j] <> v_scl;
        v_ok_win := (select count(*) from unnest(v_recent[greatest(cardinality(v_recent) - (v_win - 2), 1):]) r
                      where r = v_skeys[j]) < v_maxsrc;
        if (tier = 1 and v_ok_cat and v_ok_typ and v_ok_tik and v_ok_scl and v_ok_win)
           or (tier = 2 and v_ok_typ and v_ok_tik and v_ok_scl)
           or (tier = 3 and v_ok_typ and v_ok_tik)
           or tier = 4 then
          v_pick := j; exit;
        end if;
      end loop;
    end loop;

    v_used[v_pick] := true;
    v_out := v_out || v_ids[v_pick];
    if v_cats[v_pick] = v_cat then v_run := v_run + 1; else v_cat := v_cats[v_pick]; v_run := 1; end if;
    v_clu    := v_clus[v_pick];
    v_scl    := v_scls[v_pick];
    v_tick   := coalesce(array(select jsonb_array_elements_text(v_ticks[v_pick])), '{}');
    v_recent := (v_recent || v_skeys[v_pick]);
    v_recent := v_recent[greatest(cardinality(v_recent) - (greatest(v_win, 2) - 2), 1):];   -- keep the last window-1
  end loop;

  return jsonb_build_object('ids', to_jsonb(v_out),
                            'left', to_jsonb(coalesce(array(select v_ids[j] from generate_series(1, v_n) j
                                                             where not v_used[j] order by j), '{}')),
                            'state', jsonb_build_object('c', v_cat, 'r', v_run, 'k', v_clu, 't', to_jsonb(v_tick),
                                                        's', v_scl, 'w', to_jsonb(v_recent)));
end;
$$;

-- 2-argument form (place every card), kept for compatibility
create or replace function core.diversify(p_ids uuid[], p_state jsonb)
returns jsonb language sql stable security definer set search_path = ''
as $$ select core.diversify(p_ids, p_state, cardinality(p_ids)); $$;

revoke all on function core.diversify(uuid[], jsonb, int) from public, anon, authenticated;
revoke all on function core.diversify(uuid[], jsonb)      from public, anon, authenticated;

-- =============================================================================
-- api.feed and api.feed_for_you: same as 070000, plus "carry-over". Each Trending / For you page
-- now looks at diversity_carry (3) more cards than it shows; the ones it holds back (because
-- showing them now would put similar cards together) travel in the cursor and come first on the
-- next page. No card is lost or shown twice: held-back cards are always above the cursor's key.
-- Cursors: Trending '<key>|<uuid>|<generation>|<state>|<held-back ids>',
--          For you  '<score>|<uuid>|<generation>|<as_of>|<state>|<held-back ids>'. Older ones work.
-- Latest is unchanged (plain newest first).
-- =============================================================================

create or replace function api.feed(
  p_mode     text default 'top',
  p_cursor   text default null,
  p_limit    int  default 20,
  p_category text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_mode     text := coalesce(p_mode, 'top');
  v_limit    int  := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_hid      text[];
  v_hsrc     text[];
  v_gen      bigint;
  v_maxb     numeric;
  v_rank_key numeric;
  v_time_key timestamptz;
  v_id       uuid;
  v_ids      uuid[];
  v_keys     text[];
  v_next     text;
  v_items    jsonb;
  v_state    jsonb := '{}';
  v_div      jsonb;
  v_carry    uuid[] := '{}';
  v_left     uuid[];
  v_fetch    int;
  v_extra    int;
  v_more     boolean := false;
  v_lastkey  text;
  v_lastid   uuid;
begin
  if v_mode not in ('top', 'latest') then
    raise exception 'invalid_mode' using errcode = 'PT422';
  end if;

  if v_uid is not null then
    select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = v_uid;
  end if;
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');

  if p_cursor is null then
    v_rank_key := 1e12;
    v_time_key := 'infinity';
    v_id       := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  else
    begin
      v_id := split_part(p_cursor, '|', 2)::uuid;
      if v_mode = 'top' then
        v_rank_key := split_part(p_cursor, '|', 1)::numeric;
        v_gen      := nullif(split_part(p_cursor, '|', 3), '')::bigint;
        v_state    := core.state_from_text(split_part(p_cursor, '|', 4));
        v_carry    := coalesce(string_to_array(nullif(split_part(p_cursor, '|', 5), ''), ',')::uuid[], '{}');
      else
        v_time_key := split_part(p_cursor, '|', 1)::timestamptz;
      end if;
    exception when others then
      raise exception 'invalid_cursor' using errcode = 'PT422';
    end;
  end if;

  if v_mode = 'top' then
    -- the cursor's generation if it is still kept, else the newest (0 = no boosts yet)
    if v_gen is null or not exists (select 1 from core.trend_generations where gen = v_gen) then
      select coalesce(max(gen), 0) into v_gen from core.trend_generations;
    end if;
    -- a boost can be as low as -trend_max_neg_hours, so key < rank_score + that bound
    select coalesce(max(value), 3) into v_maxb from core.rank_params where key = 'trend_max_neg_hours';
    -- cards held back by the previous page (still published and not hidden) come first;
    -- the page looks at diversity_carry (3) extra cards so it has room to spread similar ones
    if cardinality(v_carry) > 0 then
      select coalesce(array_agg(u.id order by u.o), '{}') into v_carry
        from unnest(v_carry) with ordinality as u(id, o)
        join core.blurbs b on b.id = u.id
       where b.status = 'published'
         and (p_category is null or b.category = p_category)
         and not (b.category = any (v_hid))
         and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)));
    end if;
    select coalesce(max(value), 3)::int into v_extra from core.rank_params where key = 'diversity_carry';
    v_fetch := greatest(v_limit + greatest(v_extra, 0) - cardinality(v_carry), 1);

    select array_agg(s.id order by s.k desc, s.id desc),
           array_agg(s.k::text order by s.k desc, s.id desc)
      into v_ids, v_keys
      from (
        select b.id, b.rank_score + coalesce(t.boost, 0) as k
          from core.blurbs b
          left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = b.id
         where b.status = 'published'
           and (p_category is null or b.category = p_category)
           and not (b.category = any (v_hid))
           and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
           and b.rank_score < v_rank_key + greatest(v_maxb, 0) + 1        -- index-friendly prefilter (safe bound)
           and (b.rank_score + coalesce(t.boost, 0), b.id) < (v_rank_key, v_id)
         order by 2 desc, b.id desc
         limit v_fetch + 1
      ) s;
  else
    select array_agg(s.id order by s.sort_at desc, s.id desc),
           array_agg(to_char(s.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                     order by s.sort_at desc, s.id desc)
      into v_ids, v_keys
      from (
        select b.id, b.sort_at
          from core.blurbs b
         where b.status = 'published'
           and (p_category is null or b.category = p_category)
           and not (b.category = any (v_hid))
           and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
           and (b.sort_at, b.id) < (v_time_key, v_id)
         order by b.sort_at desc, b.id desc
         limit v_limit + 1
      ) s;
  end if;

  v_ids := coalesce(v_ids, '{}');
  if v_mode = 'top' then
    if cardinality(v_ids) > v_fetch then
      v_more := true; v_ids := v_ids[1:v_fetch]; v_keys := v_keys[1:v_fetch];
    end if;
    if cardinality(v_ids) > 0 then
      v_lastkey := v_keys[cardinality(v_ids)]; v_lastid := v_ids[cardinality(v_ids)];
    else
      v_lastkey := v_rank_key::text; v_lastid := v_id;
    end if;
    v_ids := v_carry || v_ids;
    if cardinality(v_ids) > 0 then                                        -- breadth: pick the page's order
      v_div  := core.diversify(v_ids, v_state, v_limit);
      v_ids  := array(select x::uuid from jsonb_array_elements_text(v_div -> 'ids') with ordinality as t(x, o) order by o);
      v_left := array(select x::uuid from jsonb_array_elements_text(v_div -> 'left') with ordinality as t(x, o) order by o);
      if v_more or cardinality(v_left) > 0 then
        v_next := v_lastkey || '|' || v_lastid || '|' || v_gen || '|' || core.state_to_text(v_div -> 'state')
                  || '|' || array_to_string(v_left, ',');
      end if;
    end if;
  elsif cardinality(v_ids) > v_limit then
    v_next := v_keys[v_limit] || '|' || v_ids[v_limit];                   -- Latest: plain keyset
    v_ids  := v_ids[1:v_limit];
  end if;

  select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(core.cards_json(v_ids, null)) with ordinality as x(c, o);

  return jsonb_build_object('items', v_items, 'next_cursor', v_next);
end;
$$;

revoke execute on function api.feed(text, text, int, text) from public;
grant  execute on function api.feed(text, text, int, text) to anon, authenticated, service_role;

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
  v_carry    uuid[] := '{}';
  v_left     uuid[];
  v_fetch    int;
  v_extra    int;
  v_more     boolean := false;
  v_lastkey  text;
  v_lastid   uuid;
  v_fol     text[];
  v_hid     text[];
  v_hsrc    text[];
  v_follow  numeric; v_window numeric; v_seen numeric; v_seenv numeric;
  v_explore numeric; v_exmin numeric; v_step numeric; v_days numeric; v_scale numeric;
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
  -- first page: as_of = this moment (clock time, so signals stored earlier in the same
  -- transaction still count); later pages reuse it. Only signals strictly older than as_of count.
  v_asof := least(coalesce(v_asof, clock_timestamp()), clock_timestamp());
  if v_gen is null or not exists (select 1 from core.trend_generations where gen = v_gen) then
    select coalesce(max(gen), 0) into v_gen from core.trend_generations;
  end if;

  select followed_categories, hidden_categories, hidden_sources into v_fol, v_hid, v_hsrc
    from core.user_prefs where user_id = v_uid;
  v_fol  := coalesce(v_fol, '{}');
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');

  select coalesce(max(value) filter (where key = 'boost_followed_hours'), 2),
         coalesce(max(value) filter (where key = 'for_you_window_days'), 30),
         coalesce(max(value) filter (where key = 'seen_penalty_hours'), 100),
         coalesce(max(value) filter (where key = 'seen_view_penalty_hours'), 24),
         coalesce(max(value) filter (where key = 'foryou_explore_hours'), 1),
         coalesce(max(value) filter (where key = 'foryou_explore_min_events'), 5),
         coalesce(max(value) filter (where key = 'foryou_category_step_hours'), 0.5),
         coalesce(max(value) filter (where key = 'affinity_days'), 30),
         coalesce(max(value) filter (where key = 'foryou_personal_scale'), 3)
    into v_follow, v_window, v_seen, v_seenv, v_explore, v_exmin, v_step, v_days, v_scale
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

  with aff as (
    select a.category, a.hours from core.user_affinity(v_uid, v_asof) a
  ), sig as (
    select distinct b.category
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
       and e.created_at > v_asof - make_interval(days => v_days::int)
  ), shown as (
    select e.blurb_id,
           bool_or(e.kind = 'open_detail'
                   or (e.kind = 'dwell' and e.dwell_ms >= core.long_look_ms(b.word_count))) as was_read
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
       and e.kind in ('view', 'dwell', 'open_detail', 'open_source')
     group by e.blurb_id
  ), base as (
    select b.id, b.category,
           b.rank_score + coalesce(t.boost, 0)
             + v_scale * (
                 case when b.category = any (v_fol) then v_follow else 0 end
               + coalesce(a.hours, 0)
               + case when v_nev >= v_exmin and not (b.category = any (v_fol))
                           and not exists (select 1 from sig where sig.category = b.category)
                      then v_explore else 0 end)
             - case when sh.was_read then v_seen
                    when sh.blurb_id is not null then v_seenv else 0 end as s0
      from core.blurbs b
      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = b.id
      left join aff a    on a.category = b.category
      left join shown sh on sh.blurb_id = b.id
     where b.status = 'published'
       and b.published_at <= v_asof
       and b.sort_at > v_asof - make_interval(days => v_window::int)
       and not (b.category = any (v_hid))
       and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike')
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

  -- breadth: pick the page's order (same rules as Trending); leftovers and state go in the cursor
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

notify pgrst, 'reload schema';

-- HOW TO CHECK: paste this file after 20261017070000_trending_foryou.sql (expected "Success. No
-- rows returned"; a second run gives the same), then run supabase/tests/trending_check.sql.
-- Live look: select x->>'category', x->'sources'->0->>'name', x->>'attribution'
--              from jsonb_array_elements(api.feed('top', null, 10)->'items') x;
-- =============================================================================
