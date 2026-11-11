-- Checks for 20261126000000_foryou_m9b.sql (signed-in For you, M9 batch 2). Test rows roll back at the closing error.
-- Settings (D-115, D-116, D-117) and range guards; anon cannot call the new 4-argument function; a key-series card
-- older than the 30-day window stays in For you (key_release); a followed company's card rises with reason
-- follow_company; a followed topic says follow_topic; a liked company says liked_company; at most 1 single-company
-- card in any 3 of the first 9 slots; full scrolls (v5 and v3) never repeat a card; another reader sees none of the
-- first reader's reasons; the old 2- and 3-argument calls still work.
do $$
declare
  ua uuid; ub uuid;
  base numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  ok boolean; r jsonb; cur text; c uuid[]; ids uuid[]; codes text[]; co boolean[]; i int; n int; mode int;
  k_old uuid; k_other uuid; k_new uuid; msft uuid; en uuid; aapl_liked uuid; aapl2 uuid; t1 text; t2 text;
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  delete from core.ml_pages where user_id in (ua, ub);
  delete from core.user_events where user_id in (ua, ub);
  delete from core.user_prefs where user_id in (ua, ub);
  update core.blurbs set status = 'hidden' where status = 'published';
  update core.ml_models set gate_passed = false where gate_passed;
  update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode');

  -- 1. settings
  if (select value from core.rank_params where key = 'fedreg_noneconomic_micro') <> 1 then raise exception 'FAIL: fedreg_noneconomic_micro must be 1 (D-115)'; end if;
  if (select value from core.rank_params where key = 'ml_purge_events_days') <> 60 then raise exception 'FAIL: ml_purge_events_days must be 60 (D-117)'; end if;
  if (select value from core.rank_params where key = 'foryou_personal_scale') <> 3 then raise exception 'FAIL: foryou_personal_scale must stay 3 (D-116)'; end if;
  if (select value from core.rank_params where key = 'foryou_max_scored') <> 1500 then raise exception 'FAIL: foryou_max_scored changed'; end if;
  ok := false; begin update core.rank_params set value = 20 where key = 'ml_purge_events_days'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: ml_purge_events_days accepted 20 (floor 31)'; end if;
  ok := false; begin update core.rank_params set value = 100 where key = 'fy_follow_company_hours'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: fy_follow_company_hours accepted 100'; end if;

  -- 2. grants
  if has_function_privilege('anon', 'api.feed_for_you(text,integer,uuid[],text[])', 'execute') then raise exception 'FAIL: anon can call api.feed_for_you (4 args)'; end if;
  if not has_function_privilege('authenticated', 'api.feed_for_you(text,integer,uuid[],text[])', 'execute') then raise exception 'FAIL: authenticated cannot call api.feed_for_you (4 args)'; end if;
  if has_function_privilege('authenticated', 'core.fy_post(jsonb,uuid)', 'execute') then raise exception 'FAIL: core.fy_post is client-callable'; end if;

  -- 3. cards: 40 fresh market stories, 8 fresh single-company earnings cards (AAPL tag), a 45-day-old CPI card
  --    (key series), a 45-day-old non-key data card, an older MSFT card, an energy card, a liked older AAPL card
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score)
  select 'm9b-' || g, 'summary', 'Market story ' || g, 'Text.', 'markets', 'published', now(), now(), now() - make_interval(hours => g), 4, base - g + 16
    from generate_series(1, 40) g;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score, tickers)
  select 'm9b-co-' || g, 'summary', 'Company posts results ' || g, 'Text.', 'earnings', 'published', now(), now(), now() - make_interval(mins => 30 * g), 6,
         base - 0.5 * g + 21, '[{"symbol":"AAPL","name":"Apple","exchange":"NASDAQ"}]'::jsonb
    from generate_series(1, 8) g;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score)
  values ('CPIAUCSL:2026-08', 'data', 'Consumer prices up 3.0%', 'CPI.', 'economy', 'published', now() - interval '70 days', now() - interval '40 days',
          now() - interval '70 days', 8, base - 70 * 24 + 24) returning id into k_old;
  -- released an hour ago for a period 40 days back: counts from its release (F7)
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score)
  values ('ZZM9BNEW:2026-09', 'data', 'Trade deficit shrinks', 'X.', 'economy', 'published', now() - interval '40 days', now() - interval '1 hour',
          now() - interval '40 days', 8, base - 40 * 24 + 24) returning id into k_new;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score)
  values ('ZZM9BTEST:2026-08', 'data', 'Other series 1.0%', 'X.', 'economy', 'published', now() - interval '70 days', now() - interval '40 days',
          now() - interval '70 days', 8, base - 70 * 24 + 24) returning id into k_other;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score, tickers)
  values ('m9b-msft', 'summary', 'Microsoft files a report', 'Text.', 'deals', 'published', now(), now(), now() - interval '30 hours', 4, base - 30 + 16,
          '[{"symbol":"MSFT","name":"Microsoft","exchange":"NASDAQ"}]') returning id into msft;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score)
  values ('m9b-en', 'summary', 'Gas prices fall', 'Text.', 'energy', 'published', now(), now(), now() - interval '30 hours', 4, base - 30 + 16) returning id into en;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score, tickers)
  values ('m9b-aapl-old', 'summary', 'Apple old news', 'Text.', 'deals', 'published', now(), now(), now() - interval '20 days', 4, base - 480 + 16,
          '[{"symbol":"AAPL","name":"Apple","exchange":"NASDAQ"}]') returning id into aapl_liked;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select id, 'SEC', 'government', 'https://www.sec.gov/m9b/' || dedupe_key, 'public_domain', true
    from core.blurbs where dedupe_key like 'm9b%' or dedupe_key in ('CPIAUCSL:2026-08', 'ZZM9BTEST:2026-08', 'ZZM9BNEW:2026-09');
  -- company tags (the tag trigger may already have added them; tickers must exist in core.companies)
  insert into core.companies (ticker, name, short_name, sector, industry)
  values ('AAPL', 'Apple Inc.', 'Apple', 'tech', 'hardware'), ('MSFT', 'Microsoft Corporation', 'Microsoft', 'tech', 'software')
  on conflict do nothing;
  insert into core.card_companies (blurb_id, ticker, method, confidence, sort_at)
  select b.id, x.t, 'card_ticker', 1, b.sort_at
    from core.blurbs b cross join lateral (select upper(j ->> 'symbol') t from jsonb_array_elements(b.tickers) j) x
   where b.dedupe_key like 'm9b%'
  on conflict do nothing;

  -- reader A: follows energy, liked the old Apple card, some events so it is warm
  insert into core.user_prefs (user_id, followed_categories) values (ua, '{energy}');
  insert into core.user_events (user_id, blurb_id, kind, created_at) values (ua, aapl_liked, 'like', now() - interval '1 hour');
  insert into core.user_events (user_id, blurb_id, kind, created_at)
  select ua, id, 'like', now() - interval '2 hours' from core.blurbs where dedupe_key in ('m9b-30', 'm9b-31', 'm9b-32', 'm9b-33', 'm9b-34');

  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- 4. full scrolls with followed MSFT, v5 (mode 0) and v3 (mode 3): no repeats, key card in, non-key old card out
  foreach mode in array array[0, 3] loop
    update core.rank_params set value = mode where key = 'foryou_ml_mode';
    update core.rank_params set value = 0 where key = 'v3_holdout_pct';
    c := '{}'; cur := null;
    for n in 1..20 loop
      r := api.feed_for_you(cur, 20, '{}'::uuid[], array['msft']);
      c := c || array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
      cur := r ->> 'next_cursor'; exit when cur is null;
    end loop;
    if (select count(distinct x) from unnest(c) x) <> cardinality(c) then raise exception 'FAIL: mode % scroll repeated a card', mode; end if;
    if not (k_old = any (c)) then raise exception 'FAIL: mode % key-series card older than the window must stay eligible', mode; end if;
    if not (k_new = any (c[1:10])) then raise exception 'FAIL: mode % a data card released an hour ago must count as fresh (pos %)', mode, array_position(c, k_new); end if;
    if k_other = any (c) then raise exception 'FAIL: mode % a non-key data card older than the window came in', mode; end if;
    if not (msft = any (c[1:20])) then raise exception 'FAIL: mode % followed company card must be in the top 20 (pos %)', mode, array_position(c, msft); end if;
    ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(api.feed_for_you(null, 30, '{}'::uuid[]) -> 'items') x);
    if array_position(ids, msft) is not null and array_position(ids, msft) <= array_position(c, msft) then
      raise exception 'FAIL: mode % following MSFT must lift its card (% without, % with)', mode, array_position(ids, msft), array_position(c, msft); end if;
  end loop;
  update core.rank_params set value = 0 where key = 'foryou_ml_mode';

  -- 5. reasons and the company cap on page 1
  r := api.feed_for_you(null, 20, '{}'::uuid[], array['MSFT']);
  ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') with ordinality t(x, o) order by o);
  codes := array(select x -> 'reason' ->> 'code' from jsonb_array_elements(r -> 'items') with ordinality t(x, o) order by o);
  if exists (select 1 from unnest(codes) c0 where c0 is null) then raise exception 'FAIL: every For you card needs a reason (%)', codes; end if;
  if codes[array_position(ids, msft)] <> 'follow_company' then raise exception 'FAIL: MSFT card reason %', codes[array_position(ids, msft)]; end if;
  if en = any (ids) and codes[array_position(ids, en)] <> 'follow_topic' then raise exception 'FAIL: energy card reason %', codes[array_position(ids, en)]; end if;
  if not ('liked_company' = any (codes)) then raise exception 'FAIL: an AAPL card should say liked_company (%)', codes; end if;
  co := array(select (x ->> 'category') = 'earnings' from jsonb_array_elements(r -> 'items') with ordinality t(x, o) order by o);
  for i in 1..7 loop
    if (co[i]::int + co[i + 1]::int + co[i + 2]::int) > 1 then raise exception 'FAIL: more than 1 company card in slots %-% (%)', i, i + 2, co; end if;
  end loop;
  if (select (x ->> 'reason') from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = k_old) is not null
     and k_old = any (ids) and codes[array_position(ids, k_old)] <> 'key_release' then
    raise exception 'FAIL: key card reason %', codes[array_position(ids, k_old)]; end if;

  -- 6. old calls still work (no tickers: no follow_company reason)
  r := api.feed_for_you(null, 20);
  if jsonb_array_length(r -> 'items') = 0 then raise exception 'FAIL: 2-argument call returned nothing'; end if;
  if exists (select 1 from jsonb_array_elements(r -> 'items') x where x -> 'reason' ->> 'code' = 'follow_company') then
    raise exception 'FAIL: follow_company without followed tickers'; end if;
  r := api.feed_for_you(null, 20, '{}'::uuid[]);
  if jsonb_array_length(r -> 'items') = 0 then raise exception 'FAIL: 3-argument call returned nothing'; end if;
  if core.fy_followed_tickers() <> '{}' then raise exception 'FAIL: followed tickers leaked past the request'; end if;

  -- 7. reader B sees nothing of A's follows or likes
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := api.feed_for_you(null, 20, '{}'::uuid[], '{}'::text[]);
  if exists (select 1 from jsonb_array_elements(r -> 'items') x
              where x -> 'reason' ->> 'code' in ('follow_topic', 'follow_company', 'liked_company', 'liked_topic')) then
    raise exception 'FAIL: reader B got a personal reason from reader A'; end if;

  -- 8. anon: not authenticated
  perform set_config('request.jwt.claims', '', true);
  ok := false; begin perform api.feed_for_you(null, 20, '{}'::uuid[], '{}'::text[]); exception when others then ok := sqlstate = 'PT401'; end;
  if not ok then raise exception 'FAIL: For you without a user must raise not_authenticated'; end if;

  raise exception 'ALL FORYOU M9B CHECKS PASSED';
end $$;
