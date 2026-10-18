-- =============================================================================
-- Element: Trending, For you v2 and hidden topics (2026-10-17, D-40, D-41)
--
--   A  tunable values (core.rank_params)
--   B  core.blurbs.word_count (for length-aware "long look")
--   C  Trending: core.trend_generations + core.trend_boosts (aggregate counts only),
--      core.refresh_trending(), api.refresh_trending() (service role only)
--   D  core.user_affinity v2: signals fade over time (half-life), long look depends on card
--      length, a look over 2 minutes counts as "walked away" (neutral)
--   E  api.feed: 'top' (the app calls it Trending) = rank_score + trend boost; 'latest' stays
--      newest first; signed-in callers never see their hidden topics; the card JSON now comes
--      from core.cards_json (one card shape for every feed)
--   F  api.feed_for_you v2: Trending base, follows, learned affinity, exploration, seen
--      penalties, a gentle per-topic spread, no more than 2 in a row from one topic, and a
--      frozen "as of" time in the cursor so pages never repeat while you scroll
--   G  api.my_categories(): topics with followed / hidden flags (signed-in users)
--   H  hide sources: core.user_prefs.hidden_sources, core.source_keys, api.sources() (anyone),
--      api.set_prefs(p_followed, p_hidden, p_hidden_sources), api.get_prefs adds hidden_sources;
--      api.feed (signed in) and api.feed_for_you leave out cards whose primary source is hidden
--
-- Privacy: Trending only stores one number per card (a boost built from counts of distinct
-- users); no user id, text or device data leaves core.user_events.
-- Requires 20261017030000_accounts, 20261017050000_detail_revise, 20261017060000_signals.
-- Idempotent: safe to run more than once.
-- =============================================================================


-- =============================================================================
-- A. TUNABLE VALUES (change with UPDATE core.rank_params; no code change)
-- Trending (all users, last trend_window_hours):
--   points = 3 x likes + 2 x detail opens + 2 x source taps + 1 x long looks + 0.2 x views
--            - 3 x dislikes          (each counts DISTINCT users, so one person counts once)
--   boost  = trend_max_hours x points / (points + trend_half_points)        (saturating)
--            negative points: -trend_max_neg_hours x |points| / (|points| + trend_half_points)
--   no boost unless at least trend_min_users different people interacted with the card
--   6 h max = less than one "doubling" of importance (8 h), so engagement can reorder
--   similar stories but never lifts a small story over a Fed decision of the same age.
-- For you:
--   foryou_personal_scale      3: follows, learned affinity and exploration count 3x (so +6 h for a
--                              followed topic, up to +-12 h learned). At 1x they could not beat the
--                              importance spread (a Fed card is ~21 h ahead of a small story)
--   seen_penalty_hours         read card: -100 h (was -3 in the signals migration)
--   foryou_explore_hours       +1 h for topics you have no signals in yet (needs
--                              foryou_explore_min_events signals first; new users get Trending)
--   seen_view_penalty_hours    -24 h for a card you were shown but did not read
--   foryou_category_step_hours -0.5 h for each better card of the same topic ahead of it
--   diversity_max_run          at most 2 cards in a row from one topic (Trending and For you)
--   diversity_lookahead        8: the breadth re-rank only reaches 8 cards ahead, so an
--                              important card is never pushed far down
--   signal_half_life_days      a signal counts half after 14 days
--   dwell_ms_per_word / dwell_long_min_ms: long look = max(6 s, 150 ms x words), capped at
--                              dwell_long_ms (8 s)
--   dwell_walkaway_ms          a look over 2 minutes means "walked away": neutral
-- =============================================================================

insert into core.rank_params (key, value) values
  ('trend_window_hours',          48),
  ('trend_max_hours',             6),
  ('trend_max_neg_hours',         3),
  ('trend_half_points',           8),
  ('trend_min_users',             2),
  ('trend_w_like',                3),
  ('trend_w_open_detail',         2),
  ('trend_w_open_source',         2),
  ('trend_w_dwell_long',          1),
  ('trend_w_view',                0.2),
  ('trend_w_dislike',             3),
  ('trend_keep_generations',      6),
  ('foryou_explore_hours',        1),
  ('foryou_explore_min_events',   5),
  ('seen_view_penalty_hours',     24),
  ('foryou_category_step_hours',  0.5),
  ('diversity_max_run',           2),
  ('signal_half_life_days',       14),
  ('dwell_ms_per_word',           150),
  ('dwell_long_min_ms',           6000),
  ('dwell_walkaway_ms',           120000),
  ('foryou_personal_scale',       3),
  ('diversity_lookahead',         8)
on conflict (key) do nothing;

-- Read cards: -3 h (signals migration) was too weak to move them (offline test: the same top 10
-- came back every session). Raised to -100 h = "read cards go to the end". Only changed if it is
-- still the old default, so a hand-tuned value is kept.
update core.rank_params set value = 100 where key = 'seen_penalty_hours' and value = 3;


-- =============================================================================
-- H. SOURCES THE USER CAN HIDE (D-42)
-- A card's source key comes from its primary source name (what the ingest script stores);
-- data cards (kind 'data', numbers via FRED) are all 'fred'. Cards whose source has no key
-- (e.g. a future news source) can't be hidden by source.
-- =============================================================================

alter table core.user_prefs add column if not exists hidden_sources text[] not null default '{}';

create table if not exists core.source_keys (
  key         text primary key,
  name        text not null,
  match_names text[] not null default '{}',   -- core.blurb_sources.name values that map to this key
  sort_order  int not null
);
alter table core.source_keys enable row level security;    -- read only through api.sources()
revoke all on core.source_keys from public, anon, authenticated;

insert into core.source_keys (key, name, match_names, sort_order) values
  ('sec',       'SEC filings',                '{SEC}',                                        1),
  ('fed',       'Federal Reserve',            '{"Federal Reserve Board"}',                    2),
  ('bea',       'Bureau of Economic Analysis','{"U.S. Bureau of Economic Analysis"}',         3),
  ('fred',      'Economic numbers (FRED)',    '{}',                                           4),
  ('fedreg',    'Federal Register',           '{"Federal Register"}',                         5),
  ('wikipedia', 'Wikipedia',                  '{Wikipedia}',                                  6),
  ('cpsc',      'Product recalls (CPSC)',     '{"U.S. Consumer Product Safety Commission"}',  7),
  ('usgs',      'Earthquakes (USGS)',         '{"U.S. Geological Survey"}',                   8),
  ('nasa',      'NASA',                       '{NASA}',                                       9)
on conflict (key) do update
  set name = excluded.name, match_names = excluded.match_names, sort_order = excluded.sort_order;

-- source key of one card (null = no key). Private.
create or replace function core.source_key_of(p_kind text, p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_kind = 'data' then 'fred' else (
    select k.key
      from core.blurb_sources s
      join core.source_keys k on s.name = any (k.match_names)
     where s.blurb_id = p_id
     order by s.is_primary desc, s.position, s.id
     limit 1) end;
$$;
revoke all on function core.source_key_of(text, uuid) from public, anon, authenticated;

-- api.sources(): [{key, name}] for the app's source toggles. Anyone may read it.
create or replace function api.sources()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', k.key, 'name', k.name) order by k.sort_order), '[]'::jsonb)
    from core.source_keys k;
$$;
revoke all on function api.sources() from public;
grant execute on function api.sources() to anon, authenticated, service_role;

-- api.get_prefs: same as the signals migration + hidden_sources
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
                              'hidden_sources', '[]'::jsonb,
                              'onboarded', false, 'updated_at', null, 'affinity', v_aff);
  end if;
  return jsonb_build_object('followed_categories', to_jsonb(v_p.followed_categories),
                            'hidden_categories',   to_jsonb(v_p.hidden_categories),
                            'hidden_sources',      to_jsonb(v_p.hidden_sources),
                            'onboarded',           v_p.onboarded,
                            'updated_at',          v_p.updated_at,
                            'affinity',            v_aff);
end;
$$;
revoke all on function api.get_prefs() from public, anon;
grant execute on function api.get_prefs() to authenticated;

-- api.set_prefs(p_followed, p_hidden, p_hidden_sources): the 2-argument version is dropped so
-- that 2-argument calls (SQL and PostgREST) are not ambiguous; they now reach this one through
-- the defaults. null = keep the saved list, '{}' = clear it. Source keys must exist in
-- core.source_keys (error unknown_source).
drop function if exists api.set_prefs(text[], text[]);

create or replace function api.set_prefs(p_followed text[] default null, p_hidden text[] default null,
                                         p_hidden_sources text[] default null)
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
  v_src  text[];
  v_bad  text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  select * into v_old from core.user_prefs where user_id = v_uid;

  v_fol := case when p_followed is null then coalesce(v_old.followed_categories, '{}')
                else coalesce((select array_agg(distinct x order by x) from unnest(p_followed) x where x is not null), '{}') end;
  v_hid := case when p_hidden is null then coalesce(v_old.hidden_categories, '{}')
                else coalesce((select array_agg(distinct x order by x) from unnest(p_hidden) x where x is not null), '{}') end;
  v_src := case when p_hidden_sources is null then coalesce(v_old.hidden_sources, '{}')
                else coalesce((select array_agg(distinct x order by x) from unnest(p_hidden_sources) x where x is not null), '{}') end;

  select x into v_bad from unnest(v_fol || v_hid) x
   where not exists (select 1 from core.categories c where c.slug = x) limit 1;
  if v_bad is not null then
    raise exception 'unknown_category: %', left(v_bad, 50) using errcode = 'PT422';
  end if;

  select x into v_bad from unnest(v_fol) x where x = any (v_hid) limit 1;
  if v_bad is not null then
    raise exception 'category_followed_and_hidden: %', v_bad using errcode = 'PT422';
  end if;

  select x into v_bad from unnest(v_src) x
   where not exists (select 1 from core.source_keys k where k.key = x) limit 1;
  if v_bad is not null then
    raise exception 'unknown_source: %', left(v_bad, 50) using errcode = 'PT422';
  end if;

  insert into core.user_prefs (user_id, followed_categories, hidden_categories, hidden_sources, onboarded, updated_at)
  values (v_uid, v_fol, v_hid, v_src, true, now())
  on conflict (user_id) do update
     set followed_categories = excluded.followed_categories,
         hidden_categories   = excluded.hidden_categories,
         hidden_sources      = excluded.hidden_sources,
         onboarded           = true,
         updated_at          = now();

  return api.get_prefs();
end;
$$;
revoke all on function api.set_prefs(text[], text[], text[]) from public, anon;
grant execute on function api.set_prefs(text[], text[], text[]) to authenticated;


-- =============================================================================
-- B. WORD COUNT (computed by Postgres from headline + body; follows every rewrite)
-- =============================================================================

alter table core.blurbs add column if not exists word_count int
  generated always as (cardinality(regexp_split_to_array(btrim(headline || ' ' || coalesce(body, '')), '\s+'))) stored;

-- Long-look threshold for a card with p_words words (ms). Private helper.
create or replace function core.long_look_ms(p_words int)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select least(coalesce(max(value) filter (where key = 'dwell_long_ms'), 8000),
               greatest(coalesce(max(value) filter (where key = 'dwell_long_min_ms'), 6000),
                        coalesce(p_words, 0) * coalesce(max(value) filter (where key = 'dwell_ms_per_word'), 150)))
    from core.rank_params;
$$;

revoke all on function core.long_look_ms(int) from public, anon, authenticated;


-- =============================================================================
-- C. TRENDING
-- A "generation" is one refresh. Pages carry their generation in the cursor, so a refresh
-- in the middle of a scroll never reorders the cards you are paging through.
-- Only the last trend_keep_generations (6) are kept; an older cursor uses the newest one.
-- =============================================================================

create table if not exists core.trend_generations (
  gen        bigint primary key,
  created_at timestamptz not null default now()
);

create table if not exists core.trend_boosts (
  gen      bigint  not null references core.trend_generations (gen) on delete cascade,
  blurb_id uuid    not null references core.blurbs (id) on delete cascade,
  boost    numeric not null,
  primary key (gen, blurb_id)
);

alter table core.trend_generations enable row level security;   -- no policies: private
alter table core.trend_boosts      enable row level security;
revoke all on core.trend_generations, core.trend_boosts from public, anon, authenticated;

-- Recompute every card's boost from the last trend_window_hours of events.
-- returns {generation, boosted, top_boost}. Safe to run anytime (serialized by a lock).
create or replace function core.refresh_trending()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gen  bigint;
  v_n    int;
  v_top  numeric;
  p      record;
begin
  perform pg_advisory_xact_lock(hashtext('element.refresh_trending'));

  select coalesce(max(value) filter (where key = 'trend_window_hours'),     48)  as win,
         coalesce(max(value) filter (where key = 'trend_max_hours'),        6)   as maxh,
         coalesce(max(value) filter (where key = 'trend_max_neg_hours'),    3)   as maxneg,
         coalesce(max(value) filter (where key = 'trend_half_points'),      8)   as half,
         coalesce(max(value) filter (where key = 'trend_min_users'),        2)   as minu,
         coalesce(max(value) filter (where key = 'trend_w_like'),           3)   as w_like,
         coalesce(max(value) filter (where key = 'trend_w_open_detail'),    2)   as w_detail,
         coalesce(max(value) filter (where key = 'trend_w_open_source'),    2)   as w_source,
         coalesce(max(value) filter (where key = 'trend_w_dwell_long'),     1)   as w_long,
         coalesce(max(value) filter (where key = 'trend_w_view'),           0.2) as w_view,
         coalesce(max(value) filter (where key = 'trend_w_dislike'),        3)   as w_dislike,
         coalesce(max(value) filter (where key = 'trend_keep_generations'), 6)   as keep,
         coalesce(max(value) filter (where key = 'dwell_walkaway_ms'),      120000) as walk
    into p
    from core.rank_params;

  select coalesce(max(gen), 0) + 1 into v_gen from core.trend_generations;
  insert into core.trend_generations (gen) values (v_gen);

  insert into core.trend_boosts (gen, blurb_id, boost)
  select v_gen, x.blurb_id,
         round(case when x.pts > 0 then  p.maxh   * x.pts  / (x.pts  + p.half)
                    else                -p.maxneg * (-x.pts) / (-x.pts + p.half) end, 6)
    from (
      select e.blurb_id,
             count(distinct e.user_id) as users,
               p.w_like    * count(distinct e.user_id) filter (where e.kind = 'like')
             + p.w_detail  * count(distinct e.user_id) filter (where e.kind = 'open_detail')
             + p.w_source  * count(distinct e.user_id) filter (where e.kind = 'open_source')
             + p.w_long    * count(distinct e.user_id) filter (where e.kind = 'dwell'
                                 and e.dwell_ms >= core.long_look_ms(b.word_count)
                                 and e.dwell_ms <= p.walk)
             + p.w_view    * count(distinct e.user_id) filter (where e.kind = 'view')
             - p.w_dislike * count(distinct e.user_id) filter (where e.kind = 'dislike') as pts
        from core.user_events e
        join core.blurbs b on b.id = e.blurb_id and b.status = 'published'
       where e.created_at > now() - make_interval(hours => p.win::int)
       group by e.blurb_id
    ) x
   where x.users >= p.minu and x.pts <> 0;
  get diagnostics v_n = row_count;

  select max(boost) into v_top from core.trend_boosts where gen = v_gen;
  delete from core.trend_generations where gen <= v_gen - greatest(p.keep, 1);   -- boosts cascade

  return jsonb_build_object('generation', v_gen, 'boosted', v_n, 'top_boost', v_top);
end;
$$;

revoke all on function core.refresh_trending() from public, anon, authenticated;

-- Service-role RPC for the ingest script (end of every run).
create or replace function api.refresh_trending()
returns jsonb
language sql
security definer
set search_path = ''
as $$ select core.refresh_trending(); $$;

revoke all on function api.refresh_trending() from public, anon, authenticated;
grant execute on function api.refresh_trending() to service_role;


-- =============================================================================
-- D. LEARNED AFFINITY v2 (same output as the signals migration: (category, hours))
-- per card (as before): like +1, dislike -1, detail +0.5, source +0.5, long look +0.25,
--   quick skip -0.15 (only looks <= 1.5 s and no positive signal), clamped -1 .. +1.5
-- changed: long look = core.long_look_ms(card words); a look > dwell_walkaway_ms is neutral;
--   each card's total x 0.5 ^ (days since its newest event / signal_half_life_days)
-- category total clamped to +-affinity_cap_hours (4). p_asof = "now" for the window and fade.
-- =============================================================================

create or replace function core.user_affinity(p_user uuid, p_asof timestamptz)
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
           coalesce(max(value) filter (where key = 'dwell_skip_ms'),      1500)  as skip_ms,
           coalesce(max(value) filter (where key = 'dwell_walkaway_ms'),  120000) as walk_ms,
           coalesce(max(value) filter (where key = 'card_cap_pos_hours'), 1.5)   as card_pos,
           coalesce(max(value) filter (where key = 'card_cap_neg_hours'), -1)    as card_neg,
           coalesce(max(value) filter (where key = 'affinity_cap_hours'), 4)     as cap,
           coalesce(max(value) filter (where key = 'affinity_days'),      30)    as days,
           coalesce(max(value) filter (where key = 'signal_half_life_days'), 14) as half
      from core.rank_params
  ), ev as (
    select e.blurb_id,
           bool_or(e.kind = 'like')        as liked,
           bool_or(e.kind = 'dislike')     as disliked,
           bool_or(e.kind = 'open_detail') as detail,
           bool_or(e.kind = 'open_source') as src,
           bool_or(e.kind = 'view')        as viewed,
           max(e.dwell_ms) filter (where e.dwell_ms <= p.walk_ms) as max_dwell,   -- walked away = no look
           max(e.created_at)               as last_at
      from core.user_events e cross join p
     where e.user_id = p_user
       and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => p.days::int)
     group by e.blurb_id
  ), card as (
    select b.category,
           greatest(least(
               case when ev.liked    then p.w_like   else 0 end
             + case when ev.disliked then p.w_dislike else 0 end
             + case when ev.detail   then p.w_detail else 0 end
             + case when ev.src      then p.w_source else 0 end
             + case when ev.viewed   then p.w_view   else 0 end
             + case when ev.max_dwell >= core.long_look_ms(b.word_count) then p.w_long else 0 end
             + case when ev.max_dwell <= p.skip_ms
                     and not (ev.liked or ev.detail or ev.src) then p.w_skip else 0 end,
             p.card_pos), p.card_neg)
           * power(0.5::numeric, (extract(epoch from (p_asof - ev.last_at)) / 86400.0)::numeric / greatest(p.half, 0.01)) as s
      from ev
      join core.blurbs b on b.id = ev.blurb_id
      cross join p
  )
  select c.category, greatest(least(sum(c.s), max(p.cap)), -max(p.cap)) as hours
    from card c cross join p
   group by c.category;
$$;

create or replace function core.user_affinity(p_user uuid)
returns table (category text, hours numeric)
language sql
stable
security definer
set search_path = ''
as $$ select a.category, a.hours from core.user_affinity(p_user, clock_timestamp()) a; $$;   -- includes signals stored just now

revoke all on function core.user_affinity(uuid, timestamptz) from public, anon, authenticated;
revoke all on function core.user_affinity(uuid)              from public, anon, authenticated;


-- =============================================================================
-- D2. BREADTH: core.diversify (used by Trending and For you; Latest stays strictly by time)
-- Input: one page of card ids in score order + the state left by the previous page.
-- Greedy: each slot takes the best remaining card (looking at most diversity_lookahead cards
-- ahead) that
--   1. does not make a run of more than diversity_max_run (2) cards from one category,
--   2. is not the same "story type" as the card just before it (same category + event_type,
--      e.g. two bank earnings or two earthquakes), and
--   3. shares no company ticker with the card just before it.
-- If no card passes all three, rule 1 is dropped; if still none, the best remaining card is used.
-- Before that, a story type that fills half or more of what is left on the page goes first,
-- so e.g. 5 earthquakes on a 10-card page come out every other card instead of 5 at the end.
-- Paging-safe: which cards are on a page is still decided by the score (keyset); only the order
-- inside the page changes, and the last card's category / run / story type / tickers travel in
-- the cursor so the next page continues the pattern. Same input -> same output.
-- returns {ids: [uuid...], state: {c, r, k, t}}
-- =============================================================================

create or replace function core.diversify(p_ids uuid[], p_state jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_maxrun int;
  v_look   int;
  v_cat    text   := coalesce(p_state ->> 'c', '');
  v_run    int    := coalesce((p_state ->> 'r')::int, 0);
  v_clu    text   := coalesce(p_state ->> 'k', '');
  v_tick   text[] := coalesce(array(select jsonb_array_elements_text(
                        case when jsonb_typeof(p_state -> 't') = 'array' then p_state -> 't' else '[]'::jsonb end)), '{}');
  v_ids    uuid[];
  v_cats   text[];
  v_clus   text[];
  v_ticks  jsonb[];
  v_n      int;
  v_used   boolean[];
  v_out    uuid[] := '{}';
  v_pick   int;
  v_seen   int;
  v_ok     boolean;
  v_force  text;
begin
  select coalesce(max(value) filter (where key = 'diversity_max_run'), 2)::int,
         coalesce(max(value) filter (where key = 'diversity_lookahead'), 8)::int
    into v_maxrun, v_look
    from core.rank_params;

  select array_agg(b.id order by u.o),
         array_agg(b.category order by u.o),
         array_agg(case when b.event_type is null then '' else b.category || '/' || b.event_type end order by u.o),
         array_agg(coalesce((select jsonb_agg(t ->> 'symbol') from jsonb_array_elements(b.tickers) t
                              where t ->> 'symbol' is not null), '[]'::jsonb) order by u.o)
    into v_ids, v_cats, v_clus, v_ticks
    from unnest(p_ids) with ordinality as u(id, o)
    join core.blurbs b on b.id = u.id;

  v_n := coalesce(cardinality(v_ids), 0);
  v_used := array_fill(false, array[greatest(v_n, 1)]);
  for slot in 1 .. v_n loop
    v_pick := null;
    -- spread a crowded story type: if one type (not the previous card's) fills at least half of
    -- what is left, take its best card now, otherwise its cards would end up back to back
    select x.k into v_force
      from (select v_clus[j] as k, count(*) as c, min(j) as first_j
              from generate_series(1, v_n) j
             where not v_used[j] and v_clus[j] <> '' and v_clus[j] <> v_clu
             group by v_clus[j]) x
     where 2 * x.c - 1 >= v_n - slot + 1
     order by x.c desc, x.first_j
     limit 1;
    if found then   -- its best card that shares no company with the previous card (else its best)
      select j into v_pick from generate_series(1, v_n) j
       where not v_used[j] and v_clus[j] = v_force
       order by (exists (select 1 from jsonb_array_elements_text(v_ticks[j]) s where s = any (v_tick))), j
       limit 1;
    end if;
    for tier in 1 .. 3 loop
      exit when v_pick is not null;
      v_seen := 0;
      for j in 1 .. v_n loop
        continue when v_used[j];
        v_seen := v_seen + 1;
        exit when v_seen > greatest(v_look, 1);
        v_ok := tier = 3
             or ((tier = 2 or v_cats[j] <> v_cat or v_run < v_maxrun)
                 and (v_clus[j] = '' or v_clus[j] <> v_clu)
                 and not exists (select 1 from jsonb_array_elements_text(v_ticks[j]) s where s = any (v_tick)));
        if v_ok then v_pick := j; exit; end if;
      end loop;
      exit when v_pick is not null;
    end loop;
    v_used[v_pick] := true;
    v_out := v_out || v_ids[v_pick];
    if v_cats[v_pick] = v_cat then v_run := v_run + 1; else v_cat := v_cats[v_pick]; v_run := 1; end if;
    v_clu  := v_clus[v_pick];
    v_tick := coalesce(array(select jsonb_array_elements_text(v_ticks[v_pick])), '{}');
  end loop;

  return jsonb_build_object('ids', to_jsonb(v_out),
                            'state', jsonb_build_object('c', v_cat, 'r', v_run, 'k', v_clu, 't', to_jsonb(v_tick)));
end;
$$;

revoke all on function core.diversify(uuid[], jsonb) from public, anon, authenticated;

-- cursor helpers: the breadth state travels as base64 text (never contains '|')
create or replace function core.state_to_text(p jsonb)
returns text language sql immutable set search_path = ''
as $$ select translate(encode(convert_to(p::text, 'UTF8'), 'base64'), chr(10), ''); $$;

create or replace function core.state_from_text(p text)
returns jsonb language sql immutable set search_path = ''
as $$ select case when coalesce(p, '') = '' then '{}'::jsonb
                  else convert_from(decode(p, 'base64'), 'UTF8')::jsonb end; $$;

revoke all on function core.state_to_text(jsonb)  from public, anon, authenticated;
revoke all on function core.state_from_text(text) from public, anon, authenticated;


-- =============================================================================
-- E. api.feed
-- p_mode 'top'    (Trending) key = rank_score + trend boost of the cursor's generation; the page
--                 is then re-ordered for breadth (core.diversify)
--                 cursor '<key>|<uuid>|<generation>|<breadth state>' (older 2-part cursors work)
--        'latest' newest first: sort_at desc, id desc; cursor '<sort_at>|<uuid>' (unchanged)
-- p_category      optional topic filter (unchanged)
-- Signed in (auth.uid() not null): cards in the caller's hidden topics are left out in every
-- mode, also when p_category asks for a hidden topic (then the page is empty). Anon: unchanged.
-- Cards: core.cards_json without my_reaction (same keys as before, including detail).
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
         limit v_limit + 1
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
  if cardinality(v_ids) > v_limit then
    v_next := v_keys[v_limit] || '|' || v_ids[v_limit]                     -- cursor = last row of the page
              || case when v_mode = 'top' then '|' || v_gen else '' end;
    v_ids  := v_ids[1:v_limit];
  end if;

  if v_mode = 'top' and cardinality(v_ids) > 0 then                        -- breadth re-order inside the page
    v_div := core.diversify(v_ids, v_state);
    v_ids := array(select x::uuid from jsonb_array_elements_text(v_div -> 'ids') with ordinality as t(x, o) order by o);
    if v_next is not null then v_next := v_next || '|' || core.state_to_text(v_div -> 'state'); end if;
  end if;

  select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(core.cards_json(v_ids, null)) with ordinality as x(c, o);

  return jsonb_build_object('items', v_items, 'next_cursor', v_next);
end;
$$;

revoke execute on function api.feed(text, text, int, text) from public;
grant  execute on function api.feed(text, text, int, text) to anon, authenticated, service_role;


-- =============================================================================
-- F. api.feed_for_you v2
-- s0 (hours) = rank_score + trend boost                       (Trending order = cold start)
--            + foryou_personal_scale (3) x (
--                boost_followed_hours (2)        followed topic
--              + core.user_affinity(user, as_of) learned, -4..+4, fades with a 14-day half-life
--              + foryou_explore_hours (1))       topic with no signals yet (not followed),
--                                                once the user has >= 5 signals
--            - seen_penalty_hours (100)          card already read (long look or detail opened)
--            - seen_view_penalty_hours (24)      card shown before but not read
-- personal_score = s0 - foryou_category_step_hours (0.5) x (number of better cards of the
--                  same topic), so one busy topic cannot fill the whole feed
-- Page = the next p_limit cards by (personal_score, id) after the cursor (keyset); inside the
-- page the order is rearranged for breadth by core.diversify (max 2 in a row per topic, no two
-- of the same story type or company back to back), continued across pages.
-- Cursor '<score>|<uuid>|<generation>|<as_of>|<breadth state>' (opaque). as_of is the time of the
-- first page: signals and cards newer than it are ignored until a refresh, so likes, views and
-- new cards during a scroll never make a card repeat or be skipped. Older 2-part cursors work.
-- Excluded: hidden topics, disliked cards, cards older than for_you_window_days, unpublished.
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
     limit v_limit + 1
  )
  select array_agg(p.id order by p.ps desc, p.id desc),
         array_agg(p.ps::text order by p.ps desc, p.id desc)
    into v_ids, v_keys
    from page p;

  v_ids := coalesce(v_ids, '{}');
  if cardinality(v_ids) > v_limit then
    v_next := v_keys[v_limit] || '|' || v_ids[v_limit] || '|' || v_gen || '|'
              || to_char(v_asof at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    v_ids  := v_ids[1:v_limit];
  end if;

  -- breadth: re-order inside the page (same rules as Trending); state carried in the cursor
  v_out := v_ids;
  if cardinality(v_ids) > 0 then
    v_div := core.diversify(v_ids, v_state);
    v_out := array(select x::uuid from jsonb_array_elements_text(v_div -> 'ids') with ordinality as t(x, o) order by o);
    if v_next is not null then v_next := v_next || '|' || core.state_to_text(v_div -> 'state'); end if;
  end if;

  return jsonb_build_object('items', core.cards_json(v_out, v_uid), 'next_cursor', v_next);
end;
$$;

revoke all on function api.feed_for_you(text, int) from public, anon;
grant execute on function api.feed_for_you(text, int) to authenticated;


-- =============================================================================
-- G. api.my_categories (signed-in users)
-- returns [{slug, name, sort_order, followed, hidden}] for topics that have cards, plus any
-- topic the user follows or hides (so a hidden topic can always be un-hidden).
-- =============================================================================

create or replace function api.my_categories()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_fol text[];
  v_hid text[];
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;
  select followed_categories, hidden_categories into v_fol, v_hid
    from core.user_prefs where user_id = v_uid;
  v_fol := coalesce(v_fol, '{}');
  v_hid := coalesce(v_hid, '{}');
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'slug', c.slug, 'name', c.name, 'sort_order', c.sort_order,
             'followed', c.slug = any (v_fol), 'hidden', c.slug = any (v_hid))
           order by c.sort_order), '[]'::jsonb)
      from core.categories c
     where c.slug = any (v_fol || v_hid)
        or exists (select 1 from core.blurbs b where b.category = c.slug and b.status = 'published'));
end;
$$;

revoke all on function api.my_categories() from public, anon;
grant execute on function api.my_categories() to authenticated;

notify pgrst, 'reload schema';

-- HOW TO CHECK: paste this file after 20261017060000_signals.sql (expected "Success. No rows
-- returned"; a second run gives the same). Then run supabase/tests/trending_check.sql (needs the
-- two test users). select api.refresh_trending(); as service role returns {generation, ...}.
-- =============================================================================
