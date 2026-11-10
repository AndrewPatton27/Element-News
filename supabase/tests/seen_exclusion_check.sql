-- =============================================================================
-- seen_exclusion_check.sql: checks for 20261113000000_seen_exclusion.sql (Drew's rules, 2026-11-09)
--   1. a card seen in Trending is not in For you   2. a card seen in For you is not in For you again
--   3. Trending and Latest still list ALL their cards after views   4. Search and Following are unchanged
--   Any view counts toward For you (views are not tab-specific). Followed stories are exempt (ids sent with the
--   For you request, capped). Also: settings; private helpers closed to anon/authenticated; full For you scroll
--   with no repeats, nothing lost, unseen first and seen last newest first (seen_from); an all-seen reader still
--   gets a page; liked and updated cards come back; window and cap; readers do not see each other's data;
--   stable paging with views mid-scroll; modes 0 and 3 (v7, holdout); seen_exclude_mode = 0 is the old behaviour;
--   delete_my_data resets; an error reading the set serves the feed without exclusion.
--
-- Supabase SQL editor: needs the two test users element-test-a@example.com and element-test-b@example.com.
--   expected:     ERROR: ALL SEEN_EXCLUSION CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- =============================================================================

do $$
declare
  ua     uuid;
  ub     uuid;
  base   numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  b      uuid;
  cards  uuid[] := '{}';
  i      int;
  r      jsonb;
  cur    text;
  ok     boolean;
  ids    uuid[];
  tmp    uuid[];
  seenx  uuid[];
  trend  uuid[];
  fyseen uuid[];
  ga     uuid[];
  gb     uuid[];
  fj     jsonb;
  unseen uuid[];
  sf     int;
  n      int;
  tab    text;
  rl     text;
  p1     uuid[];
  p2     uuid[];
  cats   text[] := array['markets', 'world', 'tech', 'policy', 'energy', 'deals'];
  viewed int[] := array[1, 2, 3, 5, 8, 9, 13, 14, 20, 21, 22, 30];
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
  update core.ml_models set gate_passed = false where gate_passed;
  update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode');

  -- ---- 1. settings -------------------------------------------------------------------------------------
  if (select string_agg(key || '=' || value::text, ',' order by key) from core.rank_params where key like 'seen\_exclude%')
     is distinct from 'seen_exclude_days=14,seen_exclude_max=800,seen_exclude_mode=1' then
    raise exception 'FAIL: seen settings are %', (select string_agg(key || '=' || value::text, ',' order by key) from core.rank_params where key like 'seen\_exclude%');
  end if;
  ok := false; begin update core.rank_params set value = 0 where key = 'seen_exclude_days'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: seen_exclude_days accepted 0'; end if;
  ok := false; begin update core.rank_params set value = 2 where key = 'seen_exclude_mode'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: seen_exclude_mode accepted 2'; end if;
  if not exists (select 1 from pg_indexes where indexname = 'user_events_view_idx') then raise exception 'FAIL: view index missing'; end if;

  -- ---- 2. privileges -----------------------------------------------------------------------------------
  foreach rl in array array['anon', 'authenticated'] loop
    perform set_config('role', rl, true);
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', rl)::text, true);
    ok := false; begin perform core.seen_ids(ua, now()); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.seen_ids', rl; end if;
    ok := false; begin perform core.seen_tail(ua, null, null, 10, false); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.seen_tail', rl; end if;
    ok := false; begin perform core.seen_fill('{}'::jsonb, ua, null, 10, false); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.seen_fill', rl; end if;
    perform set_config('role', 'none', true);
  end loop;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  ok := false; begin perform api.feed_for_you(null, 10); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: anon can call api.feed_for_you'; end if;
  ok := false; begin perform api.feed_for_you(null, 10, array[gen_random_uuid()]); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: anon can call api.feed_for_you with followed ids'; end if;
  if has_function_privilege('anon', 'api.feed_for_you(text,integer,uuid[])', 'execute')
     or not has_function_privilege('authenticated', 'api.feed_for_you(text,integer,uuid[])', 'execute') then
    raise exception 'FAIL: grants of the 3-argument api.feed_for_you';
  end if;
  perform api.feed('top', null, 10);                                     -- the guest feed is still open to anon
  perform set_config('role', 'none', true);

  -- ---- 3. data: 30 cards, Trending order = Latest order = card 1 first ------------------------------------
  for i in 1 .. 30 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('seen-' || i, 'summary', 'Seen test story ' || i, cats[1 + (i % 6)], now(),
            now() - make_interval(secs => i * 300), base + 20 - i * 0.5)
    returning id into b;
    cards := cards || b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'Seen source ' || i, 'filing', 'https://www.sec.gov/seen/' || b, 'company_filing', true);
  end loop;
  -- views: odd cards were seen in Trending, even ones in For you, card 30 in Latest (the surface is only a label:
  -- every view counts toward For you)
  foreach i in array viewed loop
    insert into core.user_events (user_id, blurb_id, kind, created_at, surface)
    values (ua, cards[i], 'view', now() - interval '2 hours' - make_interval(secs => i),
            case when i = 30 then 'latest' when i % 2 = 1 then 'trending' else 'for_you' end);
  end loop;
  seenx := array(select cards[x] from unnest(viewed) x);
  trend := array(select cards[x] from unnest(viewed) x where x <> 30 and x % 2 = 1);
  fyseen := array(select cards[x] from unnest(viewed) x where x <> 30 and x % 2 = 0);
  unseen := array(select c from unnest(cards) c where c <> all (seenx));

  -- ---- 4. For you: full scroll, no repeats, nothing lost, unseen first, seen last newest first -------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  ids := '{}'; cur := null; sf := null; n := 0;
  loop
    r := api.feed_for_you(cur, 10);
    if r ->> 'seen_from' is not null and sf is null then sf := cardinality(ids) + (r ->> 'seen_from')::int; end if;
    tmp := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
    if exists (select 1 from unnest(tmp) t where t = any (ids)) then raise exception 'FAIL: For you repeats a card'; end if;
    ids := ids || tmp;
    cur := r ->> 'next_cursor';
    exit when cur is null;
    n := n + 1;
    if n > 12 then raise exception 'FAIL: For you never ends'; end if;
  end loop;
  perform set_config('role', 'none', true);
  if cardinality(ids) <> 30 then raise exception 'FAIL: For you returned % cards, expected all 30', cardinality(ids); end if;
  if sf is distinct from 18 then raise exception 'FAIL: For you seen_from is %, expected 18', sf; end if;
  if exists (select 1 from unnest(ids[1:18]) t where t = any (seenx)) then raise exception 'FAIL: For you shows a seen card before the unseen ones are over'; end if;
  if ids[19:30] is distinct from array(select cards[x] from unnest(viewed) x order by x) then raise exception 'FAIL: For you seen tail is not newest first'; end if;

  -- RULE 1: cards seen in Trending are not in the unseen part of For you
  if exists (select 1 from unnest(ids[1:18]) t where t = any (trend)) then raise exception 'FAIL: rule 1: a card seen in Trending is in For you'; end if;
  -- RULE 2: cards seen in For you do not come again in For you
  if exists (select 1 from unnest(ids[1:18]) t where t = any (fyseen)) then raise exception 'FAIL: rule 2: a card seen in For you came again in For you'; end if;
  -- (a view from Latest counts too)
  if cards[30] = any (ids[1:18]) then raise exception 'FAIL: a card seen in Latest is in For you'; end if;

  -- RULE 3: Trending and Latest still list ALL cards, whatever was seen: same lists as a reader with no views,
  -- no seen_from, no tail cursor
  foreach tab in array array['top', 'latest'] loop
    foreach rl in array array['a', 'b'] loop
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims', json_build_object('sub', case when rl = 'a' then ua else ub end, 'role', 'authenticated')::text, true);
      ids := '{}'; cur := null; n := 0;
      loop
        r := api.feed(tab, cur, 10);
        if r ? 'seen_from' then raise exception 'FAIL: rule 3: % has seen_from', tab; end if;
        ids := ids || array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
        cur := r ->> 'next_cursor';
        exit when cur is null;
        if cur like 'S|%' then raise exception 'FAIL: rule 3: % has a tail cursor', tab; end if;
        n := n + 1;
        if n > 12 then raise exception 'FAIL: % never ends', tab; end if;
      end loop;
      perform set_config('role', 'none', true);
      if cardinality(ids) <> 30 or cardinality(array(select distinct x from unnest(ids) x)) <> 30 then raise exception 'FAIL: rule 3: % lost or repeated cards for %', tab, rl; end if;
      if rl = 'a' then ga := ids; else gb := ids; end if;
    end loop;
    if ga is distinct from gb then raise exception 'FAIL: rule 3: % order depends on what the reader saw', tab; end if;
  end loop;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if (api.feed('top', null, 10) -> 'items' -> 0 ->> 'id')::uuid is distinct from cards[1] then raise exception 'FAIL: rule 3: Trending lost a seen card at the top'; end if;
  ok := false;
  begin perform api.feed('top', 'S|2026-01-01T00:00:00.000000Z|' || cards[1], 10); exception when others then ok := sqlerrm = 'invalid_cursor'; end;
  if not ok then raise exception 'FAIL: the seen-tail cursor works on Trending'; end if;
  perform set_config('role', 'none', true);

  -- ---- 5. reader B is not affected by A's views ---------------------------------------------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := api.feed_for_you(null, 30);
  if jsonb_array_length(r -> 'items') <> 30 or r ->> 'seen_from' is not null then raise exception 'FAIL: B is affected by A''s views'; end if;
  perform set_config('role', 'none', true);

  -- ---- 6. guests: Trending and Latest exactly as before -------------------------------------------------------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  r := api.feed('latest', null, 30);
  if jsonb_array_length(r -> 'items') <> 30 or r ? 'seen_from' then raise exception 'FAIL: guest feed changed'; end if;
  perform set_config('role', 'none', true);

  -- ---- 7. RULE 4: Search and Following are not affected (same answer with the feature on and off) ---------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  fj := jsonb_build_object('s', api.search('Seen test story', null, 30), 'f', api.following_feed(cats, '{}', '{}', null, 30));
  perform set_config('role', 'none', true);
  if jsonb_array_length(fj -> 's' -> 'items') <> 30 or jsonb_array_length(fj -> 'f' -> 'items') <> 30 then
    raise exception 'FAIL: rule 4: search % / following % cards, expected 30 / 30', jsonb_array_length(fj -> 's' -> 'items'), jsonb_array_length(fj -> 'f' -> 'items');
  end if;
  update core.rank_params set value = 0 where key = 'seen_exclude_mode';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if fj is distinct from jsonb_build_object('s', api.search('Seen test story', null, 30), 'f', api.following_feed(cats, '{}', '{}', null, 30)) then
    raise exception 'FAIL: rule 4: search or following changed with seen exclusion';
  end if;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 1 where key = 'seen_exclude_mode';

  -- ---- 8. followed stories are exempt (ids come with the For you request, capped) ---------------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  -- followed: card 1 (seen in Trending) and card 2 (seen in For you): both show again; the other seen cards stay out
  r := api.feed_for_you(null, 30, array[cards[1], cards[2]]);
  ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  if (r ->> 'seen_from')::int is distinct from 20 or not (cards[1] = any (ids[1:20]) and cards[2] = any (ids[1:20])) then
    raise exception 'FAIL: followed stories seen in Trending / For you did not show in For you (seen_from %)', r ->> 'seen_from';
  end if;
  if exists (select 1 from unnest(ids[1:20]) t where t = any (seenx) and t <> all (array[cards[1], cards[2]])) then
    raise exception 'FAIL: a non-followed seen card was not excluded';
  end if;
  perform set_config('role', 'none', true);
  -- a linked update of a followed story is exempt too
  insert into core.story_links (card_id, related_id, kind) values (cards[9], cards[1], 'update');
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 30, array[cards[1]]);
  ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  if (r ->> 'seen_from')::int is distinct from 20 or not (cards[9] = any (ids[1:20])) then raise exception 'FAIL: a linked update of a followed story was not exempt'; end if;
  -- the cap: only the first seen_followed_max ids count
  perform set_config('role', 'none', true);
  update core.rank_params set value = 1 where key = 'seen_followed_max';
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 30, array[cards[2], cards[4], cards[6]]);
  if (r ->> 'seen_from')::int is distinct from 19 then raise exception 'FAIL: cap 1 exempted % cards, expected 1', (r ->> 'seen_from')::int - 18; end if;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 0 where key = 'seen_followed_max';
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 30, array[cards[2], cards[4]]);
  if (r ->> 'seen_from')::int is distinct from 18 then raise exception 'FAIL: cap 0 still exempts followed stories'; end if;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 200 where key = 'seen_followed_max';
  delete from core.story_links where card_id = cards[9];
  -- the 2-argument call (old apps) leaves nothing exempt, even after a 3-argument call in the same transaction
  perform set_config('role', 'authenticated', true);
  perform api.feed_for_you(null, 30, array[cards[1]]);
  r := api.feed_for_you(null, 30);
  if (r ->> 'seen_from')::int is distinct from 18 then raise exception 'FAIL: the exemption leaked into a 2-argument call'; end if;
  perform set_config('role', 'none', true);
  -- a malformed list is ignored, never an error
  perform set_config('element.seen_exempt', 'not-a-uuid,1', true);
  if cardinality(core.seen_ids(ua, now())) <> 12 then raise exception 'FAIL: a malformed exempt list changed the seen set'; end if;
  perform set_config('element.seen_exempt', '', true);
  perform set_config('role', 'authenticated', true);
  if jsonb_array_length(api.feed('top', null, 30) -> 'items') <> 30 then raise exception 'FAIL: Trending changed'; end if;
  perform set_config('role', 'none', true);

  -- ---- 9. an all-seen reader still gets a For you page, newest first, seen_from 0, then the end -------------------
  foreach i in array array[4, 6, 7, 10, 11, 12, 15, 16, 17, 18, 19, 23, 24, 25, 26, 27, 28, 29] loop
    insert into core.user_events (user_id, blurb_id, kind, created_at) values (ua, cards[i], 'view', now() - interval '3 hours');
  end loop;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.feed_for_you(null, 10);
  if jsonb_array_length(r -> 'items') <> 10 or (r ->> 'seen_from')::int <> 0 or (r -> 'items' -> 0 ->> 'id')::uuid <> cards[1] then
    raise exception 'FAIL: all-seen first page wrong: % items, seen_from %', jsonb_array_length(r -> 'items'), r ->> 'seen_from';
  end if;
  ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  cur := r ->> 'next_cursor';
  if cur is null or cur not like 'S|%' then raise exception 'FAIL: tail cursor missing'; end if;
  r := api.feed_for_you(cur, 10);
  ids := ids || array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  cur := r ->> 'next_cursor';
  r := api.feed_for_you(cur, 10);
  ids := ids || array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  if ids is distinct from cards or r ->> 'next_cursor' is not null then raise exception 'FAIL: all-seen scroll is not the 30 cards newest first'; end if;
  r := api.feed('latest', null, 30);
  if jsonb_array_length(r -> 'items') <> 30 or r ? 'seen_from' then raise exception 'FAIL: Latest changed when everything is seen'; end if;
  perform set_config('role', 'none', true);

  -- ---- 10. exceptions: a liked card and an updated story come back ---------------------------------------------
  insert into core.user_events (user_id, blurb_id, kind) values (ua, cards[5], 'like');
  update core.blurbs set updated_at = now() - interval '1 hour', revision = 2 where id = cards[7];   -- seen 3 h ago, updated since
  update core.blurbs set updated_at = now() - interval '5 hours', revision = 2 where id = cards[8];  -- updated before it was seen
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.feed_for_you(null, 30);
  ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  if (r ->> 'seen_from')::int is distinct from 2 then raise exception 'FAIL: seen_from is %, expected 2', r ->> 'seen_from'; end if;
  if not (cards[5] = any (ids[1:2]) and cards[7] = any (ids[1:2])) then raise exception 'FAIL: liked/updated cards are not among the unseen ones'; end if;
  if cards[8] = any (ids[1:2]) then raise exception 'FAIL: a card updated before it was seen came back'; end if;
  perform set_config('role', 'none', true);
  delete from core.user_events where user_id = ua and kind = 'like';
  update core.blurbs set updated_at = null, revision = 1 where id in (cards[7], cards[8]);

  -- ---- 11. the window: old views age out; the count cap keeps the newest views ----------------------------------
  update core.user_events set created_at = now() - interval '20 days' where user_id = ua and blurb_id = cards[30];
  if cards[30] = any (core.seen_ids(ua, now())) then raise exception 'FAIL: a 20-day-old view still counts (window 14 days)'; end if;
  if cardinality(core.seen_ids(ua, now())) <> 29 then raise exception 'FAIL: seen set size % expected 29', cardinality(core.seen_ids(ua, now())); end if;
  update core.rank_params set value = 5 where key = 'seen_exclude_max';
  tmp := core.seen_ids(ua, now());
  if cardinality(tmp) <> 5 then raise exception 'FAIL: cap 5 gave % cards', cardinality(tmp); end if;
  if (select array_agg(x order by x) from unnest(tmp) x) is distinct from (select array_agg(c order by c) from unnest(array[cards[1], cards[2], cards[3], cards[5], cards[8]]) c) then
    raise exception 'FAIL: cap kept the wrong cards (not the 5 most recent views)';
  end if;
  update core.rank_params set value = 800 where key = 'seen_exclude_max';

  -- an error while reading the seen set (here: a window so large the date arithmetic overflows) serves the feed
  -- without exclusion instead of failing it (statement timeouts take the same path)
  update core.rank_params set value = 1e15 where key = 'seen_exclude_days';
  if cardinality(core.seen_ids(ua, now())) <> 0 then raise exception 'FAIL: an error in seen_ids did not fall back to an empty set'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if jsonb_array_length(api.feed_for_you(null, 30) -> 'items') <> 30 then raise exception 'FAIL: For you failed when the seen set could not be read'; end if;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 14 where key = 'seen_exclude_days';

  -- ---- 12. paging is stable when views happen in the middle of a For you scroll --------------------------------
  delete from core.user_events where user_id = ua;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.feed_for_you(null, 10);
  p1 := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  cur := r ->> 'next_cursor';
  perform set_config('role', 'none', true);
  -- (created_at = clock_timestamp(): after the scroll started, like a real view; now() is the start of this test)
  insert into core.user_events (user_id, blurb_id, kind, created_at)
    select ua, c, 'view', clock_timestamp() from unnest(p1) c;               -- the reader viewed page 1 ...
  insert into core.user_events (user_id, blurb_id, kind, created_at)
    values (ua, cards[25], 'view', clock_timestamp()), (ua, cards[26], 'view', clock_timestamp());  -- ... and two later cards elsewhere
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(cur, 10);
  p2 := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  if cardinality(p2) <> 10 or exists (select 1 from unnest(p2) t where t = any (p1)) or cards[25] = any (p2) or cards[26] = any (p2) then
    raise exception 'FAIL: For you page 2 after mid-scroll views is wrong (% cards, % repeats)', cardinality(p2), (select count(*) from unnest(p2) t where t = any (p1));
  end if;
  perform set_config('role', 'none', true);
  delete from core.user_events where user_id = ua;

  -- ---- 13. ranking v3 mode and its holdout: exclusion applies to both arms ----------------------------------------
  foreach i in array viewed loop
    insert into core.user_events (user_id, blurb_id, kind, created_at) values (ua, cards[i], 'view', now() - interval '2 hours' - make_interval(secs => i));
  end loop;
  foreach n in array array[0, 100] loop                                    -- 0 % holdout: v7; 100 %: all holdout (v5)
    update core.rank_params set value = 3 where key = 'foryou_ml_mode';
    update core.rank_params set value = n where key = 'v3_holdout_pct';
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    ids := '{}'; cur := null; sf := null; i := 0;
    loop
      r := api.feed_for_you(cur, 10);
      if r ->> 'seen_from' is not null and sf is null then sf := cardinality(ids) + (r ->> 'seen_from')::int; end if;
      tmp := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
      if exists (select 1 from unnest(tmp) t where t = any (ids)) then raise exception 'FAIL: mode 3 (holdout %) repeats a card', n; end if;
      ids := ids || tmp;
      cur := r ->> 'next_cursor';
      exit when cur is null;
      i := i + 1;
      if i > 12 then raise exception 'FAIL: mode 3 never ends'; end if;
    end loop;
    if cardinality(ids) <> 30 or sf is distinct from 18 or exists (select 1 from unnest(ids[1:18]) t where t = any (seenx)) then
      raise exception 'FAIL: mode 3 (holdout %) did not exclude seen cards: % cards, seen_from %', n, cardinality(ids), sf;
    end if;
    -- followed ids work in v7 too
    r := api.feed_for_you(null, 30, array[cards[1]]);
    perform set_config('role', 'none', true);
    if (r ->> 'seen_from')::int is distinct from 19 then raise exception 'FAIL: mode 3 (holdout %) ignores followed ids', n; end if;
  end loop;
  update core.rank_params set value = 0 where key = 'foryou_ml_mode';

  -- ---- 14. seen_exclude_mode = 0 is the old behaviour ------------------------------------------------------------
  update core.rank_params set value = 0 where key = 'seen_exclude_mode';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.feed_for_you(null, 30);
  if jsonb_array_length(r -> 'items') <> 30 or r ->> 'seen_from' is not null or r ->> 'next_cursor' is not null then
    raise exception 'FAIL: mode 0 changed For you';
  end if;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 1 where key = 'seen_exclude_mode';

  -- ---- 15. a topic hidden by the reader stays out of the tail; delete_my_data resets -----------------------------
  insert into core.user_prefs (user_id, hidden_categories) values (ua, array[cats[1 + (1 % 6)]])
    on conflict (user_id) do update set hidden_categories = excluded.hidden_categories;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.feed_for_you(null, 30);
  if exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'category' = cats[1 + (1 % 6)]) then
    raise exception 'FAIL: the seen tail shows a hidden topic';
  end if;
  perform api.delete_my_data();
  r := api.feed_for_you(null, 30);
  if jsonb_array_length(r -> 'items') <> 30 or r ->> 'seen_from' is not null then raise exception 'FAIL: delete_my_data did not reset the seen set'; end if;
  perform set_config('role', 'none', true);

  raise exception 'ALL SEEN_EXCLUSION CHECKS PASSED (test data rolled back on purpose)';
end
$$;
