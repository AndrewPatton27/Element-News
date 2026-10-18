-- =============================================================================
-- Element: richer reading signals for the For you feed (2026-10-17)
--
-- The For you feed learns from more than likes:
--   how long a card stayed on screen (dwell), opening the in-depth view (open_detail),
--   tapping a source link (open_source), likes and dislikes.
-- Only durations and taps are stored: no text, no position, no device data.
--
--   A  core.user_events: kinds 'open_detail' and 'dwell', column dwell_ms
--   B  weights and limits (core.rank_params)
--   C  core.user_affinity(user): learned hours per category (one formula for feed + readout)
--   D  api.track(p_blurb, p_kind, p_ms default null): replaces the 2-argument version;
--      old calls {p_blurb, p_kind} keep working through the default
--   E  api.get_prefs and api.feed_for_you use core.user_affinity + the "seen" penalty
--
-- core.cards_json is NOT changed here (it belongs to the detail migration).
-- Idempotent. Run after 20261017030000_accounts.sql (and 20261017050000 if present).
-- =============================================================================


-- =============================================================================
-- A. EVENTS TABLE
-- =============================================================================

alter table core.user_events add column if not exists dwell_ms int;

alter table core.user_events drop constraint if exists user_events_kind_check;
alter table core.user_events add constraint user_events_kind_check
  check (kind in ('view', 'open_source', 'like', 'dislike', 'open_detail', 'dwell'));

-- dwell_ms only on 'dwell' rows, 0..600000 ms (10 minutes)
alter table core.user_events drop constraint if exists user_events_dwell_check;
alter table core.user_events add constraint user_events_dwell_check
  check ((kind = 'dwell' and dwell_ms between 0 and 600000) or (kind <> 'dwell' and dwell_ms is null));


-- =============================================================================
-- B. WEIGHTS AND LIMITS (hours of ranking boost; change with UPDATE)
--   per card, from the user's events on that card in the last affinity_days (30):
--     w_like          +1.0   liked
--     w_dislike       -1.0   disliked (the card itself is also removed from For you)
--     w_open_detail   +0.5   opened the in-depth view
--     w_open_source   +0.5   tapped a source link
--     w_dwell_long    +0.25  longest look >= dwell_long_ms (8 s)
--     w_dwell_skip    -0.15  every look <= dwell_skip_ms (1.5 s) and no positive signal
--     w_view           0     a view alone means nothing
--   card total clamped to card_cap_neg_hours (-1.0) .. card_cap_pos_hours (+1.5)
--   category total clamped to +-affinity_cap_hours (4, from the accounts migration)
--   seen_penalty_hours 3: a card already read (look >= 8 s or detail opened) moves down
--   dwell_min_ms 300: shorter looks are not stored; dwell_window_minutes 30: one dwell row
--   per card per 30 min (the longest is kept)
-- affinity_hours_per_event (accounts migration) is no longer used; w_like / w_dislike replace it.
-- =============================================================================

insert into core.rank_params (key, value) values
  ('w_like',                1.0),
  ('w_dislike',            -1.0),
  ('w_open_detail',         0.5),
  ('w_open_source',         0.5),
  ('w_dwell_long',          0.25),
  ('w_dwell_skip',         -0.15),
  ('w_view',                0),
  ('dwell_long_ms',         8000),
  ('dwell_skip_ms',         1500),
  ('dwell_min_ms',          300),
  ('dwell_window_minutes',  30),
  ('card_cap_pos_hours',    1.5),
  ('card_cap_neg_hours',   -1.0),
  ('seen_penalty_hours',    3)
on conflict (key) do nothing;


-- =============================================================================
-- C. LEARNED AFFINITY (private)
-- returns one row per category the user has signals in: (category, hours), hours in -cap..+cap
-- =============================================================================

create or replace function core.user_affinity(p_user uuid)
returns table (category text, hours numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select coalesce(max(value) filter (where key = 'w_like'),             1)     as w_like,
           coalesce(max(value) filter (where key = 'w_dislike'),         -1)     as w_dislike,
           coalesce(max(value) filter (where key = 'w_open_detail'),      0.5)   as w_detail,
           coalesce(max(value) filter (where key = 'w_open_source'),      0.5)   as w_source,
           coalesce(max(value) filter (where key = 'w_dwell_long'),       0.25)  as w_long,
           coalesce(max(value) filter (where key = 'w_dwell_skip'),      -0.15)  as w_skip,
           coalesce(max(value) filter (where key = 'w_view'),             0)     as w_view,
           coalesce(max(value) filter (where key = 'dwell_long_ms'),      8000)  as long_ms,
           coalesce(max(value) filter (where key = 'dwell_skip_ms'),      1500)  as skip_ms,
           coalesce(max(value) filter (where key = 'card_cap_pos_hours'), 1.5)   as card_pos,
           coalesce(max(value) filter (where key = 'card_cap_neg_hours'), -1)    as card_neg,
           coalesce(max(value) filter (where key = 'affinity_cap_hours'), 4)     as cap,
           coalesce(max(value) filter (where key = 'affinity_days'),      30)    as days
      from core.rank_params
  ), ev as (
    select e.blurb_id,
           bool_or(e.kind = 'like')        as liked,
           bool_or(e.kind = 'dislike')     as disliked,
           bool_or(e.kind = 'open_detail') as detail,
           bool_or(e.kind = 'open_source') as src,
           bool_or(e.kind = 'view')        as viewed,
           max(e.dwell_ms)                 as max_dwell
      from core.user_events e cross join p
     where e.user_id = p_user
       and e.created_at > now() - make_interval(days => p.days::int)
     group by e.blurb_id
  ), card as (
    select b.category,
           greatest(least(
               case when ev.liked    then p.w_like   else 0 end
             + case when ev.disliked then p.w_dislike else 0 end
             + case when ev.detail   then p.w_detail else 0 end
             + case when ev.src      then p.w_source else 0 end
             + case when ev.viewed   then p.w_view   else 0 end
             + case when ev.max_dwell >= p.long_ms then p.w_long else 0 end
             + case when ev.max_dwell <= p.skip_ms
                     and not (ev.liked or ev.detail or ev.src) then p.w_skip else 0 end,
             p.card_pos), p.card_neg) as s
      from ev
      join core.blurbs b on b.id = ev.blurb_id
      cross join p
  )
  select c.category, greatest(least(sum(c.s), max(p.cap)), -max(p.cap)) as hours
    from card c cross join p
   group by c.category;
$$;

revoke all on function core.user_affinity(uuid) from public, anon, authenticated;


-- =============================================================================
-- D. api.track (3 arguments; the 2-argument version is replaced)
-- p_kind: 'view' | 'open_source' | 'open_detail' | 'like' | 'dislike' | 'dwell' | 'clear'
--   view, open_source, open_detail  ignored if the same card+kind was stored in the last 60 min
--   dwell  p_ms required (ms the card was on screen). Under 300 ms: ignored. Over 600000: stored
--          as 600000. One row per card per 30 min: a longer look updates it, a shorter one is ignored.
--   like, dislike, clear  as before (one reaction per card)
-- p_ms is ignored for every kind except dwell.
-- returns {status: 'recorded' | 'ignored' | 'cleared'}
-- =============================================================================

-- Two functions named api.track with the same first two arguments would make 2-argument calls
-- ambiguous (in SQL and in PostgREST), so the old one is dropped and the new one has a default.
drop function if exists api.track(uuid, text);

create or replace function api.track(p_blurb uuid, p_kind text, p_ms int default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_dedupe numeric;
  v_max    numeric;
  v_minms  numeric;
  v_win    numeric;
  v_ms     int;
  v_row    bigint;
  v_old    int;
  v_n      int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;
  if p_kind is null or p_kind not in ('view', 'open_source', 'open_detail', 'like', 'dislike', 'dwell', 'clear') then
    raise exception 'invalid_kind' using errcode = 'PT422';
  end if;
  if p_kind = 'dwell' and (p_ms is null or p_ms < 0) then
    raise exception 'invalid_ms' using errcode = 'PT422';
  end if;
  if p_blurb is null or not exists (select 1 from core.blurbs where id = p_blurb and status = 'published') then
    raise exception 'unknown_card' using errcode = 'PT422';
  end if;

  if p_kind = 'clear' then
    delete from core.user_events
     where user_id = v_uid and blurb_id = p_blurb and kind in ('like', 'dislike');
    return jsonb_build_object('status', 'cleared');
  end if;

  if p_kind = 'dwell' then
    select value into v_minms from core.rank_params where key = 'dwell_min_ms';
    select value into v_win   from core.rank_params where key = 'dwell_window_minutes';
    if p_ms < coalesce(v_minms, 300) then
      return jsonb_build_object('status', 'ignored');
    end if;
    v_ms := least(p_ms, 600000);
    select id, dwell_ms into v_row, v_old from core.user_events
     where user_id = v_uid and blurb_id = p_blurb and kind = 'dwell'
       and created_at > now() - make_interval(mins => coalesce(v_win, 30)::int)
     order by created_at desc limit 1;
    if v_row is not null then
      if v_ms > v_old then
        update core.user_events set dwell_ms = v_ms where id = v_row;   -- keep the longest look
        return jsonb_build_object('status', 'recorded');
      end if;
      return jsonb_build_object('status', 'ignored');
    end if;
  end if;

  select value into v_max from core.rank_params where key = 'track_max_per_hour';
  select count(*) into v_n from core.user_events
   where user_id = v_uid and created_at > now() - interval '1 hour';
  if v_n >= coalesce(v_max, 600) then
    return jsonb_build_object('status', 'ignored');
  end if;

  if p_kind in ('view', 'open_source', 'open_detail') then
    select value into v_dedupe from core.rank_params where key = 'view_dedupe_minutes';
    if exists (select 1 from core.user_events
                where user_id = v_uid and blurb_id = p_blurb and kind = p_kind
                  and created_at > now() - make_interval(mins => coalesce(v_dedupe, 60)::int)) then
      return jsonb_build_object('status', 'ignored');
    end if;
  elsif p_kind in ('like', 'dislike') then
    if exists (select 1 from core.user_events
                where user_id = v_uid and blurb_id = p_blurb and kind = p_kind) then
      return jsonb_build_object('status', 'ignored');
    end if;
    delete from core.user_events
     where user_id = v_uid and blurb_id = p_blurb and kind in ('like', 'dislike');
  end if;

  insert into core.user_events (user_id, blurb_id, kind, dwell_ms)
  values (v_uid, p_blurb, p_kind, case when p_kind = 'dwell' then v_ms end);
  return jsonb_build_object('status', 'recorded');
end;
$$;

revoke all on function api.track(uuid, text, int) from public, anon;
grant execute on function api.track(uuid, text, int) to authenticated;


-- =============================================================================
-- E. READOUT AND FEED
-- =============================================================================

-- ---------- api.get_prefs (affinity now from core.user_affinity) -----------------
create or replace function api.get_prefs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_p    core.user_prefs%rowtype;
  v_aff  jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  select coalesce(jsonb_object_agg(a.category, round(a.hours, 2)), '{}'::jsonb) into v_aff
    from core.user_affinity(v_uid) a
   where a.hours <> 0;

  select * into v_p from core.user_prefs where user_id = v_uid;
  if not found then
    return jsonb_build_object('followed_categories', '[]'::jsonb, 'hidden_categories', '[]'::jsonb,
                              'onboarded', false, 'updated_at', null, 'affinity', v_aff);
  end if;
  return jsonb_build_object('followed_categories', to_jsonb(v_p.followed_categories),
                            'hidden_categories',   to_jsonb(v_p.hidden_categories),
                            'onboarded',           v_p.onboarded,
                            'updated_at',          v_p.updated_at,
                            'affinity',            v_aff);
end;
$$;

-- ---------- api.feed_for_you -----------------------------------------------------
-- personal_score (hours) = rank_score
--                        + boost_followed_hours (2) if the category is followed
--                        + core.user_affinity hours for the category (-4..+4)
--                        - seen_penalty_hours (3) if the user already read the card
--                          (a look >= dwell_long_ms or opened the in-depth view; any time)
-- Excluded: hidden categories, disliked cards, cards older than for_you_window_days, unpublished.
-- Same paging and cursor as before ('<personal_score>|<uuid>'); same mid-scroll caveat:
-- new signals change later scores, so a card may repeat or be skipped once in that scroll.
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
  v_fol     text[];
  v_hid     text[];
  v_follow  numeric; v_window numeric; v_seen numeric; v_long numeric;
  v_ids     uuid[];
  v_keys    text[];
  v_next    text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  if p_cursor is null then
    v_key := 1e12;
    v_id  := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  else
    begin
      v_key := split_part(p_cursor, '|', 1)::numeric;
      v_id  := split_part(p_cursor, '|', 2)::uuid;
    exception when others then
      raise exception 'invalid_cursor' using errcode = 'PT422';
    end;
  end if;

  select coalesce(followed_categories, '{}'), coalesce(hidden_categories, '{}')
    into v_fol, v_hid
    from core.user_prefs where user_id = v_uid;
  v_fol := coalesce(v_fol, '{}');
  v_hid := coalesce(v_hid, '{}');

  select value into v_follow from core.rank_params where key = 'boost_followed_hours';
  select value into v_window from core.rank_params where key = 'for_you_window_days';
  select value into v_seen   from core.rank_params where key = 'seen_penalty_hours';
  select value into v_long   from core.rank_params where key = 'dwell_long_ms';
  v_follow := coalesce(v_follow, 2); v_window := coalesce(v_window, 30);
  v_seen := coalesce(v_seen, 3);     v_long := coalesce(v_long, 8000);

  with aff as (
    select a.category, a.hours from core.user_affinity(v_uid) a
  ), seen as (
    select e.blurb_id from core.user_events e
     where e.user_id = v_uid
       and (e.kind = 'open_detail' or (e.kind = 'dwell' and e.dwell_ms >= v_long))
     group by e.blurb_id
  ), scored as (
    select b.id,
           b.rank_score
             + case when b.category = any (v_fol) then v_follow else 0 end
             + coalesce(a.hours, 0)
             - case when sn.blurb_id is not null then v_seen else 0 end as ps
      from core.blurbs b
      left join aff a   on a.category = b.category
      left join seen sn on sn.blurb_id = b.id
     where b.status = 'published'
       and b.sort_at > now() - make_interval(days => v_window::int)
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike')
  ), page as (
    select s.id, s.ps from scored s
     where (s.ps, s.id) < (v_key, v_id)
     order by s.ps desc, s.id desc
     limit v_limit + 1
  )
  select array_agg(p.id order by p.ps desc, p.id desc),
         array_agg(p.ps::text order by p.ps desc, p.id desc)
    into v_ids, v_keys
    from page p;

  v_ids := coalesce(v_ids, '{}');
  if cardinality(v_ids) > v_limit then
    v_next := v_keys[v_limit] || '|' || v_ids[v_limit];
    v_ids  := v_ids[1:v_limit];
  end if;

  return jsonb_build_object('items', core.cards_json(v_ids, v_uid), 'next_cursor', v_next);
end;
$$;

revoke all on function api.get_prefs()             from public, anon;
revoke all on function api.feed_for_you(text, int) from public, anon;
grant execute on function api.get_prefs()             to authenticated;
grant execute on function api.feed_for_you(text, int) to authenticated;

-- Ask PostgREST to reload its schema cache (api.track changed signature). Harmless elsewhere.
notify pgrst, 'reload schema';

-- HOW TO CHECK: paste this file (expected "Success. No rows returned"; a second run gives the
-- same). Then run supabase/tests/signals_check.sql and supabase/tests/accounts_check.sql with
-- the two test users (element-test-a@example.com, element-test-b@example.com) in place.
