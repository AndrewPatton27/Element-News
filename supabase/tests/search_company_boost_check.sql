-- =============================================================================
-- search_company_boost_check.sql: checks for 20261115000100_search_company_boost.sql, and the M8 pieces
-- working together (seen exclusion 20261113, search v5 20261114, companies 20261115).
--   1. a query that names a company (name or ticker) puts that company's tagged cards first, even when an
--      untagged text match is fresher and trends far higher; a prefix or typo gives no company tier;
--      paging with the tier has no repeats or gaps; the v5 checks' fixtures are not company names.
--   2. together: a signed-in reader who viewed the company card no longer gets it on Trending or For you
--      (the source of "Suggested for you") until the feed runs out, where it comes back after seen_from;
--      search still finds it, company first; its company chip (api.card_companies) and company page
--      (api.company_cards) still list it.
--   expected:     ERROR: ALL SEARCH_COMPANY_BOOST CHECKS PASSED (test data rolled back on purpose)
-- =============================================================================
do $$
declare
  ua uuid;
  base numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  c_co uuid; c_fruit uuid; c_other uuid;
  r jsonb; ids text[]; seen text[] := '{}'; cur text; i int := 0; sf int; allids text[] := '{}';
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  if ua is null then raise exception 'SETUP: create the user element-test-a@example.com first'; end if;
  delete from core.user_events where user_id = ua;
  delete from core.user_prefs where user_id = ua;
  update core.blurbs set status = 'hidden' where status = 'published';   -- real cards out of the way (rolled back)
  update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode');

  -- The company card: older, low trend. The fruit card: fresh, trending far higher, same visible word.
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at, importance, rank_score)
  values ('scb-co', 'summary', 'Apple shares slip after earnings', 'Revenue missed estimates.', 'earnings', 'published',
          '[{"symbol":"AAPL","name":"Apple Inc.","exchange":"Nasdaq"}]', now(), now(), now() - interval '30 hours', 1, base - 30)
  returning id into c_co;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score)
  values ('scb-fruit', 'summary', 'Apple harvest falls as orchards face drought', 'Growers expect a smaller crop this year.', 'economy', 'published',
          now(), now(), now(), 8, base + 60)
  returning id into c_fruit;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score)
  values ('scb-other', 'summary', 'Port traffic slows', 'Shipments fell.', 'economy', 'published', now(), now(), now() - interval '1 hour', 2, base + 5)
  returning id into c_other;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select id, 'SCB Source', 'news', 'https://example.com/' || dedupe_key, 'company_filing', true from core.blurbs where dedupe_key like 'scb-%';

  if not exists (select 1 from core.card_companies where blurb_id = c_co and ticker = 'AAPL') then raise exception 'FAIL: setup, the company card is not tagged AAPL'; end if;
  if exists (select 1 from core.card_companies where blurb_id = c_fruit) then raise exception 'FAIL: setup, the fruit card is tagged as a company'; end if;

  -- ---- 1. company tier ------------------------------------------------------------------------------------
  r := api.search('apple', null, 10);
  ids := (select array_agg(x ->> 'id' order by n) from jsonb_array_elements(r -> 'items') with ordinality e(x, n));
  if ids is distinct from array[c_co::text, c_fruit::text] then raise exception 'FAIL: "apple" must put the Apple card first: %', ids; end if;
  r := api.search('AAPL', null, 10);
  if r -> 'items' -> 0 ->> 'id' <> c_co::text then raise exception 'FAIL: ticker query must put the AAPL card first'; end if;
  r := api.search('apple inc', null, 10);
  if r -> 'items' -> 0 ->> 'id' <> c_co::text then raise exception 'FAIL: exact company name must put the Apple card first'; end if;
  -- a multi-word query that is not a company name: no tier, v5 order (the hotter visible match first)
  r := api.search('apple drought', null, 10);
  if r -> 'items' -> 0 ->> 'id' <> c_fruit::text then raise exception 'FAIL: "apple drought" must not get the company tier'; end if;
  -- prefix only (score 0.8): no tier; both cards prefix-match, the prior decides
  r := api.search('appl', null, 10);
  if r -> 'items' -> 0 ->> 'id' <> c_fruit::text then raise exception 'FAIL: a prefix company match must not get the tier'; end if;
  -- the v5 checks' made-up words name no company
  if exists (select 1 from core.company_query_scores('quixor') where score >= 0.95)
     or exists (select 1 from core.company_query_scores('vantrel') where score >= 0.95) then
    raise exception 'FAIL: v5 fixture words now name a company'; end if;
  -- paging with the tier: one per page equals one big page
  r := api.search('apple', null, 1);
  select coalesce(array_agg(x ->> 'id'), '{}') into seen from jsonb_array_elements(r -> 'items') x;
  cur := r ->> 'next_cursor';
  while cur is not null and i < 10 loop
    r := api.search('apple', cur, 1);
    select seen || coalesce(array_agg(x ->> 'id'), '{}') into seen from jsonb_array_elements(r -> 'items') x;
    cur := r ->> 'next_cursor'; i := i + 1;
  end loop;
  if seen is distinct from array[c_co::text, c_fruit::text] then raise exception 'FAIL: paged company search %', seen; end if;
  if not exists (select 1 from pg_proc where oid = 'api.search(text,text,int)'::regprocedure and prosecdef and proconfig @> array['search_path=""']) then
    raise exception 'FAIL: api.search must stay security definer with an empty search_path'; end if;
  if not has_function_privilege('anon', 'api.search(text,text,int)', 'execute') then raise exception 'FAIL: anon must be able to call api.search'; end if;

  -- ---- 2. together: seen exclusion + search + company chips ------------------------------------------------
  -- viewed no earlier than its last update (a card updated after the view may come back, by design;
  -- inside this one transaction now() is both the insert's updated_at and the view time)
  insert into core.user_events (user_id, blurb_id, kind, created_at) values (ua, c_co, 'view', now());
  if not (c_co = any (core.seen_ids(ua, now()))) then
    raise exception 'FAIL: setup, the view does not count as seen (updated_at %)', (select updated_at from core.blurbs where id = c_co); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  -- Trending (pages are at least 10, so the whole fixture is one page): seen exclusion applies to For you
  -- only (D-84), so the viewed card is still listed and there is no seen_from
  i := 0; sf := null; allids := '{}'; cur := null;
  loop
    r := api.feed('top', cur, 10);
    if r ->> 'seen_from' is not null and sf is null then sf := cardinality(allids) + (r ->> 'seen_from')::int; end if;
    select allids || coalesce(array_agg(x ->> 'id' order by n), '{}') into allids from jsonb_array_elements(r -> 'items') with ordinality e(x, n);
    cur := r ->> 'next_cursor'; i := i + 1;
    exit when cur is null or i > 10;
  end loop;
  if (select array_agg(x order by x) from unnest(allids) x) is distinct from (select array_agg(x order by x) from unnest(array[c_fruit::text, c_other::text, c_co::text]) x) or sf is not null then
    raise exception 'FAIL: Trending must still list the viewed card (no seen exclusion outside For you): % (seen_from %)', allids, sf; end if;
  -- For you (what "Suggested for you" picks from, signed in): the viewed card only after seen_from
  r := api.feed_for_you(null, 10);
  ids := (select array_agg(x ->> 'id' order by n) from jsonb_array_elements(r -> 'items') with ordinality e(x, n));
  if (r ->> 'seen_from') is null or ids[(r ->> 'seen_from')::int + 1] is distinct from c_co::text
     or c_co::text = any (ids[1:(r ->> 'seen_from')::int]) then
    raise exception 'FAIL: For you must put the viewed card after seen_from: % (seen_from %)', ids, r ->> 'seen_from'; end if;
  -- search does not hide seen cards: the company card still comes first for this reader
  r := api.search('apple', null, 10);
  if r -> 'items' -> 0 ->> 'id' <> c_co::text then raise exception 'FAIL: signed-in company search must still put the Apple card first'; end if;
  -- company chip and company page still list it
  r := api.card_companies(array[c_co, c_fruit]);
  if jsonb_array_length(r) <> 1 or r -> 0 ->> 'id' <> c_co::text or r -> 0 -> 'companies' -> 0 ->> 'ticker' <> 'AAPL' then
    raise exception 'FAIL: company chips %', r; end if;
  r := api.company_cards('AAPL', null, 10);
  if not exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'id' = c_co::text) then
    raise exception 'FAIL: company page lost the card: %', r; end if;
  perform set_config('request.jwt.claims', '', true);

  raise exception 'ALL SEARCH_COMPANY_BOOST CHECKS PASSED (company tier, no tier for prefix or other words, paging, seen exclusion with search and company chips; test data rolled back on purpose)';
end $$;
