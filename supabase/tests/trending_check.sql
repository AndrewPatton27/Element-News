-- =============================================================================
-- trending_check.sql: checks for 20261017070000_trending_foryou.sql
--   Trending (api.feed 'top' + engagement boost), Latest, hidden topics, For you v2
--
-- Supabase SQL editor: needs the two test users element-test-a@example.com and
-- element-test-b@example.com (Authentication -> Users -> Add user, "Auto Confirm User").
-- Paste the whole file and run it.
--   expected:     ERROR: ALL TRENDING CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- Signed-in users are simulated as in accounts_check.sql (role + request.jwt.claims).
-- Events are inserted directly (as the owner) to stand in for many api.track calls.
-- =============================================================================

do $$
declare
  ua    uuid;
  ub    uuid;
  base  numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  b     uuid;
  r     jsonb;
  page  jsonb;
  cur   text;
  seen  text[];
  ids   jsonb := '{}';
  got   text;
  ok    boolean;
  n     int;
  i     int;
  k1    text;
  k2    text;
  t0    timestamptz;
  mode  text;
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  if ua is null or ub is null then
    raise exception 'SETUP: create the users element-test-a@example.com and element-test-b@example.com first';
  end if;
  delete from core.user_events where user_id in (ua, ub);
  delete from core.user_prefs  where user_id in (ua, ub);
  update core.blurbs set status = 'hidden' where status = 'published';

  -- FED: importance 10, 2 h old; SMALL: importance 1.6, brand new (19.2 h behind FED);
  -- N1/N2: two close deals cards; F0..F25 fillers (markets/energy) far below
  insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
  values ('tr-FED', 'summary', 'TR FED', 'economy', now(), now() - interval '2 hours', base - 2 + 8 * log(2, 10::numeric))
  returning id into b; ids := ids || jsonb_build_object('FED', b);
  insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
  values ('tr-SMALL', 'summary', 'TR SMALL', 'tech', now(), now(), base + 8 * log(2, 1.6::numeric))
  returning id into b; ids := ids || jsonb_build_object('SMALL', b);
  insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
  values ('tr-N1', 'summary', 'TR N1', 'deals', now(), now() - interval '1 minute', base + 1.0)
  returning id into b; ids := ids || jsonb_build_object('N1', b);
  insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
  values ('tr-N2', 'summary', 'TR N2', 'deals', now(), now() - interval '2 minutes', base + 0.5)
  returning id into b; ids := ids || jsonb_build_object('N2', b);
  for i in 0 .. 25 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('tr-F' || i, 'summary', 'TR F' || i, case when i % 2 = 0 then 'markets' else 'energy' end,
            now(), now() - make_interval(mins => 10 + i), base - 10 - i)
    returning id into b; ids := ids || jsonb_build_object('F' || i, b);
  end loop;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select x.id, 'SEC', 'filing', 'https://www.sec.gov/tr/' || x.id, 'company_filing', true
    from core.blurbs x where x.dedupe_key like 'tr-%';

  -- ---- 1. privileges ----------------------------------------------------------------
  foreach mode in array array['anon', 'authenticated'] loop
    perform set_config('role', mode, true);
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', mode)::text, true);
    ok := false;
    begin perform api.refresh_trending();
    exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.refresh_trending', mode; end if;
    ok := false;
    begin perform count(*) from core.trend_boosts;
    exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can read core.trend_boosts', mode; end if;
  end loop;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  ok := false;
  begin perform api.my_categories();
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: anon can call api.my_categories'; end if;

  -- ---- 2. before any engagement: importance x recency -------------------------------
  select string_agg(replace(x->>'headline', 'TR ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed('top', null, 10) -> 'items') with ordinality as t(x, o)
   where x->>'headline' in ('TR FED', 'TR SMALL', 'TR N1', 'TR N2');   -- relative order (breadth may slot cards between)
  if got is distinct from 'FED,SMALL,N1,N2' then raise exception 'FAIL: trending order before engagement is %', got; end if;
  if (select count(*) from jsonb_array_elements(api.feed() -> 'items')) <> 20 then
    raise exception 'FAIL: api.feed() with defaults (old app call) broke';
  end if;

  -- ---- 3. engagement from both users, then a refresh --------------------------------
  perform set_config('role', 'none', true);
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms)
  select u, (ids->>'SMALL')::uuid, k, case when k = 'dwell' then 9000 end
    from unnest(array[ua, ub]) u, unnest(array['view', 'like', 'open_detail', 'open_source', 'dwell']) k;
  insert into core.user_events (user_id, blurb_id, kind)                   -- N2: two likes
  select u, (ids->>'N2')::uuid, 'like' from unnest(array[ua, ub]) u;
  insert into core.user_events (user_id, blurb_id, kind)                   -- F1: one keen user only
  select ua, (ids->>'F1')::uuid, k from unnest(array['like', 'open_detail', 'open_source']) k;
  insert into core.user_events (user_id, blurb_id, kind)                   -- F2: two dislikes
  select u, (ids->>'F2')::uuid, 'dislike' from unnest(array[ua, ub]) u;
  r := core.refresh_trending();
  if (r->>'boosted')::int <> 3 then raise exception 'FAIL: refresh boosted % cards, expected 3 (SMALL, N2, F2): %', r->>'boosted', r; end if;

  perform set_config('role', 'anon', true);
  select string_agg(replace(x->>'headline', 'TR ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed('top', null, 10) -> 'items') with ordinality as t(x, o)
   where x->>'headline' in ('TR FED', 'TR SMALL', 'TR N1', 'TR N2');   -- relative order (breadth may slot cards between)
  -- SMALL gets ~+4 h (16.4 points), still ~15 h behind FED: importance dominates.
  -- N2 (+2.6 h for two likes) passes N1.
  if got is distinct from 'FED,SMALL,N2,N1' then raise exception 'FAIL: trending order after engagement is %', got; end if;
  perform set_config('role', 'none', true);
  select max(boost) into k1 from core.trend_boosts where gen = (r->>'generation')::bigint;
  if k1::numeric > 6 or k1::numeric < 3.9 then raise exception 'FAIL: top boost % outside 3.9..6', k1; end if;
  if exists (select 1 from core.trend_boosts where blurb_id = (ids->>'F1')::uuid) then
    raise exception 'FAIL: a card with only one interested user got a boost';
  end if;
  if (select boost from core.trend_boosts where gen = (r->>'generation')::bigint and blurb_id = (ids->>'F2')::uuid) >= 0 then
    raise exception 'FAIL: two dislikes did not give a negative boost';
  end if;
  -- refresh again with nothing new: same boosts, new generation; old generations are trimmed
  for i in 1 .. 7 loop perform core.refresh_trending(); end loop;
  if (select count(*) from core.trend_generations) > 6 then raise exception 'FAIL: old trend generations not trimmed'; end if;

  -- ---- 4. Trending paging across a refresh: no repeats, nothing skipped -------------
  perform set_config('role', 'anon', true);
  page := api.feed('top', null, 10);
  seen := array(select x->>'id' from jsonb_array_elements(page->'items') x);
  cur  := page->>'next_cursor';
  if split_part(cur, '|', 3) !~ '^[0-9]+$' then raise exception 'FAIL: trending cursor has no generation: %', cur; end if;
  -- F8 is on page 2; both users now love it (+~4 h would lift it into page 1's range)
  perform set_config('role', 'none', true);
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms)
  select u, (ids->>'F8')::uuid, k, case when k = 'dwell' then 9000 end
    from unnest(array[ua, ub]) u, unnest(array['view', 'like', 'open_detail', 'open_source', 'dwell']) k;
  perform core.refresh_trending();
  perform set_config('role', 'anon', true);
  loop
    page := api.feed('top', cur, 10);
    for r in select value from jsonb_array_elements(page->'items') loop
      if (r->>'id') = any (seen) then raise exception 'FAIL: trending paging repeated % across a refresh', r->>'headline'; end if;
      seen := seen || (r->>'id');
    end loop;
    cur := page->>'next_cursor';
    exit when cur is null or cardinality(seen) > 100;
  end loop;
  if cardinality(seen) <> 30 then raise exception 'FAIL: trending paging across a refresh returned % cards, expected 30', cardinality(seen); end if;
  -- a fresh first page uses the new generation: F8 is now in the top 10
  if not exists (select 1 from jsonb_array_elements(api.feed('top', null, 10)->'items') x where x->>'headline' = 'TR F8') then
    raise exception 'FAIL: a fresh trending page does not show the newly boosted card';
  end if;
  -- an old 2-part cursor (older app build) still works
  page := api.feed('top', (base + 100)::text || '|ffffffff-ffff-ffff-ffff-ffffffffffff', 10);
  if jsonb_array_length(page->'items') <> 10 then raise exception 'FAIL: 2-part trending cursor broke'; end if;

  -- ---- 5. Latest is newest first --------------------------------------------------------
  seen := '{}'; cur := null; k1 := null;
  loop
    page := api.feed('latest', cur, 10);
    for r in select value from jsonb_array_elements(page->'items') loop
      if k1 is not null and (r->>'sort_at')::timestamptz > k1::timestamptz then
        raise exception 'FAIL: latest is not newest first at %', r->>'headline';
      end if;
      k1 := r->>'sort_at';
      seen := seen || (r->>'id');
    end loop;
    cur := page->>'next_cursor';
    exit when cur is null or cardinality(seen) > 100;
  end loop;
  if cardinality(seen) <> 30 or cardinality(seen) <> (select count(distinct x) from unnest(seen) x) then
    raise exception 'FAIL: latest paging returned % cards (expected 30, no repeats)', cardinality(seen);
  end if;

  -- ---- 6. hidden topics (signed in) vs anon ------------------------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform api.set_prefs(null, array['energy']);
  r := api.my_categories();
  if not exists (select 1 from jsonb_array_elements(r) x where x->>'slug' = 'energy' and (x->>'hidden')::boolean)
     or exists (select 1 from jsonb_array_elements(r) x where x->>'slug' = 'markets' and (x->>'hidden')::boolean) then
    raise exception 'FAIL: my_categories flags wrong: %', r;
  end if;
  foreach mode in array array['top', 'latest'] loop
    seen := '{}'; cur := null;
    loop
      page := api.feed(mode, cur, 10);
      for r in select value from jsonb_array_elements(page->'items') loop
        if r->>'category' = 'energy' then raise exception 'FAIL: hidden topic shown to A in %', mode; end if;
        if (r->>'id') = any (seen) then raise exception 'FAIL: % repeated for A', mode; end if;
        seen := seen || (r->>'id');
      end loop;
      cur := page->>'next_cursor';
      exit when cur is null or cardinality(seen) > 100;
    end loop;
    if cardinality(seen) <> 17 then raise exception 'FAIL: A got % cards in %, expected 17 (30 - 13 energy)', cardinality(seen), mode; end if;
  end loop;
  if jsonb_array_length(api.feed('top', null, 10, 'energy')->'items') <> 0 then
    raise exception 'FAIL: hidden topic returned through p_category';
  end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  if jsonb_array_length(api.feed('latest', null, 30, 'energy')->'items') <> 13 then
    raise exception 'FAIL: anon lost energy cards';
  end if;

  -- ---- 7. card keys: feed == feed_for_you minus my_reaction; detail present ------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select string_agg(key, ',' order by key) into k1 from jsonb_object_keys(api.feed_for_you(null, 10)->'items'->0) key;
  select string_agg(key, ',' order by key) into k2
    from jsonb_object_keys((api.feed('top', null, 10)->'items'->0) || '{"my_reaction":null}'::jsonb) key;
  if k1 is distinct from k2 then raise exception 'FAIL: card keys differ: % vs %', k1, k2; end if;
  if k1 not like '%detail%' then raise exception 'FAIL: detail key missing'; end if;
  if (api.feed('top', null, 10)->'items'->0) ? 'my_reaction' then raise exception 'FAIL: api.feed leaks my_reaction'; end if;

  -- ---- 8. For you paging with fresh signals and a new card mid-scroll ------------------
  t0 := clock_timestamp();
  page := api.feed_for_you(null, 10);
  seen := array(select x->>'id' from jsonb_array_elements(page->'items') x);
  cur  := page->>'next_cursor';
  perform set_config('role', 'none', true);
  -- A reads every card on page 1 after it was served (each would now be -100 h) ...
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at)
  select ua, x::uuid, 'dwell', 9000, clock_timestamp() from unnest(seen) x;
  -- ... and a big new card is published
  insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, published_at, rank_score)
  values ('tr-NEW', 'summary', 'TR NEW', 'markets', now(), now(), clock_timestamp(), base + 50);
  perform set_config('role', 'authenticated', true);
  loop
    page := api.feed_for_you(cur, 10);
    for r in select value from jsonb_array_elements(page->'items') loop
      if (r->>'id') = any (seen) then raise exception 'FAIL: for-you repeated % during a scroll', r->>'headline'; end if;
      if r->>'headline' = 'TR NEW' then raise exception 'FAIL: new card jumped into a running scroll'; end if;
      if r->>'category' = 'energy' then raise exception 'FAIL: hidden topic in For you'; end if;
      seen := seen || (r->>'id');
    end loop;
    cur := page->>'next_cursor';
    exit when cur is null or cardinality(seen) > 100;
  end loop;
  -- 17 non-energy cards, minus F2 (A disliked it)
  if cardinality(seen) <> 16 then raise exception 'FAIL: for-you scroll returned % cards, expected 16', cardinality(seen); end if;
  -- a fresh first page sees the new card and the reads
  page := api.feed_for_you(null, 30);
  if page->'items'->0->>'headline' <> 'TR NEW' then raise exception 'FAIL: refreshed For you does not start with the new card'; end if;
  -- an old 2-part cursor still works
  if jsonb_typeof(api.feed_for_you((base + 100)::text || '|ffffffff-ffff-ffff-ffff-ffffffffffff', 10)->'items') <> 'array' then
    raise exception 'FAIL: 2-part for-you cursor broke';
  end if;
  ok := false;
  begin perform api.feed_for_you('garbage', 10);
  exception when others then ok := sqlerrm = 'invalid_cursor'; end;
  if not ok then raise exception 'FAIL: bad for-you cursor accepted'; end if;

  -- ---- 9. no more than 2 in a row from one topic while another topic is still available ---
  -- (13 of A's 16 cards are markets, so the tail is allowed to be markets only)
  select array_agg(x->>'category' order by o) into seen
    from jsonb_array_elements(api.feed_for_you(null, 30)->'items') with ordinality as t(x, o);
  for i in 3 .. coalesce(cardinality(seen), 0) loop
    if seen[i] = seen[i-1] and seen[i] = seen[i-2]
       and exists (select 1 from unnest(seen[i:]) c where c <> seen[i]) then
      raise exception 'FAIL: 3 in a row from % while other topics remain: %', seen[i], array_to_string(seen, ',');
    end if;
  end loop;

  -- ---- 10. cold start = Trending order, followed topic boosted --------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  perform set_config('role', 'none', true);
  delete from core.user_events where user_id = ub;            -- boosts already stored stay
  perform set_config('role', 'authenticated', true);
  if api.feed_for_you(null, 10)->'items'->0->>'headline' <> 'TR NEW'
     or api.feed_for_you(null, 10)->'items'->1->>'headline' <> 'TR FED' then
    raise exception 'FAIL: cold start does not follow Trending';
  end if;
  perform api.set_prefs(array['energy'], null);
  select o into n from jsonb_array_elements(api.feed_for_you(null, 30)->'items') with ordinality as t(x, o) where x->>'headline' = 'TR F1';
  select o into i from jsonb_array_elements(api.feed('top', null, 30)->'items') with ordinality as t(x, o) where x->>'headline' = 'TR F1';
  if n >= i then raise exception 'FAIL: following energy did not move F1 up (% vs Trending %)', n, i; end if;

  -- ---- 11. users cannot see each other's data -------------------------------------------
  if (api.get_prefs()->'hidden_categories') <> '[]'::jsonb then raise exception 'FAIL: B sees A''s hidden topics'; end if;
  if exists (select 1 from jsonb_array_elements(api.feed('latest', null, 30)->'items') x where x->>'category' = 'energy') is not true then
    raise exception 'FAIL: A''s hidden topic was applied to B';
  end if;

  -- ---- 12. breadth: 5 bank earnings + 5 earthquakes + others (Trending and For you) ------
  perform set_config('role', 'none', true);
  update core.blurbs set status = 'hidden' where dedupe_key like 'tr-%';
  delete from core.trend_generations;                                   -- no boosts for this part
  for i in 1 .. 5 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, event_type, tickers, as_of, sort_at, rank_score)
    values ('br-E' || i, 'summary', 'BR E' || i, 'earnings', 'earnings',
            jsonb_build_array(jsonb_build_object('symbol', (array['JPM','BAC','WFC','C','GS'])[i], 'name', 'Bank ' || i)),
            now(), now(), base + 10 - 0.1 * i);
  end loop;
  insert into core.blurbs (dedupe_key, kind, headline, category, event_type, tickers, as_of, sort_at, rank_score)
  values ('br-DJ', 'summary', 'BR DJ', 'deals', 'deal', '[{"symbol":"JPM","name":"JPMorgan"}]', now(), now(), base + 9.95);
  for i in 1 .. 10 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('br-X' || i, 'summary', 'BR X' || i, (array['markets','policy','world'])[1 + i % 3], now(), now(), base + 9.5 - 0.5 * i);
  end loop;
  for i in 1 .. 5 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, event_type, as_of, sort_at, rank_score)
    values ('br-Q' || i, 'summary', 'BR Q' || i, 'science', 'earthquake', now(), now(), base + 4.9 - 0.1 * i);
  end loop;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select x.id, case when x.dedupe_key like 'br-Q%' then 'U.S. Geological Survey' else 'SEC' end,
         case when x.dedupe_key like 'br-Q%' then 'government' else 'filing' end,
         'https://www.sec.gov/br/' || x.id, case when x.dedupe_key like 'br-Q%' then 'public_domain' else 'company_filing' end, true
    from core.blurbs x where x.dedupe_key like 'br-%';

  foreach mode in array array['anon-top', 'b-foryou'] loop
    if mode = 'anon-top' then
      perform set_config('role', 'anon', true);
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    else
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
      perform api.set_prefs('{}', null);                             -- B follows nothing here
    end if;
    page := '[]'::jsonb; cur := null; n := 0;
    loop
      if mode = 'anon-top' then r := api.feed('top', cur, 10); else r := api.feed_for_you(cur, 10); end if;
      page := page || (r->'items');
      cur := r->>'next_cursor'; n := n + 1;
      exit when cur is null or n > 10;
    end loop;
    if jsonb_array_length(page) <> 21
       or (select count(distinct x->>'id') from jsonb_array_elements(page) x) <> 21 then
      raise exception 'FAIL: % breadth paging returned % cards (expected 21, no repeats)', mode, jsonb_array_length(page);
    end if;
    select string_agg(replace(x->>'headline', 'BR ', ''), ',' order by o) into got
      from jsonb_array_elements(page) with ordinality as t(x, o);
    -- back-to-back rule on one 30-card page (across a page boundary it holds only when the
    -- next page still has another kind of card; here the last page would be a lone quake)
    if mode = 'anon-top' then r := api.feed('top', null, 30); else r := api.feed_for_you(null, 30); end if;
    select string_agg(replace(x->>'headline', 'BR ', ''), ',' order by o) into k1
      from jsonb_array_elements(r->'items') with ordinality as t(x, o);
    if exists (
      select 1 from jsonb_array_elements(r->'items') with ordinality as a(x, o)
        join jsonb_array_elements(r->'items') with ordinality as b2(y, p) on p = o + 1
       where (x->>'event_type' is not null and x->>'event_type' = y->>'event_type' and x->>'category' = y->>'category')
          or exists (select 1 from jsonb_array_elements(x->'tickers') t1, jsonb_array_elements(y->'tickers') t2
                      where t1->>'symbol' = t2->>'symbol')) then
      raise exception 'FAIL: % has two similar cards back to back: %', mode, k1;
    end if;
    if exists (
      select 1 from jsonb_array_elements(page) with ordinality as a(x, o)
        join jsonb_array_elements(page) with ordinality as b2(y, p) on p = o + 1
        join jsonb_array_elements(page) with ordinality as c3(z, q) on q = o + 2
       where x->>'category' = y->>'category' and y->>'category' = z->>'category') then
      raise exception 'FAIL: % has 3 of one category in a row: %', mode, got;
    end if;
    -- the two most important cards (DJ, E1) stay in the first 4 places
    if array_position(string_to_array(got, ','), 'DJ') > 4 or array_position(string_to_array(got, ','), 'E1') > 4 then
      raise exception 'FAIL: % pushed the most important card down: %', mode, got;
    end if;
  end loop;

  -- ---- 13. hide a source (signed in): A hides USGS ---------------------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.set_prefs(p_hidden_sources => array['usgs']);
  if r->'hidden_sources' <> '["usgs"]'::jsonb or r->'hidden_categories' <> '["energy"]'::jsonb then
    raise exception 'FAIL: set_prefs with hidden sources returned %', r;
  end if;
  r := api.set_prefs(p_followed => array['tech'], p_hidden => array['energy']);   -- old 2-argument call
  if r->'hidden_sources' <> '["usgs"]'::jsonb then raise exception 'FAIL: old set_prefs call dropped hidden_sources'; end if;
  r := api.set_prefs(array['tech'], array['energy']);                             -- positional
  ok := false;
  begin perform api.set_prefs(null, null, array['not-a-source']);
  exception when others then ok := sqlerrm like 'unknown_source%'; end;
  if not ok then raise exception 'FAIL: unknown source key accepted'; end if;
  foreach mode in array array['top', 'latest', 'foryou'] loop
    page := '[]'::jsonb; cur := null; n := 0;
    loop
      if mode = 'foryou' then r := api.feed_for_you(cur, 10); else r := api.feed(mode, cur, 10); end if;
      page := page || (r->'items');
      cur := r->>'next_cursor'; n := n + 1;
      exit when cur is null or n > 10;
    end loop;
    if exists (select 1 from jsonb_array_elements(page) x where x->>'headline' like 'BR Q%') then
      raise exception 'FAIL: hidden source USGS shown to A in %', mode;
    end if;
    if jsonb_array_length(page) <> 16 then raise exception 'FAIL: A got % cards in % with USGS hidden, expected 16', jsonb_array_length(page), mode; end if;
  end loop;
  if jsonb_array_length(api.feed('top', null, 10, 'science')->'items') <> 0 then
    raise exception 'FAIL: hidden source returned through p_category';
  end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  if (select count(*) from jsonb_array_elements(api.feed('latest', null, 30)->'items') x where x->>'headline' like 'BR Q%') <> 5 then
    raise exception 'FAIL: anon lost the USGS cards';
  end if;
  r := api.sources();
  if jsonb_array_length(r) <> 9 or not (r @> '[{"key":"usgs"}]'::jsonb) then raise exception 'FAIL: api.sources() returned %', r; end if;
  perform set_config('role', 'none', true);
  if core.source_key_of('data', gen_random_uuid()) <> 'fred' then raise exception 'FAIL: data cards are not mapped to fred'; end if;
  if core.source_key_of('summary', (select id from core.blurbs where dedupe_key = 'br-Q1')) <> 'usgs' then
    raise exception 'FAIL: USGS card not mapped to usgs';
  end if;

  -- ---- 14. four FAA rules (Federal Register, no event_type) + others ---------------------
  -- (diversity patch 071000) never two FAA rules back to back, at most 2 Federal Register
  -- cards in any 5 in a row, the top card stays first
  perform set_config('role', 'none', true);
  update core.blurbs set status = 'hidden' where dedupe_key like 'br-%' or dedupe_key like 'tr-%';
  for i in 1 .. 4 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, attribution, as_of, sort_at, rank_score)
    values ('faa-' || i, 'summary', 'FAA ' || i, 'policy', 'Federal Register, Federal Aviation Administration',
            now(), now(), base + 20 - 0.1 * i)
    returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, attribution, is_primary)
    values (b, 'Federal Register', 'government', 'https://www.federalregister.gov/d/faa' || i, 'public_domain',
            'Federal Register, Federal Aviation Administration', true);
  end loop;
  -- others: label, category, event_type, source name, rank offset
  for r in select value from jsonb_array_elements('[
      {"l":"QUAKE","c":"science","e":"earthquake","s":"U.S. Geological Survey","o":19.55},
      {"l":"EPA",  "c":"policy", "e":null,        "s":"Federal Register",      "o":19.5},
      {"l":"SEC1", "c":"earnings","e":"earnings", "s":"SEC",                   "o":19.0},
      {"l":"WIKI", "c":"world",  "e":"world_event","s":"Wikipedia",            "o":18.5},
      {"l":"NASA", "c":"science","e":"science",   "s":"NASA",                  "o":16.45},
      {"l":"NASA2","c":"tech",   "e":"tech",      "s":"NASA",                  "o":16.4},
      {"l":"WIKI2","c":"world",  "e":"world_event","s":"Wikipedia",            "o":16.3},
      {"l":"CPSC", "c":"safety", "e":"recall",    "s":"U.S. Consumer Product Safety Commission", "o":17.5},
      {"l":"BEA",  "c":"economy","e":"macro_release","s":"U.S. Bureau of Economic Analysis",   "o":17.0},
      {"l":"SEC2", "c":"deals",  "e":"deal",      "s":"SEC",                   "o":16.5}]') loop
    insert into core.blurbs (dedupe_key, kind, headline, category, event_type, attribution, as_of, sort_at, rank_score)
    values ('faa-x-' || (r->>'l'), 'summary', 'FAA ' || (r->>'l'), r->>'c', r->>'e',
            case when r->>'l' = 'EPA' then 'Federal Register, Environmental Protection Agency' end,
            now(), now(), base + (r->>'o')::numeric)
    returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, r->>'s', 'government', 'https://www.federalregister.gov/x/' || (r->>'l'), 'public_domain', true);
  end loop;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  foreach mode in array array['10', '30'] loop
    page := '[]'::jsonb; cur := null; n := 0;
    loop
      r := api.feed('top', cur, mode::int);
      page := page || (r->'items');
      cur := r->>'next_cursor'; n := n + 1;
      exit when cur is null or n > 10;
    end loop;
    select array_agg(replace(x->>'headline', 'FAA ', '') order by o) into seen
      from jsonb_array_elements(page) with ordinality as t(x, o);
    got := array_to_string(seen, ',');
    if cardinality(seen) <> 14 or (select count(distinct x) from unnest(seen) x) <> 14 then
      raise exception 'FAIL: FAA case paging (limit %) returned %', mode, got;
    end if;
    if seen[1] <> '1' then raise exception 'FAIL: FAA case: the top card is not first (limit %): %', mode, got; end if;
    for i in 2 .. cardinality(seen) loop
      if seen[i] ~ '^[1-4]$' and seen[i-1] ~ '^[1-4]$' then
        raise exception 'FAIL: two FAA rules back to back (limit %): %', mode, got;
      end if;
      if seen[i] like 'NASA%' and seen[i-1] like 'NASA%' then         -- same source, different topic
        raise exception 'FAIL: two NASA cards back to back (limit %): %', mode, got;
      end if;
    end loop;
    for i in 1 .. cardinality(seen) - 4 loop
      if (select count(*) from unnest(seen[i:i+4]) x where x ~ '^[1-4]$' or x = 'EPA') > 2 then
        raise exception 'FAIL: more than 2 Federal Register cards in 5 (limit %): %', mode, got;
      end if;
    end loop;
  end loop;

  raise exception 'ALL TRENDING CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
