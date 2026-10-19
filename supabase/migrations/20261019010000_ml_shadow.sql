-- =============================================================================
-- Element: ML shadow logging (2026-10-19)
--
-- Records, for signed-in readers only, which cards each For you and Trending page showed and in
-- what order, plus the displayed slot on 'view' events, so an offline job can replay a model
-- against real behaviour. NOTHING here changes what a reader sees: the feeds are served by the
-- same formula as before (the bodies below are unchanged copies), and only modes 0 (off) and
-- 1 (log) exist. Any other mode value behaves like 1.
--
-- Privacy: this replaces the "no position" note in the header of 20261017060000_signals.sql.
-- With a mode >= 1, page records (card ids, order, page number) and a view's displayed slot and
-- surface are stored. Page records are kept ml_log_retention_days (21). delete_my_data and
-- delete_account remove them. Both modes ship at 0 (off) until Drew approves the wording.
--
--   A  tables core.ml_pages, core.ml_shadow, core.ml_runs, core.ml_appeal (RLS on, no policies)
--   B  settings (core.rank_params, on conflict do nothing; modes 0)
--   C  core.user_events: page_id, slot, surface (view rows only) + check
--   D  api.track(p_blurb, p_kind, p_ms, p_page, p_slot, p_surface): replaces the 3-argument one
--   E  core.feed_top and core.feed_for_you_v5: the latest api.feed (20261017071000) and
--      api.feed_for_you (20261018010000 section C) bodies, copied with only the name changed
--   F  api.feed and api.feed_for_you: thin volatile wrappers that call E and log the page
--   G  api.following_feed: same as 20261018070000, fallback now calls core.feed_top
--   H  api.delete_my_data and api.delete_account, in full, also delete ml_pages
--   I  service-role RPCs: ml_export (paged), ml_begin_run, ml_write_shadow, ml_write_appeal,
--      ml_finish_run, ml_purge
--
-- Cursors (new fields only at the end; older cursors keep working and read as page 0):
--   For you   score|id|gen|as_of|state|carry|ml_run|page_no|mode   (ml_run stays empty here)
--   Trending  key|id|gen|state|carry|page_no|mode
--   Latest    unchanged
--
-- Idempotent. Run after 20261019000000_set_card_category.sql.
-- Check: supabase/tests/ml_shadow_check.sql
-- =============================================================================


-- =============================================================================
-- A. TABLES (ids and positions only; no text, IP or device data)
-- =============================================================================

-- one row per page served to a signed-in reader (For you or Trending)
create table if not exists core.ml_pages (
  page_id     uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  surface     text not null check (surface in ('for_you', 'trending')),
  ranker      text not null,                       -- 'fy-formula-v4' | 'tr-formula-v2'
  ml_mode     smallint not null,                   -- flag value when served (1 in this build)
  ml_run      bigint,                              -- always null in this build (live runs come later)
  holdout     boolean not null default false,
  page_no     int not null default 0,              -- 0 = first page of a scroll
  gen         bigint,                              -- trend generation used
  as_of       timestamptz not null,                -- the page's as-of time (For you: frozen in the cursor)
  prefs_at    timestamptz,                         -- core.user_prefs.updated_at when served
  shown_at    timestamptz not null default now(),
  card_ids    uuid[] not null,                     -- server order after core.diversify (what was returned)
  live_scores numeric[] not null,                  -- rank_score + trend boost (gen) per card, same order
  ml_terms    numeric[]                            -- null in this build
);
alter table core.ml_pages drop constraint if exists ml_pages_size_check;
alter table core.ml_pages add constraint ml_pages_size_check
  check (cardinality(card_ids) between 1 and 60
         and cardinality(live_scores) = cardinality(card_ids)
         and (ml_terms is null or cardinality(ml_terms) = cardinality(card_ids)));
create index if not exists ml_pages_user_time_idx on core.ml_pages (user_id, shown_at desc);
create index if not exists ml_pages_time_idx      on core.ml_pages (shown_at, page_id);

-- one row per scoring job run
create table if not exists core.ml_runs (
  run_id        bigint generated always as identity primary key,
  kind          text not null check (kind in ('shadow', 'live', 'appeal')),
  model_version text not null,
  approved      boolean not null default false,    -- set by hand only; not read by any feed in this build
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running', 'ok', 'failed')),
  n_users       int,
  n_rows        int,
  params        jsonb not null default '{}'
);

-- one row per (page, model version): what the model would have done (written by the replay job)
create table if not exists core.ml_shadow (
  page_id       uuid not null references core.ml_pages (page_id) on delete cascade,
  model_version text not null,
  ml_rank       smallint[] not null,
  utility       real[] not null,
  p_like        real[] not null,
  p_dislike     real[] not null,
  p_detail      real[] not null,
  completion    real[] not null,
  conf          real not null,
  why           smallint[] not null,
  ml_top_ids    uuid[] not null,
  scored_at     timestamptz not null default now(),
  primary key (page_id, model_version)
);

-- Trending appeal per (run, card); stored for offline analysis only, read by no feed in this build
create table if not exists core.ml_appeal (
  run_id    bigint not null references core.ml_runs (run_id) on delete cascade,
  blurb_id  uuid   not null references core.blurbs (id) on delete cascade,
  appeal    real   not null,
  za        real   not null check (za between -2 and 2),
  n_readers int    not null check (n_readers >= 0),
  primary key (run_id, blurb_id)
);

alter table core.ml_pages  enable row level security;
alter table core.ml_runs   enable row level security;
alter table core.ml_shadow enable row level security;
alter table core.ml_appeal enable row level security;
revoke all on table core.ml_pages, core.ml_runs, core.ml_shadow, core.ml_appeal from public, anon, authenticated;


-- =============================================================================
-- B. SETTINGS (change with UPDATE core.rank_params)
--   foryou_ml_mode / trending_ml_mode  0 = off (nothing new stored), 1 = log pages and view slots.
--                                      Any other value behaves like 1. Ship at 0 (Drew approves the
--                                      privacy wording first).
--   ml_log_retention_days 21   ml_pages (and their ml_shadow rows) older than this are purged
--   ml_keep_runs           3   newest runs kept per kind (appeal rows cascade)
--   ml_pages_max_per_hour 60   per-reader page logging cap
--   ml_purge_events_days   0   > 0: also purge core.user_events older than this many days
--                              (proposed 60; off until Drew approves)
--   ml_db_stop_mb        400   ml_purge sets both modes to 0 when the database is larger than this
-- =============================================================================

insert into core.rank_params (key, value) values
  ('foryou_ml_mode',         0),
  ('trending_ml_mode',       0),
  ('ml_log_retention_days', 21),
  ('ml_keep_runs',           3),
  ('ml_pages_max_per_hour', 60),
  ('ml_purge_events_days',   0),
  ('ml_db_stop_mb',        400)
on conflict (key) do nothing;


-- =============================================================================
-- C. core.user_events: displayed position of a view (view rows only, null otherwise)
-- =============================================================================

alter table core.user_events add column if not exists page_id uuid;      -- no FK: pages are purged first
alter table core.user_events add column if not exists slot    smallint;  -- displayed index, 0-based, 0..499
alter table core.user_events add column if not exists surface text;

alter table core.user_events drop constraint if exists user_events_slot_check;
alter table core.user_events add constraint user_events_slot_check
  check ((kind = 'view' or (page_id is null and slot is null and surface is null))
         and (slot is null or slot between 0 and 499)
         and (surface is null or surface in ('for_you', 'trending', 'latest', 'search', 'following', 'brief', 'detail')));

create index if not exists user_events_time_idx on core.user_events (created_at, id);


-- =============================================================================
-- D. api.track (6 arguments; old 2- and 3-argument calls keep working through the defaults)
-- Same as 20261017060000 section D, plus: for kind 'view' and only while foryou_ml_mode or
-- trending_ml_mode is not 0, it stores
--   p_page     only if that page exists and belongs to the caller (else null; never raises)
--   p_slot     only if 0..499 (else null)
--   p_surface  only if one of for_you, trending, latest, search, following, brief, detail (else null)
-- In mode 0, and for every other kind, the three columns are null.
-- =============================================================================

drop function if exists api.track(uuid, text, int);

create or replace function api.track(p_blurb uuid, p_kind text, p_ms int default null,
                                     p_page uuid default null, p_slot int default null, p_surface text default null)
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
  v_page   uuid;
  v_slot   smallint;
  v_surf   text;
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

  -- position of a view: only while a logging mode is on
  if p_kind = 'view'
     and exists (select 1 from core.rank_params
                  where key in ('foryou_ml_mode', 'trending_ml_mode') and value <> 0) then
    if p_page is not null then
      select m.page_id into v_page from core.ml_pages m where m.page_id = p_page and m.user_id = v_uid;
    end if;
    if p_slot between 0 and 499 then v_slot := p_slot; end if;
    if p_surface in ('for_you', 'trending', 'latest', 'search', 'following', 'brief', 'detail') then
      v_surf := p_surface;
    end if;
  end if;

  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, page_id, slot, surface)
  values (v_uid, p_blurb, p_kind, case when p_kind = 'dwell' then v_ms end, v_page, v_slot, v_surf);
  return jsonb_build_object('status', 'recorded');
end;
$$;

revoke all on function api.track(uuid, text, int, uuid, int, text) from public, anon;
grant execute on function api.track(uuid, text, int, uuid, int, text) to authenticated;


-- =============================================================================
-- E. STABLE CORES (private). Bodies copied unchanged; only the function name differs.
-- =============================================================================

-- E1. core.feed_top = api.feed from 20261017071000_diversity_patch.sql
create or replace function core.feed_top(
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

revoke all on function core.feed_top(text, text, int, text) from public, anon, authenticated;

-- E2. core.feed_for_you_v5 = api.feed_for_you from 20261018010000_algo_v2.sql (section C)
create or replace function core.feed_for_you_v5(p_cursor text default null, p_limit int default 20)
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

revoke all on function core.feed_for_you_v5(text, int) from public, anon, authenticated;


-- =============================================================================
-- F. api.feed and api.feed_for_you: same signatures, grants and output as before, plus
--   * next_cursor gains the trailing fields (Trending: page_no|mode; For you: ml_run|page_no|mode)
--   * signed-in Trending (p_mode 'top', no category) and For you pages are logged in core.ml_pages
--     when the surface's mode is not 0; the response then gains "page_id". Guests: never.
--   * logging can never break the feed: any error in it is swallowed and the page is returned
-- volatile because of the insert. The items always equal the core function's items.
-- =============================================================================

create or replace function api.feed(
  p_mode     text default 'top',
  p_cursor   text default null,
  p_limit    int  default 20,
  p_category text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r      jsonb;
  v_uid    uuid := auth.uid();
  v_mode   int;
  v_cmode  int;
  v_tmp    int;
  v_pno    int := 0;
  v_gen    bigint;
  v_ids    uuid[];
  v_max    numeric;
  v_n      int;
  v_page   uuid;
begin
  v_r := core.feed_top(p_mode, p_cursor, p_limit, p_category);
  if coalesce(p_mode, 'top') <> 'top' then return v_r; end if;           -- Latest: unchanged

  select case when coalesce(max(value), 0) = 0 then 0 else 1 end into v_mode
    from core.rank_params where key = 'trending_ml_mode';
  v_cmode := v_mode;
  if p_cursor is not null then                                           -- fields 6 and 7 (absent = old cursor)
    begin
      v_pno   := coalesce(nullif(split_part(p_cursor, '|', 6), '')::int, 0);
      v_tmp   := nullif(split_part(p_cursor, '|', 7), '')::int;
      v_cmode := case when v_tmp is null then v_mode when v_tmp = 0 then 0 else 1 end;
    exception when others then v_pno := 0; v_cmode := v_mode;
    end;
    if v_pno < 0 then v_pno := 0; end if;
  end if;
  if v_r ->> 'next_cursor' is not null then
    v_r := jsonb_set(v_r, '{next_cursor}', to_jsonb((v_r ->> 'next_cursor') || '|' || (v_pno + 1) || '|' || v_cmode));
  end if;

  if v_uid is null or v_mode = 0 or p_category is not null or jsonb_array_length(v_r -> 'items') = 0 then
    return v_r;
  end if;
  begin
    select coalesce(max(value), 60) into v_max from core.rank_params where key = 'ml_pages_max_per_hour';
    select count(*) into v_n from core.ml_pages where user_id = v_uid and shown_at > now() - interval '1 hour';
    if v_n < v_max then
      begin v_gen := nullif(split_part(p_cursor, '|', 3), '')::bigint; exception when others then v_gen := null; end;
      if v_gen is null or not exists (select 1 from core.trend_generations where gen = v_gen) then
        select coalesce(max(gen), 0) into v_gen from core.trend_generations;
      end if;
      v_ids := array(select (x.c ->> 'id')::uuid from jsonb_array_elements(v_r -> 'items') with ordinality as x(c, o) order by x.o);
      insert into core.ml_pages (user_id, surface, ranker, ml_mode, page_no, gen, as_of, prefs_at, card_ids, live_scores)
      values (v_uid, 'trending', 'tr-formula-v2', v_mode, v_pno, v_gen, now(),
              (select p.updated_at from core.user_prefs p where p.user_id = v_uid),
              v_ids,
              array(select coalesce(b.rank_score + coalesce(t.boost, 0), 0)
                      from unnest(v_ids) with ordinality as u(id, o)
                      left join core.blurbs b on b.id = u.id
                      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = u.id
                     order by u.o))
      returning page_id into v_page;
    end if;
  exception when others then
    v_page := null;                                                      -- never break the feed
  end;
  if v_page is not null then v_r := v_r || jsonb_build_object('page_id', v_page); end if;
  return v_r;
end;
$$;

revoke execute on function api.feed(text, text, int, text) from public;
grant  execute on function api.feed(text, text, int, text) to anon, authenticated, service_role;

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
begin
  v_r := core.feed_for_you_v5(p_cursor, p_limit);                        -- raises for guests, as before

  select case when coalesce(max(value), 0) = 0 then 0 else 1 end into v_mode
    from core.rank_params where key = 'foryou_ml_mode';
  v_cmode := v_mode;
  if p_cursor is not null then                                           -- fields 8 and 9 (absent = old cursor)
    begin
      v_pno   := coalesce(nullif(split_part(p_cursor, '|', 8), '')::int, 0);
      v_tmp   := nullif(split_part(p_cursor, '|', 9), '')::int;
      v_cmode := case when v_tmp is null then v_mode when v_tmp = 0 then 0 else 1 end;
    exception when others then v_pno := 0; v_cmode := v_mode;
    end;
    if v_pno < 0 then v_pno := 0; end if;
  end if;
  if v_r ->> 'next_cursor' is not null then                              -- field 7 (ml_run) stays empty
    v_r := jsonb_set(v_r, '{next_cursor}', to_jsonb((v_r ->> 'next_cursor') || '||' || (v_pno + 1) || '|' || v_cmode));
  end if;

  if v_uid is null or v_mode = 0 or jsonb_array_length(v_r -> 'items') = 0 then
    return v_r;
  end if;
  begin
    select coalesce(max(value), 60) into v_max from core.rank_params where key = 'ml_pages_max_per_hour';
    select count(*) into v_n from core.ml_pages where user_id = v_uid and shown_at > now() - interval '1 hour';
    if v_n < v_max then
      -- as_of and gen as the core used them: the next cursor carries both; else the request's cursor
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
      insert into core.ml_pages (user_id, surface, ranker, ml_mode, page_no, gen, as_of, prefs_at, card_ids, live_scores)
      values (v_uid, 'for_you', 'fy-formula-v4', v_mode, v_pno, v_gen, v_asof,
              (select p.updated_at from core.user_prefs p where p.user_id = v_uid),
              v_ids,
              array(select coalesce(b.rank_score + coalesce(t.boost, 0), 0)
                      from unnest(v_ids) with ordinality as u(id, o)
                      left join core.blurbs b on b.id = u.id
                      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = u.id
                     order by u.o))
      returning page_id into v_page;
    end if;
  exception when others then
    v_page := null;                                                      -- never break the feed
  end;
  if v_page is not null then v_r := v_r || jsonb_build_object('page_id', v_page); end if;
  return v_r;
end;
$$;

revoke all on function api.feed_for_you(text, int) from public, anon;
grant execute on function api.feed_for_you(text, int) to authenticated;


-- =============================================================================
-- G. api.following_feed = 20261018070000_following_v2.sql; the no-follows fallback calls
--    core.feed_top (stable) instead of api.feed (now volatile and logging)
-- =============================================================================

create or replace function api.following_feed(p_topics text[], p_sources text[], p_tickers text[], p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_topics text[] := coalesce(p_topics, '{}'); v_sources text[] := coalesce(p_sources, '{}'); v_tickers text[] := coalesce(p_tickers, '{}');
  v_limit int := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_key numeric := 1e30; v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'; v_asof timestamptz := now(); v_next text; v_items jsonb;
  v_uid uuid := auth.uid(); v_taste jsonb; v_scale numeric; v_half numeric;
begin
  if cardinality(v_topics) + cardinality(v_sources) + cardinality(v_tickers) = 0 then return core.feed_top('top', p_cursor, p_limit, null); end if;
  if p_cursor is not null then begin v_key := split_part(p_cursor, '|', 1)::numeric; v_id := split_part(p_cursor, '|', 2)::uuid; v_asof := least(coalesce(nullif(split_part(p_cursor, '|', 3), '')::timestamptz, v_asof), v_asof); exception when others then raise exception 'invalid_cursor' using errcode = 'PT422'; end; end if;
  select coalesce(max(value) filter (where key='foryou_personal_scale'),3),coalesce(max(value) filter (where key='following_half_life_hours'),12) into v_scale,v_half from core.rank_params;
  if v_uid is not null then v_taste := core.user_taste(v_uid,v_asof); end if;
  with direct as (
    select b.id,b.category,b.dedupe_key,b.sort_at,b.importance,
      case when b.category=any(v_topics) then 1.0 when exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name=any(v_sources)) then 1.0 when exists(select 1 from jsonb_array_elements(b.tickers) t where t->>'symbol'=any(v_tickers)) then 1.0 else 0.0 end rel,
      case when b.category=any(v_topics) then 'Because you follow '||coalesce((select c.name from core.categories c where c.slug=b.category),b.category) when exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name=any(v_sources)) then 'Because you follow '||(select s.name from core.blurb_sources s where s.blurb_id=b.id and s.name=any(v_sources) limit 1) else 'Because you follow '||coalesce((select t->>'symbol' from jsonb_array_elements(b.tickers) t where t->>'symbol'=any(v_tickers) limit 1),v_tickers[1]) end reason
    from core.blurbs b join core.app_config cfg on cfg.id where b.status='published' and b.published_at<=now() and (b.kind<>'link_out' or cfg.linkout_cards) and exists(select 1 from core.blurb_sources bs where bs.blurb_id=b.id) and (b.category=any(v_topics) or exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name=any(v_sources)) or exists(select 1 from jsonb_array_elements(b.tickers) t where t->>'symbol'=any(v_tickers)))
  ), candidates0 as (
    select d.id,d.dedupe_key,d.rel,d.reason,d.sort_at,d.importance,null::text link_kind,null::uuid related_id,null::text related_headline from direct d
    union all
    select b.id,b.dedupe_key,case sl.kind when 'related' then 0.6 else 0.9 end,case sl.kind when 'update' then 'Update to a story you follow' when 'angle' then 'Another angle on a story you follow' else 'Related to something you follow' end,b.sort_at,b.importance,sl.kind,sl.related_id,target.headline
    from core.story_links sl join core.blurbs b on b.id=sl.card_id join core.blurbs target on target.id=sl.related_id join direct d on d.id=sl.related_id
    where b.status='published' and (sl.kind='related' or true)
    union all
    select b.id,b.dedupe_key,0.6,'Related to something you follow',b.sort_at,b.importance,sl.kind,sl.card_id,target.headline
    from core.story_links sl join core.blurbs b on b.id=sl.related_id join core.blurbs target on target.id=sl.card_id join direct d on d.id=sl.card_id where b.status='published'
  ), candidates as (
    select * from (select distinct on(id) * from candidates0 order by id,rel desc,sort_at desc) preferred
    union all
    select b.id,b.dedupe_key,0.6,'Related to '||coalesce((select t->>'symbol' from jsonb_array_elements(b.tickers) t where exists(select 1 from direct d,core.blurbs db,jsonb_array_elements(db.tickers) dt where db.id=d.id and dt->>'symbol'=t->>'symbol') limit 1),(select c.name from core.categories c where c.slug=b.category),b.category),b.sort_at,b.importance,null::text,null::uuid,null::text from core.blurbs b where not exists(select 1 from candidates0 c where c.id=b.id) and (exists(select 1 from direct d join core.blurbs db on db.id=d.id where db.category=b.category) or exists(select 1 from jsonb_array_elements(b.tickers) t join direct d on exists(select 1 from core.blurbs db,jsonb_array_elements(db.tickers) dt where db.id=d.id and dt->>'symbol'=t->>'symbol')) or exists(select 1 from direct d join core.blurbs db on db.id=d.id where split_part(db.dedupe_key,':',1)=split_part(b.dedupe_key,':',1)) or exists(select 1 from jsonb_array_elements(b.macro) m join direct d on exists(select 1 from core.blurbs db,jsonb_array_elements(db.macro) dm where db.id=d.id and dm->>'series_id'=m->>'series_id')))
  ), cfg as (select linkout_cards from core.app_config where id), eligible as (
    select c.*,(case when c.rel>=0.9 then 10000 else 0 end)+c.rel*(case when c.rel>=0.9 then 0.35+0.65*exp(-greatest(extract(epoch from (v_asof-c.sort_at)),0)/3600/greatest(v_half,0.5)*ln(2)) else exp(-greatest(extract(epoch from (v_asof-c.sort_at)),0)/3600/greatest(v_half,0.5)*ln(2)) end)*greatest(c.importance,0.1)*case when v_taste is null then 1 else power(2::numeric,least(greatest(v_scale*core.taste_hours(v_taste,b.category,coalesce(b.event_type,b.kind),case when b.kind='data' then 'fred' else core.source_key_of(b.kind,b.id) end),-48),48)/greatest(v_half,0.5)) end score,
      row_number() over(partition by c.dedupe_key order by case when c.link_kind in ('update','angle') then 1 else 0 end desc,c.rel desc,c.sort_at desc,c.id desc,case c.link_kind when 'update' then 1 when 'angle' then 2 when 'related' then 3 else 4 end,c.related_id nulls last) dedupe_n
    from candidates c join core.blurbs b on b.id=c.id cross join cfg where b.status='published' and b.published_at<=now() and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id) and (b.kind<>'link_out' or cfg.linkout_cards)
  ), page as (select e.* from eligible e where e.dedupe_n=1 and (round(e.score::numeric,8),e.id)<(v_key,v_id) order by round(e.score::numeric,8) desc,e.id desc limit v_limit+1), chosen as (select * from page order by round(score::numeric,8) desc,id desc limit v_limit)
  select coalesce(jsonb_agg((x.c-'my_reaction')||jsonb_build_object('follow_reason',r.reason)||case when r.link_kind is null then '{}'::jsonb else jsonb_build_object('story_link',jsonb_build_object('kind',r.link_kind,'related_id',r.related_id,'related_headline',r.related_headline)) end order by x.o),'[]'::jsonb),case when (select count(*) from page)>v_limit then (select round(score::numeric,8)::text||'|'||id::text||'|'||to_char(v_asof at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from chosen order by round(score::numeric,8) asc,id asc limit 1) end into v_items,v_next
  from jsonb_array_elements(core.cards_json((select array_agg(id order by round(score::numeric,8) desc,id desc) from chosen),null)) with ordinality x(c,o) join chosen r on r.id=(x.c->>'id')::uuid;
  return jsonb_build_object('items',coalesce(v_items,'[]'::jsonb),'next_cursor',v_next);
end; $$;
revoke all on function api.following_feed(text[],text[],text[],text,int) from public;
grant execute on function api.following_feed(text[],text[],text[],text,int) to anon,authenticated;


-- =============================================================================
-- H. DELETION (recreated in full; return shapes unchanged)
-- =============================================================================

-- returns {deleted_prefs, deleted_events}
create or replace function api.delete_my_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_p   int;
  v_e   int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;
  delete from core.ml_pages    where user_id = v_uid;                   -- ml_shadow rows cascade
  delete from core.user_events where user_id = v_uid;
  get diagnostics v_e = row_count;
  delete from core.user_prefs  where user_id = v_uid;
  get diagnostics v_p = row_count;
  return jsonb_build_object('deleted_prefs', v_p, 'deleted_events', v_e);
end;
$$;

revoke all on function api.delete_my_data() from public, anon;
grant execute on function api.delete_my_data() to authenticated;

-- returns {"deleted": true}
create or replace function api.delete_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_n   int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  -- own data first (also covered by the cascades; explicit so nothing is left if a FK changes)
  delete from core.ml_pages    where user_id = v_uid;
  delete from core.user_events where user_id = v_uid;
  delete from core.user_prefs  where user_id = v_uid;

  delete from auth.users where id = v_uid;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'account_not_found' using errcode = 'PT404';
  end if;
  return jsonb_build_object('deleted', true);
end;
$$;

revoke all on function api.delete_account() from public, anon;
grant execute on function api.delete_account() to authenticated;


-- =============================================================================
-- I. SERVICE-ROLE RPCs for the laptop job (ids only, no email; service_role only)
-- =============================================================================

-- I1. api.ml_purge(): run at the end of every ingest run and by ml_finish_run.
--   deletes ml_pages older than ml_log_retention_days (ml_shadow cascades), core.user_events older
--   than ml_purge_events_days (only when that is > 0), and ml_runs beyond the newest ml_keep_runs
--   per kind. Storage stop rule: database larger than ml_db_stop_mb sets both modes to 0.
--   returns {pages, events, runs, db_mb, ml_pages_rows, pages_24h, stopped}
create or replace function api.ml_purge()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ret   numeric;
  v_evd   numeric;
  v_keep  numeric;
  v_stop  numeric;
  v_p     int := 0;
  v_e     int := 0;
  v_r     int := 0;
  v_db    bigint;
  v_stopped boolean := false;
begin
  select coalesce(max(value) filter (where key = 'ml_log_retention_days'), 21),
         coalesce(max(value) filter (where key = 'ml_purge_events_days'), 0),
         coalesce(max(value) filter (where key = 'ml_keep_runs'), 3),
         coalesce(max(value) filter (where key = 'ml_db_stop_mb'), 400)
    into v_ret, v_evd, v_keep, v_stop
    from core.rank_params;

  delete from core.ml_pages where shown_at < now() - make_interval(secs => greatest(v_ret, 1) * 86400);
  get diagnostics v_p = row_count;

  if v_evd > 0 then
    delete from core.user_events where created_at < now() - make_interval(secs => greatest(v_evd, 31) * 86400);
    get diagnostics v_e = row_count;
  end if;

  delete from core.ml_runs r
   using (select run_id, row_number() over (partition by kind order by run_id desc) as n from core.ml_runs) k
   where k.run_id = r.run_id and k.n > greatest(v_keep, 1);
  get diagnostics v_r = row_count;

  v_db := pg_database_size(current_database());
  if v_db > v_stop * 1024 * 1024 then
    update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode') and value <> 0;
    v_stopped := true;
  end if;

  return jsonb_build_object('pages', v_p, 'events', v_e, 'runs', v_r,
                            'db_mb', round(v_db / 1048576.0, 1),
                            'ml_pages_rows', (select count(*) from core.ml_pages),
                            'pages_24h', (select count(*) from core.ml_pages where shown_at > now() - interval '24 hours'),
                            'stopped', v_stopped);
end;
$$;

-- I2. api.ml_export(p_what, p_since, p_next, p_limit): one page of 'events' | 'pages' | 'prefs'
--   created at or after p_since, keyset on (time, id), at most 5000 rows per call.
--   returns {what, rows: [...], next}; next is null on the last page, else pass it back as p_next.
create or replace function api.ml_export(p_what text, p_since timestamptz, p_next text default null, p_limit int default 5000)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim  int := least(greatest(coalesce(p_limit, 5000), 1), 5000);
  v_ts   timestamptz := '-infinity';
  v_id   text := '';
  v_rows jsonb;
  v_n    int;
  v_next text;
begin
  if p_what is null or p_what not in ('events', 'pages', 'prefs') then
    raise exception 'invalid_what' using errcode = 'PT422';
  end if;
  if p_since is null then raise exception 'invalid_since' using errcode = 'PT422'; end if;
  if p_next is not null then
    begin
      v_ts := split_part(p_next, '|', 1)::timestamptz;
      v_id := split_part(p_next, '|', 2);
      if v_id = '' then raise exception 'empty'; end if;
    exception when others then raise exception 'invalid_next' using errcode = 'PT422';
    end;
  end if;

  if p_what = 'events' then
    with page as (
      select e.id, e.user_id, e.blurb_id, e.kind, e.dwell_ms, e.created_at, e.page_id, e.slot, e.surface
        from core.user_events e
       where e.created_at >= p_since
         and (e.created_at, e.id) > (v_ts, case when v_id = '' then -1 else v_id::bigint end)
       order by e.created_at, e.id
       limit v_lim + 1
    )
    select coalesce(jsonb_agg(to_jsonb(p) - 'rn' order by p.created_at, p.id) filter (where p.rn <= v_lim), '[]'),
           count(*),
           max(to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p.id) filter (where p.rn = v_lim)
      into v_rows, v_n, v_next
      from (select page.*, row_number() over (order by page.created_at, page.id) as rn from page) p;
  elsif p_what = 'pages' then
    with page as (
      select m.page_id, m.user_id, m.surface, m.ranker, m.ml_mode, m.ml_run, m.holdout, m.page_no, m.gen,
             m.as_of, m.prefs_at, m.shown_at, m.card_ids, m.live_scores
        from core.ml_pages m
       where m.shown_at >= p_since
         and (m.shown_at, m.page_id) > (v_ts, case when v_id = '' then '00000000-0000-0000-0000-000000000000'::uuid else v_id::uuid end)
       order by m.shown_at, m.page_id
       limit v_lim + 1
    )
    select coalesce(jsonb_agg(to_jsonb(p) - 'rn' order by p.shown_at, p.page_id) filter (where p.rn <= v_lim), '[]'),
           count(*),
           max(to_char(p.shown_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p.page_id) filter (where p.rn = v_lim)
      into v_rows, v_n, v_next
      from (select page.*, row_number() over (order by page.shown_at, page.page_id) as rn from page) p;
  else
    with page as (
      select u.user_id, u.followed_categories, u.hidden_categories, u.hidden_sources, u.updated_at
        from core.user_prefs u
       where u.updated_at >= p_since
         and (u.updated_at, u.user_id) > (v_ts, case when v_id = '' then '00000000-0000-0000-0000-000000000000'::uuid else v_id::uuid end)
       order by u.updated_at, u.user_id
       limit v_lim + 1
    )
    select coalesce(jsonb_agg(to_jsonb(p) - 'rn' order by p.updated_at, p.user_id) filter (where p.rn <= v_lim), '[]'),
           count(*),
           max(to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p.user_id) filter (where p.rn = v_lim)
      into v_rows, v_n, v_next
      from (select page.*, row_number() over (order by page.updated_at, page.user_id) as rn from page) p;
  end if;

  return jsonb_build_object('what', p_what, 'rows', v_rows, 'next', case when v_n > v_lim then v_next end);
end;
$$;

-- I3. api.ml_begin_run(kind 'shadow' | 'appeal', model_version, params) -> run_id
--     ('live' runs are not accepted in this build)
create or replace function api.ml_begin_run(p_kind text, p_model_version text, p_params jsonb default '{}')
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_run bigint;
begin
  if p_kind is null or p_kind not in ('shadow', 'appeal') then raise exception 'invalid_kind' using errcode = 'PT422'; end if;
  if p_model_version is null or length(p_model_version) not between 1 and 200 then
    raise exception 'invalid_model_version' using errcode = 'PT422';
  end if;
  insert into core.ml_runs (kind, model_version, params)
  values (p_kind, p_model_version, coalesce(p_params, '{}'))
  returning run_id into v_run;
  return v_run;
end;
$$;

-- I4. api.ml_write_shadow(p_rows): upsert ml_shadow rows, at most 5000 per call.
--   row: {page_id, model_version, ml_rank[], utility[], p_like[], p_dislike[], p_detail[], completion[],
--         conf, why[], ml_top_ids[]}; every per-card array must have the page's card count.
--   Rows for missing pages (purged or deleted reader) or with wrong lengths are skipped.
--   returns {written, skipped}
create or replace function api.ml_write_shadow(p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_total int; v_w int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows' using errcode = 'PT422'; end if;
  v_total := jsonb_array_length(p_rows);
  if v_total > 5000 then raise exception 'too_many_rows' using errcode = 'PT422'; end if;

  with src as (
    select (r ->> 'page_id')::uuid as page_id, r ->> 'model_version' as model_version,
           array(select x::smallint from jsonb_array_elements_text(r -> 'ml_rank') x)    as ml_rank,
           array(select x::real     from jsonb_array_elements_text(r -> 'utility') x)    as utility,
           array(select x::real     from jsonb_array_elements_text(r -> 'p_like') x)     as p_like,
           array(select x::real     from jsonb_array_elements_text(r -> 'p_dislike') x)  as p_dislike,
           array(select x::real     from jsonb_array_elements_text(r -> 'p_detail') x)   as p_detail,
           array(select x::real     from jsonb_array_elements_text(r -> 'completion') x) as completion,
           (r ->> 'conf')::real as conf,
           array(select x::smallint from jsonb_array_elements_text(r -> 'why') x)        as why,
           array(select x::uuid     from jsonb_array_elements_text(r -> 'ml_top_ids') x) as ml_top_ids
      from jsonb_array_elements(p_rows) r
  ), ok as (
    select s.* from src s join core.ml_pages m on m.page_id = s.page_id
     where s.model_version is not null and length(s.model_version) between 1 and 200 and s.conf is not null
       and cardinality(s.ml_rank)    = cardinality(m.card_ids)
       and cardinality(s.utility)    = cardinality(m.card_ids)
       and cardinality(s.p_like)     = cardinality(m.card_ids)
       and cardinality(s.p_dislike)  = cardinality(m.card_ids)
       and cardinality(s.p_detail)   = cardinality(m.card_ids)
       and cardinality(s.completion) = cardinality(m.card_ids)
       and cardinality(s.why)        = cardinality(m.card_ids)
       and cardinality(s.ml_top_ids) <= 60
  )
  insert into core.ml_shadow (page_id, model_version, ml_rank, utility, p_like, p_dislike, p_detail, completion, conf, why, ml_top_ids)
  select page_id, model_version, ml_rank, utility, p_like, p_dislike, p_detail, completion, conf, why, ml_top_ids from ok
  on conflict (page_id, model_version) do update
    set ml_rank = excluded.ml_rank, utility = excluded.utility, p_like = excluded.p_like,
        p_dislike = excluded.p_dislike, p_detail = excluded.p_detail, completion = excluded.completion,
        conf = excluded.conf, why = excluded.why, ml_top_ids = excluded.ml_top_ids, scored_at = now();
  get diagnostics v_w = row_count;
  return jsonb_build_object('written', v_w, 'skipped', v_total - v_w);
end;
$$;

-- I5. api.ml_write_appeal(p_run, p_rows): rows {blurb_id, appeal, za (-2..2), n_readers} for a
--     running 'appeal' run, at most 5000 per call; cards that no longer exist are skipped.
--     returns {written, skipped}
create or replace function api.ml_write_appeal(p_run bigint, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_total int; v_w int;
begin
  if not exists (select 1 from core.ml_runs where run_id = p_run and kind = 'appeal' and status = 'running') then
    raise exception 'unknown_run' using errcode = 'PT422';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows' using errcode = 'PT422'; end if;
  v_total := jsonb_array_length(p_rows);
  if v_total > 5000 then raise exception 'too_many_rows' using errcode = 'PT422'; end if;

  insert into core.ml_appeal (run_id, blurb_id, appeal, za, n_readers)
  select p_run, x.blurb_id, x.appeal, x.za, x.n_readers
    from jsonb_to_recordset(p_rows) as x(blurb_id uuid, appeal real, za real, n_readers int)
    join core.blurbs b on b.id = x.blurb_id
   where x.appeal is not null and x.za between -2 and 2 and x.n_readers >= 0
  on conflict (run_id, blurb_id) do update
    set appeal = excluded.appeal, za = excluded.za, n_readers = excluded.n_readers;
  get diagnostics v_w = row_count;
  return jsonb_build_object('written', v_w, 'skipped', v_total - v_w);
end;
$$;

-- I6. api.ml_finish_run(p_run, 'ok' | 'failed', n_users, n_rows): closes the run, then api.ml_purge().
--     returns {run_id, status, purge}
create or replace function api.ml_finish_run(p_run bigint, p_status text, p_n_users int default null, p_n_rows int default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('ok', 'failed') then raise exception 'invalid_status' using errcode = 'PT422'; end if;
  update core.ml_runs set status = p_status, finished_at = now(), n_users = p_n_users, n_rows = p_n_rows
   where run_id = p_run and status = 'running';
  if not found then raise exception 'unknown_run' using errcode = 'PT422'; end if;
  return jsonb_build_object('run_id', p_run, 'status', p_status, 'purge', api.ml_purge());
end;
$$;

revoke all on function api.ml_purge()                                  from public, anon, authenticated;
revoke all on function api.ml_export(text, timestamptz, text, int)     from public, anon, authenticated;
revoke all on function api.ml_begin_run(text, text, jsonb)             from public, anon, authenticated;
revoke all on function api.ml_write_shadow(jsonb)                      from public, anon, authenticated;
revoke all on function api.ml_write_appeal(bigint, jsonb)              from public, anon, authenticated;
revoke all on function api.ml_finish_run(bigint, text, int, int)       from public, anon, authenticated;
grant execute on function api.ml_purge()                               to service_role;
grant execute on function api.ml_export(text, timestamptz, text, int)  to service_role;
grant execute on function api.ml_begin_run(text, text, jsonb)          to service_role;
grant execute on function api.ml_write_shadow(jsonb)                   to service_role;
grant execute on function api.ml_write_appeal(bigint, jsonb)           to service_role;
grant execute on function api.ml_finish_run(bigint, text, int, int)    to service_role;

-- HOW TO CHECK: paste this file twice (expected "Success. No rows returned" both times), then run
-- supabase/tests/ml_shadow_check.sql and every older check (they must still pass).
