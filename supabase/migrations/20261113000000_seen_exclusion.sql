-- =============================================================================
-- Element: seen-card exclusion for Trending, Latest and For you (signed-in readers) (2026-11-13)
--
-- A signed-in reader is not shown a card they have already seen, on any of the three tabs. "Seen" is the
-- existing 'view' event (api.track kind 'view': the card became the active card on screen), shared across
-- the three tabs because core.user_events is per reader, not per tab. No new table, no new event kind,
-- nothing new is stored.
--
-- Scalability first (Drew): the work per page is bounded and flat, however long the reader has been here.
--   * only the reader's latest seen_exclude_max (800) distinct viewed cards inside the last
--     seen_exclude_days (14) days count. Older ones age out: a card seen more than 14 days ago, or beyond the
--     800 most recent, can come back. That is the one trade-off (a rare repeat after the window).
--   * exact inside the window (no filter that could hide an unseen card). The window is read through the
--     partial index user_events_view_idx (user_id, created_at desc) where kind = 'view' with a LIMIT, so the
--     cost does not grow with the reader's event history.
--   * any error or statement timeout while reading the set serves the feed without exclusion (never fails).
--   * 14 days is under the 31-day floor of ml_purge_events_days, so the (optional) event purge never removes
--     rows this feature needs, and this feature adds no storage.
--
-- Exceptions (the card may come back): the reader liked it (their like is still on it), or the story was
-- updated after the reader last saw it (core.blurbs.updated_at, set by a revision, later than the last view).
-- A disliked card is gone as before (For you already did this).
--
-- Paging: the exclusion is a filter placed after scoring, next to the keyset test, so every remaining card
-- keeps its sort key (same-topic step, boosts, scores unchanged) and the cursor stays valid: no repeats, no
-- reshuffles. All three tabs use the views up to the moment of the request (the set is not frozen into the
-- cursor: it only removes cards, it never moves one).
--
-- Never an empty feed: when the unseen cards run out (next_cursor would be null) and the page is shorter than
-- a page, seen cards are appended newest first, and the response carries seen_from (index of the first
-- re-shown card; 0 on later pages) so the app can say "all caught up". The tail has its own cursor
-- 'S|<sort_at>|<id>'; it ends when the (capped) seen set is used up.
--
-- Guests: api.feed output is byte-for-byte what it was (v_uid is null: empty seen set, no tail).
-- Ranking v3 / ml modes: unchanged by this file. The filter sits in v5, v6 and v7, so it applies in every
-- foryou_ml_mode, to the v3 arm and to the holdout alike. seen_exclude_mode = 0 restores the old behaviour.
--
--   B  settings (core.rank_params seen_*, on conflict do nothing), partial index
--   C  core.seen_ids(user, as_of), core.seen_tail(...), core.seen_fill(...)  (private)
--   F  the cores: feed_top, feed_for_you_v5 / v6 / v7 (bodies copied, filter lines added)
--   G  api.feed, api.feed_for_you (bodies copied, tail cursor and seen_fill added)
--
-- Idempotent. Run after 20261112000000_ranking_v3.sql. Check: supabase/tests/seen_exclusion_check.sql
-- =============================================================================


-- =============================================================================
-- B. SETTINGS AND INDEX
-- =============================================================================

insert into core.rank_params (key, value) values
  ('seen_exclude_mode',  1),    -- 1 = seen cards are left out (signed-in readers); 0 = off (the old behaviour)
  ('seen_exclude_days', 14),    -- only views in the last N days count (must stay below ml_purge_events_days' floor of 31)
  ('seen_exclude_max', 800)     -- at most the N most recent distinct viewed cards count (flat cost per page)
on conflict (key) do nothing;

alter table core.rank_params drop constraint if exists rank_params_seen_range;
alter table core.rank_params add constraint rank_params_seen_range
  check ((key not in ('seen_exclude_days', 'seen_exclude_max') or value > 0)
     and (key <> 'seen_exclude_mode' or value in (0, 1)));

create index if not exists user_events_view_idx
  on core.user_events (user_id, created_at desc) where kind = 'view';


-- =============================================================================
-- C. HELPERS (private: no grant to anon or authenticated)
-- =============================================================================

-- The reader's seen set: distinct viewed cards in the window, newest first, minus liked cards and cards
-- updated since the last view. Always returns an array (empty = nothing excluded).
create or replace function core.seen_ids(p_user uuid, p_asof timestamptz)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mode numeric; v_days numeric; v_max numeric;
  v_ids  uuid[];
begin
  if p_user is null then return '{}'; end if;
  select coalesce(max(value) filter (where key = 'seen_exclude_mode'), 0),
         greatest(coalesce(max(value) filter (where key = 'seen_exclude_days'), 14), 1),
         greatest(coalesce(max(value) filter (where key = 'seen_exclude_max'), 800), 1)
    into v_mode, v_days, v_max
    from core.rank_params;
  if v_mode = 0 then return '{}'; end if;

  select coalesce(array_agg(s.blurb_id order by s.last_at desc), '{}') into v_ids
    from (
      select x.blurb_id, x.last_at
        from (
          select r.blurb_id, max(r.created_at) as last_at     -- the latest view rows only (index range scan + limit)
            from (select e.blurb_id, e.created_at
                    from core.user_events e
                   where e.user_id = p_user and e.kind = 'view'
                     and e.created_at <= p_asof
                     and e.created_at > p_asof - make_interval(secs => v_days * 86400)
                   order by e.created_at desc
                   limit v_max * 2) r
           group by r.blurb_id
        ) x
        join core.blurbs b on b.id = x.blurb_id
       where (b.updated_at is null or b.updated_at <= x.last_at)             -- updated since: may come back
         and not exists (select 1 from core.user_events l                    -- liked: may come back
                          where l.user_id = p_user and l.blurb_id = x.blurb_id and l.kind = 'like')
       order by x.last_at desc
       limit v_max
    ) s;
  return v_ids;
exception
  when query_canceled then return '{}';      -- statement timeout: serve the feed without exclusion
  when others then return '{}';
end;
$$;
revoke all on function core.seen_ids(uuid, timestamptz) from public, anon, authenticated;

-- One page of the seen tail: seen cards, newest first (sort_at desc, id desc), same visibility rules as the feed.
-- p_cursor null = from the top; otherwise 'S|<sort_at>|<id>'.  Returns {items, next_cursor, seen_from: 0}.
create or replace function core.seen_tail(p_user uuid, p_category text, p_cursor text, p_limit int, p_for_you boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t     timestamptz := 'infinity';
  v_id    uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_lim   int := least(greatest(coalesce(p_limit, 20), 1), 30);
  v_hid   text[];
  v_hsrc  text[];
  v_seen  uuid[];
  v_ids   uuid[];
  v_keys  text[];
  v_next  text;
  v_items jsonb;
begin
  if p_cursor is not null then
    begin
      v_t  := split_part(p_cursor, '|', 2)::timestamptz;
      v_id := split_part(p_cursor, '|', 3)::uuid;
    exception when others then
      raise exception 'invalid_cursor' using errcode = 'PT422';
    end;
  end if;
  select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = p_user;
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');
  v_seen := core.seen_ids(p_user, clock_timestamp());

  select array_agg(s.id order by s.sort_at desc, s.id desc),
         array_agg(to_char(s.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') order by s.sort_at desc, s.id desc)
    into v_ids, v_keys
    from (
      select b.id, b.sort_at
        from core.blurbs b
       where b.id = any (v_seen)
         and b.status = 'published'
         and (p_category is null or b.category = p_category)
         and not (b.category = any (v_hid))
         and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
         and not exists (select 1 from core.user_events d
                          where d.user_id = p_user and d.blurb_id = b.id and d.kind = 'dislike')
         and (b.sort_at, b.id) < (v_t, v_id)
       order by b.sort_at desc, b.id desc
       limit v_lim + 1
    ) s;
  v_ids := coalesce(v_ids, '{}');
  if cardinality(v_ids) > v_lim then
    v_next := 'S|' || v_keys[v_lim] || '|' || v_ids[v_lim];
    v_ids  := v_ids[1:v_lim];
  end if;

  if p_for_you then
    v_items := core.cards_json(v_ids, p_user);
  else
    select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb)
      into v_items
      from jsonb_array_elements(core.cards_json(v_ids, null)) with ordinality as x(c, o);
  end if;
  return jsonb_build_object('items', coalesce(v_items, '[]'::jsonb), 'next_cursor', v_next, 'seen_from', 0);
end;
$$;
revoke all on function core.seen_tail(uuid, text, text, int, boolean) from public, anon, authenticated;

-- Fills a short last page with the seen tail. Only when the unseen stream is over (no next_cursor) and the
-- page is shorter than a page. Guests, a full page, a page with a next_cursor and "nothing seen" come back unchanged.
create or replace function core.seen_fill(p_r jsonb, p_user uuid, p_category text, p_limit int, p_for_you boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_n int;
  v_t jsonb;
begin
  if p_user is null or p_r is null or p_r ->> 'next_cursor' is not null then return p_r; end if;
  v_n := jsonb_array_length(coalesce(p_r -> 'items', '[]'::jsonb));
  if v_n >= p_limit then return p_r; end if;
  v_t := core.seen_tail(p_user, p_category, null, p_limit - v_n, p_for_you);
  if jsonb_array_length(v_t -> 'items') = 0 then return p_r; end if;
  return p_r || jsonb_build_object('items', coalesce(p_r -> 'items', '[]'::jsonb) || (v_t -> 'items'),
                                   'next_cursor', v_t -> 'next_cursor', 'seen_from', v_n);
end;
$$;
revoke all on function core.seen_fill(jsonb, uuid, text, int, boolean) from public, anon, authenticated;


-- =============================================================================
-- F, G. THE FEED FUNCTIONS (copied bodies; the added lines mention v_sx, seen_tail or seen_fill)
-- =============================================================================


-- F1. core.feed_top (Trending and Latest): ml_shadow section E1 plus the seen filter (lines that mention v_sx)
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
  v_sx     uuid[] := '{}';
begin
  if v_mode not in ('top', 'latest') then
    raise exception 'invalid_mode' using errcode = 'PT422';
  end if;

  if v_uid is not null then
    select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = v_uid;
  end if;
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');
  v_sx := core.seen_ids(v_uid, clock_timestamp());     -- seen-card exclusion (signed in only; guests get '{}')

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
         and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
         and not (b.id = any (v_sx));
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
           and not (b.id = any (v_sx))
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
           and not (b.id = any (v_sx))
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

-- F2. core.feed_for_you_v5: ml_shadow section E2 plus the seen filter
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
  v_sx    uuid[] := '{}';
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
  v_sx := core.seen_ids(v_uid, clock_timestamp());     -- seen-card exclusion (live: keys do not depend on it)

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
       and not (s.id = any (v_sx))
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

-- F3. core.feed_for_you_v6: ranking v2 section F plus the seen filter
create or replace function core.feed_for_you_v6(p_cursor text, p_limit int, p_model bigint, p_seed bigint)
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
  v_sx    uuid[] := '{}';
  v_hid     text[];
  v_hsrc    text[];
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

  select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = v_uid;
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');
  v_sx := core.seen_ids(v_uid, clock_timestamp());

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

  select array_agg(s.o_id order by s.o_ps desc, s.o_id desc),
         array_agg(s.o_ps::text order by s.o_ps desc, s.o_id desc)
    into v_ids, v_keys
    from (
      select x.o_id, x.o_ps from core.v2_scores(v_uid, v_asof, p_model, p_seed) x
       where (x.o_ps, x.o_id) < (v_key, v_id)
         and not (x.o_id = any (v_sx))
       order by x.o_ps desc, x.o_id desc
       limit v_fetch + 1
    ) s;

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

revoke all on function core.feed_for_you_v6(text, int, bigint, bigint) from public, anon, authenticated;

-- F4. core.feed_for_you_v7: ranking v3 section F plus the seen filter
create or replace function core.feed_for_you_v7(p_cursor text, p_limit int)
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
  v_sx    uuid[] := '{}';
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
  v_sx := core.seen_ids(v_uid, clock_timestamp());

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
  ), pg as (
    select s.o_id, s.o_ps from s
     where (s.o_ps, s.o_id) < (v_key, v_id)
       and not (s.o_id = any (v_sx))
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

revoke all on function core.feed_for_you_v7(text, int) from public, anon, authenticated;

-- =============================================================================
-- G. api.feed and api.feed_for_you: previous bodies plus the tail cursor and core.seen_fill at every return
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
  v_lim    int := least(greatest(coalesce(p_limit, 20), 10), 30);
begin
  if v_uid is not null and p_cursor like 'S|%' then                     -- seen-cards tail (all caught up)
    if coalesce(p_mode, 'top') not in ('top', 'latest') then raise exception 'invalid_mode' using errcode = 'PT422'; end if;
    return core.seen_tail(v_uid, p_category, p_cursor, v_lim, false);
  end if;
  v_r := core.feed_top(p_mode, p_cursor, p_limit, p_category);
  if coalesce(p_mode, 'top') <> 'top' then return core.seen_fill(v_r, v_uid, p_category, v_lim, false); end if;           -- Latest: unchanged

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
    return core.seen_fill(v_r, v_uid, p_category, v_lim, false);
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
  return core.seen_fill(v_r, v_uid, p_category, v_lim, false);
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

-- HOW TO CHECK: paste this file twice (expected "Success. No rows returned" both times), then run
-- supabase/tests/seen_exclusion_check.sql and every older check.
