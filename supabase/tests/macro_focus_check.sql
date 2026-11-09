-- =============================================================================
-- macro_focus_check.sql: checks for 20261116000000_macro_focus.sql (macro/finance focus, recall gate)
--   1 weights, settings and range checks; the four feed functions (and seen_tail) wrapped exactly once
--   2 importance after publish; a fresh macro release beats a recall up to 19 h newer (crossover 19.3 h)
--   3 api.set_card_material: service role only, validation, not_found
--   4 guest Trending: non-material recalls never shown, material ones shown and capped (1 in any 10), science
--     capped, whole keyset scroll: every visible card once, pages full, same cursor = same page
--   5 the Safety chip (category browse) still lists every recall, material or not, in Trending and Latest
--   6 guest Latest: same gate and cap, non-micro cards newest first, older cursor works, broken MC: refused
--   7 For you v5 (mode 0) and the v7 path: gate and cap, no repeats
--   8 seen-exclusion together with the gate (signed in): seen cards out of the unseen part, left-out recalls
--     never shown (also not in the "all caught up" tail), every card once
--   9 api.followed_micro: followed company's left-out recall shows, unfollowed and material ones do not,
--     hidden topics respected, bad tickers ignored, anon may call
--  10 refill: 40 left-out recalls ranked above 12 macro cards: full first page, every macro card once
--  11 switches: gate off + cap off = the base functions byte for byte; no micro card = unchanged order
--  12 api.macro_share: service role only, counts on known data
--
-- Supabase SQL editor: needs the test users element-test-a@example.com and element-test-b@example.com.
-- Paste the whole file and run it, with no ingest run going.
--   expected:     ERROR: ALL MACRO_FOCUS CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- =============================================================================

do $$
declare
  ua      uuid;
  base    numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  b       uuid;
  i       int;
  n       int;
  r       jsonb;
  r2      jsonb;
  cur     text;
  pages   int;
  sizes   int[];
  seen    uuid[];
  flags   boolean[];
  gated   uuid[] := '{}';
  viewed  uuid[] := '{}';
  ok      boolean;
  got     text;
  imp_r   numeric;
  imp_m   numeric;
  s_r     numeric;
  s_m     numeric;
  rl      text;
  fn      text;
  macro   text[] := array['economy', 'markets', 'earnings', 'deals', 'energy', 'insider'];
  evt     text[] := array['macro_release', 'deal', 'earnings', 'deal', 'macro_release', 'insider'];
  ord_on  uuid[];
  ord_off uuid[];
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  if ua is null then
    raise exception 'SETUP: create the users element-test-a@example.com and element-test-b@example.com first';
  end if;
  delete from core.ml_pages    where user_id = ua;
  delete from core.user_events where user_id = ua;
  delete from core.user_prefs  where user_id = ua;
  update core.blurbs set status = 'hidden' where status = 'published';   -- real cards out of the way (rolled back)
  update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode');

  -- ---- 1. settings and wrapping --------------------------------------------------------------------------------
  select string_agg(event_type || '=' || weight::text, ',' order by event_type) into got
    from core.rank_event_weights where event_type in ('recall', 'science', 'earnings');
  if got is distinct from 'earnings=6,recall=1.5,science=1.5' then raise exception 'FAIL: event weights %', got; end if;
  select string_agg(key || '=' || value::text, ',' order by key) into got
    from core.rank_params where starts_with(key, 'micro_');
  if got is distinct from 'micro_category:safety=2,micro_category:science=1,micro_follow_days=14,micro_follow_max=30,micro_gate_max_calls=4,micro_material_min_units=100000,micro_max_per_10=1,micro_watch_material=1' then
    raise exception 'FAIL: micro settings %', got;
  end if;
  ok := false; begin update core.rank_params set value = 11 where key = 'micro_max_per_10'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: micro_max_per_10 accepted 11'; end if;
  ok := false; begin update core.rank_params set value = 3 where key = 'micro_category:safety'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: micro_category accepted 3'; end if;
  ok := false; begin update core.rank_params set value = 0 where key = 'micro_gate_max_calls'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: micro_gate_max_calls accepted 0'; end if;
  foreach fn in array array['feed_top(text,text,integer,text)', 'feed_for_you_v5(text,integer)',
                            'feed_for_you_v6(text,integer,bigint,bigint)', 'feed_for_you_v7(text,integer)'] loop
    if (select prosrc from pg_proc where oid = to_regprocedure('core.' || fn)) not like '%macro_focus_wrapper%'
       or to_regprocedure('core.' || replace(fn, '(', '_base(')) is null
       or (select prosrc from pg_proc where oid = to_regprocedure('core.' || replace(fn, '(', '_base('))) like '%macro_focus_wrapper%' then
      raise exception 'FAIL: core.% is not wrapped exactly once', fn;
    end if;
  end loop;
  if to_regprocedure('core.seen_tail_base(uuid,text,text,integer,boolean)') is not null
     and (select prosrc from pg_proc where oid = 'core.seen_tail(uuid,text,text,integer,boolean)'::regprocedure) not like '%macro_focus_wrapper%' then
    raise exception 'FAIL: core.seen_tail not wrapped';
  end if;
  -- the seen filter of the installed base is still there (seen-exclusion migration applied before this one)
  if to_regprocedure('core.seen_ids(uuid,timestamptz)') is not null
     and (select prosrc from pg_proc where oid = 'core.feed_top_base(text,text,integer,text)'::regprocedure) not like '%v_sx%' then
    raise exception 'FAIL: the wrapped feed_top lost the seen filter';
  end if;

  -- ---- 2. importance after publish; fresh macro beats a recall --------------------------------------------------
  r := api.publish_blurb(jsonb_build_object('dedupe_key', 'mf-recall', 'kind', 'summary', 'headline', 'MF recall', 'category', 'safety',
         'event_type', 'recall', 'ai_generated', true, 'sort_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         'sources', jsonb_build_array(jsonb_build_object('name', 'U.S. Consumer Product Safety Commission', 'kind', 'government',
           'doc_label', 'Recall', 'url', 'https://www.cpsc.gov/Recalls/mf-1', 'license_class', 'public_domain'))));
  if r ->> 'status' <> 'published' then raise exception 'FAIL: recall publish %', r; end if;
  r := api.publish_blurb(jsonb_build_object('dedupe_key', 'mf-macro', 'kind', 'summary', 'headline', 'MF macro', 'category', 'economy',
         'event_type', 'macro_release', 'ai_generated', true, 'sort_at', to_char((now() - interval '19 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         'sources', jsonb_build_array(jsonb_build_object('name', 'U.S. Bureau of Labor Statistics', 'kind', 'government',
           'doc_label', 'Release', 'url', 'https://www.bls.gov/news.release/mf-1.htm', 'license_class', 'public_domain'))));
  if r ->> 'status' <> 'published' then raise exception 'FAIL: macro publish %', r; end if;
  select importance, rank_score into imp_r, s_r from core.blurbs where dedupe_key = 'mf-recall';
  select importance, rank_score into imp_m, s_m from core.blurbs where dedupe_key = 'mf-macro';
  if imp_r <> 1.875 or imp_m <> 10 then raise exception 'FAIL: importance recall % (want 1.875), macro % (want 10)', imp_r, imp_m; end if;
  if s_m <= s_r then raise exception 'FAIL: a 19 h old macro release (%) does not beat a brand-new recall (%)', s_m, s_r; end if;
  if s_m - s_r > 0.33 or s_m - s_r < 0.31 then raise exception 'FAIL: 19 h macro lead is % h, want 0.32 (crossover 19.32 h)', s_m - s_r; end if;

  -- ---- 3. api.set_card_material --------------------------------------------------------------------------------
  foreach rl in array array['anon', 'authenticated'] loop
    perform set_config('role', rl, true);
    ok := false; begin perform api.set_card_material('{}'); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.set_card_material', rl; end if;
    perform set_config('role', 'none', true);
  end loop;
  if not has_function_privilege('service_role', 'api.set_card_material(jsonb)', 'execute') then raise exception 'FAIL: service_role grant'; end if;
  ok := false; begin perform api.set_card_material('{"id":"x","material":true}'); exception when others then ok := sqlerrm = 'invalid_id'; end;
  if not ok then raise exception 'FAIL: bad id accepted'; end if;
  ok := false; begin perform api.set_card_material(jsonb_build_object('id', gen_random_uuid(), 'material', 'yes')); exception when others then ok := sqlerrm = 'invalid_material'; end;
  if not ok then raise exception 'FAIL: non-boolean material accepted'; end if;
  if api.set_card_material(jsonb_build_object('id', gen_random_uuid(), 'material', true)) ->> 'status' <> 'not_found' then raise exception 'FAIL: not_found'; end if;
  select id into b from core.blurbs where dedupe_key = 'mf-recall';
  r := api.set_card_material(jsonb_build_object('id', b, 'material', true, 'reasons', jsonb_build_array('units_100000'), 'tickers', jsonb_build_array('mmm', 'bad ticker!')));
  if r ->> 'status' <> 'set' or (select tickers from core.card_material where blurb_id = b) <> array['MMM'] then raise exception 'FAIL: set_card_material %', r; end if;
  update core.blurbs set status = 'hidden' where dedupe_key in ('mf-recall', 'mf-macro');

  -- ---- catalog: 30 macro + 2 material recalls + 1 science (shown, capped) + 6 left-out recalls -------------------
  -- micro cards rank HIGHEST and are the NEWEST, so without the rules they would lead both tabs
  for i in 1 .. 9 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, event_type, as_of, sort_at, rank_score)
    values ('mf-u' || i, 'summary', 'MF micro ' || i, case when i = 3 then 'science' else 'safety' end,
            case when i = 3 then 'science' else 'recall' end, now(), now() - make_interval(secs => i * 60), base + 100 - i * 0.1)
    returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'MF micro source ' || i, 'government', 'https://www.cpsc.gov/mf/u' || i, 'public_domain', true);
    if i in (1, 2) then
      perform api.set_card_material(jsonb_build_object('id', b, 'material', true, 'reasons', jsonb_build_array('deaths')));
    elsif i <> 3 then
      gated := gated || b;
      if i < 9 then                                                     -- u9: no row at all (= not material)
        perform api.set_card_material(jsonb_build_object('id', b, 'material', false, 'reasons', jsonb_build_array('minor'),
                                                         'tickers', case when i = 4 then jsonb_build_array('MMM') else '[]'::jsonb end));
      end if;
    end if;
  end loop;
  for i in 1 .. 30 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, event_type, as_of, sort_at, rank_score)
    values ('mf-m' || i, 'summary', 'MF macro ' || i, macro[1 + (i % 6)], evt[1 + (i % 6)], now(),
            now() - make_interval(secs => 600 + i * 60), base + 90 - i * 0.5)
    returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'MF macro source ' || i, 'filing', 'https://www.sec.gov/mf/m' || i, 'company_filing', true);
  end loop;

  -- ---- 4 + 6. guest Trending and Latest --------------------------------------------------------------------------
  foreach rl in array array['top', 'latest'] loop
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    seen := '{}'; sizes := '{}'; cur := null; pages := 0;
    loop
      r := api.feed(rl, cur, 10, null);
      seen  := seen || array(select (x.c ->> 'id')::uuid from jsonb_array_elements(r -> 'items') with ordinality as x(c, o) order by x.o);
      sizes := sizes || jsonb_array_length(r -> 'items');
      if pages = 0 then
        r2 := api.feed(rl, null, 10, null);
        if r2 is distinct from r then raise exception 'FAIL: % first page differs on a repeat', rl; end if;
      end if;
      if pages = 1 then
        r2 := api.feed(rl, cur, 10, null);
        if r2 is distinct from r then raise exception 'FAIL: % same cursor gave a different page', rl; end if;
      end if;
      cur := r ->> 'next_cursor'; pages := pages + 1;
      exit when cur is null or pages > 20;
      if pages = 1 then
        r2 := r;   -- keep page 1; page 2 is fetched next and compared with a repeat above
      end if;
    end loop;
    perform set_config('role', 'none', true);
    if cardinality(seen) <> 33 or (select count(distinct x) from unnest(seen) x) <> 33 then
      raise exception 'FAIL: % scroll showed % cards, % distinct (want 33)', rl, cardinality(seen), (select count(distinct x) from unnest(seen) x);
    end if;
    if seen && gated then raise exception 'FAIL: % showed a non-material recall', rl; end if;
    if exists (select 1 from unnest(sizes[1:cardinality(sizes) - 1]) s where s <> 10) then raise exception 'FAIL: % page sizes %', rl, sizes; end if;
    flags := array(select bb.category in ('safety', 'science') from unnest(seen) with ordinality as u(id, o) join core.blurbs bb on bb.id = u.id order by u.o);
    select max((select count(*) from generate_series(i0, least(i0 + 9, cardinality(flags))) k where flags[k])) into n
      from generate_series(1, cardinality(flags)) i0;
    if n > 1 then raise exception 'FAIL: % has % micro cards in some 10 in a row: %', rl, n, flags; end if;
    if not flags[1] then raise exception 'FAIL: % the top micro card should still lead (cap allows 1)', rl; end if;
    if rl = 'latest' and exists (select 1 from (select bb.sort_at, lag(bb.sort_at) over (order by u.o) as prev
                                                  from unnest(seen) with ordinality as u(id, o) join core.blurbs bb on bb.id = u.id
                                                 where bb.category not in ('safety', 'science')) z where z.prev < z.sort_at) then
      raise exception 'FAIL: Latest reordered non-micro cards';
    end if;
  end loop;
  -- Latest: an older cursor ('<sort_at>|<id>') still works; a broken MC: cursor is refused
  select to_char(sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || id into cur from core.blurbs where dedupe_key = 'mf-m5';
  perform set_config('role', 'anon', true);
  if jsonb_array_length(api.feed('latest', cur, 10, null) -> 'items') <> 10 then raise exception 'FAIL: old Latest cursor'; end if;
  ok := false; begin r := api.feed('latest', 'MC:%%%:zz:x', 10, null); exception when others then ok := sqlerrm = 'invalid_cursor'; end;
  if not ok then raise exception 'FAIL: a broken MC: cursor was not refused'; end if;

  -- ---- 5. Safety chip lists every recall --------------------------------------------------------------------------
  foreach rl in array array['top', 'latest'] loop
    r := api.feed(rl, null, 30, 'safety');
    select count(*) into n from jsonb_array_elements(r -> 'items') x;
    if n <> 8 then raise exception 'FAIL: Safety chip (%) lists % recalls, want 8', rl, n; end if;
  end loop;
  perform set_config('role', 'none', true);

  -- ---- 7. For you v5 and v7 (signed in, no views yet) --------------------------------------------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  foreach rl in array array['v5', 'v7'] loop
    perform set_config('role', 'authenticated', true);
    seen := '{}'; cur := null; pages := 0;
    loop
      if rl = 'v5' then r := api.feed_for_you(cur, 10); else perform set_config('role', 'none', true); r := core.feed_for_you_v7(cur, 10); end if;
      seen := seen || array(select (x.c ->> 'id')::uuid from jsonb_array_elements(r -> 'items') with ordinality as x(c, o) order by x.o);
      if r ? 'terms' and jsonb_array_length(r -> 'terms') <> jsonb_array_length(r -> 'items') then raise exception 'FAIL: v7 terms not aligned'; end if;
      cur := r ->> 'next_cursor'; pages := pages + 1;
      exit when cur is null or pages > 20;
    end loop;
    perform set_config('role', 'none', true);
    if cardinality(seen) <> 33 or (select count(distinct x) from unnest(seen) x) <> 33 then
      raise exception 'FAIL: For you % showed % cards, % distinct (want 33)', rl, cardinality(seen), (select count(distinct x) from unnest(seen) x);
    end if;
    if seen && gated then raise exception 'FAIL: For you % showed a non-material recall', rl; end if;
    flags := array(select bb.category in ('safety', 'science') from unnest(seen) with ordinality as u(id, o) join core.blurbs bb on bb.id = u.id order by u.o);
    select max((select count(*) from generate_series(i0, least(i0 + 9, cardinality(flags))) k where flags[k])) into n
      from generate_series(1, cardinality(flags)) i0;
    if n > 1 then raise exception 'FAIL: For you % has % micro cards in some 10 in a row: %', rl, n, flags; end if;
  end loop;
  perform set_config('role', 'none', true);

  -- ---- 8. seen-exclusion + gate (only when 20261113000000_seen_exclusion.sql is installed) ---------------------------
  if to_regprocedure('core.seen_ids(uuid,timestamptz)') is not null then
    -- A has seen 5 macro cards and one left-out recall (e.g. in the Safety chip)
    viewed := array(select id from core.blurbs where dedupe_key in ('mf-m1', 'mf-m2', 'mf-m7', 'mf-m11', 'mf-m20'));
    insert into core.user_events (user_id, blurb_id, kind, created_at)
    select ua, v, 'view', now() - interval '1 hour' from unnest(viewed || gated[1]) v;
    foreach rl in array array['top', 'latest', 'foryou'] loop
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
      seen := '{}'; cur := null; pages := 0; n := null;
      loop
        r := case when rl = 'foryou' then api.feed_for_you(cur, 10) else api.feed(rl, cur, 10, null) end;
        if r ->> 'seen_from' is not null and n is null then n := cardinality(seen) + (r ->> 'seen_from')::int; end if;
        seen := seen || array(select (x.c ->> 'id')::uuid from jsonb_array_elements(r -> 'items') with ordinality as x(c, o) order by x.o);
        cur := r ->> 'next_cursor'; pages := pages + 1;
        exit when cur is null or pages > 20;
      end loop;
      perform set_config('role', 'none', true);
      if seen && gated then raise exception 'FAIL: % (signed in, seen on) showed a non-material recall', rl; end if;
      if (select count(distinct x) from unnest(seen) x) <> cardinality(seen) then raise exception 'FAIL: % repeated a card', rl; end if;
      if seen[1:28] && viewed then raise exception 'FAIL: % showed a seen card before the unseen ones ran out', rl; end if;
      if not (array(select x from unnest(seen[1:28]) x) <@ seen) or cardinality(seen) < 28 then
        raise exception 'FAIL: % showed % cards, want the 28 unseen ones first', rl, cardinality(seen);
      end if;
    end loop;
    delete from core.user_events where user_id = ua;
  end if;

  -- ---- 9. api.followed_micro --------------------------------------------------------------------------------------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  r := api.followed_micro(array['mmm', 'not a ticker'], 10);
  if jsonb_array_length(r -> 'items') <> 1 or r -> 'items' -> 0 ->> 'headline' <> 'MF micro 4' then
    raise exception 'FAIL: followed_micro(MMM) %', r;
  end if;
  if jsonb_array_length(api.followed_micro(array['AAPL'], 10) -> 'items') <> 0 then raise exception 'FAIL: unfollowed company recall returned'; end if;
  if jsonb_array_length(api.followed_micro(null, 10) -> 'items') <> 0 then raise exception 'FAIL: followed_micro(null)'; end if;
  perform set_config('role', 'none', true);
  -- a material recall of a followed company is already in the feeds: not returned again
  perform api.set_card_material(jsonb_build_object('id', (select id from core.blurbs where dedupe_key = 'mf-u1'), 'material', true, 'tickers', jsonb_build_array('MMM')));
  perform set_config('role', 'anon', true);
  if jsonb_array_length(api.followed_micro(array['MMM'], 10) -> 'items') <> 1 then raise exception 'FAIL: material recall returned by followed_micro'; end if;
  perform set_config('role', 'none', true);
  insert into core.user_prefs (user_id, hidden_categories) values (ua, array['safety']);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  if jsonb_array_length(api.followed_micro(array['MMM'], 10) -> 'items') <> 0 then raise exception 'FAIL: followed_micro ignored a hidden topic'; end if;
  perform set_config('role', 'none', true);
  delete from core.user_prefs where user_id = ua;
  if not has_function_privilege('anon', 'api.followed_micro(text[],integer)', 'execute') then raise exception 'FAIL: anon cannot call followed_micro'; end if;

  -- ---- 12. api.macro_share -----------------------------------------------------------------------------------------
  foreach rl in array array['anon', 'authenticated'] loop
    perform set_config('role', rl, true);
    ok := false; begin perform api.macro_share(); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.macro_share', rl; end if;
    perform set_config('role', 'none', true);
  end loop;
  perform set_config('request.jwt.claims', '', true);
  r := api.macro_share();
  if (r #>> '{trending,top10,n}')::int <> 10 or (r #>> '{trending,top10,micro}')::int <> 1 or (r #>> '{trending,top10,macro_share}')::numeric <> 0.9
     or (r #>> '{trending,top50,n}')::int <> 33 or (r #>> '{trending,top50,micro}')::int <> 3
     or (r #>> '{latest,top10,micro}')::int <> 1 or (r #>> '{latest,top50,n}')::int <> 33
     or (r #>> '{gated_14d,cards}')::int <> 8 or (r #>> '{gated_14d,left_out}')::int <> 6 then
    raise exception 'FAIL: macro_share %', r;
  end if;

  -- ---- 11. switches -----------------------------------------------------------------------------------------------
  update core.rank_params set value = 10 where key = 'micro_max_per_10';
  update core.rank_params set value = 1 where key = 'micro_category:safety';
  if core.feed_top('latest', null, 10, null) is distinct from core.feed_top_base('latest', null, 10, null) then
    raise exception 'FAIL: Latest with gate and cap off differs from the base';
  end if;
  if core.feed_top('top', null, 10, null) is distinct from core.feed_top_base('top', null, 10, null) then
    raise exception 'FAIL: Trending with gate and cap off differs from the base';
  end if;
  update core.rank_params set value = 1 where key = 'micro_max_per_10';
  update core.rank_params set value = 2 where key = 'micro_category:safety';
  update core.blurbs set status = 'hidden' where dedupe_key like 'mf-u%';
  ord_on := array(select (x.c ->> 'id')::uuid from jsonb_array_elements(core.feed_top('top', null, 20, null) -> 'items') with ordinality as x(c, o) order by x.o);
  ord_off := array(select (x.c ->> 'id')::uuid from jsonb_array_elements(core.feed_top_base('top', null, 20, null) -> 'items') with ordinality as x(c, o) order by x.o);
  if ord_on is distinct from ord_off then raise exception 'FAIL: the wrapper changed a page with no micro card'; end if;

  -- ---- 10. refill: 40 left-out recalls ranked above 12 macro cards ----------------------------------------------------
  update core.blurbs set status = 'hidden' where dedupe_key like 'mf-%';
  for i in 1 .. 40 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, event_type, as_of, sort_at, rank_score)
    values ('mf-g' || i, 'summary', 'MF gated ' || i, 'safety', 'recall', now(), now() - make_interval(secs => i * 30), base + 80 - i * 0.05)
    returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'MF gated source ' || (i % 5), 'government', 'https://www.cpsc.gov/mf/g' || i, 'public_domain', true);
  end loop;
  update core.blurbs set status = 'published' where dedupe_key in (select 'mf-m' || g from generate_series(1, 12) g);
  foreach rl in array array['top', 'latest'] loop
    perform set_config('role', 'anon', true);
    seen := '{}'; sizes := '{}'; cur := null; pages := 0;
    loop
      r := api.feed(rl, cur, 10, null);
      seen  := seen || array(select (x.c ->> 'id')::uuid from jsonb_array_elements(r -> 'items') with ordinality as x(c, o) order by x.o);
      sizes := sizes || jsonb_array_length(r -> 'items');
      cur := r ->> 'next_cursor'; pages := pages + 1;
      exit when cur is null or pages > 20;
    end loop;
    perform set_config('role', 'none', true);
    if sizes[1] <> 10 then raise exception 'FAIL: % refill: first page has % cards (want 10)', rl, sizes[1]; end if;
    if cardinality(seen) <> 12 or (select count(distinct x) from unnest(seen) x) <> 12 then
      raise exception 'FAIL: % refill showed % cards, want the 12 macro cards once (pages %)', rl, cardinality(seen), sizes;
    end if;
  end loop;

  -- ---- 13. backfill verdicts from card text (recalls published before the migration) ----------------------------
  if core.recall_text_verdict('Pacearth is recalling about 110,550 swing seats. Nine injuries were reported, including fractures.', '{}')
     <> '{"material": true, "reasons": ["text:units_110550", "text:serious_injuries"]}'::jsonb then
    raise exception 'FAIL: text verdict (units, injuries) %', core.recall_text_verdict('Pacearth is recalling about 110,550 swing seats. Nine injuries were reported, including fractures.', '{}');
  end if;
  if core.recall_text_verdict('Acme recalls about 600 cups. No injuries have been reported. The cups pose a risk of serious injury or death.', '{}')
     <> '{"material": false, "reasons": ["text:minor"]}'::jsonb then
    raise exception 'FAIL: negated / risk-only sentences counted';
  end if;
  if core.recall_text_verdict('The firm is aware of two deaths.', '{}') ->> 'reasons' <> '["text:deaths"]' then raise exception 'FAIL: deaths'; end if;
  if core.recall_text_verdict('About 1.2 million heaters are recalled.', '{}') ->> 'reasons' <> '["text:units_1200000"]' then raise exception 'FAIL: million'; end if;
  if core.recall_text_verdict('3M recalls about 53,634 laminators.', array['MMM']) ->> 'reasons' <> '["text:watch_company_MMM"]' then
    raise exception 'FAIL: watch-list company (micro_watch_material = 1) is not material';
  end if;
  update core.rank_params set value = 0 where key = 'micro_watch_material';
  if (core.recall_text_verdict('3M recalls about 53,634 laminators.', array['MMM']) ->> 'material')::boolean then
    raise exception 'FAIL: micro_watch_material = 0 still counts the company';
  end if;
  update core.rank_params set value = 1 where key = 'micro_watch_material';

  insert into core.blurbs (dedupe_key, kind, headline, body, category, event_type, tickers, as_of, sort_at, rank_score)
  values ('mf-b1', 'summary', 'Big recall', 'Acme is recalling about 250,000 heaters.', 'safety', 'recall', '[]', now(), now(), base),
         ('mf-b2', 'summary', 'Small recall', 'Acme is recalling about 300 mugs. No injuries have been reported.', 'safety', 'recall', '[]', now(), now(), base),
         ('mf-b3', 'summary', 'Brand recall', 'About 900 kettles.', 'safety', 'recall', '[{"symbol":"WMT","name":"Walmart"}]', now(), now(), base),
         ('mf-b4', 'summary', 'Ingest verdict', 'About 900 kettles.', 'safety', 'recall', '[]', now(), now(), base);
  perform api.set_card_material(jsonb_build_object('id', (select id from core.blurbs where dedupe_key = 'mf-b4'), 'material', true, 'reasons', jsonb_build_array('deaths')));
  delete from core.card_material where blurb_id in (select id from core.blurbs where dedupe_key like 'mf-%' and dedupe_key <> 'mf-b4');
  foreach rl in array array['anon', 'authenticated'] loop
    perform set_config('role', rl, true);
    ok := false; begin perform api.backfill_recall_material(false); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.backfill_recall_material', rl; end if;
    perform set_config('role', 'none', true);
  end loop;
  r := core.backfill_recall_material(false);
  select string_agg(b.dedupe_key || '=' || m.material::text, ',' order by b.dedupe_key) into got
    from core.card_material m join core.blurbs b on b.id = m.blurb_id where b.dedupe_key like 'mf-b%';
  if got is distinct from 'mf-b1=true,mf-b2=false,mf-b3=true,mf-b4=true' then raise exception 'FAIL: backfill verdicts % (%)', got, r; end if;
  if (select reasons from core.card_material m join core.blurbs b on b.id = m.blurb_id where b.dedupe_key = 'mf-b4') <> array['deaths'] then
    raise exception 'FAIL: the backfill touched an ingest verdict';
  end if;
  if (core.backfill_recall_material(false) ->> 'checked')::int <> 0 then raise exception 'FAIL: backfill is not idempotent'; end if;
  r := core.backfill_recall_material(true);                              -- redo 'text:' verdicts only
  if (select reasons from core.card_material m join core.blurbs b on b.id = m.blurb_id where b.dedupe_key = 'mf-b4') <> array['deaths'] then
    raise exception 'FAIL: overwrite touched an ingest verdict';
  end if;

  -- ---- 14. macro/finance definition for the share metric (Drew decision 5; real Federal Register cards from the
  --          2026-11-09 prod snapshot) -------------------------------------------------------------------------
  foreach got in array array[
      'OCC issues rules for payment stablecoins|Source: Federal Register (National Archives), Comptroller of the Currency',
      'IRS finalises rules for paying taxes by card|Source: Federal Register (National Archives), Internal Revenue Service',
      'Commerce sets new tariff rates on steel imports|Source: Federal Register (National Archives), International Trade Administration',
      'SEC adopts rule on short sale reporting|Source: Federal Register (National Archives), Securities and Exchange Commission',
      'Agency updates mortgage disclosure rules|Source: Federal Register (National Archives), Housing and Urban Development Department'] loop
    if not core.fedreg_economic(split_part(got, '|', 1), split_part(got, '|', 2)) then raise exception 'FAIL: not economic: %', got; end if;
  end loop;
  foreach got in array array[
      'Boeing 757 video monitors get new safety rules|Source: Federal Register (National Archives), Federal Aviation Administration',
      'FAA orders fixes for Airbus A330-941 flight computers|Source: Federal Register (National Archives), Federal Aviation Administration',
      'Fcc updates rules for stopping unwanted robocalls|Source: Federal Register (National Archives), Federal Communications Commission',
      'Transportation department delays airline rule to February|Source: Federal Register (National Archives), Transportation Department',
      'FAA updates eastern air navigation route|Source: Federal Register (National Archives), Federal Aviation Administration',
      'Accelerated review for separated parts|Source: Federal Register (National Archives), Food and Drug Administration'] loop
    if core.fedreg_economic(split_part(got, '|', 1), split_part(got, '|', 2)) then raise exception 'FAIL: economic: %', got; end if;
  end loop;
  -- whole card JSON: Fed always counts, Federal Register only when economic, the FCC body mentioning banks does not
  if not core.is_macro_card('{"kind":"summary","category":"policy","headline":"Fed raises federal funds rate target range","sources":[{"name":"Federal Reserve Board"}]}', array['economy'])
     or not core.is_macro_card('{"kind":"summary","category":"policy","headline":"Federal Reserve releases September FOMC meeting minutes","sources":[{"name":"Federal Reserve Board"}]}', array['economy'])
     or not core.is_macro_card('{"kind":"summary","category":"policy","headline":"OCC issues rules for payment stablecoins","attribution":"Source: Federal Register (National Archives), Comptroller of the Currency","sources":[{"name":"Federal Register"}]}', array['economy'])
     or core.is_macro_card('{"kind":"summary","category":"policy","headline":"Fcc updates rules for stopping unwanted robocalls","body":"Banks also get new ways to warn customers.","attribution":"Source: Federal Register (National Archives), Federal Communications Commission","sources":[{"name":"Federal Register"}]}', array['economy'])
     or core.is_macro_card('{"kind":"summary","category":"policy","headline":"Interest rates explained","sources":[{"name":"Wikipedia"}]}', array['economy'])
     or not core.is_macro_card('{"kind":"data","category":"policy","headline":"x","sources":[]}', array['economy']) then
    raise exception 'FAIL: core.is_macro_card';
  end if;

  raise exception 'ALL MACRO_FOCUS CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
