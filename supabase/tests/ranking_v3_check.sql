-- =============================================================================
-- ranking_v3_check.sql: checks for 20261112000000_ranking_v3.sql (For you ranking v3)
--   settings ship off; v3 functions closed to anon/authenticated; a cold-start reader gets exactly the v5
--   order in mode 3; mode 3 with evidence: v7 pages, cursor layout, same cursor = same page, a full scroll
--   with no repeats, logging with the v3 terms; reader A's scores ignore reader B; modes 0, 1 and 2 unchanged;
--   a v3 scroll finishes on v3 after switching off; cost guard, errors and statement timeouts fall back to v5;
--   holdout; no division by zero; delete_my_data resets to cold start; guest api.feed unchanged; daily check.
--
-- Supabase SQL editor: needs the two test users element-test-a@example.com and
-- element-test-b@example.com. Paste the whole file and run it, with no ingest run going.
--   expected:     ERROR: ALL RANKING_V3 CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- Mode 3 is switched on only inside this block, which is rolled back at the end.
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
  r      jsonb;
  r2     jsonb;
  cur    text;
  cur2   text;
  c0     text;
  ok     boolean;
  got    text;
  seen   text[];
  seen5  text[];
  rl     text;
  asof   timestamptz := now();
  cold   jsonb;
  s1     jsonb;
  s2     jsonb;
  g      bigint;
  cats   text[] := array['markets', 'world', 'tech', 'policy', 'energy', 'deals'];
  heads  text[] := array['Stocks rally on Wall Street', 'Storm hits the coast', 'New AI chips ship',
                         'Fed holds interest rates', 'Oil prices slide', 'Merger talks continue'];
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
  update core.ml_models set gate_passed = false where gate_passed;       -- no v2 model takes part (rolled back)

  -- ---- 1. settings: shipped off, tuned values ------------------------------------------------------------
  if (select value from core.rank_params where key = 'foryou_ml_mode') <> 0 then
    raise exception 'FAIL: foryou_ml_mode is not 0 (v3 must ship off)';
  end if;
  update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode');
  select string_agg(key || '=' || value::text, ',' order by key) into got from core.rank_params
   where key in ('v3_hours_per_reward', 'v3_cap_hours', 'v3_lambda', 'v3_k0', 'v3_w_topic', 'v3_w_type',
                 'v3_w_source', 'v3_w_tag', 'v3_step_extra', 'v3_holdout_pct');
  if got is distinct from 'v3_cap_hours=30,v3_holdout_pct=10,v3_hours_per_reward=36,v3_k0=3,v3_lambda=2,v3_step_extra=2.5,v3_w_source=0.5,v3_w_tag=1,v3_w_topic=1,v3_w_type=0.5' then
    raise exception 'FAIL: v3 rank_params are %', got;
  end if;
  -- Drew's decision (20261117000000_v3_extra_cold.sql): the extra topic step also for cold readers
  if (select value from core.rank_params where key = 'v3_step_extra_cold') is distinct from 1 then
    raise exception 'FAIL: v3_step_extra_cold is %, expected 1', (select value from core.rank_params where key = 'v3_step_extra_cold');
  end if;
  ok := false; begin update core.rank_params set value = 0 where key = 'v3_half_life_days'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: v3_half_life_days accepted 0'; end if;
  ok := false; begin update core.rank_params set value = -1 where key = 'v3_lambda'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: v3_lambda accepted -1'; end if;

  -- ---- 2. privileges ---------------------------------------------------------------------------------
  foreach rl in array array['anon', 'authenticated'] loop
    perform set_config('role', rl, true);
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', rl)::text, true);
    ok := false; begin perform core.v3_reader_weights(ua, now()); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.v3_reader_weights', rl; end if;
    ok := false; begin perform core.v3_scores(ua, now(), 0); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.v3_scores', rl; end if;
    ok := false; begin perform core.feed_for_you_v7(null, 10); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.feed_for_you_v7', rl; end if;
    ok := false; begin perform api.ml_v3_check(); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_v3_check', rl; end if;
    ok := false; begin perform core.ml_kill_counts('fy-v3', 3); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.ml_kill_counts', rl; end if;
    perform set_config('role', 'none', true);
  end loop;
  perform set_config('role', 'anon', true);
  ok := false; begin perform api.feed_for_you(null, 10); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: anon can call api.feed_for_you'; end if;
  perform set_config('role', 'none', true);
  if not has_function_privilege('service_role', 'api.ml_v3_check()', 'execute')
     or not has_function_privilege('service_role', 'api.ml_v2_check()', 'execute')
     or has_function_privilege('anon', 'api.feed_for_you(text,integer)', 'execute')
     or not has_function_privilege('authenticated', 'api.feed_for_you(text,integer)', 'execute')
     or (select provolatile from pg_proc where oid = 'api.feed_for_you(text,integer)'::regprocedure) <> 'v' then
    raise exception 'FAIL: grants';
  end if;
  if exists (select 1 from pg_proc p
              where p.oid in ('core.v3_reader_weights(uuid,timestamptz)'::regprocedure, 'core.v3_scores(uuid,timestamptz,bigint)'::regprocedure,
                              'core.feed_for_you_v7(text,integer)'::regprocedure, 'api.ml_v3_check()'::regprocedure)
                and (not p.prosecdef or not (p.proconfig @> array['search_path=""']))) then
    raise exception 'FAIL: v3 functions must be security definer with an empty search_path';
  end if;

  -- cards: 36, six topics, each with its own source, headlines that hit tag rules
  for i in 1 .. 36 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('rv3-' || i, 'summary', heads[1 + (i % 6)] || ' ' || i, cats[1 + (i % 6)], now(),
            now() - make_interval(secs => i * 300), base + 20 - i * 0.5)
    returning id into b;
    cards := cards || b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'RV3 source ' || i, 'filing', 'https://www.sec.gov/rv3/' || b, 'company_filing', true);
  end loop;
  select coalesce(max(gen), 0) into g from core.trend_generations;
  update core.rank_params set value = 0 where key = 'v3_holdout_pct';         -- nobody in the holdout until section 9
  c0 := '1e12|ffffffff-ffff-ffff-ffff-ffffffffffff||' || to_char(asof at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '||';

  -- ---- 3. cold start in mode 3: no weights and no v3 hours. With v3_step_extra_cold = 1 (shipped) the extra
  --         topic step applies: every score is the v5 score minus 2.5 h per better same-topic card ahead, and a
  --         whole scroll still has all 36 cards once. With v3_step_extra_cold = 0: exactly the v5 order. ---------
  if exists (select 1 from core.v3_reader_weights(ua, asof)) then raise exception 'FAIL: cold reader has weights'; end if;
  if exists (select 1 from core.v3_scores(ua, asof, g) where o_v3 <> 0) then raise exception 'FAIL: cold reader has v3 hours'; end if;
  select jsonb_agg(jsonb_build_array(o_id, o_ps) order by o_ps desc, o_id desc) into cold from core.v3_scores(ua, asof, g);
  if coalesce(jsonb_array_length(cold), 0) <> 36 then raise exception 'FAIL: cold-start scores for % cards', jsonb_array_length(cold); end if;
  if exists (select 1 from (
        select o_ps, o_s0, row_number() over (partition by o_category order by o_s0 + o_v3 desc, o_id desc) - 1 as d
          from core.v3_scores(ua, asof, g)) x
      where x.d > 0 and x.o_ps > x.o_s0 - x.d * 2.5 + 1e-6) then
    raise exception 'FAIL: cold reader does not get the extra topic step (v3_step_extra_cold = 1)';
  end if;
  update core.rank_params set value = 3 where key = 'foryou_ml_mode';
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  seen := '{}'; cur := null; n := 0;
  loop
    perform set_config('role', 'authenticated', true);
    r := api.feed_for_you(cur, 10);
    perform set_config('role', 'none', true);
    seen := seen || array(select x ->> 'id' from jsonb_array_elements(r -> 'items') x);
    cur := r ->> 'next_cursor'; n := n + 1;
    exit when cur is null or n > 10;
  end loop;
  if cardinality(seen) <> 36 or (select count(distinct s) from unnest(seen) s) <> 36 then
    raise exception 'FAIL: cold reader scroll with the extra step: % cards', cardinality(seen);
  end if;
  delete from core.ml_pages where user_id = ua;
  update core.rank_params set value = 0 where key = 'v3_step_extra_cold';      -- the switch: exactly v5 again
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  seen := '{}'; seen5 := '{}'; cur := null; cur2 := null; n := 0;        -- a new scroll (an old cursor stays on v5)
  loop
    perform set_config('role', 'authenticated', true);
    r := api.feed_for_you(cur, 10);
    perform set_config('role', 'none', true);
    r2 := core.fy_post(core.feed_for_you_v5(cur2, 10), ua) - '_perm';
    if split_part(r ->> 'next_cursor', '|', 9) not in ('3', '') then raise exception 'FAIL: cold mode 3 cursor %', r ->> 'next_cursor'; end if;
    seen := seen || array(select x ->> 'id' from jsonb_array_elements(r -> 'items') x);
    seen5 := seen5 || array(select x ->> 'id' from jsonb_array_elements(r2 -> 'items') x);
    cur := r ->> 'next_cursor'; cur2 := r2 ->> 'next_cursor'; n := n + 1;
    exit when cur is null or n > 10;
  end loop;
  if seen is distinct from seen5 or cardinality(seen) <> 36 then
    raise exception 'FAIL: cold reader in mode 3 does not get the v5 order (% vs % cards)', cardinality(seen), cardinality(seen5);
  end if;
  if (select ranker || '/' || ml_mode from core.ml_pages where user_id = ua order by shown_at, page_no limit 1) <> 'fy-v3/3' then
    raise exception 'FAIL: mode 3 page not logged as fy-v3';
  end if;
  update core.rank_params set value = 1 where key = 'v3_step_extra_cold';      -- back to the shipped value

  -- reader A: follows tech, likes two tech cards, quick-skips a world card, dislikes a deals card
  insert into core.user_prefs (user_id, followed_categories) values (ua, '{tech}');
  insert into core.user_events (user_id, blurb_id, kind, created_at, slot) values
    (ua, cards[2], 'view', now() - interval '2 hours', 0), (ua, cards[8], 'view', now() - interval '2 hours', 3),
    (ua, cards[1], 'view', now() - interval '2 hours', 1), (ua, cards[5], 'view', now() - interval '2 hours', 2),
    (ua, cards[7], 'view', now() - interval '2 hours', 4);
  insert into core.user_events (user_id, blurb_id, kind, created_at) values
    (ua, cards[2], 'like', now() - interval '2 hours'), (ua, cards[8], 'like', now() - interval '2 hours'),
    (ua, cards[5], 'dislike', now() - interval '2 hours');
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at) values
    (ua, cards[1], 'dwell', 700, now() - interval '2 hours'), (ua, cards[7], 'dwell', 900, now() - interval '2 hours');

  -- ---- 4. modes 0, 1 and 2 (no passed model): exactly v5 ---------------------------------------------------------
  c0 := '1e12|ffffffff-ffff-ffff-ffff-ffffffffffff||' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '||';
  foreach n in array array[0, 1, 2] loop
    update core.rank_params set value = n where key = 'foryou_ml_mode';
    perform set_config('role', 'authenticated', true);
    r := api.feed_for_you(c0, 10);
    perform set_config('role', 'none', true); r2 := core.fy_post(core.feed_for_you_v5(c0, 10), ua) - '_perm';
    if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: mode % differs from v5', n; end if;
    if r ->> 'next_cursor' is distinct from (r2 ->> 'next_cursor') || '||1|' || least(n, 1) then
      raise exception 'FAIL: mode % cursor %', n, r ->> 'next_cursor';
    end if;
  end loop;
  if exists (select 1 from core.ml_pages where user_id = ua and ranker = 'fy-v3' and ml_mode <> 3) then raise exception 'FAIL: v3 page outside mode 3'; end if;

  -- ---- 5. mode 3 with evidence: v7 ------------------------------------------------------------------------------
  update core.rank_params set value = 3 where key = 'foryou_ml_mode';
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  cur := r ->> 'next_cursor';
  perform set_config('role', 'none', true);
  if split_part(cur, '|', 7) <> '' or split_part(cur, '|', 8) <> '1' or split_part(cur, '|', 9) <> '3' or split_part(cur, '|', 10) <> '' then
    raise exception 'FAIL: v3 cursor layout %', cur;
  end if;
  if jsonb_array_length(r -> 'items') <> 10 or r ? 'terms' then raise exception 'FAIL: v3 page shape'; end if;
  if exists (select 1 from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = cards[5]) then
    raise exception 'FAIL: disliked card on a v3 page';
  end if;
  if (select ml_mode || '/' || ranker || '/' || holdout || '/' || page_no || '/' || cardinality(ml_terms)
        from core.ml_pages where page_id = (r ->> 'page_id')::uuid) <> '3/fy-v3/false/0/10' then
    raise exception 'FAIL: v3 page row';
  end if;
  -- the personal term is there: the liked topic (tech) above the quick-skipped one (world)
  if (select avg(o_v3) from core.v3_scores(ua, now(), g) where o_category = 'tech')
     <= (select avg(o_v3) from core.v3_scores(ua, now(), g) where o_category = 'world') then
    raise exception 'FAIL: liked topic does not score higher than a skipped one';
  end if;
  if not exists (select 1 from core.v3_reader_weights(ua, now()) where o_feature = 'c:tech' and o_b > 0) then
    raise exception 'FAIL: c:tech weight not positive';
  end if;
  -- page 2 twice: the same page; equals core.feed_for_you_v7
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(cur, 10);
  r2 := api.feed_for_you(cur, 10);
  if r -> 'items' is distinct from r2 -> 'items' or r ->> 'next_cursor' is distinct from r2 ->> 'next_cursor' then
    raise exception 'FAIL: same cursor gave a different page';
  end if;
  perform set_config('role', 'none', true);
  r2 := core.fy_post(core.feed_for_you_v7(cur, 10), ua) - '_perm';
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: wrapper page 2 differs from v7'; end if;
  -- a full scroll: no repeats, every eligible card once (35 = 36 minus the disliked one), reactions mid-scroll change nothing
  perform set_config('role', 'authenticated', true);
  seen := '{}'; cur2 := null; n := 0;
  loop
    r := api.feed_for_you(cur2, 10);
    seen := seen || array(select x ->> 'id' from jsonb_array_elements(r -> 'items') x);
    cur2 := r ->> 'next_cursor'; n := n + 1;
    if n = 2 then
      perform set_config('role', 'none', true);
      insert into core.user_events (user_id, blurb_id, kind, created_at, slot) values
        (ua, (r -> 'items' -> 0 ->> 'id')::uuid, 'view', clock_timestamp() + interval '1 minute', 0),
        (ua, (r -> 'items' -> 1 ->> 'id')::uuid, 'like', clock_timestamp() + interval '1 minute', null);
      perform set_config('role', 'authenticated', true);
    end if;
    exit when cur2 is null or n > 10;
  end loop;
  perform set_config('role', 'none', true);
  if cardinality(seen) <> 35 or (select count(distinct s) from unnest(seen) s) <> 35 then
    raise exception 'FAIL: v3 scroll: % cards, % distinct', cardinality(seen), (select count(distinct s) from unnest(seen) s);
  end if;
  delete from core.user_events where user_id = ua and created_at > now();

  -- ---- 6. reader A's scores do not depend on reader B; each reader's pages are their own -------------------------------
  select jsonb_agg(jsonb_build_array(o_id, o_ps) order by o_ps desc, o_id desc) into s1 from core.v3_scores(ua, asof, g);
  insert into core.user_prefs (user_id, followed_categories) values (ub, '{world,energy}');
  insert into core.user_events (user_id, blurb_id, kind, created_at)
  select ub, c, k, now() - interval '3 hours' from unnest(cards[1:20]) c, unnest(array['view', 'like']) k;
  select jsonb_agg(jsonb_build_array(o_id, o_ps) order by o_ps desc, o_id desc) into s2 from core.v3_scores(ua, asof, g);
  if s1 is distinct from s2 then raise exception 'FAIL: reader B changed reader A''s scores'; end if;
  if (select count(*) from core.v3_reader_weights(ub, now())) = 0 then raise exception 'FAIL: B has no weights'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  perform set_config('role', 'none', true);
  if (select user_id from core.ml_pages where page_id = (r ->> 'page_id')::uuid) <> ub then raise exception 'FAIL: B page logged for another reader'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- ---- 7. switching off mid-scroll: a v3 cursor finishes on v3; new scrolls get v5 -----------------------------------
  foreach n in array array[1, 0] loop
    update core.rank_params set value = n where key = 'foryou_ml_mode';
    perform set_config('role', 'authenticated', true);
    r := api.feed_for_you(cur, 10);
    perform set_config('role', 'none', true);
    r2 := core.fy_post(core.feed_for_you_v7(cur, 10), ua) - '_perm';
    if r -> 'items' is distinct from r2 -> 'items' or split_part(r ->> 'next_cursor', '|', 9) <> '3' then
      raise exception 'FAIL: mode % did not keep the v3 scroll (cursor %)', n, r ->> 'next_cursor';
    end if;
    perform set_config('role', 'authenticated', true);
    r := api.feed_for_you(null, 10);
    perform set_config('role', 'none', true);
    if split_part(r ->> 'next_cursor', '|', 9) <> n::text then raise exception 'FAIL: new scroll in mode % not on v5', n; end if;
  end loop;
  update core.rank_params set value = 3 where key = 'foryou_ml_mode';

  -- ---- 8. cost guard, errors and statement timeouts serve v5 ------------------------------------------------------------
  update core.rank_params set value = 1 where key = 'v3_max_candidates';
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);                                     -- new scrolls from here on (would be v3)
  perform set_config('role', 'none', true); r2 := core.fy_post(core.feed_for_you_v5(null, 10), ua) - '_perm';
  if r -> 'items' is distinct from r2 -> 'items' or split_part(r ->> 'next_cursor', '|', 9) <> '1' then raise exception 'FAIL: candidate guard'; end if;
  update core.rank_params set value = 3000 where key = 'v3_max_candidates';
  alter table core.card_features rename to card_features_gone;
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  perform set_config('role', 'none', true);
  if r -> 'items' is distinct from r2 -> 'items' or split_part(r ->> 'next_cursor', '|', 9) <> '1' then raise exception 'FAIL: v3 error not caught'; end if;
  alter table core.card_features_gone rename to card_features;
  create or replace function core.feed_for_you_v7(p_cursor text, p_limit int)    -- rolled back at the end
  returns jsonb
  language plpgsql stable security definer set search_path = ''
  as $f$ begin raise exception 'canceling statement due to statement timeout' using errcode = 'query_canceled'; end; $f$;
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  perform set_config('role', 'none', true);
  if r -> 'items' is distinct from r2 -> 'items' or split_part(r ->> 'next_cursor', '|', 9) <> '1' then
    raise exception 'FAIL: statement timeout in v3 not caught';
  end if;
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(cur, 10);                                     -- a running v3 scroll that times out: a page, not an error
  perform set_config('role', 'none', true);
  if jsonb_array_length(r -> 'items') = 0 or split_part(r ->> 'next_cursor', '|', 9) = '3' then raise exception 'FAIL: timed-out v3 scroll'; end if;

  -- ---- 9. holdout: formula pages, logged as mode-3 holdout -----------------------------------------------------------
  update core.rank_params set value = 100 where key = 'v3_holdout_pct';
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  perform set_config('role', 'none', true);
  if r -> 'items' is distinct from r2 -> 'items' or split_part(r ->> 'next_cursor', '|', 9) <> '1' then raise exception 'FAIL: holdout not on v5'; end if;
  if (select ml_mode || '/' || ranker || '/' || holdout from core.ml_pages where page_id = (r ->> 'page_id')::uuid) <> '3/fy-formula-v4/true' then
    raise exception 'FAIL: holdout page row %', (select ml_mode || '/' || ranker || '/' || holdout from core.ml_pages where page_id = (r ->> 'page_id')::uuid);
  end if;
  update core.rank_params set value = 0 where key = 'v3_holdout_pct';

  -- ---- 10. guests: api.feed unchanged ------------------------------------------------------------------------------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  r := api.feed('top', null, 10, null);
  perform set_config('role', 'none', true); r2 := core.feed_top('top', null, 10, null);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: guest Trending changed'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- ---- 11. daily check: v3 dislikes far above the mode-3 holdout's drop mode 3 to 0; v2's check ignores them ------------
  delete from core.ml_pages;                                                  -- (rolled back) only the pages below
  update core.rank_params set value = 5 where key in ('v3_kill_min_cards', 'v2_kill_min_cards');
  r := api.ml_v3_check();
  if (r ->> 'dropped')::boolean then raise exception 'FAIL: check dropped with no data: %', r; end if;
  insert into core.ml_pages (user_id, surface, ranker, ml_mode, holdout, as_of, shown_at, card_ids, live_scores) values
    (ua, 'for_you', 'fy-v3',         3, false, now() - interval '2 hours', now() - interval '2 hours', cards[1:10], array_fill(0::numeric, array[10])),
    (ub, 'for_you', 'fy-formula-v4', 3, true,  now() - interval '2 hours', now() - interval '2 hours', cards[11:20], array_fill(0::numeric, array[10]));
  insert into core.user_events (user_id, blurb_id, kind, created_at)
  select ua, c, 'dislike', now() - interval '110 minutes' from unnest(cards[1:3]) c;
  insert into core.user_events (user_id, blurb_id, kind, created_at) values (ub, cards[11], 'dislike', now() - interval '110 minutes');
  r := api.ml_v2_check();
  if (r ->> 'hold_cards')::int <> 0 or (r ->> 'dropped')::boolean then raise exception 'FAIL: v2 check counted mode-3 pages: %', r; end if;
  r := api.ml_v3_check();
  if not (r ->> 'dropped')::boolean or (select value from core.rank_params where key = 'foryou_ml_mode') <> 0
     or (r ->> 'treat_rate')::numeric <> 0.4 or (r ->> 'hold_rate')::numeric <> 0.1 then
    raise exception 'FAIL: daily check did not drop mode 3 to 0: %', r;
  end if;
  update core.rank_params set value = 3 where key = 'foryou_ml_mode';
  delete from core.user_events where user_id = ub;
  delete from core.user_events where user_id = ua and kind = 'dislike' and blurb_id = any (cards[1:3]);

  -- ---- 12. no division by zero: lambda 0 and k0 0, with and without evidence ------------------------------------------
  update core.rank_params set value = 0 where key in ('v3_lambda', 'v3_k0');
  perform count(*) from core.v3_scores(ua, now(), g);
  perform count(*) from core.v3_scores(ub, now(), g);
  if exists (select 1 from core.v3_reader_weights(ua, now()) where o_b = 'NaN'::float8 or o_rbar = 'NaN'::float8) then
    raise exception 'FAIL: NaN weight';
  end if;
  update core.rank_params set value = 2 where key = 'v3_lambda';
  update core.rank_params set value = 3 where key = 'v3_k0';

  -- ---- 13. delete_my_data: back to cold start (and so to the v5 order) ---------------------------------------------------
  perform set_config('role', 'authenticated', true);
  r := api.delete_my_data();
  perform set_config('role', 'none', true);
  if exists (select 1 from core.v3_reader_weights(ua, asof)) then raise exception 'FAIL: weights left after delete_my_data'; end if;
  select jsonb_agg(jsonb_build_array(o_id, o_ps) order by o_ps desc, o_id desc) into s1 from core.v3_scores(ua, asof, g);
  if s1 is distinct from cold then raise exception 'FAIL: after delete_my_data the scores are not cold start'; end if;
  if exists (select 1 from core.ml_pages where user_id = ua) then raise exception 'FAIL: pages left after delete'; end if;

  raise exception 'ALL RANKING_V3 CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
