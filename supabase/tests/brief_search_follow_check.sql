-- Checks for 20261018000000_brief_search_follow.sql; runs after migration 090000.
--   expected:     ERROR: ALL BRIEF SEARCH FOLLOW CHECKS PASSED (test rows rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- Every row is inserted inside this DO statement and rolled back by the final deliberate error.
-- Needs the test user element-test-a@example.com (as in accounts_check.sql) for the personalization checks.
do $$
declare
  ids uuid[] := array_fill(null::uuid, array[12]);
  newid uuid;
  cat text;
  cat2 text;
  ua uuid;
  i int;
  r jsonb;
  cursor_ text;
  first_id text;
  anon_first text;
  user_first text;
  seen text[] := '{}';
  n int;
begin
  select slug into cat from core.categories order by sort_order limit 1;
  select slug into cat2 from core.categories where slug <> cat order by sort_order limit 1;
  select id into ua from auth.users where email = 'element-test-a@example.com';
  if ua is null then raise exception 'SETUP: create the user element-test-a@example.com first'; end if;
  delete from core.user_prefs where user_id = ua;

  for i in 1..7 loop
    insert into core.blurbs (dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
    values ('briefcheck:'||i,'summary',case when i=1 then 'AAPL quarterly results' else 'Brief check story '||i end,
      'Searchable demo body for the test.',
      case when i = 3 then cat2 else cat end,'published',
      case when i in (1,2) then '[{"symbol":"AAPL","name":"Apple Inc.","exchange":"Nasdaq"}]'::jsonb
           when i = 3 then '[{"symbol":"AAPL","name":"Apple Inc.","exchange":"Nasdaq"}]'::jsonb else '[]'::jsonb end,
      now()-make_interval(hours=>i),now()-make_interval(hours=>i),now()-make_interval(hours=>i),10-i)
    returning id into newid;
    ids[i] := newid;
    insert into core.blurb_sources (blurb_id,name,kind,url,license_class,is_primary)
    values (newid,case when i=1 then 'Apple News Desk' else 'Brief Test Source' end,'news','https://example.com/briefcheck/'||i,'company_filing',true);
  end loop;

  -- Two equal "zebra" cards in different categories, same time and importance: used for personalization.
  for i in 8..9 loop
    insert into core.blurbs (dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
    values ('briefcheck:'||i,'summary','Zebra migration report','Plain body.',case when i = 8 then cat else cat2 end,'published','[]'::jsonb,
      now()-interval '2 hours',now()-interval '2 hours',now()-interval '2 hours',5)
    returning id into newid;
    ids[i] := newid;
    insert into core.blurb_sources (blurb_id,name,kind,url,license_class,is_primary)
    values (newid,'Brief Test Source','news','https://example.com/briefcheck/'||i,'company_filing',true);
  end loop;

  -- Two same-importance cards in the followed category, 1 h and 20 h old: the newer must rank first.
  for i in 10..11 loop
    insert into core.blurbs (dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
    values ('briefcheck:'||i,'summary','Recency probe '||i,'Plain body.',cat,'published','[]'::jsonb,
      now()-case when i = 10 then interval '1 hour' else interval '20 hours' end,
      now()-case when i = 10 then interval '1 hour' else interval '20 hours' end,
      now()-case when i = 10 then interval '1 hour' else interval '20 hours' end,5)
    returning id into newid;
    ids[i] := newid;
    insert into core.blurb_sources (blurb_id,name,kind,url,license_class,is_primary)
    values (newid,'Brief Test Source','news','https://example.com/briefcheck/'||i,'company_filing',true);
  end loop;

  -- search: first page, ticker fallback, cursor paging with no repeats
  r := api.search('AAPL',null,1);
  if jsonb_array_length(r->'items') <> 1 or r->'next_cursor' is null then raise exception 'FAIL: search first page / ticker fallback'; end if;
  seen := seen || (r->'items'->0->>'id');
  cursor_ := r->>'next_cursor';
  for i in 1..5 loop
    exit when cursor_ is null;
    r := api.search('AAPL',cursor_,1);
    if jsonb_array_length(r->'items') <> 1 or (r->'items'->0->>'id') = any (seen) then raise exception 'FAIL: search cursor paging repeats a card'; end if;
    seen := seen || (r->'items'->0->>'id');
    cursor_ := r->>'next_cursor';
  end loop;
  if cardinality(seen) <> 3 then raise exception 'FAIL: search paging should return exactly the 3 AAPL cards, got %', cardinality(seen); end if;
  if jsonb_array_length(api.search('x',null,20)->'items') <> 0 then raise exception 'FAIL: short search'; end if;
  r := api.search('qqqxxnomatch',null,20);
  if jsonb_array_length(r->'items') <> 0 or r->>'next_cursor' is not null then raise exception 'FAIL: search with no match'; end if;
  begin perform api.search('AAPL','garbage',5); raise exception 'FAIL: bad cursor accepted';
  exception when sqlstate 'PT422' then null; end;

  -- related: same category and ticker-only (different category) matches, never itself
  r := api.related_cards(ids[1],10);
  if not exists (select 1 from jsonb_array_elements(r) x where x->>'id'=ids[2]::text) then raise exception 'FAIL: related category/ticker match'; end if;
  if not exists (select 1 from jsonb_array_elements(r) x where x->>'id'=ids[3]::text) then raise exception 'FAIL: related ticker-only match (different category)'; end if;
  if exists (select 1 from jsonb_array_elements(r) x where x->>'id'=ids[1]::text) then raise exception 'FAIL: related includes itself'; end if;
  if jsonb_array_length(api.related_cards('00000000-0000-0000-0000-000000000000',5)) <> 0 then raise exception 'FAIL: related for unknown card'; end if;

  -- following: direct match, reason, empty lists fall back to the top feed
  r := api.following_feed(array[cat],array[]::text[],array[]::text[],null,10);
  if jsonb_array_length(r->'items') < 1 or r->'items'->0->>'follow_reason' not like 'Because you follow %' then raise exception 'FAIL: following direct match/reason'; end if;
  r := api.following_feed(array[]::text[],array[]::text[],array['AAPL'],null,10);
  if not exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id'=ids[3]::text) then raise exception 'FAIL: following ticker match'; end if;
  r := api.following_feed(array[]::text[],array[]::text[],array[]::text[],null,10);
  if jsonb_array_length(r->'items') < 1 or r->'items'->0 ? 'follow_reason' then raise exception 'FAIL: empty following fallback should be the plain top feed'; end if;
  r := api.following_feed(null,null,null,null,10);
  if jsonb_array_length(r->'items') < 1 then raise exception 'FAIL: null follow lists fallback'; end if;
  -- recency: for a followed topic, a newer card of equal importance ranks above an older one
  r := api.following_feed(array[cat],array[]::text[],array[]::text[],null,30);
  if (select min(o) from jsonb_array_elements(r->'items') with ordinality t(x,o) where x->>'id'=ids[10]::text)
     > (select min(o) from jsonb_array_elements(r->'items') with ordinality t(x,o) where x->>'id'=ids[11]::text) then
    raise exception 'FAIL: following recency weighting (1 h old card must outrank 20 h old card of equal importance)'; end if;
  -- paging with a small page returns each card once
  seen := '{}';
  r := api.following_feed(array[cat],array[]::text[],array[]::text[],null,10);
  cursor_ := r->>'next_cursor';
  n := jsonb_array_length(r->'items');
  select array_agg(x->>'id') into seen from jsonb_array_elements(r->'items') x;
  for i in 1..10 loop
    exit when cursor_ is null;
    r := api.following_feed(array[cat],array[]::text[],array[]::text[],cursor_,10);
    if exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = any (seen)) then raise exception 'FAIL: following cursor paging repeats a card'; end if;
    select seen || array_agg(x->>'id') into seen from jsonb_array_elements(r->'items') x;
    cursor_ := r->>'next_cursor';
  end loop;

  -- personalization (search): guests get no boost, a follower sees the followed category first
  r := api.search('zebra',null,10);
  if jsonb_array_length(r->'items') <> 2 then raise exception 'FAIL: zebra search should find 2 cards'; end if;
  anon_first := r->'items'->0->>'id';
  if anon_first <> greatest(ids[8],ids[9])::text then raise exception 'FAIL: guest search order must be the plain tie-break (id desc), no boost'; end if;
  insert into core.user_prefs (user_id, followed_categories) values (ua, array[case when ids[8] < ids[9] then cat else cat2 end])
    on conflict (user_id) do update set followed_categories = excluded.followed_categories;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.search('zebra',null,10);
  user_first := r->'items'->0->>'id';
  if user_first <> least(ids[8],ids[9])::text then raise exception 'FAIL: signed-in follower should get the followed category first'; end if;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  if api.search('zebra',null,10)->'items'->0->>'id' <> anon_first then raise exception 'FAIL: guest search changed after another user followed'; end if;
  perform set_config('request.jwt.claims', '', true);

  -- briefs
  r := api.daily_brief();
  if jsonb_typeof(r->'headline_cards') <> 'array' or jsonb_array_length(r->'headline_cards') > 3 or jsonb_array_length(r->'sections') > 8 or jsonb_array_length(r->'numbers') > 4 then raise exception 'FAIL: daily brief shape/limits'; end if;
  if (r->>'window_hours')::int not in (24,48,72) then raise exception 'FAIL: daily window'; end if;
  if jsonb_array_length(r->'headline_cards') < 1 then raise exception 'FAIL: daily brief empty'; end if;
  r := api.weekly_brief();
  if (r->>'window_hours')::int <> 168 or jsonb_array_length(r->'movers') > 4 or jsonb_array_length(r->'headline_cards') < 1 then raise exception 'FAIL: weekly brief shape/limits'; end if;

  -- grants / security
  if has_function_privilege('anon','api.search(text,text,integer)','execute') is not true
     or has_function_privilege('anon','api.related_cards(uuid,integer)','execute') is not true
     or has_function_privilege('authenticated','api.following_feed(text[],text[],text[],text,integer)','execute') is not true
     or has_function_privilege('anon','api.daily_brief()','execute') is not true
     or has_function_privilege('anon','api.weekly_brief()','execute') is not true then raise exception 'FAIL: RPC grants'; end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'api' and p.proname in ('search','related_cards','following_feed','daily_brief','weekly_brief')
                and (not p.prosecdef or p.provolatile <> 's' or p.proconfig is null or not ('search_path=""' = any (p.proconfig)))) then
    raise exception 'FAIL: RPCs must be security definer, stable, search_path empty'; end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'api' and p.proname in ('search','related_cards','following_feed','daily_brief','weekly_brief')
                and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)) then
    raise exception 'FAIL: PUBLIC must not have execute on the new RPCs'; end if;

  raise exception 'ALL BRIEF SEARCH FOLLOW CHECKS PASSED (test rows rolled back on purpose)';
end $$;
