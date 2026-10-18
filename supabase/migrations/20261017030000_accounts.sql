-- =============================================================================
-- Element: accounts and the personal "For you" feed
--
-- Sign-in is Supabase Auth (email + password). This file adds:
--   A  core.user_prefs, core.user_events, row-level security, privileges
--   B  tunable values (core.rank_params rows)
--   C  private helper core.cards_json (same card JSON as api.feed)
--   D  api RPCs for signed-in users only:
--        api.get_prefs()                      -> UserPrefs
--        api.set_prefs(p_followed, p_hidden)  -> UserPrefs
--        api.track(p_blurb, p_kind)           -> {status}
--        api.feed_for_you(p_cursor, p_limit)  -> FeedPage (cards carry my_reaction)
--        api.delete_my_data()                 -> {deleted_prefs, deleted_events}
--      Every one is SECURITY DEFINER, reads auth.uid() and raises when it is null.
--      EXECUTE is granted to `authenticated` only (never anon, never public).
--   E  how to check it
--
-- Guests are unchanged: api.feed, api.numbers_to_know, api.app_config and
-- api.categories are not touched here.
--
-- Idempotent: every statement can be run again (if not exists / create or replace /
-- drop policy if exists / on conflict). Run after 20261017000000_init.sql.
-- Requires the Supabase `auth` schema (auth.users, auth.uid()).
-- =============================================================================


-- =============================================================================
-- A. TABLES, ROW-LEVEL SECURITY, PRIVILEGES
-- =============================================================================

-- One row per signed-in user, created on the first api.set_prefs call.
create table if not exists core.user_prefs (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  followed_categories text[]      not null default '{}',
  hidden_categories   text[]      not null default '{}',
  onboarded           boolean     not null default false,
  updated_at          timestamptz not null default now()
);

-- What a user did with a card. No PII beyond user_id (no IP, device or text).
-- like/dislike: at most one per user and card (api.track replaces the other one).
create table if not exists core.user_events (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  blurb_id   uuid        not null references core.blurbs (id) on delete cascade,
  kind       text        not null check (kind in ('view', 'open_source', 'like', 'dislike')),
  created_at timestamptz not null default now()
);

create index if not exists user_events_user_time_idx
  on core.user_events (user_id, created_at desc);
create index if not exists user_events_user_blurb_idx
  on core.user_events (user_id, blurb_id, kind);

alter table core.user_prefs  enable row level security;
alter table core.user_events enable row level security;

-- Defence in depth. The app never reads these tables directly (the core schema is
-- not exposed and has no grants); if it ever did, a user would only see own rows.
drop policy if exists user_prefs_own  on core.user_prefs;
drop policy if exists user_events_own on core.user_events;
create policy user_prefs_own on core.user_prefs
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy user_events_own on core.user_events
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on core.user_prefs, core.user_events from public, anon, authenticated;
revoke all on all sequences in schema core from public, anon, authenticated;


-- =============================================================================
-- B. TUNABLE VALUES (core.rank_params; change with UPDATE, no code change)
--   boost_followed_hours      +2 h for a followed category (ranking design)
--   affinity_hours_per_event  +1 h per like, -1 h per dislike, per category
--   affinity_cap_hours        learned affinity clamped to +-4 h per category
--   affinity_days             likes/dislikes older than this are ignored
--   for_you_window_days       only cards with sort_at in this window are scored
--   view_dedupe_minutes       a 2nd view/open_source of the same card inside this is ignored
--   track_max_per_hour        events per user per hour; more are ignored
-- =============================================================================

insert into core.rank_params (key, value) values
  ('boost_followed_hours',     2),
  ('affinity_hours_per_event', 1),
  ('affinity_cap_hours',       4),
  ('affinity_days',            30),
  ('for_you_window_days',      30),
  ('view_dedupe_minutes',      60),
  ('track_max_per_hour',       600)
on conflict (key) do nothing;


-- =============================================================================
-- C. PRIVATE HELPER: card JSON for a list of ids, in that order
-- Same object as api.feed builds (BlurbCard), plus my_reaction for p_user.
-- Keep in step with api.feed if the card shape ever changes.
-- =============================================================================

create or replace function core.cards_json(p_ids uuid[], p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', b.id, 'kind', b.kind, 'headline', b.headline, 'body', b.body,
      'category', b.category, 'event_type', b.event_type,
      'tickers', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'symbol', t.value ->> 'symbol',
                   'name', t.value ->> 'name',
                   'exchange', t.value -> 'exchange',
                   'quote', null)                       -- prices are never shown
                 order by t.ordinality)
            from jsonb_array_elements(b.tickers) with ordinality as t(value, ordinality)), '[]'::jsonb),
      'macro', b.macro,
      'sources', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', s.name, 'kind', s.kind, 'doc_label', s.doc_label, 'url', s.url,
                   'published_at', s.published_at, 'license_class', s.license_class,
                   'attribution', s.attribution, 'is_primary', s.is_primary)
                 order by s.is_primary desc, s.position, s.id)
            from core.blurb_sources s where s.blurb_id = b.id), '[]'::jsonb),
      'source_count', b.source_count,
      'as_of', b.as_of, 'published_at', b.published_at, 'sort_at', b.sort_at,
      'updated_at', b.updated_at, 'revision', b.revision,
      'freshness', jsonb_build_object('delayed_hours', b.delayed_hours),
      'ai', jsonb_build_object('generated', b.ai_generated, 'label', b.ai_label),
      'attribution', b.attribution,
      'image', null,
      'is_saved', false,
      'share_path', '/b/' || b.id,
      'importance', b.importance,
      'my_reaction', (select e.kind from core.user_events e
                       where e.user_id = p_user and e.blurb_id = b.id
                         and e.kind in ('like', 'dislike')
                       order by e.created_at desc limit 1)
    ) order by u.ord), '[]'::jsonb)
  from unnest(p_ids) with ordinality as u(id, ord)
  join core.blurbs b on b.id = u.id;
$$;

revoke all on function core.cards_json(uuid[], uuid) from public, anon, authenticated;


-- =============================================================================
-- D. API RPCs (signed-in users only)
-- Errors (PostgREST turns SQLSTATE PTnnn into HTTP status nnn):
--   PT401 not_authenticated   no user in the JWT
--   PT422 unknown_category / category_followed_and_hidden / invalid_kind /
--         unknown_card / invalid_cursor
-- =============================================================================

-- ---------- api.get_prefs ------------------------------------------------------
-- returns {followed_categories, hidden_categories, onboarded, updated_at, affinity}
--   affinity = {"<slug>": hours} learned from likes/dislikes (only non-zero categories)
-- A user who never saved prefs gets the defaults (onboarded false, updated_at null).
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
  v_per  numeric; v_cap numeric; v_days numeric;
  v_aff  jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  select value into v_per  from core.rank_params where key = 'affinity_hours_per_event';
  select value into v_cap  from core.rank_params where key = 'affinity_cap_hours';
  select value into v_days from core.rank_params where key = 'affinity_days';

  select coalesce(jsonb_object_agg(a.category, a.hours), '{}'::jsonb) into v_aff
    from (
      select b.category,
             greatest(least(sum(case e.kind when 'like' then coalesce(v_per, 1) else -coalesce(v_per, 1) end),
                            coalesce(v_cap, 4)), -coalesce(v_cap, 4)) as hours
        from core.user_events e
        join core.blurbs b on b.id = e.blurb_id
       where e.user_id = v_uid
         and e.kind in ('like', 'dislike')
         and e.created_at > now() - make_interval(days => coalesce(v_days, 30)::int)
       group by b.category
    ) a
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

-- ---------- api.set_prefs ------------------------------------------------------
-- p_followed / p_hidden: category slugs. null = keep the saved list, '{}' = clear it.
-- Every slug must exist in core.categories; a slug cannot be both followed and hidden.
-- Saving marks the user as onboarded. Returns the same object as api.get_prefs.
create or replace function api.set_prefs(p_followed text[] default null, p_hidden text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_old  core.user_prefs%rowtype;
  v_fol  text[];
  v_hid  text[];
  v_bad  text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  select * into v_old from core.user_prefs where user_id = v_uid;

  -- distinct, sorted, nulls dropped
  v_fol := case when p_followed is null then coalesce(v_old.followed_categories, '{}')
                else coalesce((select array_agg(distinct x order by x) from unnest(p_followed) x where x is not null), '{}') end;
  v_hid := case when p_hidden is null then coalesce(v_old.hidden_categories, '{}')
                else coalesce((select array_agg(distinct x order by x) from unnest(p_hidden) x where x is not null), '{}') end;

  select x into v_bad from unnest(v_fol || v_hid) x
   where not exists (select 1 from core.categories c where c.slug = x) limit 1;
  if v_bad is not null then
    raise exception 'unknown_category: %', left(v_bad, 50) using errcode = 'PT422';
  end if;

  select x into v_bad from unnest(v_fol) x where x = any (v_hid) limit 1;
  if v_bad is not null then
    raise exception 'category_followed_and_hidden: %', v_bad using errcode = 'PT422';
  end if;

  insert into core.user_prefs (user_id, followed_categories, hidden_categories, onboarded, updated_at)
  values (v_uid, v_fol, v_hid, true, now())
  on conflict (user_id) do update
     set followed_categories = excluded.followed_categories,
         hidden_categories   = excluded.hidden_categories,
         onboarded           = true,
         updated_at          = now();

  return api.get_prefs();
end;
$$;

-- ---------- api.track ----------------------------------------------------------
-- p_kind: 'view' | 'open_source' | 'like' | 'dislike' | 'clear'
--   view, open_source  stored; ignored if the same card+kind was stored in the last
--                      view_dedupe_minutes (60)
--   like, dislike      one reaction per card: replaces the opposite one; a repeat is ignored
--   clear              removes the user's like/dislike on the card (nothing stored)
-- More than track_max_per_hour (600) events per user per hour are ignored.
-- returns {status: 'recorded' | 'ignored' | 'cleared'}
create or replace function api.track(p_blurb uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_dedupe numeric;
  v_max    numeric;
  v_n      int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;
  if p_kind is null or p_kind not in ('view', 'open_source', 'like', 'dislike', 'clear') then
    raise exception 'invalid_kind' using errcode = 'PT422';
  end if;
  if p_blurb is null or not exists (select 1 from core.blurbs where id = p_blurb and status = 'published') then
    raise exception 'unknown_card' using errcode = 'PT422';
  end if;

  if p_kind = 'clear' then
    delete from core.user_events
     where user_id = v_uid and blurb_id = p_blurb and kind in ('like', 'dislike');
    return jsonb_build_object('status', 'cleared');
  end if;

  select value into v_max from core.rank_params where key = 'track_max_per_hour';
  select count(*) into v_n from core.user_events
   where user_id = v_uid and created_at > now() - interval '1 hour';
  if v_n >= coalesce(v_max, 600) then
    return jsonb_build_object('status', 'ignored');
  end if;

  if p_kind in ('view', 'open_source') then
    select value into v_dedupe from core.rank_params where key = 'view_dedupe_minutes';
    if exists (select 1 from core.user_events
                where user_id = v_uid and blurb_id = p_blurb and kind = p_kind
                  and created_at > now() - make_interval(mins => coalesce(v_dedupe, 60)::int)) then
      return jsonb_build_object('status', 'ignored');
    end if;
  else
    if exists (select 1 from core.user_events
                where user_id = v_uid and blurb_id = p_blurb and kind = p_kind) then
      return jsonb_build_object('status', 'ignored');
    end if;
    delete from core.user_events
     where user_id = v_uid and blurb_id = p_blurb and kind in ('like', 'dislike');
  end if;

  insert into core.user_events (user_id, blurb_id, kind) values (v_uid, p_blurb, p_kind);
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- ---------- api.feed_for_you ---------------------------------------------------
-- p_cursor  opaque '<personal_score>|<uuid>' from next_cursor; null = first page
-- p_limit   default 20, clamped to 10..30
-- returns   { "items": ForYouCard[], "next_cursor": text | null }
--
-- personal_score (hours) = rank_score
--                        + boost_followed_hours (2)   if the card's category is followed
--                        + learned affinity           sum over the user's likes (+1 h) and
--                                                     dislikes (-1 h) in the card's category,
--                                                     last affinity_days (30), clamped to +-4 h
-- Excluded: hidden categories, cards the user disliked (at any time), cards older than
-- for_you_window_days (30), unpublished cards.
-- The score is recomputed the same way on every call and paged on (personal_score, id),
-- so with no new likes the pages never repeat or skip. A like or follow made mid-scroll
-- changes scores for later pages: a card may then appear twice or be skipped once in that
-- scroll; a pull-to-refresh fixes it. Accepted for v1 (the app can also drop repeated ids).
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
  v_follow  numeric; v_per numeric; v_cap numeric; v_days numeric; v_window numeric;
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
  select value into v_per    from core.rank_params where key = 'affinity_hours_per_event';
  select value into v_cap    from core.rank_params where key = 'affinity_cap_hours';
  select value into v_days   from core.rank_params where key = 'affinity_days';
  select value into v_window from core.rank_params where key = 'for_you_window_days';
  v_follow := coalesce(v_follow, 2); v_per := coalesce(v_per, 1); v_cap := coalesce(v_cap, 4);
  v_days := coalesce(v_days, 30);    v_window := coalesce(v_window, 30);

  with aff as (
    select b.category,
           greatest(least(sum(case e.kind when 'like' then v_per else -v_per end), v_cap), -v_cap) as hours
      from core.user_events e
      join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid
       and e.kind in ('like', 'dislike')
       and e.created_at > now() - make_interval(days => v_days::int)
     group by b.category
  ), scored as (
    select b.id,
           b.rank_score
             + case when b.category = any (v_fol) then v_follow else 0 end
             + coalesce(a.hours, 0) as ps
      from core.blurbs b
      left join aff a on a.category = b.category
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
    v_next := v_keys[v_limit] || '|' || v_ids[v_limit];   -- cursor = last row returned
    v_ids  := v_ids[1:v_limit];
  end if;

  return jsonb_build_object('items', core.cards_json(v_ids, v_uid), 'next_cursor', v_next);
end;
$$;

-- ---------- api.delete_my_data -------------------------------------------------
-- Removes the caller's prefs and events. The login itself is deleted in the Supabase
-- dashboard (Authentication -> Users); that also cascades to both tables.
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
  delete from core.user_events where user_id = v_uid;
  get diagnostics v_e = row_count;
  delete from core.user_prefs  where user_id = v_uid;
  get diagnostics v_p = row_count;
  return jsonb_build_object('deleted_prefs', v_p, 'deleted_events', v_e);
end;
$$;

-- ---------- privileges: authenticated only -------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default and Supabase may grant to anon:
-- take both away explicitly.
revoke all on function api.get_prefs()                   from public, anon;
revoke all on function api.set_prefs(text[], text[])     from public, anon;
revoke all on function api.track(uuid, text)             from public, anon;
revoke all on function api.feed_for_you(text, int)       from public, anon;
revoke all on function api.delete_my_data()              from public, anon;
grant execute on function api.get_prefs()                to authenticated;
grant execute on function api.set_prefs(text[], text[])  to authenticated;
grant execute on function api.track(uuid, text)          to authenticated;
grant execute on function api.feed_for_you(text, int)    to authenticated;
grant execute on function api.delete_my_data()           to authenticated;


-- =============================================================================
-- E. HOW TO CHECK
-- 1. Paste this whole file in the SQL editor and run it. Expected: "Success. No rows returned".
--    Running it a second time gives the same result.
-- 2. Create two test users in Authentication -> Users -> Add user (tick "Auto Confirm User"):
--    element-test-a@example.com and element-test-b@example.com (any password).
-- 3. Run supabase/tests/accounts_check.sql. Expected last line:
--    ERROR: ALL ACCOUNT CHECKS PASSED (test data rolled back on purpose)
-- 4. Delete the two test users afterwards (their prefs/events go with them).
-- =============================================================================
