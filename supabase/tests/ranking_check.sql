-- =============================================================================
-- ranking_check.sql: checks to run after the init migration.
-- Run it in the Supabase SQL editor in TWO runs:
--   1. Select PART 1 only (from "PART 1" down to the line before "PART 2") and run it.
--   2. Then select PART 2 only (from "PART 2" down to its "rollback;") and run it.
-- Do not run the whole file at once: PART 1 ends with a deliberate error, so the
-- editor stops there and PART 2 would never run.
--
-- PART 1 (ranking, paging, publish rules) runs inside one DO block that ends by
-- raising an error ON PURPOSE, so every test row is rolled back:
--   expected result:  ERROR: ALL CHECKS PASSED (test data rolled back on purpose)
--   any failure:      ERROR: FAIL: <what failed>
-- PART 2 (privileges) runs as the anon role and must print no error.
-- PART 3 (optional) is a curl check with the publishable key from your shell.
-- =============================================================================

-- ---------------------------------------------------------------- PART 1 ----
do $$
declare
  ids    jsonb;
  got    text;
  page   jsonb;
  cur    text;
  seen   text[] := '{}';
  pages  int := 0;
  r      jsonb;
  failed boolean;
  b      uuid;
  i      int;
  -- six cards from the ranking design: label, event_type, source kind, age, distinct sources
  spec   jsonb := '[
    {"l":"A","et":"fed",          "k":"government","age":6,    "n":14},
    {"l":"B","et":"earnings",     "k":"filing",    "age":0.333,"n":6},
    {"l":"C","et":"macro_release","k":"government","age":26,   "n":3},
    {"l":"D","et":"insider",      "k":"filing",    "age":1,    "n":1},
    {"l":"E","et":"exec_change",  "k":"filing",    "age":3,    "n":2},
    {"l":"F","et":"deal",         "k":"filing",    "age":12,   "n":8}]';
  c      jsonb;
begin
  -- hide real cards for the duration of this block (rolled back at the end)
  update core.blurbs set status = 'hidden' where status = 'published';

  -- 1. six-card order ---------------------------------------------------------
  for c in select value from jsonb_array_elements(spec) loop
    insert into core.blurbs (dedupe_key, kind, headline, category, event_type, as_of, sort_at)
    values ('test-' || (c->>'l'), 'summary', 'TEST ' || (c->>'l'), 'markets', c->>'et',
            now() - make_interval(secs => (c->>'age')::numeric * 3600),
            now() - make_interval(secs => (c->>'age')::numeric * 3600))
    returning id into b;
    for i in 1 .. (c->>'n')::int loop
      insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary, position)
      values (b, 'Outlet ' || i, c->>'k', 'https://www.sec.gov/test/' || (c->>'l') || '/' || i,
              case when c->>'k' = 'government' then 'public_domain' else 'company_filing' end, i = 1, i);
    end loop;
    perform core.refresh_rank(b);
  end loop;

  select string_agg(replace(x->>'headline', 'TEST ', ''), '' order by o) into got
    from jsonb_array_elements(api.feed('top', null, 10) -> 'items') with ordinality as t(x, o);
  if got is distinct from 'ABEFDC' then raise exception 'FAIL: top order is %, expected ABEFDC', got; end if;

  select string_agg(replace(x->>'headline', 'TEST ', ''), '' order by o) into got
    from jsonb_array_elements(api.feed('latest', null, 10) -> 'items') with ordinality as t(x, o);
  if got is distinct from 'BDEAFC' then raise exception 'FAIL: latest order is %, expected BDEAFC', got; end if;

  -- importance of card A should be 16.6 (8 x 1.25 x (1 + 0.25 ln 14))
  if (select importance from core.blurbs where dedupe_key = 'test-A') <> 16.598 then
    raise exception 'FAIL: importance of A is %, expected 16.598',
      (select importance from core.blurbs where dedupe_key = 'test-A');
  end if;

  -- 2. hidden cards never appear ---------------------------------------------
  update core.blurbs set status = 'hidden' where dedupe_key = 'test-A';
  if exists (select 1 from jsonb_array_elements(api.feed('top', null, 30) -> 'items') x
              where x->>'headline' = 'TEST A') then
    raise exception 'FAIL: hidden card A appears in the feed';
  end if;

  -- 3. paging: 25 more cards, limit 10, every id exactly once, both modes -----
  for i in 1 .. 25 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, event_type, as_of, sort_at)
    values ('test-p' || i, 'summary', 'TEST P' || i, 'tech', case when i % 3 = 0 then 'earnings' end,
            now() - make_interval(hours => i), now() - make_interval(hours => i))
    returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'SEC', 'filing', 'https://www.sec.gov/test/p' || i, 'company_filing', true);
    perform core.refresh_rank(b);
  end loop;

  foreach got in array array['top', 'latest'] loop
    seen := '{}'; cur := null; pages := 0;
    loop
      page := api.feed(got, cur, 10, 'tech');
      pages := pages + 1;
      for r in select value from jsonb_array_elements(page -> 'items') loop
        if (r->>'id') = any(seen) then raise exception 'FAIL: % paging repeated %', got, r->>'headline'; end if;
        seen := seen || (r->>'id');
      end loop;
      cur := page ->> 'next_cursor';
      exit when cur is null or pages > 5;
    end loop;
    if cardinality(seen) <> 25 or pages <> 3 then
      raise exception 'FAIL: % paging returned % cards in % pages, expected 25 in 3', got, cardinality(seen), pages;
    end if;
  end loop;

  -- 4. limit clamp: 100 -> 30, 1 -> 10 ----------------------------------------
  if jsonb_array_length(api.feed('top', null, 1, 'tech') -> 'items') <> 10 then
    raise exception 'FAIL: p_limit 1 not clamped to 10';
  end if;

  -- 5. publish_blurb rules ------------------------------------------------------
  failed := false;
  begin
    perform api.publish_blurb('{"dedupe_key":"test-nosrc","kind":"summary","headline":"x","category":"markets","sort_at":"2026-10-17T00:00:00Z","sources":[]}');
  exception when others then failed := true;
  end;
  if not failed then raise exception 'FAIL: publish_blurb accepted a card with zero sources'; end if;

  failed := false;
  begin
    perform api.publish_blurb('{"dedupe_key":"test-dev","kind":"summary","headline":"x","category":"markets","sort_at":"2026-10-17T00:00:00Z","sources":[{"name":"X","kind":"news","url":"https://example.com/a","license_class":"dev_only"}]}');
  exception when check_violation then failed := true;
  end;
  if not failed then raise exception 'FAIL: publish_blurb accepted a dev_only source'; end if;

  r := api.publish_blurb('{"dedupe_key":"test-ok","kind":"summary","headline":"TEST OK","category":"earnings","event_type":"earnings","ai_generated":true,"sort_at":"2026-10-17T20:00:00Z","tickers":[{"symbol":"ZZZT","name":"Test Co","exchange":"NYSE"}],"sources":[{"name":"SEC","kind":"filing","doc_label":"Form 8-K","url":"https://www.sec.gov/test/ok","license_class":"company_filing"}]}');
  if r->>'status' <> 'published' then raise exception 'FAIL: valid publish returned %', r; end if;
  if (select ai_label from core.blurbs where dedupe_key = 'test-ok') is distinct from 'AI-generated summary · may contain errors' then
    raise exception 'FAIL: ai_label not taken from app_config';
  end if;
  if (select importance from core.blurbs where dedupe_key = 'test-ok') <> 6 then   -- earnings weight 6 (20261116000000_macro_focus.sql)
    raise exception 'FAIL: publish_blurb did not refresh the rank';
  end if;
  r := api.publish_blurb('{"dedupe_key":"test-ok","kind":"summary","headline":"TEST OK","category":"earnings","sort_at":"2026-10-17T20:00:00Z","sources":[{"name":"SEC","kind":"filing","url":"https://www.sec.gov/test/ok","license_class":"company_filing"}]}');
  if r->>'status' <> 'duplicate' then raise exception 'FAIL: duplicate publish returned %', r; end if;

  -- per-ticker cap: 2 more cards for ZZZT are fine, the 4th within 24 h is refused
  for i in 1 .. 3 loop
    r := api.publish_blurb(jsonb_build_object('dedupe_key', 'test-cap' || i, 'kind', 'summary',
           'headline', 'TEST CAP', 'category', 'earnings', 'sort_at', '2026-10-17T1' || i || ':00:00Z',
           'tickers', '[{"symbol":"ZZZT","name":"Test Co","exchange":"NYSE"}]'::jsonb,
           'sources', '[{"name":"SEC","kind":"filing","url":"https://www.sec.gov/test/cap","license_class":"company_filing"}]'::jsonb));
    if i < 3 and r->>'status' <> 'published' then raise exception 'FAIL: cap card % returned %', i, r; end if;
    if i = 3 and r->>'status' <> 'ticker_cap' then raise exception 'FAIL: 4th card for ticker returned %', r; end if;
  end loop;

  -- 6. tickers come back with quote null; image null ---------------------------
  ids := api.feed('top', null, 30, 'earnings') -> 'items';
  if not exists (select 1 from jsonb_array_elements(ids) x
                  where x->'tickers'->0->>'symbol' = 'ZZZT' and x->'tickers'->0 ? 'quote'
                    and x->'tickers'->0->'quote' = 'null'::jsonb and x->'image' = 'null'::jsonb) then
    raise exception 'FAIL: ticker quote/image not null in feed output';
  end if;

  raise exception 'ALL CHECKS PASSED (test data rolled back on purpose)';
end;
$$;

-- ---------------------------------------------------------------- PART 2 ----
-- Privileges: run as the anon role (what the publishable key uses).
-- Expected: no error. Any "FAIL:" error means a privilege is too open.
begin;
set local role anon;
do $$
declare ok boolean;
begin
  -- anon cannot read core or ingest
  ok := false; begin perform 1 from core.blurbs limit 1;
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: anon can select from core.blurbs'; end if;

  ok := false; begin perform 1 from ingest.items limit 1;
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: anon can select from ingest.items'; end if;

  -- anon cannot call the write RPCs
  ok := false; begin perform api.publish_blurb('{}'::jsonb);
  exception when insufficient_privilege then ok := true;
            when others then raise exception 'FAIL: anon can call api.publish_blurb (it ran and raised: %)', sqlerrm;
  end;
  if not ok then raise exception 'FAIL: anon can call api.publish_blurb'; end if;

  ok := false; begin perform api.upsert_item('{}'::jsonb);
  exception when insufficient_privilege then ok := true;
            when others then raise exception 'FAIL: anon can call api.upsert_item (it ran and raised: %)', sqlerrm;
  end;
  if not ok then raise exception 'FAIL: anon can call api.upsert_item'; end if;

  ok := false; begin perform api.upsert_macro('{}'::jsonb);
  exception when insufficient_privilege then ok := true;
            when others then raise exception 'FAIL: anon can call api.upsert_macro (it ran and raised: %)', sqlerrm;
  end;
  if not ok then raise exception 'FAIL: anon can call api.upsert_macro'; end if;

  ok := false; begin perform core.refresh_all_ranks();
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: anon can call core.refresh_all_ranks'; end if;

  -- anon CAN read the public api
  perform api.feed('top', null, 10, null);
  perform 1 from api.app_config;
  perform 1 from api.categories;
  perform 1 from api.numbers_to_know;
  raise notice 'PART 2 PASSED: anon is locked out of core/ingest and the write RPCs';
end;
$$;
rollback;

-- ---------------------------------------------------------------- PART 3 ----
-- Optional, from Git Bash with the PUBLISHABLE key (never the secret key):
--
--   URL=https://<project-ref>.supabase.co ; KEY=<publishable key>
--   # works (200, JSON with items):
--   curl -s -X POST "$URL/rest/v1/rpc/feed" -H "apikey: $KEY" -H "Content-Profile: api" \
--        -H "Content-Type: application/json" -d '{"p_mode":"top"}'
--   # must fail (schema not exposed, error PGRST106):
--   curl -s "$URL/rest/v1/blurbs" -H "apikey: $KEY" -H "Accept-Profile: core"
--   # must fail (permission denied, HTTP 401/403):
--   curl -s -X POST "$URL/rest/v1/rpc/publish_blurb" -H "apikey: $KEY" -H "Content-Profile: api" \
--        -H "Content-Type: application/json" -d '{"p":{}}'
