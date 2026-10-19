-- =============================================================================
-- ml_shadow_check.sql: checks for 20261019010000_ml_shadow.sql (ML shadow logging)
--   settings, privileges and RLS, wrapper output = core output (modes 0, 1 and 2), page logging,
--   cursors (new and old format), guests, logging failures, the per-reader cap, api.track
--   positions, the service RPCs (paged export, runs, shadow and appeal rows), purging, the storage
--   stop rule and deletion.
--
-- Supabase SQL editor: needs the two test users element-test-a@example.com and
-- element-test-b@example.com (Authentication -> Users -> Add user, "Auto Confirm User").
-- Paste the whole file and run it. Run it with no ingest run (refresh_trending) going.
--   expected:     ERROR: ALL ML_SHADOW CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- The modes are switched to 1 and 2 only inside this block, which is rolled back at the end.
-- Signed-in users are simulated as in accounts_check.sql (role + request.jwt.claims).
-- =============================================================================

do $$
declare
  ua     uuid;
  ub     uuid;
  base   numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  b      uuid;
  cards  uuid[] := '{}';
  i      int;
  n      int;
  n2     int;
  r      jsonb;
  r2     jsonb;
  cur    text;
  c0     text;
  pg     uuid;
  pgb    uuid;
  run    bigint;
  ok     boolean;
  got    text;
  seen   text[];
  rl     text;
  t      text;
  cats   text[] := array['markets', 'world', 'tech', 'policy', 'energy', 'deals'];
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  if ua is null or ub is null then
    raise exception 'SETUP: create the users element-test-a@example.com and element-test-b@example.com first';
  end if;
  delete from core.ml_pages    where user_id in (ua, ub);
  delete from core.user_events where user_id in (ua, ub);
  delete from core.user_prefs  where user_id in (ua, ub);
  update core.blurbs set status = 'hidden' where status = 'published';   -- real cards out of the way (rolled back)

  -- ---- 1. settings: shipped with both modes off ------------------------------------------------
  select string_agg(key || '=' || value::text, ',' order by key) into got from core.rank_params
   where key in ('foryou_ml_mode', 'trending_ml_mode', 'ml_log_retention_days', 'ml_keep_runs',
                 'ml_pages_max_per_hour', 'ml_purge_events_days', 'ml_db_stop_mb');
  if got is distinct from 'foryou_ml_mode=0,ml_db_stop_mb=400,ml_keep_runs=3,ml_log_retention_days=21,ml_pages_max_per_hour=60,ml_purge_events_days=0,trending_ml_mode=0' then
    raise exception 'FAIL: rank_params defaults are %', got;
  end if;

  -- ---- 2. privileges, RLS, function properties -------------------------------------------------
  foreach t in array array['core.ml_pages', 'core.ml_runs', 'core.ml_shadow', 'core.ml_appeal'] loop
    if not (select relrowsecurity from pg_class where oid = t::regclass) then raise exception 'FAIL: RLS off on %', t; end if;
    foreach rl in array array['anon', 'authenticated'] loop
      if has_table_privilege(rl, t, 'select') or has_table_privilege(rl, t, 'insert') then
        raise exception 'FAIL: % has table rights on %', rl, t;
      end if;
    end loop;
  end loop;
  foreach rl in array array['anon', 'authenticated'] loop
    perform set_config('role', rl, true);
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', rl)::text, true);
    ok := false; begin perform count(*) from core.ml_pages; exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can read core.ml_pages', rl; end if;
    ok := false; begin perform api.ml_purge(); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_purge', rl; end if;
    ok := false; begin perform api.ml_export('events', now() - interval '1 day'); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_export', rl; end if;
    ok := false; begin perform api.ml_begin_run('shadow', 'x'); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_begin_run', rl; end if;
    ok := false; begin perform api.ml_write_shadow('[]'); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_write_shadow', rl; end if;
    ok := false; begin perform api.ml_write_appeal(1, '[]'); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_write_appeal', rl; end if;
    ok := false; begin perform api.ml_finish_run(1, 'ok'); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_finish_run', rl; end if;
    ok := false; begin perform core.feed_top('top', null, 10, null); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.feed_top', rl; end if;
    ok := false; begin perform core.feed_for_you_v5(null, 10); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.feed_for_you_v5', rl; end if;
    perform set_config('role', 'none', true);
  end loop;
  foreach t in array array['api.ml_purge()', 'api.ml_export(text,timestamptz,text,integer)', 'api.ml_begin_run(text,text,jsonb)',
                           'api.ml_write_shadow(jsonb)', 'api.ml_write_appeal(bigint,jsonb)', 'api.ml_finish_run(bigint,text,integer,integer)'] loop
    if not has_function_privilege('service_role', t, 'execute') then raise exception 'FAIL: service_role cannot execute %', t; end if;
    if exists (select 1 from pg_proc p where p.oid = t::regprocedure
                  and (not p.prosecdef or not (p.proconfig @> array['search_path=""'])
                       or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))) then
      raise exception 'FAIL: % must be security definer, search_path empty, not PUBLIC', t;
    end if;
  end loop;
  if exists (select 1 from pg_proc p where p.oid in ('core.feed_top(text,text,integer,text)'::regprocedure, 'core.feed_for_you_v5(text,integer)'::regprocedure)
                and not (p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=""'])) then
    raise exception 'FAIL: the core feed functions must be stable, security definer, search_path empty';
  end if;
  if exists (select 1 from pg_proc p where p.oid in ('api.feed(text,text,integer,text)'::regprocedure, 'api.feed_for_you(text,integer)'::regprocedure)
                and not (p.provolatile = 'v' and p.prosecdef and p.proconfig @> array['search_path=""'])) then
    raise exception 'FAIL: api.feed and api.feed_for_you must be volatile, security definer, search_path empty';
  end if;
  if not has_function_privilege('anon', 'api.feed(text,text,integer,text)', 'execute')
     or not has_function_privilege('authenticated', 'api.feed(text,text,integer,text)', 'execute')
     or has_function_privilege('anon', 'api.feed_for_you(text,integer)', 'execute')
     or not has_function_privilege('authenticated', 'api.feed_for_you(text,integer)', 'execute') then
    raise exception 'FAIL: feed grants changed';
  end if;
  if (select provolatile from pg_proc where oid = 'api.following_feed(text[],text[],text[],text,integer)'::regprocedure) <> 's' then
    raise exception 'FAIL: api.following_feed must stay stable';
  end if;
  if to_regprocedure('api.track(uuid,text,integer)') is not null
     or not has_function_privilege('authenticated', 'api.track(uuid,text,integer,uuid,integer,text)', 'execute')
     or has_function_privilege('anon', 'api.track(uuid,text,integer,uuid,integer,text)', 'execute') then
    raise exception 'FAIL: api.track signature or grants';
  end if;

  -- cards: 36, six topics, each with its own source
  for i in 1 .. 36 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('mls-' || i, 'summary', 'MLS ' || i, cats[1 + (i % 6)], now(),
            now() - make_interval(secs => i * 300), base + 20 - i * 0.5)
    returning id into b;
    cards := cards || b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'MLS source ' || i, 'filing', 'https://www.sec.gov/mls/' || b, 'company_filing', true);
  end loop;

  -- ---- 3. mode 0: wrapper = core, nothing logged, no page_id ---------------------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  c0 := '1e12|ffffffff-ffff-ffff-ffff-ffffffffffff||' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '||';
  r  := api.feed_for_you(c0, 10);
  perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(c0, 10); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: For you wrapper differs from core in mode 0'; end if;
  if r ? 'page_id' then raise exception 'FAIL: page_id in mode 0'; end if;
  if r ->> 'next_cursor' is distinct from (r2 ->> 'next_cursor') || '||1|0' then
    raise exception 'FAIL: For you cursor tail in mode 0: % vs %', r ->> 'next_cursor', r2 ->> 'next_cursor';
  end if;
  r  := api.feed('top', null, 10, null);
  perform set_config('role', 'none', true); r2 := core.feed_top('top', null, 10, null); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: Trending wrapper differs from core in mode 0'; end if;
  if r ->> 'next_cursor' is distinct from (r2 ->> 'next_cursor') || '|1|0' then raise exception 'FAIL: Trending cursor tail in mode 0'; end if;
  r  := api.feed('latest', null, 10, null);
  perform set_config('role', 'none', true); r2 := core.feed_top('latest', null, 10, null); perform set_config('role', 'authenticated', true);
  if r is distinct from r2 then raise exception 'FAIL: Latest changed'; end if;
  perform set_config('role', 'none', true);
  if exists (select 1 from core.ml_pages where user_id = ua) then raise exception 'FAIL: pages logged in mode 0'; end if;

  -- ---- 4. mode 1: same output, one page row per call ------------------------------------------------
  update core.rank_params set value = 1 where key in ('foryou_ml_mode', 'trending_ml_mode');
  perform set_config('role', 'authenticated', true);
  r  := api.feed_for_you(c0, 10);
  perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(c0, 10); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: For you wrapper differs from core in mode 1'; end if;
  if not r ? 'page_id' then raise exception 'FAIL: no page_id in mode 1'; end if;
  pg := (r ->> 'page_id')::uuid;
  perform set_config('role', 'none', true);
  select count(*) into n from core.ml_pages where user_id = ua;
  if n <> 1 then raise exception 'FAIL: % page rows after one For you call', n; end if;
  if (select card_ids from core.ml_pages where page_id = pg)
       is distinct from array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') with ordinality q(x, o) order by o)
     or (select surface || '/' || ranker || '/' || ml_mode || '/' || page_no from core.ml_pages where page_id = pg) <> 'for_you/fy-formula-v4/1/0'
     or (select cardinality(live_scores) from core.ml_pages where page_id = pg) <> jsonb_array_length(r -> 'items') then
    raise exception 'FAIL: For you page row wrong';
  end if;
  cur := r ->> 'next_cursor';
  if split_part(cur, '|', 7) <> '' or split_part(cur, '|', 8) <> '1' or split_part(cur, '|', 9) <> '1' then
    raise exception 'FAIL: For you cursor layout %', cur;
  end if;
  -- page 2 with the new cursor
  perform set_config('role', 'authenticated', true);
  r  := api.feed_for_you(cur, 10);
  perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(cur, 10); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: For you page 2 wrapper differs from core'; end if;
  if r ->> 'next_cursor' is distinct from (r2 ->> 'next_cursor') || '||2|1' then raise exception 'FAIL: For you page 2 cursor %', r ->> 'next_cursor'; end if;
  perform set_config('role', 'none', true);
  if (select page_no from core.ml_pages where page_id = (r ->> 'page_id')::uuid) <> 1 then raise exception 'FAIL: page 2 page_no'; end if;
  -- old-format For you cursor (6 fields) gives the same page as before and reads as page 0
  perform set_config('role', 'authenticated', true);
  perform set_config('role', 'none', true); cur := core.feed_for_you_v5(c0, 10) ->> 'next_cursor'; perform set_config('role', 'authenticated', true);
  r  := api.feed_for_you(cur, 10);
  perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(cur, 10); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: old For you cursor gives a different page'; end if;
  if r ->> 'next_cursor' is distinct from (r2 ->> 'next_cursor') || '||1|1' then raise exception 'FAIL: old For you cursor tail'; end if;
  perform set_config('role', 'none', true);
  if (select page_no from core.ml_pages where page_id = (r ->> 'page_id')::uuid) <> 0 then raise exception 'FAIL: old cursor page_no'; end if;

  -- Trending: same output, logged; old 5-field cursor works; Latest and topic pages are not logged
  perform set_config('role', 'authenticated', true);
  r  := api.feed('top', null, 10, null);
  perform set_config('role', 'none', true); r2 := core.feed_top('top', null, 10, null); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' or not r ? 'page_id' then raise exception 'FAIL: Trending mode 1'; end if;
  if r ->> 'next_cursor' is distinct from (r2 ->> 'next_cursor') || '|1|1' then raise exception 'FAIL: Trending cursor layout'; end if;
  pgb := (r ->> 'page_id')::uuid;
  cur := r2 ->> 'next_cursor';                                            -- old 5-field cursor
  r  := api.feed('top', cur, 10, null);
  perform set_config('role', 'none', true); r2 := core.feed_top('top', cur, 10, null); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: old Trending cursor gives a different page'; end if;
  if (r ->> 'next_cursor') is distinct from (r2 ->> 'next_cursor') || '|1|1' then raise exception 'FAIL: old Trending cursor tail'; end if;
  -- full Trending scroll through the wrapper: no repeats, no gaps
  seen := '{}'; cur := null; n := 0;
  loop
    r := api.feed('top', cur, 10, null);
    seen := seen || array(select x ->> 'id' from jsonb_array_elements(r -> 'items') x);
    cur := r ->> 'next_cursor'; n := n + 1;
    exit when cur is null or n > 10;
  end loop;
  if cardinality(seen) <> 36 or (select count(distinct s) from unnest(seen) s) <> 36 then
    raise exception 'FAIL: Trending scroll through the wrapper: % cards, % distinct', cardinality(seen), (select count(distinct s) from unnest(seen) s);
  end if;
  r := api.feed('latest', null, 10, null);
  if r ? 'page_id' then raise exception 'FAIL: Latest logged'; end if;
  r := api.feed('top', null, 10, 'markets');
  if r ? 'page_id' then raise exception 'FAIL: topic page logged'; end if;
  perform set_config('role', 'none', true);
  if (select surface || '/' || ranker || '/' || page_no from core.ml_pages where page_id = pgb) <> 'trending/tr-formula-v2/0' then
    raise exception 'FAIL: Trending page row';
  end if;
  if (select live_scores[1] from core.ml_pages where page_id = pgb) <> (select rank_score from core.blurbs where id = cards[1]) then
    raise exception 'FAIL: Trending live_scores';
  end if;

  -- guests: no page_id, nothing stored; For you stays signed-in only
  perform set_config('role', 'none', true);
  select count(*) into n from core.ml_pages;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  r := api.feed('top', null, 10, null);
  if r ? 'page_id' then raise exception 'FAIL: guest Trending page logged'; end if;
  ok := false; begin perform api.feed_for_you(null, 10); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: anon can call api.feed_for_you'; end if;
  perform set_config('role', 'none', true);
  if (select count(*) from core.ml_pages) <> n then raise exception 'FAIL: guest call stored a page'; end if;

  -- ---- 5. mode 2 behaves like mode 1 (log only, never re-rank) ---------------------------------------
  update core.rank_params set value = 2 where key in ('foryou_ml_mode', 'trending_ml_mode');
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r  := api.feed_for_you(c0, 10);
  perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(c0, 10); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: mode 2 changed For you'; end if;
  if split_part(r ->> 'next_cursor', '|', 9) <> '1' then raise exception 'FAIL: mode 2 not stored as 1 in the cursor'; end if;
  pg := (r ->> 'page_id')::uuid;
  r  := api.feed('top', null, 10, null);
  perform set_config('role', 'none', true); r2 := core.feed_top('top', null, 10, null); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: mode 2 changed Trending'; end if;
  perform set_config('role', 'none', true);
  if (select ml_mode from core.ml_pages where page_id = pg) <> 1 then raise exception 'FAIL: mode 2 logged as %', (select ml_mode from core.ml_pages where page_id = pg); end if;
  update core.rank_params set value = 1 where key in ('foryou_ml_mode', 'trending_ml_mode');

  -- the flag is the kill switch: a mode-1 cursor after the flag goes to 0 logs nothing (cursor keeps its mode)
  update core.rank_params set value = 0 where key = 'foryou_ml_mode';
  perform set_config('role', 'authenticated', true);
  perform set_config('role', 'none', true); cur := (core.feed_for_you_v5(c0, 10) ->> 'next_cursor') || '||1|1'; perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(cur, 10);
  if r ? 'page_id' or split_part(r ->> 'next_cursor', '|', 9) <> '1' then raise exception 'FAIL: kill switch or frozen cursor mode'; end if;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 1 where key = 'foryou_ml_mode';

  -- ---- 6. a failing log insert never breaks the feed ---------------------------------------------
  alter table core.ml_pages add constraint ml_pages_force_fail check (false) not valid;
  perform set_config('role', 'authenticated', true);
  r  := api.feed_for_you(c0, 10);
  perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(c0, 10); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' or r ? 'page_id' then raise exception 'FAIL: For you with a failing insert'; end if;
  r  := api.feed('top', null, 10, null);
  perform set_config('role', 'none', true); r2 := core.feed_top('top', null, 10, null); perform set_config('role', 'authenticated', true);
  if r -> 'items' is distinct from r2 -> 'items' or r ? 'page_id' then raise exception 'FAIL: Trending with a failing insert'; end if;
  perform set_config('role', 'none', true);
  alter table core.ml_pages drop constraint ml_pages_force_fail;

  -- ---- 7. per-reader cap (60 pages per hour) and page size limit ------------------------------------
  insert into core.ml_pages (user_id, surface, ranker, ml_mode, as_of, card_ids, live_scores)
  select ua, 'for_you', 'test', 1, now(), array[cards[1]], array[0::numeric] from generate_series(1, 60);
  select count(*) into n from core.ml_pages where user_id = ua;
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(c0, 10);
  if r ? 'page_id' or jsonb_array_length(r -> 'items') <> 10 then raise exception 'FAIL: cap not applied'; end if;
  r := api.feed('top', null, 10, null);
  if r ? 'page_id' or jsonb_array_length(r -> 'items') <> 10 then raise exception 'FAIL: Trending cap not applied'; end if;
  perform set_config('role', 'none', true);
  if (select count(*) from core.ml_pages where user_id = ua) <> n then raise exception 'FAIL: page stored over the cap'; end if;
  delete from core.ml_pages where user_id = ua and ranker = 'test';
  ok := false;
  begin
    insert into core.ml_pages (user_id, surface, ranker, ml_mode, as_of, card_ids, live_scores)
    select ua, 'for_you', 'test', 1, now(), array_agg(cards[1]), array_agg(0::numeric) from generate_series(1, 61);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: a 61-card page was accepted'; end if;
  ok := false;
  begin
    insert into core.ml_pages (user_id, surface, ranker, ml_mode, as_of, card_ids, live_scores)
    values (ua, 'for_you', 'test', 1, now(), array[cards[1], cards[2]], array[0::numeric]);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: misaligned live_scores accepted'; end if;

  -- ---- 8. api.track positions ------------------------------------------------------------------
  insert into core.ml_pages (user_id, surface, ranker, ml_mode, as_of, card_ids, live_scores)
  values (ub, 'for_you', 'test', 1, now(), array[cards[1]], array[0::numeric]) returning page_id into pgb;   -- B's page
  update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode');
  perform set_config('role', 'authenticated', true);
  perform api.track(cards[20], 'view', null, pg, 3, 'for_you');
  perform set_config('role', 'none', true);
  if (select row(page_id, slot, surface) is distinct from row(null::uuid, null::smallint, null::text)
        from core.user_events where user_id = ua and blurb_id = cards[20] and kind = 'view') then
    raise exception 'FAIL: mode 0 stored a position';
  end if;
  update core.rank_params set value = 1 where key = 'trending_ml_mode';          -- either mode on is enough
  perform set_config('role', 'authenticated', true);
  perform api.track(cards[21], 'view', null, pg, 3, 'for_you');
  perform api.track(cards[22], 'view', null, pgb, 4, 'trending');                 -- someone else's page
  perform api.track(cards[23], 'view', null, null, 900, 'bogus');                 -- out of range / unknown
  perform api.track(cards[24], 'like', null, pg, 3, 'for_you');                   -- not a view
  perform api.track(cards[25], 'view');                                           -- 2-argument call
  perform api.track(cards[26], 'dwell', 5000);                                    -- 3-argument call
  perform api.track(cards[21], 'view', null, pg, 7, 'trending');                  -- deduped: first view keeps its slot
  perform set_config('role', 'none', true);
  select string_agg(coalesce(e.page_id::text = pg::text, false)::text || '/' || coalesce(e.slot::text, '-') || '/' || coalesce(e.surface, '-'), ','
                    order by array_position(cards, e.blurb_id))
    into got from core.user_events e where e.user_id = ua and e.blurb_id = any (cards[21:26]);
  if got is distinct from 'true/3/for_you,false/4/trending,false/-/-,false/-/-,false/-/-,false/-/-' then
    raise exception 'FAIL: track positions: %', got;
  end if;
  if exists (select 1 from core.user_events where user_id = ua and blurb_id = cards[22] and page_id is not null) then
    raise exception 'FAIL: foreign page stored';
  end if;
  ok := false;
  begin
    insert into core.user_events (user_id, blurb_id, kind, slot) values (ua, cards[27], 'like', 1);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: slot on a non-view row accepted'; end if;

  -- ---- 9. service RPCs: shadow and appeal rows, runs -----------------------------------------------
  r := api.ml_write_shadow(jsonb_build_array(
         jsonb_build_object('page_id', pgb, 'model_version', 'test-v1', 'ml_rank', array[0], 'utility', array[0.5],
                            'p_like', array[0.1], 'p_dislike', array[0.01], 'p_detail', array[0.2], 'completion', array[0.9],
                            'conf', 0.5, 'why', array[2], 'ml_top_ids', array[cards[1], cards[2]]),
         jsonb_build_object('page_id', pgb, 'model_version', 'test-bad', 'ml_rank', array[0, 1], 'utility', array[0.5],
                            'p_like', array[0.1], 'p_dislike', array[0.01], 'p_detail', array[0.2], 'completion', array[0.9],
                            'conf', 0.5, 'why', array[2], 'ml_top_ids', array[cards[1]]),
         jsonb_build_object('page_id', gen_random_uuid(), 'model_version', 'test-v1', 'ml_rank', array[0], 'utility', array[0.5],
                            'p_like', array[0.1], 'p_dislike', array[0.01], 'p_detail', array[0.2], 'completion', array[0.9],
                            'conf', 0.5, 'why', array[2], 'ml_top_ids', array[cards[1]])));
  if r is distinct from '{"written": 1, "skipped": 2}'::jsonb then raise exception 'FAIL: ml_write_shadow %', r; end if;
  ok := false; begin perform api.ml_begin_run('live', 'x'); exception when sqlstate 'PT422' then ok := true; end;
  if not ok then raise exception 'FAIL: live runs must be refused'; end if;
  run := api.ml_begin_run('appeal', 'test-v1', '{"k":30}');
  r := api.ml_write_appeal(run, jsonb_build_array(
         jsonb_build_object('blurb_id', cards[1], 'appeal', 0.4, 'za', 1.2, 'n_readers', 3),
         jsonb_build_object('blurb_id', cards[2], 'appeal', 0.4, 'za', 5, 'n_readers', 3),
         jsonb_build_object('blurb_id', gen_random_uuid(), 'appeal', 0.4, 'za', 1, 'n_readers', 3)));
  if r is distinct from '{"written": 1, "skipped": 2}'::jsonb then raise exception 'FAIL: ml_write_appeal %', r; end if;
  ok := false; begin perform api.ml_finish_run(run, 'done'); exception when sqlstate 'PT422' then ok := true; end;
  if not ok then raise exception 'FAIL: bad run status accepted'; end if;
  r := api.ml_finish_run(run, 'ok', 2, 1);
  if r ->> 'status' <> 'ok' or not (r -> 'purge') ? 'db_mb' then raise exception 'FAIL: ml_finish_run %', r; end if;
  ok := false; begin perform api.ml_write_appeal(run, '[]'); exception when sqlstate 'PT422' then ok := true; end;
  if not ok then raise exception 'FAIL: wrote to a finished run'; end if;

  -- ---- 10. purge: pages after 21 days (shadow cascades), runs beyond 3 per kind, events only when on ----
  insert into core.ml_pages (user_id, surface, ranker, ml_mode, as_of, card_ids, live_scores, shown_at) values
    (ub, 'trending', 'old22', 1, now(), array[cards[1]], array[0::numeric], now() - interval '22 days'),
    (ub, 'trending', 'old20', 1, now(), array[cards[1]], array[0::numeric], now() - interval '20 days');
  insert into core.ml_shadow (page_id, model_version, ml_rank, utility, p_like, p_dislike, p_detail, completion, conf, why, ml_top_ids)
  select page_id, 'test-old', '{0}', '{0}', '{0}', '{0}', '{0}', '{0}', 0, '{0}', '{}' from core.ml_pages where ranker = 'old22';
  insert into core.user_events (user_id, blurb_id, kind, created_at) values
    (ub, cards[30], 'view', now() - interval '61 days'), (ub, cards[31], 'view', now() - interval '20 days');
  delete from core.ml_runs;
  for i in 1 .. 5 loop perform api.ml_begin_run('shadow', 'test-' || i); end loop;
  r := api.ml_purge();
  if exists (select 1 from core.ml_pages where ranker = 'old22') or not exists (select 1 from core.ml_pages where ranker = 'old20')
     or exists (select 1 from core.ml_shadow where model_version = 'test-old') then
    raise exception 'FAIL: page purge %', r;
  end if;
  if (select count(*) from core.user_events where user_id = ub and blurb_id in (cards[30], cards[31])) <> 2 then
    raise exception 'FAIL: events purged while ml_purge_events_days = 0';
  end if;
  if (select string_agg(model_version, ',' order by run_id) from core.ml_runs) <> 'test-3,test-4,test-5' then
    raise exception 'FAIL: run trim kept %', (select string_agg(model_version, ',' order by run_id) from core.ml_runs);
  end if;
  update core.rank_params set value = 60 where key = 'ml_purge_events_days';
  r := api.ml_purge();
  if exists (select 1 from core.user_events where user_id = ub and blurb_id = cards[30])
     or not exists (select 1 from core.user_events where user_id = ub and blurb_id = cards[31]) then
    raise exception 'FAIL: 60-day event purge %', r;
  end if;
  update core.rank_params set value = 0 where key = 'ml_purge_events_days';
  -- storage stop rule: over ml_db_stop_mb both modes go to 0
  update core.rank_params set value = 1 where key in ('foryou_ml_mode', 'trending_ml_mode');
  update core.rank_params set value = 0 where key = 'ml_db_stop_mb';
  r := api.ml_purge();
  if not (r ->> 'stopped')::boolean or exists (select 1 from core.rank_params where key in ('foryou_ml_mode', 'trending_ml_mode') and value <> 0) then
    raise exception 'FAIL: storage stop rule %', r;
  end if;
  update core.rank_params set value = 400 where key = 'ml_db_stop_mb';
  r := api.ml_purge();
  if (r ->> 'stopped')::boolean then raise exception 'FAIL: stop rule fired under 400 MB (db_mb %)', r ->> 'db_mb'; end if;

  -- ---- 11. paged export: keyset, no repeats, at most 5000 rows, ids only ------------------------------
  insert into core.user_events (user_id, blurb_id, kind, created_at)
  select ub, cards[1 + (g % 36)], 'view', now() - interval '2 hours' + make_interval(secs => g) from generate_series(1, 5001) g;
  select count(*) into n from core.user_events where created_at >= now() - interval '3 hours';
  r := api.ml_export('events', now() - interval '3 hours', null, 10000);
  if jsonb_array_length(r -> 'rows') <> 5000 or r ->> 'next' is null then raise exception 'FAIL: export limit cap'; end if;
  if (select string_agg(k, ',' order by k) from jsonb_object_keys(r -> 'rows' -> 0) k)
     <> 'blurb_id,created_at,dwell_ms,id,kind,page_id,slot,surface,user_id' then
    raise exception 'FAIL: export row keys %', (select string_agg(k, ',' order by k) from jsonb_object_keys(r -> 'rows' -> 0) k);
  end if;
  seen := '{}'; cur := null; i := 0;
  loop
    r := api.ml_export('events', now() - interval '3 hours', cur, 2000);
    seen := seen || array(select x ->> 'id' from jsonb_array_elements(r -> 'rows') x);
    cur := r ->> 'next'; i := i + 1;
    exit when cur is null or i > 10;
  end loop;
  if cardinality(seen) <> n or (select count(distinct s) from unnest(seen) s) <> n then
    raise exception 'FAIL: paged event export % rows (% distinct), expected %', cardinality(seen), (select count(distinct s) from unnest(seen) s), n;
  end if;
  select count(*) into n from core.ml_pages where shown_at >= now() - interval '30 days';
  seen := '{}'; cur := null; i := 0;
  loop
    r := api.ml_export('pages', now() - interval '30 days', cur, 1);
    seen := seen || array(select x ->> 'page_id' from jsonb_array_elements(r -> 'rows') x);
    cur := r ->> 'next'; i := i + 1;
    exit when cur is null or i > 100;
  end loop;
  if cardinality(seen) <> n or (select count(distinct s) from unnest(seen) s) <> n then raise exception 'FAIL: paged page export'; end if;
  perform set_config('role', 'authenticated', true);
  perform api.set_prefs(array['world'], null);
  perform set_config('role', 'none', true);
  r := api.ml_export('prefs', now() - interval '1 day');
  if not exists (select 1 from jsonb_array_elements(r -> 'rows') x where (x ->> 'user_id')::uuid = ua) or r::text ilike '%@example.com%' then
    raise exception 'FAIL: prefs export';
  end if;
  ok := false; begin perform api.ml_export('emails', now()); exception when sqlstate 'PT422' then ok := true; end;
  if not ok then raise exception 'FAIL: unknown export kind accepted'; end if;

  -- ---- 12. deletion removes page records; return shapes unchanged -----------------------------------
  insert into core.ml_shadow (page_id, model_version, ml_rank, utility, p_like, p_dislike, p_detail, completion, conf, why, ml_top_ids)
  select page_id, 'test-del', '{0}', '{0}', '{0}', '{0}', '{0}', '{0}', 0, '{0}', '{}' from core.ml_pages where user_id = ua limit 1;
  perform set_config('role', 'authenticated', true);
  r := api.delete_my_data();
  perform set_config('role', 'none', true);
  if (select string_agg(k, ',' order by k) from jsonb_object_keys(r) k) <> 'deleted_events,deleted_prefs' then
    raise exception 'FAIL: delete_my_data shape %', r;
  end if;
  if exists (select 1 from core.ml_pages where user_id = ua) or exists (select 1 from core.ml_shadow where model_version = 'test-del') then
    raise exception 'FAIL: delete_my_data left page records';
  end if;
  if not exists (select 1 from core.ml_pages where user_id = ub) then raise exception 'FAIL: setup, B has no pages'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := api.delete_account();
  perform set_config('role', 'none', true);
  if r is distinct from '{"deleted": true}'::jsonb or exists (select 1 from core.ml_pages where user_id = ub)
     or exists (select 1 from core.ml_shadow where model_version = 'test-v1') then
    raise exception 'FAIL: delete_account %', r;
  end if;

  raise exception 'ALL ML_SHADOW CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
