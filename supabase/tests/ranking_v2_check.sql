-- =============================================================================
-- ranking_v2_check.sql: checks for 20261109000000_ranking_v2.sql (For you ranking v2)
--   settings ship off; tables and RPCs closed to anon/authenticated; modes 0 and 1 (and mode 2 without
--   a passed model) give exactly the v5 output; mode 2 with a passed model: v6 pages, cursor layout,
--   same cursor = same page, a full scroll with no repeats, logging; reader A's scores ignore reader B;
--   kill switch mid-scroll; holdout; delete_my_data resets to cold start; guest api.feed unchanged;
--   Trending Bayesian average only when switched on; weight validation; card export; daily check.
--
-- Supabase SQL editor: needs the two test users element-test-a@example.com and
-- element-test-b@example.com. Paste the whole file and run it, with no ingest run going.
--   expected:     ERROR: ALL RANKING_V2 CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- Modes are switched on only inside this block, which is rolled back at the end.
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
  pg     uuid;
  m_ok   bigint;
  m_bad  bigint;
  seed   bigint;
  ok     boolean;
  got    text;
  seen   text[];
  rl     text;
  t      text;
  asof   timestamptz := now();                     -- the cards below are published at now()
  cold   jsonb;
  s1     jsonb;
  s2     jsonb;
  x_card uuid;
  bst    numeric;
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
  update core.ml_models set gate_passed = false where gate_passed;       -- no real model takes part (rolled back)
  update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode');

  -- ---- 1. settings ---------------------------------------------------------------------------------
  select string_agg(key || '=' || value::text, ',' order by key) into got from core.rank_params
   where key in ('v2_hours_per_reward', 'v2_cap_hours', 'v2_explore', 'v2_prior_lean', 'v2_min_readers',
                 'v2_propensity_cap', 'v2_holdout_pct', 'v2_kill_ratio', 'v2_follow_pseudo');
  if got is distinct from 'v2_cap_hours=18,v2_explore=1,v2_follow_pseudo=3,v2_holdout_pct=10,v2_hours_per_reward=12,v2_kill_ratio=1.2,v2_min_readers=20,v2_prior_lean=0.15,v2_propensity_cap=3' then
    raise exception 'FAIL: v2 rank_params are %', got;
  end if;
  if (select count(*) from core.rank_params where key like 'v2\_lean\_tag\_%' and value = 1) <> 5 then
    raise exception 'FAIL: lean tag rows';
  end if;
  if (select count(*) from core.tag_rules) < 60 then raise exception 'FAIL: tag rule seed missing'; end if;

  -- ---- 2. privileges ---------------------------------------------------------------------------------
  foreach t in array array['core.tag_rules', 'core.ml_models', 'core.ml_weights'] loop
    if not (select relrowsecurity from pg_class where oid = t::regclass) then raise exception 'FAIL: RLS off on %', t; end if;
    foreach rl in array array['anon', 'authenticated'] loop
      if has_table_privilege(rl, t, 'select') or has_table_privilege(rl, t, 'insert') then
        raise exception 'FAIL: % has table rights on %', rl, t;
      end if;
    end loop;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'ml_weights' and column_name like '%user%') then
    raise exception 'FAIL: ml_weights must not hold user ids';
  end if;
  foreach rl in array array['anon', 'authenticated'] loop
    perform set_config('role', rl, true);
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', rl)::text, true);
    ok := false; begin perform core.v2_scores(ua, now(), 1, 1); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.v2_scores', rl; end if;
    ok := false; begin perform core.feed_for_you_v6(null, 10, 1, 1); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.feed_for_you_v6', rl; end if;
    ok := false; begin perform api.ml_write_weights('{"version": "x"}', '[]'); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_write_weights', rl; end if;
    ok := false; begin perform api.ml_export_cards(now()); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_export_cards', rl; end if;
    ok := false; begin perform api.ml_v2_params(); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_v2_params', rl; end if;
    ok := false; begin perform api.ml_v2_check(); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_v2_check', rl; end if;
    ok := false; begin perform count(*) from core.ml_weights; exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can read core.ml_weights', rl; end if;
    perform set_config('role', 'none', true);
  end loop;
  foreach t in array array['api.ml_write_weights(jsonb,jsonb)', 'api.ml_export_cards(timestamptz,text,integer)',
                           'api.ml_v2_params()', 'api.ml_v2_check()'] loop
    if not has_function_privilege('service_role', t, 'execute') then raise exception 'FAIL: service_role cannot execute %', t; end if;
    if exists (select 1 from pg_proc p where p.oid = t::regprocedure
                  and (not p.prosecdef or not (p.proconfig @> array['search_path=""'])
                       or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))) then
      raise exception 'FAIL: % must be security definer, search_path empty, not PUBLIC', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'api.feed_for_you(text,integer)', 'execute')
     or not has_function_privilege('authenticated', 'api.feed_for_you(text,integer)', 'execute')
     or not has_function_privilege('anon', 'api.feed(text,text,integer,text)', 'execute')
     or (select provolatile from pg_proc where oid = 'api.feed_for_you(text,integer)'::regprocedure) <> 'v'
     or (select provolatile from pg_proc where oid = 'core.feed_for_you_v5(text,integer)'::regprocedure) <> 's' then
    raise exception 'FAIL: feed grants or volatility changed';
  end if;

  -- ---- 3. weights: validation and the two models ---------------------------------------------------------
  ok := false;
  begin
    perform api.ml_write_weights('{"version": "too-many"}', (select jsonb_agg(jsonb_build_object('kind', 'slot', 'key', '0', 'value', 1)) from generate_series(1, 301)));
  exception when sqlstate 'PT422' then ok := true; end;
  if not ok then raise exception 'FAIL: 301 rows accepted'; end if;
  r := api.ml_write_weights('{"version": "test-ok", "gate_passed": true, "n_readers": 40}',
         '[{"kind": "feature", "key": "c:tech",    "value": 0.3,  "n_readers": 25},
           {"kind": "feature", "key": "c:world",   "value": -0.1, "n_readers": 30},
           {"kind": "feature", "key": "g:rates",   "value": 0.05, "n_readers": 21},
           {"kind": "feature", "key": "c:energy",  "value": 0.9,  "n_readers": 3},
           {"kind": "feature", "key": "c:deals",   "value": 7,    "n_readers": 50},
           {"kind": "group",   "key": "c",         "value": 3},
           {"kind": "group",   "key": "x",         "value": 3},
           {"kind": "global",  "key": "tau",       "value": 0.45},
           {"kind": "slot",    "key": "0",         "value": 1},
           {"kind": "slot",    "key": "3",         "value": 0.6},
           {"kind": "slot",    "key": "21",        "value": 0.5},
           {"kind": "slot",    "key": "4",         "value": 0}]');
  m_ok := (r ->> 'model_id')::bigint;
  if (r ->> 'written')::int <> 7 or (r ->> 'skipped')::int <> 5 then
    raise exception 'FAIL: weight validation wrote % skipped %', r ->> 'written', r ->> 'skipped';
  end if;
  update core.ml_models set gate_passed = false where model_id = m_ok;    -- passed only from section 6 on
  r := api.ml_write_weights('{"version": "test-failed", "gate_passed": false}', '[]');
  m_bad := (r ->> 'model_id')::bigint;
  if core.v2_active_model() is not null then raise exception 'FAIL: active model without a passed gate'; end if;

  -- cards: 36, six topics, each with its own source, headlines that hit tag rules
  for i in 1 .. 36 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('rv2-' || i, 'summary', heads[1 + (i % 6)] || ' ' || i, cats[1 + (i % 6)], now(),
            now() - make_interval(secs => i * 300), base + 20 - i * 0.5)
    returning id into b;
    cards := cards || b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'RV2 source ' || i, 'filing', 'https://www.sec.gov/rv2/' || b, 'company_filing', true);
  end loop;
  if core.v2_features('policy', 'fed', null, 'Fed holds interest rates', '[]') <> array['c:policy', 'g:rates', 't:fed'] then
    raise exception 'FAIL: features %', core.v2_features('policy', 'fed', null, 'Fed holds interest rates', '[]');
  end if;
  if not ('g:inflation' = any (core.v2_features('economy', 'macro_release', 'fred', 'Prices', '[{"series_id": "CPIAUCSL"}]'))) then
    raise exception 'FAIL: series tag';
  end if;
  -- cold-start scores of A (no events, no prefs), kept for the deletion check
  select jsonb_agg(jsonb_build_array(o_id, o_ps) order by o_ps desc, o_id desc) into cold from core.v2_scores(ua, asof, m_ok, 4242);
  if coalesce(jsonb_array_length(cold), 0) <> 36 then raise exception 'FAIL: cold-start scores for % cards', jsonb_array_length(cold); end if;

  -- reader A: follows tech, likes two tech cards, quick-skips a world card, dislikes a deals card
  insert into core.user_prefs (user_id, followed_categories) values (ua, '{tech}');
  insert into core.user_events (user_id, blurb_id, kind, created_at, slot) values
    (ua, cards[2], 'view', now() - interval '2 hours', 0), (ua, cards[8], 'view', now() - interval '2 hours', 3),
    (ua, cards[1], 'view', now() - interval '2 hours', 1);
  insert into core.user_events (user_id, blurb_id, kind, created_at) values
    (ua, cards[2], 'like', now() - interval '2 hours'), (ua, cards[8], 'like', now() - interval '2 hours'),
    (ua, cards[5], 'dislike', now() - interval '2 hours');
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at) values
    (ua, cards[1], 'dwell', 700, now() - interval '2 hours');

  -- ---- 4. modes 0 and 1: exactly v5 (even with a passed model present) --------------------------------------
  update core.ml_models set gate_passed = true where model_id = m_ok;
  c0 := '1e12|ffffffff-ffff-ffff-ffff-ffffffffffff||' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '||';
  foreach n in array array[0, 1] loop
    update core.rank_params set value = n where key = 'foryou_ml_mode';
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    r := api.feed_for_you(c0, 10);
    perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(c0, 10);
    if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: mode % differs from v5', n; end if;
    if r ->> 'next_cursor' is distinct from (r2 ->> 'next_cursor') || '||1|' || n then raise exception 'FAIL: mode % cursor %', n, r ->> 'next_cursor'; end if;
    perform set_config('role', 'authenticated', true);
    cur := r ->> 'next_cursor';
    r := api.feed_for_you(cur, 10);
    perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(cur, 10);
    if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: mode % page 2 differs from v5', n; end if;
  end loop;
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);                                               -- mode 1, new scroll
  if split_part(r ->> 'next_cursor', '|', 9) <> '1' or split_part(r ->> 'next_cursor', '|', 10) <> '' then
    raise exception 'FAIL: mode 1 first page cursor %', r ->> 'next_cursor';
  end if;
  perform set_config('role', 'none', true);
  if exists (select 1 from core.ml_pages where user_id = ua and ranker <> 'fy-formula-v4') then raise exception 'FAIL: v6 page in mode 0/1'; end if;

  -- ---- 5. mode 2 without a passed model: like mode 1 ---------------------------------------------------------
  update core.ml_models set gate_passed = false where model_id = m_ok;
  update core.rank_params set value = 2 where key = 'foryou_ml_mode';
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(c0, 10);
  perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(c0, 10);
  if r -> 'items' is distinct from r2 -> 'items' or split_part(r ->> 'next_cursor', '|', 9) <> '1' then
    raise exception 'FAIL: mode 2 without a model must equal v5 (cursor %)', r ->> 'next_cursor';
  end if;
  if (select ml_mode || '/' || ranker || '/' || holdout from core.ml_pages where page_id = (r ->> 'page_id')::uuid) <> '1/fy-formula-v4/false' then
    raise exception 'FAIL: mode 2 without a model logged wrong';
  end if;
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  if split_part(r ->> 'next_cursor', '|', 9) <> '1' or split_part(r ->> 'next_cursor', '|', 10) <> '' then raise exception 'FAIL: first page without a model'; end if;
  perform set_config('role', 'none', true);

  -- ---- 6. mode 2 with a passed model: v6 ---------------------------------------------------------------------
  update core.ml_models set gate_passed = true where model_id = m_ok;
  update core.rank_params set value = 0 where key = 'v2_holdout_pct';                -- nobody in the holdout here
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  cur := r ->> 'next_cursor';
  if split_part(cur, '|', 7) <> m_ok::text or split_part(cur, '|', 8) <> '1' or split_part(cur, '|', 9) <> '2'
     or split_part(cur, '|', 10) !~ '^[0-9]+$' then
    raise exception 'FAIL: v6 cursor layout %', cur;
  end if;
  seed := split_part(cur, '|', 10)::bigint;
  if jsonb_array_length(r -> 'items') <> 10 then raise exception 'FAIL: v6 page size'; end if;
  if exists (select 1 from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = cards[5]) then
    raise exception 'FAIL: disliked card on a v6 page';
  end if;
  perform set_config('role', 'none', true);
  if (select ml_mode || '/' || ranker || '/' || ml_run || '/' || holdout || '/' || page_no from core.ml_pages where page_id = (r ->> 'page_id')::uuid)
     <> '2/fy-ts-v6/' || m_ok || '/false/0' then
    raise exception 'FAIL: v6 page row %', (select ml_mode || '/' || ranker || '/' || ml_run from core.ml_pages where page_id = (r ->> 'page_id')::uuid);
  end if;
  -- page 2 = core.feed_for_you_v6 on the same cursor, model and seed; asking twice gives the same page
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(cur, 10);
  r2 := api.feed_for_you(cur, 10);
  if r -> 'items' is distinct from r2 -> 'items' or r ->> 'next_cursor' is distinct from r2 ->> 'next_cursor' then
    raise exception 'FAIL: same cursor gave a different page';
  end if;
  perform set_config('role', 'none', true);
  r2 := core.feed_for_you_v6(cur, 10, m_ok, seed);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: wrapper page 2 differs from v6'; end if;
  if split_part(r ->> 'next_cursor', '|', 8) <> '2' or split_part(r ->> 'next_cursor', '|', 10) <> seed::text then
    raise exception 'FAIL: page 2 cursor %', r ->> 'next_cursor';
  end if;
  -- the personal term is really there: A's liked topic (tech, followed) scores above its rank_score
  if (select avg(o_bandit) from core.v2_scores(ua, now(), m_ok, seed) where o_category = 'tech')
     <= (select avg(o_bandit) from core.v2_scores(ua, now(), m_ok, seed) where o_category = 'world') then
    raise exception 'FAIL: liked and followed topic does not score higher than a skipped one';
  end if;
  -- a full scroll: no repeats, every eligible card once (35 = 36 minus the disliked one)
  perform set_config('role', 'authenticated', true);
  seen := '{}'; cur2 := null; n := 0;
  loop
    r := api.feed_for_you(cur2, 10);
    seen := seen || array(select x ->> 'id' from jsonb_array_elements(r -> 'items') x);
    cur2 := r ->> 'next_cursor'; n := n + 1;
    if n = 2 then                                    -- a view and a like mid-scroll (after the scroll's as-of) change nothing
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
    raise exception 'FAIL: v6 scroll: % cards, % distinct', cardinality(seen), (select count(distinct s) from unnest(seen) s);
  end if;

  -- ---- 7. reader A's scores do not depend on reader B --------------------------------------------------------
  select jsonb_agg(jsonb_build_array(o_id, o_ps) order by o_ps desc, o_id desc) into s1 from core.v2_scores(ua, asof, m_ok, seed);
  insert into core.user_prefs (user_id, followed_categories) values (ub, '{world,energy}');
  insert into core.user_events (user_id, blurb_id, kind, created_at)
  select ub, c, k, now() - interval '3 hours' from unnest(cards[1:20]) c, unnest(array['view', 'like']) k;
  select jsonb_agg(jsonb_build_array(o_id, o_ps) order by o_ps desc, o_id desc) into s2 from core.v2_scores(ua, asof, m_ok, seed);
  if coalesce(jsonb_array_length(s1), 0) < 30 then raise exception 'FAIL: A has % scored cards', jsonb_array_length(s1); end if;
  if s1 is distinct from s2 then raise exception 'FAIL: reader B changed reader A''s scores'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  perform set_config('role', 'none', true);
  if (select user_id from core.ml_pages where page_id = (r ->> 'page_id')::uuid) <> ub then raise exception 'FAIL: B page logged for another reader'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- ---- 8. switching off mid-scroll: a v6 cursor finishes its scroll on v6 (no repeats); new scrolls get v5 ---------
  foreach n in array array[1, 0] loop
    update core.rank_params set value = n where key = 'foryou_ml_mode';
    perform set_config('role', 'authenticated', true);
    r := api.feed_for_you(cur, 10);
    perform set_config('role', 'none', true); r2 := core.feed_for_you_v6(cur, 10, m_ok, seed);
    if r -> 'items' is distinct from r2 -> 'items' or split_part(r ->> 'next_cursor', '|', 9) <> '2'
       or split_part(r ->> 'next_cursor', '|', 10) <> seed::text then
      raise exception 'FAIL: mode % did not keep the v6 scroll (cursor %)', n, r ->> 'next_cursor';
    end if;
    perform set_config('role', 'authenticated', true);
    r := api.feed_for_you(null, 10);
    perform set_config('role', 'none', true);
    if split_part(r ->> 'next_cursor', '|', 10) <> '' or split_part(r ->> 'next_cursor', '|', 9) <> n::text then
      raise exception 'FAIL: new scroll in mode % not on v5 (%)', n, r ->> 'next_cursor';
    end if;
  end loop;
  update core.rank_params set value = 2 where key = 'foryou_ml_mode';
  -- a model that lost its pass: the running scroll finishes on it, a new scroll uses the newest passed model
  update core.ml_models set gate_passed = false where model_id = m_ok;
  insert into core.ml_models (version, gate_passed) values ('test-newer', true);
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(cur, 10);
  perform set_config('role', 'none', true); r2 := core.feed_for_you_v6(cur, 10, m_ok, seed);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: running scroll changed model'; end if;
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  perform set_config('role', 'none', true);
  if split_part(r ->> 'next_cursor', '|', 7) <> (select model_id::text from core.ml_models where version = 'test-newer') then
    raise exception 'FAIL: new scroll did not take the newest passed model';
  end if;
  delete from core.ml_models where version = 'test-newer';
  update core.ml_models set gate_passed = true where model_id = m_ok;
  -- cost guards: too many candidates, or an error inside v6, serve v5 instead of failing
  update core.rank_params set value = 1 where key = 'v2_max_candidates';
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  perform set_config('role', 'none', true);
  if split_part(r ->> 'next_cursor', '|', 10) <> '' or jsonb_array_length(r -> 'items') <> 10 then raise exception 'FAIL: candidate guard'; end if;
  update core.rank_params set value = 3000 where key = 'v2_max_candidates';
  alter table core.ml_weights rename to ml_weights_gone;
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  perform set_config('role', 'none', true);
  if split_part(r ->> 'next_cursor', '|', 10) <> '' or jsonb_array_length(r -> 'items') <> 10 then raise exception 'FAIL: v6 error not caught'; end if;
  alter table core.ml_weights_gone rename to ml_weights;
  -- settings that must stay positive
  ok := false; begin update core.rank_params set value = 0 where key = 'v2_lambda_default'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: v2_lambda_default accepted 0'; end if;
  -- precomputed features follow edits and new rules
  if exists (select 1 from core.blurbs b left join core.card_features cf on cf.blurb_id = b.id
              where b.id = any (cards)
                and cf.features is distinct from core.v2_features(b.category, coalesce(b.event_type, b.kind),
                                                  core.source_key_of(b.kind, b.id), b.headline, b.macro)) then
    raise exception 'FAIL: card_features out of date';
  end if;
  update core.blurbs set headline = 'Jobless claims rise ' || 99 where id = cards[3];
  if not coalesce((select 'g:jobs' = any (features) from core.card_features where blurb_id = cards[3]), false) then raise exception 'FAIL: feature after edit'; end if;
  insert into core.tag_rules (match_kind, pattern, tag) values ('keyword', 'claims', 'claims-test');
  if not coalesce((select 'g:claims-test' = any (features) from core.card_features where blurb_id = cards[3]), false) then raise exception 'FAIL: feature after new rule'; end if;
  delete from core.tag_rules where tag = 'claims-test';
  update core.blurbs set headline = heads[4] || ' 3' where id = cards[3];            -- back as before (cold check below)

  -- ---- 9. holdout: formula pages, logged as holdout ------------------------------------------------------------
  update core.rank_params set value = 100 where key = 'v2_holdout_pct';
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(c0, 10);
  perform set_config('role', 'none', true); r2 := core.feed_for_you_v5(c0, 10);
  if r -> 'items' is distinct from r2 -> 'items' or split_part(r ->> 'next_cursor', '|', 9) <> '1' then raise exception 'FAIL: holdout not on v5'; end if;
  if (select ml_mode || '/' || ranker || '/' || holdout from core.ml_pages where page_id = (r ->> 'page_id')::uuid) <> '2/fy-formula-v4/true' then
    raise exception 'FAIL: holdout page row';
  end if;
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 10);
  perform set_config('role', 'none', true);
  if split_part(r ->> 'next_cursor', '|', 10) <> '' then raise exception 'FAIL: holdout reader got a v6 scroll'; end if;
  update core.rank_params set value = 10 where key = 'v2_holdout_pct';

  -- ---- 10. guests: api.feed unchanged; For you closed -------------------------------------------------------------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  r := api.feed('top', null, 10, null);
  perform set_config('role', 'none', true); r2 := core.feed_top('top', null, 10, null);
  if r -> 'items' is distinct from r2 -> 'items' then raise exception 'FAIL: guest Trending changed'; end if;
  perform set_config('role', 'anon', true);
  ok := false; begin perform api.feed_for_you(null, 10); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: anon can call api.feed_for_you'; end if;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- ---- 11. Trending: formula boosts unless trending_ml_mode = 2 and a passed model exists -------------------------------
  delete from core.user_events where user_id in (ua, ub);
  x_card := cards[2];                                                            -- a tech card: no lean tag
  insert into core.user_events (user_id, blurb_id, kind, created_at) values
    (ua, x_card, 'like', now() - interval '1 hour'), (ub, x_card, 'like', now() - interval '1 hour');
  perform core.refresh_trending();
  select boost into bst from core.trend_boosts where gen = (select max(gen) from core.trend_generations) and blurb_id = x_card;
  if bst is distinct from round(6 * 6 / 14.0, 6) then raise exception 'FAIL: mode 0 Trending boost % (expected 2.571429)', bst; end if;
  update core.rank_params set value = 2 where key = 'trending_ml_mode';
  update core.ml_models set gate_passed = false where model_id = m_ok;
  perform core.refresh_trending();
  select boost into bst from core.trend_boosts where gen = (select max(gen) from core.trend_generations) and blurb_id = x_card;
  if bst is distinct from round(6 * 6 / 14.0, 6) then raise exception 'FAIL: mode 2 without a model changed Trending (%)', bst; end if;
  update core.ml_models set gate_passed = true where model_id = m_ok;
  perform core.refresh_trending();
  -- prior of a tech card under the model: c:tech 0.3, t:summary 0, s:<none>, tag ai (no lean) -> features c:tech, g:ai, t:summary
  select boost into bst from core.trend_boosts where gen = (select max(gen) from core.trend_generations) and blurb_id = x_card;
  if abs(bst - round((6 * (2 * (6 + 10 * 3 * 0.3 / sqrt(3)) / 12) / ((2 * (6 + 10 * 3 * 0.3 / sqrt(3)) / 12) + 8))::numeric, 6)) > 0.000002
     or bst >= round(6 * 6 / 14.0, 6) then
    raise exception 'FAIL: Trending v2 boost % (features %)', bst,
      (select core.v2_features(b2.category, coalesce(b2.event_type, b2.kind), core.source_key_of(b2.kind, b2.id), b2.headline, b2.macro) from core.blurbs b2 where b2.id = x_card);
  end if;
  update core.rank_params set value = 0 where key = 'trending_ml_mode';

  -- ---- 12. delete_my_data: back to cold start -----------------------------------------------------------------
  perform set_config('role', 'authenticated', true);
  r := api.delete_my_data();
  perform set_config('role', 'none', true);
  select jsonb_agg(jsonb_build_array(o_id, o_ps) order by o_ps desc, o_id desc) into s1 from core.v2_scores(ua, asof, m_ok, 4242);
  if s1 is distinct from cold then raise exception 'FAIL: after delete_my_data the scores are not cold start'; end if;
  if exists (select 1 from core.ml_pages where user_id = ua) then raise exception 'FAIL: pages left after delete'; end if;

  -- ---- 13. export and settings RPCs (service role) ---------------------------------------------------------------
  r := api.ml_export_cards(now() - interval '1 day', null, 20);
  if jsonb_array_length(r -> 'rows') <> 20 or r ->> 'next' is null
     or not (r -> 'rows' -> 0 ? 'features') or r -> 'rows' -> 0 ? 'headline' then
    raise exception 'FAIL: card export page 1';
  end if;
  r2 := api.ml_export_cards(now() - interval '1 day', r ->> 'next', 20);
  if jsonb_array_length(r2 -> 'rows') < 16 or exists (
       select 1 from jsonb_array_elements(r -> 'rows') a join jsonb_array_elements(r2 -> 'rows') c on a ->> 'id' = c ->> 'id') then
    raise exception 'FAIL: card export paging';
  end if;
  if (api.ml_v2_params() ->> 'v2_cap_hours')::numeric <> 18 then raise exception 'FAIL: ml_v2_params'; end if;

  -- ---- 14. daily check: treatment dislikes far above the holdout's drop mode 2 to 1 -----------------------------------
  delete from core.ml_pages;                                                  -- (rolled back) only the pages below
  update core.rank_params set value = 5 where key = 'v2_kill_min_cards';
  update core.rank_params set value = 2 where key = 'foryou_ml_mode';
  r := api.ml_v2_check();
  if (r ->> 'dropped')::boolean then raise exception 'FAIL: check dropped with no data: %', r; end if;
  insert into core.ml_pages (user_id, surface, ranker, ml_mode, holdout, as_of, shown_at, card_ids, live_scores) values
    (ua, 'for_you', 'fy-ts-v6',      2, false, now() - interval '2 hours', now() - interval '2 hours', cards[1:10], array_fill(0::numeric, array[10])),
    (ub, 'for_you', 'fy-formula-v4', 2, true,  now() - interval '2 hours', now() - interval '2 hours', cards[1:10], array_fill(0::numeric, array[10]));
  insert into core.user_events (user_id, blurb_id, kind, created_at)
  select ua, c, 'dislike', now() - interval '110 minutes' from unnest(cards[1:3]) c;
  insert into core.user_events (user_id, blurb_id, kind, created_at) values (ub, cards[1], 'dislike', now() - interval '110 minutes');
  r := api.ml_v2_check();
  if (r ->> 'stale')::boolean or (r ->> 'model_age_days')::numeric > 1 then raise exception 'FAIL: fresh model reported stale: %', r; end if;
  if not (r ->> 'dropped')::boolean or (select value from core.rank_params where key = 'foryou_ml_mode') <> 1
     or (r ->> 'treat_rate')::numeric <> 0.3 or (r ->> 'hold_rate')::numeric <> 0.1 then
    raise exception 'FAIL: daily check did not drop to mode 1: %', r;
  end if;

  raise exception 'ALL RANKING_V2 CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
