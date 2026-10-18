-- =============================================================================
-- collab_check.sql: checks for 20261017080000_collab.sql
--   crowd topic priors, card neighbours ("readers who liked X also liked Y"), smoothed
--   engagement rate (quality), the >= 3 people rule, caps, paging, guests unaffected,
--   deleted data leaves the aggregates.
--
-- Supabase SQL editor: needs the two test users element-test-a@example.com and
-- element-test-b@example.com (Authentication -> Users -> Add user, "Auto Confirm User").
-- Six more "crowd" users are created inside this block and rolled back with everything else.
-- Paste the whole file and run it.
--   expected:     ERROR: ALL COLLAB CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- Signed-in users are simulated as in accounts_check.sql (role + request.jwt.claims).
-- Crowd events are inserted directly (as the owner), 3 days old: older than the 48 h Trending
-- window, so the crowd tables can be checked on their own.
-- =============================================================================

do $$
declare
  ua    uuid;                -- "A": no follows, likes one card during the test
  ub    uuid;                -- "B": brand-new user who follows tech
  crowd uuid[] := '{}';
  u     uuid;
  base  numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  b     uuid;
  r     jsonb;
  page  jsonb;
  cur   text;
  seen  text[];
  ids   jsonb := '{}';
  got   text;
  a0    text;
  a1    text;
  ok    boolean;
  n     int;
  i     int;
  pages int;
  nx    numeric;
  ny    numeric;
  c     jsonb;
  spec  jsonb := '[
    {"l":"FED", "c":"economy", "o":12},
    {"l":"T1",  "c":"tech",    "o":0},
    {"l":"T2",  "c":"tech",    "o":-0.5},
    {"l":"T3",  "c":"tech",    "o":-1},
    {"l":"T4",  "c":"tech",    "o":-1.5},
    {"l":"E1",  "c":"energy",  "o":-2},
    {"l":"S2",  "c":"science", "o":-2.5},
    {"l":"S1",  "c":"science", "o":-3},
    {"l":"P1",  "c":"safety",  "o":-30}]';
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  if ua is null or ub is null then
    raise exception 'SETUP: create the users element-test-a@example.com and element-test-b@example.com first';
  end if;
  delete from core.user_events where user_id in (ua, ub);
  delete from core.user_prefs  where user_id in (ua, ub);
  update core.blurbs set status = 'hidden' where status = 'published';   -- real cards out of the way (rolled back)
  update core.rank_params set value = 0 where key = 'trend_quality_hours';  -- quality is checked on its own in part 8

  for i in 1 .. 6 loop
    insert into auth.users (id, email) values (gen_random_uuid(), 'element-collab-crowd-' || i || '@example.invalid')
    returning id into u;
    crowd := crowd || u;
  end loop;

  -- cards: FED far ahead (importance), four tech cards, E1 / S2 / S1 close together, P1 far down,
  -- F0..F19 fillers (markets / world) below
  for c in select value from jsonb_array_elements(spec) loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('cb-' || (c->>'l'), 'summary', 'CB ' || (c->>'l'), c->>'c', now(), now() - interval '5 minutes',
            base + (c->>'o')::numeric)
    returning id into b; ids := ids || jsonb_build_object(c->>'l', b);
  end loop;
  for i in 0 .. 19 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('cb-F' || i, 'summary', 'CB F' || i, case when i % 2 = 0 then 'markets' else 'world' end,
            now(), now() - make_interval(mins => 10 + i), base - 10 - i)
    returning id into b; ids := ids || jsonb_build_object('F' || i, b);
  end loop;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select x.id, 'SEC', 'filing', 'https://www.sec.gov/cb/' || x.id, 'company_filing', true
    from core.blurbs x where x.dedupe_key like 'cb-%';
  -- 29 published test cards

  -- ---- 1. privileges: crowd tables and helpers are private -----------------------------
  foreach got in array array['anon', 'authenticated'] loop
    perform set_config('role', got, true);
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', got)::text, true);
    ok := false;
    begin perform count(*) from core.collab_cards;
    exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can read core.collab_cards', got; end if;
    ok := false;
    begin perform count(*) from core.collab_topics;
    exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can read core.collab_topics', got; end if;
    ok := false;
    begin perform count(*) from core.crowd_pairs(14);
    exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.crowd_pairs', got; end if;
    ok := false;
    begin perform count(*) from core.user_affinity_dims(ua, now());
    exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.user_affinity_dims', got; end if;
  end loop;
  perform set_config('role', 'none', true);
  if exists (select 1 from pg_policies where schemaname = 'core' and tablename in ('collab_cards', 'collab_topics')) then
    raise exception 'FAIL: crowd tables have RLS policies (they must have none)';
  end if;
  if not (select bool_and(relrowsecurity) from pg_class
           where oid in ('core.collab_cards'::regclass, 'core.collab_topics'::regclass)) then
    raise exception 'FAIL: RLS is off on a crowd table';
  end if;

  -- ---- 2. no crowd yet: the same order as before (fallback) ----------------------------
  r := core.refresh_trending();
  if (r->>'card_links')::int <> 0 or (r->>'topic_cells')::int <> 0 then
    raise exception 'FAIL: crowd tables not empty without any signals: %', r;
  end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select string_agg(x->>'id', ',' order by o) into a0
    from jsonb_array_elements(api.feed('top', null, 30) -> 'items') with ordinality as t(x, o);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  perform api.set_prefs(array['tech'], null);
  select string_agg(replace(x->>'headline', 'CB ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed_for_you(null, 30) -> 'items') with ordinality as t(x, o)
   where x->>'headline' in ('CB E1', 'CB S1', 'CB S2');
  if got is distinct from 'E1,S2,S1' then raise exception 'FAIL: new user B before any crowd: % (expected E1,S2,S1)', got; end if;

  -- ---- 3. the crowd: six people who follow tech --------------------------------------
  -- all six: like + open the detail of T1 and S1; only look at E1, S2 and F0..F5
  -- two of them (under the 3-person floor): also like T2 and P1
  perform set_config('role', 'none', true);
  foreach u in array crowd loop
    insert into core.user_prefs (user_id, followed_categories, onboarded) values (u, '{tech}', true);
    insert into core.user_events (user_id, blurb_id, kind, created_at)
    select u, (ids->>k)::uuid, kind, now() - interval '3 days'
      from unnest(array['T1', 'S1']) k, unnest(array['view', 'like', 'open_detail']) kind;
    insert into core.user_events (user_id, blurb_id, kind, created_at)
    select u, (ids->>k)::uuid, 'view', now() - interval '3 days'
      from unnest(array['E1', 'S2', 'F0', 'F1', 'F2', 'F3', 'F4', 'F5']) k;
  end loop;
  foreach u in array crowd[1:2] loop
    insert into core.user_events (user_id, blurb_id, kind, created_at)
    select u, (ids->>k)::uuid, kind, now() - interval '3 days'
      from unnest(array['T2', 'P1']) k, unnest(array['view', 'like']) kind;
  end loop;

  r := core.refresh_trending();
  if (r->>'card_links')::int = 0 or (r->>'topic_cells')::int = 0 then raise exception 'FAIL: refresh built no crowd rows: %', r; end if;
  if (r->>'boosted')::int <> 0 then
    raise exception 'FAIL: 3-day-old events (outside the 48 h window, quality off) boosted % cards', r->>'boosted';
  end if;

  -- card links: T1 <-> S1 (6 people), no T2 <-> P1 (2 people), every link from >= 3 people
  select sim into nx from core.collab_cards
   where gen = (r->>'generation')::bigint and blurb_id = (ids->>'T1')::uuid and neighbor_id = (ids->>'S1')::uuid;
  if nx is null or nx <= 0 or nx >= 1 then raise exception 'FAIL: T1 -> S1 link missing or out of range: %', nx; end if;
  if exists (select 1 from core.collab_cards where gen = (r->>'generation')::bigint
              and blurb_id = (ids->>'T2')::uuid and neighbor_id = (ids->>'P1')::uuid) then
    raise exception 'FAIL: T2 -> P1 linked although only 2 people engaged with both';
  end if;
  select count(*) into n
    from core.collab_cards l
   where l.gen = (r->>'generation')::bigint
     and (select count(distinct a.user_id)
            from core.crowd_pairs(14) a join core.crowd_pairs(14) z on z.user_id = a.user_id
           where a.blurb_id = l.blurb_id and z.blurb_id = l.neighbor_id and a.pos and z.pos) < 3;
  if n > 0 then raise exception 'FAIL: % card links come from fewer than 3 people', n; end if;
  if exists (select 1 from core.collab_topics where gen = (r->>'generation')::bigint and topic_b = 'safety') then
    raise exception 'FAIL: a topic cell for safety exists although only 2 people saw it';
  end if;
  select lift into nx from core.collab_topics where gen = (r->>'generation')::bigint and topic_a = 'tech' and topic_b = 'science';
  select lift into ny from core.collab_topics where gen = (r->>'generation')::bigint and topic_a = 'tech' and topic_b = 'energy';
  if nx is null or ny is null or not (nx > 0 and ny < 0 and nx <= 1 and ny >= -1) then
    raise exception 'FAIL: tech readers -> science lift % should be > 0, -> energy % should be < 0', nx, ny;
  end if;

  -- guests: the crowd tables never touch Trending (quality is off here, events are 3 days old)
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select string_agg(x->>'id', ',' order by o) into a1
    from jsonb_array_elements(api.feed('top', null, 30) -> 'items') with ordinality as t(x, o);
  if a1 is distinct from a0 then raise exception 'FAIL: the guest Trending feed changed because of the crowd tables'; end if;

  -- ---- 4. a new user gets crowd-informed picks ---------------------------------------
  -- B follows tech and has no signals: "people who follow tech read science, skip energy"
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select string_agg(replace(x->>'headline', 'CB ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed_for_you(null, 30) -> 'items') with ordinality as t(x, o)
   where x->>'headline' in ('CB E1', 'CB S1', 'CB S2');
  if got not like 'S%,S%,E1' then raise exception 'FAIL: new user B with a crowd: % (expected both science cards above E1)', got; end if;

  -- ---- 5. co-engagement lifts a similar card after a like -----------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select string_agg(replace(x->>'headline', 'CB ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed_for_you(null, 30) -> 'items') with ordinality as t(x, o)
   where x->>'headline' in ('CB S1', 'CB S2');
  if got is distinct from 'S2,S1' then raise exception 'FAIL: A before the like: % (expected S2,S1)', got; end if;
  perform api.track((ids->>'T1')::uuid, 'like');
  page := api.feed_for_you(null, 30);
  select string_agg(replace(x->>'headline', 'CB ', ''), ',' order by o) into got
    from jsonb_array_elements(page -> 'items') with ordinality as t(x, o)
   where x->>'headline' in ('CB S1', 'CB S2');
  if got is distinct from 'S1,S2' then raise exception 'FAIL: A liked T1, readers of T1 also read S1, but order is % (expected S1,S2)', got; end if;
  -- the like shows in A's own feed only, never in the guest feed (no refresh needed for that)
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select string_agg(x->>'id', ',' order by o) into a1
    from jsonb_array_elements(api.feed('top', null, 30) -> 'items') with ordinality as t(x, o);
  if a1 is distinct from a0 then raise exception 'FAIL: A''s like changed the guest feed'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select string_agg(x->>'id', ',' order by o) into a1
    from jsonb_array_elements(api.feed('top', null, 30) -> 'items') with ordinality as t(x, o);
  if a1 is distinct from a0 then raise exception 'FAIL: signed-in Trending differs from the guest Trending (no hidden topics)'; end if;

  -- ---- 6. caps: importance still wins --------------------------------------------------
  -- S1 now has the crowd lift and the neighbour lift; FED (12 h ahead, no crowd) stays first
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if (page -> 'items' -> 0 ->> 'headline') is distinct from 'CB FED' then
    raise exception 'FAIL: A''s first card is %, expected CB FED (importance)', page -> 'items' -> 0 ->> 'headline';
  end if;
  perform set_config('role', 'none', true);
  select max(value) filter (where key = 'foryou_personal_scale') * max(value) filter (where key = 'collab_topic_hours'),
         max(value) filter (where key = 'collab_card_hours')
    into nx, ny from core.rank_params;
  if nx > 6 or ny > 4 then raise exception 'FAIL: crowd caps too high: topic % h, neighbours % h (max 6 / 4)', nx, ny; end if;

  -- ---- 7. paging: no repeats across a refresh and a like in the middle -----------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  page := api.feed_for_you(null, 10);
  seen := array(select x->>'id' from jsonb_array_elements(page->'items') x);
  cur := page->>'next_cursor';
  pages := 1;
  perform set_config('role', 'none', true);
  -- mid-scroll: the crowd likes two markets cards, a refresh runs, A likes S2 and four world cards
  -- (stamped "now", after the first page): none of it may reorder the pages A is scrolling
  insert into core.user_events (user_id, blurb_id, kind, created_at)
  select cu, (ids->>k)::uuid, kind, now() - interval '3 days'
    from unnest(crowd) cu, unnest(array['F10', 'F12']) k, unnest(array['like', 'open_detail']) kind;
  perform core.refresh_trending();
  insert into core.user_events (user_id, blurb_id, kind, created_at)
  select ua, (ids->>k)::uuid, 'like', clock_timestamp() from unnest(array['S2', 'F1', 'F3', 'F5', 'F7']) k;
  perform set_config('role', 'authenticated', true);
  loop
    exit when cur is null or pages > 6;
    page := api.feed_for_you(cur, 10);
    pages := pages + 1;
    for c in select value from jsonb_array_elements(page -> 'items') loop
      if (c->>'id') = any (seen) then raise exception 'FAIL: for-you paging repeated %', c->>'headline'; end if;
      seen := seen || (c->>'id');
    end loop;
    cur := page ->> 'next_cursor';
  end loop;
  if cardinality(seen) <> 29 then
    raise exception 'FAIL: for-you paging returned % cards in % pages, expected all 29 once', cardinality(seen), pages;
  end if;
  -- old call signatures still work and the card shape is unchanged
  if jsonb_array_length(api.feed_for_you() -> 'items') <> 20 then raise exception 'FAIL: api.feed_for_you() with defaults broke'; end if;
  select string_agg(key, ',' order by key) into got from jsonb_object_keys(api.feed_for_you(null, 10)->'items'->0) key;
  select string_agg(key, ',' order by key) into a1
    from jsonb_object_keys((api.feed('top', null, 10)->'items'->0) || '{"my_reaction":null}'::jsonb) key;
  if got is distinct from a1 then raise exception 'FAIL: card keys differ: % vs %', got, a1; end if;

  -- ---- 8. quality: a smoothed "opened when shown" rate reaches Trending -----------------
  perform set_config('role', 'none', true);
  update core.rank_params set value = 1 where key = 'trend_quality_hours';
  r := core.refresh_trending();
  select boost into nx from core.trend_boosts where gen = (r->>'generation')::bigint and blurb_id = (ids->>'S1')::uuid;
  select boost into ny from core.trend_boosts where gen = (r->>'generation')::bigint and blurb_id = (ids->>'S2')::uuid;
  if nx is null or ny is null or not (nx > 0 and ny < 0) then
    raise exception 'FAIL: quality: S1 (opened by 6 of 6) boost %, S2 (1 of 7) boost %', nx, ny;
  end if;
  if exists (select 1 from core.trend_boosts where gen = (r->>'generation')::bigint and (boost > 6 or boost < -3)) then
    raise exception 'FAIL: a Trending boost is outside -3 .. +6 h';
  end if;
  if exists (select 1 from core.trend_boosts where gen = (r->>'generation')::bigint and blurb_id = (ids->>'P1')::uuid) then
    raise exception 'FAIL: P1 (seen by 2 people) got a quality boost';
  end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select string_agg(replace(x->>'headline', 'CB ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed('top', null, 30) -> 'items') with ordinality as t(x, o)
   where x->>'headline' in ('CB S1', 'CB S2');
  if got is distinct from 'S1,S2' then raise exception 'FAIL: guest Trending with quality: % (expected S1,S2)', got; end if;
  if (select (x->>'headline') from jsonb_array_elements(api.feed('top', null, 10) -> 'items') with ordinality as t(x, o) where o = 1)
     is distinct from 'CB FED' then
    raise exception 'FAIL: quality lifted a card above FED in Trending';
  end if;

  -- ---- 9. deleted data leaves the aggregates at the next refresh --------------------------
  perform set_config('role', 'none', true);
  delete from core.user_events where user_id = any (crowd[1:4]);   -- what delete_my_data does
  r := core.refresh_trending();
  if exists (select 1 from core.collab_cards where gen = (r->>'generation')::bigint
              and blurb_id = (ids->>'T1')::uuid and neighbor_id = (ids->>'S1')::uuid) then
    raise exception 'FAIL: T1 -> S1 still linked after 4 of 6 people deleted their data (2 left)';
  end if;
  if exists (select 1 from core.collab_topics where gen = (r->>'generation')::bigint and topic_a = 'tech' and topic_b = 'science') then
    raise exception 'FAIL: "tech readers -> science" kept after 4 of its 6 readers deleted their data';
  end if;

  raise exception 'ALL COLLAB CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
