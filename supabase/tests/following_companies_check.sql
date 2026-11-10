-- Checks for 20261119000000_following_companies.sql: a followed company's news (tagged in core.card_companies)
-- shows in Following with a "(mentions ...)" reason, an unfollowed one does not, a followed company's recall
-- shows, own-ticker cards keep the old reason, paging is stable, and the ticker list is capped at 100.
do $$
declare
  tgt uuid; ford uuid; aapl uuid; hid uuid; b uuid; i int; r jsonb; cur text; seen text[] := '{}'; pg int; n int; p text; tick text[]; tsla text[];
begin
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at, importance)
  values ('fc-tgt:1', 'summary', 'Target recalls 2,000 desk lamps sold in its stores', 'The lamps can overheat.', 'safety', 'published', '[]',
          now(), now() - interval '3 hours', now() - interval '3 hours', 1) returning id into tgt;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at, importance)
  values ('fc-ford:1', 'summary', 'Ford recalls 500,000 F-150 pickups', 'The recall covers trucks.', 'deals', 'published', '[]',
          now(), now() - interval '2 hours', now() - interval '2 hours', 1) returning id into ford;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at, importance)
  values ('fc-aapl:1', 'summary', 'Apple reports quarterly results', 'Revenue rose.', 'earnings', 'published', '[{"symbol":"AAPL","name":"Apple Inc."}]',
          now(), now() - interval '1 hour', now() - interval '1 hour', 1) returning id into aapl;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at, importance)
  values ('fc-hid:1', 'summary', 'Target cuts prices as shoppers pull back', '', 'world', 'hidden', '[]', now(), now(), now(), 1) returning id into hid;
  for i in 1..40 loop
    insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at, importance)
    values ('fc-tsla:' || i, 'summary', 'Tesla delivery update ' || i, 'Shares moved.', 'markets', 'published', '[]',
            now(), now() - (i || ' minutes')::interval, now() - (i || ' minutes')::interval, 1 + (i % 3));
  end loop;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select id, 'FC wire', 'news', 'https://example.com/' || dedupe_key, 'public_domain', true from core.blurbs where dedupe_key like 'fc-%';
  if not exists (select 1 from core.card_companies where blurb_id = tgt and ticker = 'TGT') then raise exception 'FAIL: setup, Target recall not tagged'; end if;

  tsla := (select array_agg(id::text) from core.blurbs where dedupe_key like 'fc-tsla:%');
  set local role anon;
  -- 1. a followed company's recall (news, no tickers) is a direct match with a company note
  r := api.following_feed(array[]::text[], array[]::text[], array['TGT'], null, 30);
  if not exists (select 1 from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = tgt
                   and x ->> 'follow_reason' = 'Because you follow TGT (mentions Target)' and x ->> 'follow_match' = 'company' and x ->> 'follow_ticker' = 'TGT') then
    raise exception 'FAIL: followed company recall missing or wrong note: %', r -> 'items'; end if;
  -- 2. an unfollowed company's card is not there; a hidden tagged card is not there
  if exists (select 1 from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid in (ford, hid)) then raise exception 'FAIL: unfollowed or hidden card shown'; end if;
  -- 3. own-ticker (SEC-style) cards keep the old reason; lower-case follows work
  r := api.following_feed(array[]::text[], array[]::text[], array['aapl'], null, 30);
  if (select x ->> 'follow_reason' from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = aapl) is distinct from 'Because you follow AAPL' then
    raise exception 'FAIL: ticker reason %', r -> 'items'; end if;
  if (select x ->> 'follow_match' from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = aapl) is distinct from 'ticker' then raise exception 'FAIL: ticker match kind'; end if;

  -- 4. paging over 40 Tesla mentions + the Target recall: no repeats, nothing skipped
  cur := null; n := 0;
  for pg in 1..10 loop
    r := api.following_feed(array[]::text[], array[]::text[], array['TSLA', 'TGT'], cur, 10);
    for p in select x ->> 'id' from jsonb_array_elements(r -> 'items') x loop
      if p = any(seen) then raise exception 'FAIL: repeated card % on page %', p, pg; end if;
      seen := seen || p; n := n + 1;
    end loop;
    cur := r ->> 'next_cursor';
    exit when cur is null;
  end loop;
  if (select count(*) from unnest(seen) s where s = any(tsla)) <> 40 then raise exception 'FAIL: paging lost Tesla cards (% seen)', n; end if;
  if not (tgt::text = any(seen)) then raise exception 'FAIL: Target recall lost in paging'; end if;

  -- 5. cap: only the first 100 followed tickers count
  tick := (select array_agg('Q' || lpad(g::text, 3, '0')) from generate_series(1, 120) g);
  r := api.following_feed(array[]::text[], array[]::text[], tick || array['TGT'], null, 30);
  if exists (select 1 from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = tgt) then raise exception 'FAIL: ticker past the cap counted'; end if;
  r := api.following_feed(array[]::text[], array[]::text[], array['TGT'] || tick, null, 30);
  if not exists (select 1 from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = tgt) then raise exception 'FAIL: first ticker dropped by the cap'; end if;

  -- 6. topic follows unchanged: a topic match keeps its topic reason
  r := api.following_feed(array['safety'], array[]::text[], array['TGT'], null, 30);
  if (select x ->> 'follow_match' from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = tgt) is distinct from 'topic' then raise exception 'FAIL: topic precedence'; end if;
  reset role;

  -- 7. grants: anon and authenticated may call it
  if not has_function_privilege('anon', 'api.following_feed(text[],text[],text[],text,int)', 'execute') then raise exception 'FAIL: anon grant'; end if;
  if not has_function_privilege('authenticated', 'api.following_feed(text[],text[],text[],text,int)', 'execute') then raise exception 'FAIL: authenticated grant'; end if;

  raise exception 'ALL FOLLOWING COMPANIES CHECKS PASSED';
end $$;
