-- =============================================================================
-- ml_serve_hours_check.sql: checks for 20261211000000_ml_serve_hours.sql (serving path for the vector + LightGBM ranker)
--   settings ship off and are range-checked; the new tables and functions are closed to readers; the wrapper
--   core.v3_scores equals core.v3_scores_base when off, outside the share, in the holdout, with a stale batch or with too few
--   events; with a usable batch it adds the hours (capped) to o_ps and o_v3 and changes nothing else; a batch written
--   after the as-of time is ignored (paging stays stable); the writer validates input and keeps two batches per reader;
--   ml_serve_pct = 0 switches it off again; the For you function and the cursor are untouched.
--
-- Supabase SQL editor: needs the test users element-test-a@example.com and element-test-b@example.com.
--   expected:     ERROR: ALL ML_SERVE_HOURS CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- =============================================================================
do $$
declare
  ua     uuid;
  ub     uuid;
  rl     text;
  ok     boolean;
  i      int;
  n      int;
  b      uuid;
  cards  uuid[] := '{}';
  g      bigint;
  asof   timestamptz;
  t0     timestamptz := now() - interval '2 hours';
  base_r jsonb;
  wrap_r jsonb;
  w      jsonb;
  hid    uuid;
  dpos   numeric;
  dneg   numeric;
  dcap   numeric;
  dzero  numeric;
  rows   jsonb;
  usr    uuid;
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  if ua is null or ub is null then raise exception 'SETUP: create element-test-a@example.com and element-test-b@example.com first'; end if;
  delete from core.user_events where user_id in (ua, ub);
  delete from core.user_prefs  where user_id in (ua, ub);
  update core.blurbs set status = 'hidden' where status = 'published';       -- real cards out of the way (rolled back)

  -- ---- 1. settings and objects ---------------------------------------------------------------------------------------
  if (select value from core.rank_params where key = 'ml_serve_pct') <> 0 then raise exception 'FAIL: ml_serve_pct must ship at 0'; end if;
  if (select string_agg(key || '=' || value::text, ',' order by key) from core.rank_params where key like 'ml\_serve\_%')
     <> 'ml_serve_cap_h=6,ml_serve_holdout_pct=20,ml_serve_max_age_h=24,ml_serve_min_events=5,ml_serve_pct=0' then
    raise exception 'FAIL: ml_serve settings are not the shipped defaults';
  end if;
  ok := false; begin update core.rank_params set value = 101 where key = 'ml_serve_pct'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: ml_serve_pct accepts 101'; end if;
  ok := false; begin update core.rank_params set value = 31 where key = 'ml_serve_cap_h'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: ml_serve_cap_h accepts 31'; end if;
  ok := false; begin update core.rank_params set value = 0 where key = 'ml_serve_max_age_h'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: ml_serve_max_age_h accepts 0'; end if;

  foreach rl in array array['anon', 'authenticated'] loop
    perform set_config('role', rl, true);
    ok := false; begin perform api.ml_serve_status(); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_serve_status', rl; end if;
    ok := false; begin perform api.ml_write_serve_hours(now(), 'x', '[]'::jsonb); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_write_serve_hours', rl; end if;
    ok := false; begin perform count(*) from core.ml_serve_hours; exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can read core.ml_serve_hours', rl; end if;
    ok := false; begin perform core.v3_scores(ua, now(), 0); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.v3_scores', rl; end if;
    ok := false; begin perform core.v3_scores_base(ua, now(), 0); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.v3_scores_base', rl; end if;
    ok := false; begin perform core.ml_serve_active(ua); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call core.ml_serve_active', rl; end if;
    perform set_config('role', 'none', true);
  end loop;
  if not has_function_privilege('service_role', 'api.ml_write_serve_hours(timestamptz,text,jsonb)', 'execute')
     or not has_function_privilege('service_role', 'api.ml_serve_status()', 'execute') then
    raise exception 'FAIL: service_role cannot execute the serve functions';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'core.ml_serve_hours'::regclass) then raise exception 'FAIL: RLS is off on core.ml_serve_hours'; end if;
  if (select prosrc from pg_proc where oid = 'core.v3_scores(uuid,timestamp with time zone,bigint)'::regprocedure) not like '%ml_serve_hours%' then
    raise exception 'FAIL: core.v3_scores is not the ML wrapper (a later migration replaced it?)';
  end if;

  -- ---- 2. cards (12 published, spread over categories) and a reader with 6 explicit events ----------------------------
  for i in 1 .. 12 loop
    insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, sort_at, published_at, rank_score)
    values ('mlsv-' || i, 'summary', 'Serve headline ' || i, 'Serve body ' || i,
            (array['markets', 'policy', 'economy', 'deals'])[1 + i % 4], 'published', now(), now() - make_interval(mins => i * 10),
            now() - make_interval(mins => i * 10), 1000 + i)
    returning id into b;
    cards := cards || b;
  end loop;
  for i in 1 .. 6 loop
    insert into core.user_events (user_id, blurb_id, kind, created_at)
    values (ua, cards[i], case when i % 2 = 0 then 'like' else 'open_detail' end, now() - make_interval(mins => 30 + i));
  end loop;
  select coalesce(max(gen), 0) into g from core.trend_generations;
  asof := now();
  hid := cards[11];

  -- ---- 3. everything off: the wrapper is the base ---------------------------------------------------------------------
  if core.ml_serve_active(ua) then raise exception 'FAIL: ml_serve_active is true at pct 0'; end if;
  select jsonb_agg(to_jsonb(x) order by x.o_id) into base_r from core.v3_scores_base(ua, asof, g) x;
  select jsonb_agg(to_jsonb(x) order by x.o_id) into wrap_r from core.v3_scores(ua, asof, g) x;
  if base_r is null or jsonb_array_length(base_r) < 12 then raise exception 'FAIL: base scores missing'; end if;
  if base_r <> wrap_r then raise exception 'FAIL: wrapper differs from base while off'; end if;

  -- a batch exists but the switch is 0: still the base
  perform api.ml_write_serve_hours(t0, 'test:v1', jsonb_build_array(
    jsonb_build_object('user_id', ua, 'blurb_id', cards[1], 'hours', 4),
    jsonb_build_object('user_id', ua, 'blurb_id', cards[2], 'hours', -4),
    jsonb_build_object('user_id', ua, 'blurb_id', hid, 'hours', 25),            -- above the cap
    jsonb_build_object('user_id', ua, 'blurb_id', cards[12], 'hours', 0)));
  select jsonb_agg(to_jsonb(x) order by x.o_id) into wrap_r from core.v3_scores(ua, asof, g) x;
  if base_r <> wrap_r then raise exception 'FAIL: hours applied while ml_serve_pct = 0'; end if;

  -- ---- 4. on for everyone outside the holdout -------------------------------------------------------------------------
  update core.rank_params set value = 100 where key = 'ml_serve_pct';
  update core.rank_params set value = 0   where key = 'ml_serve_holdout_pct';
  if not core.ml_serve_active(ua) then raise exception 'FAIL: reader not active at pct 100, holdout 0'; end if;
  select jsonb_agg(to_jsonb(x) order by x.o_id) into wrap_r from core.v3_scores(ua, asof, g) x;
  select o_ps - (select o_ps from core.v3_scores_base(ua, asof, g) where o_id = cards[1]) into dpos from core.v3_scores(ua, asof, g) where o_id = cards[1];
  select o_ps - (select o_ps from core.v3_scores_base(ua, asof, g) where o_id = cards[2]) into dneg from core.v3_scores(ua, asof, g) where o_id = cards[2];
  select o_ps - (select o_ps from core.v3_scores_base(ua, asof, g) where o_id = hid)      into dcap from core.v3_scores(ua, asof, g) where o_id = hid;
  select o_ps - (select o_ps from core.v3_scores_base(ua, asof, g) where o_id = cards[12]) into dzero from core.v3_scores(ua, asof, g) where o_id = cards[12];
  if round(dpos, 4) <> 4 or round(dneg, 4) <> -4 then raise exception 'FAIL: hours not added to o_ps (% / %)', dpos, dneg; end if;
  if round(dcap, 4) <> 6 then raise exception 'FAIL: hours not capped at ml_serve_cap_h (got %)', dcap; end if;
  if round(dzero, 4) <> 0 then raise exception 'FAIL: zero hours changed a score'; end if;
  if (select o_v3 - (select o_v3 from core.v3_scores_base(ua, asof, g) where o_id = cards[1]) from core.v3_scores(ua, asof, g) where o_id = cards[1]) <> 4 then
    raise exception 'FAIL: hours not added to o_v3';
  end if;
  -- a card with no row is untouched, and o_s0 and o_category are never touched
  if exists (select 1 from core.v3_scores(ua, asof, g) w join core.v3_scores_base(ua, asof, g) s using (o_id)
              where w.o_s0 <> s.o_s0 or w.o_category <> s.o_category
                 or (w.o_id <> all (array[cards[1], cards[2], hid]) and (w.o_ps <> s.o_ps or w.o_v3 <> s.o_v3))) then
    raise exception 'FAIL: wrapper changed something other than the hours of cards that have rows: %',
      (select jsonb_agg(jsonb_build_array(w.o_id, w.o_ps, s.o_ps, w.o_v3, s.o_v3, w.o_s0, s.o_s0)) from core.v3_scores(ua, asof, g) w join core.v3_scores_base(ua, asof, g) s using (o_id)
        where w.o_s0 <> s.o_s0 or w.o_category <> s.o_category or (w.o_id <> all (array[cards[1], cards[2], hid]) and (w.o_ps <> s.o_ps or w.o_v3 <> s.o_v3)));
  end if;
  if (select count(*) from core.v3_scores(ua, asof, g)) <> (select count(*) from core.v3_scores_base(ua, asof, g)) then
    raise exception 'FAIL: wrapper changed the number of candidates';
  end if;

  -- another reader with no batch: base
  if (select jsonb_agg(to_jsonb(x) order by x.o_id) from core.v3_scores(ub, asof, g) x)
     <> (select jsonb_agg(to_jsonb(x) order by x.o_id) from core.v3_scores_base(ub, asof, g) x) then
    raise exception 'FAIL: reader without a batch differs from base';
  end if;

  -- ---- 5. holdout, share, stale, too few events, and a batch from the future -------------------------------------------
  update core.rank_params set value = 100 where key = 'ml_serve_holdout_pct';           -- everyone in the control arm
  if core.ml_serve_active(ua) then raise exception 'FAIL: holdout 100 still serves'; end if;
  select jsonb_agg(to_jsonb(x) order by x.o_id) into wrap_r from core.v3_scores(ua, asof, g) x;
  if base_r <> wrap_r then raise exception 'FAIL: holdout reader got hours'; end if;
  update core.rank_params set value = 0 where key = 'ml_serve_holdout_pct';

  update core.rank_params set value = 0 where key = 'ml_serve_pct';                       -- kill switch
  select jsonb_agg(to_jsonb(x) order by x.o_id) into wrap_r from core.v3_scores(ua, asof, g) x;
  if base_r <> wrap_r then raise exception 'FAIL: kill switch (pct 0) did not restore v3'; end if;
  update core.rank_params set value = 100 where key = 'ml_serve_pct';

  select jsonb_agg(to_jsonb(x) order by x.o_id) into wrap_r from core.v3_scores(ua, t0 - interval '1 minute', g) x;   -- as-of before the batch
  if wrap_r is distinct from (select jsonb_agg(to_jsonb(x) order by x.o_id) from core.v3_scores_base(ua, t0 - interval '1 minute', g) x) then
    raise exception 'FAIL: a batch written after the page as-of time was used';
  end if;
  select jsonb_agg(to_jsonb(x) order by x.o_id) into wrap_r from core.v3_scores(ua, t0 + interval '25 hours', g) x;    -- older than 24 h
  if wrap_r is distinct from (select jsonb_agg(to_jsonb(x) order by x.o_id) from core.v3_scores_base(ua, t0 + interval '25 hours', g) x) then
    raise exception 'FAIL: a stale batch was used';
  end if;
  update core.rank_params set value = 7 where key = 'ml_serve_min_events';
  select jsonb_agg(to_jsonb(x) order by x.o_id) into wrap_r from core.v3_scores(ua, asof, g) x;
  if base_r <> wrap_r then raise exception 'FAIL: a reader below ml_serve_min_events got hours'; end if;
  update core.rank_params set value = 5 where key = 'ml_serve_min_events';

  -- ---- 6. a newer batch is picked, the older one is kept for scrolls that started before it ---------------------------------
  perform api.ml_write_serve_hours(now() - interval '1 hour', 'test:v2', jsonb_build_array(
    jsonb_build_object('user_id', ua, 'blurb_id', cards[1], 'hours', -2)));
  if round((select o_ps - (select o_ps from core.v3_scores_base(ua, now(), g) where o_id = cards[1]) from core.v3_scores(ua, now(), g) where o_id = cards[1]), 4) <> -2 then
    raise exception 'FAIL: the newest batch is not used';
  end if;
  if round((select o_ps - (select o_ps from core.v3_scores_base(ua, t0 + interval '10 minutes', g) where o_id = cards[1])
              from core.v3_scores(ua, t0 + interval '10 minutes', g) where o_id = cards[1]), 4) <> 4 then
    raise exception 'FAIL: a scroll that started before the new batch lost its batch';
  end if;
  perform api.ml_write_serve_hours(now() - interval '30 minutes', 'test:v3', jsonb_build_array(
    jsonb_build_object('user_id', ua, 'blurb_id', cards[1], 'hours', 1)));
  select count(distinct batch_at) into n from core.ml_serve_hours where user_id = ua;
  if n <> 2 then raise exception 'FAIL: expected the 2 newest batches to be kept, found %', n; end if;

  -- ---- 7. the writer ---------------------------------------------------------------------------------------------------
  ok := false; begin perform api.ml_write_serve_hours(now(), '', '[]'::jsonb); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: empty model name accepted'; end if;
  ok := false; begin perform api.ml_write_serve_hours(now() + interval '1 day', 'x', '[]'::jsonb); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: future batch accepted'; end if;
  ok := false; begin perform api.ml_write_serve_hours(now(), 'x', '{}'::jsonb); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: non-array accepted'; end if;
  w := api.ml_write_serve_hours(now() - interval '20 minutes', 'test:v4', jsonb_build_array(
    jsonb_build_object('user_id', ub, 'blurb_id', cards[3], 'hours', 99),                           -- clamped to 30
    jsonb_build_object('user_id', gen_random_uuid(), 'blurb_id', cards[3], 'hours', 1),             -- unknown reader: skipped
    jsonb_build_object('user_id', ub, 'blurb_id', null, 'hours', 1)));                              -- no card: skipped
  if (w ->> 'written')::int <> 1 or (w ->> 'skipped')::int <> 2 then raise exception 'FAIL: writer counts %', w; end if;
  if (select hours from core.ml_serve_hours where user_id = ub) <> 30 then raise exception 'FAIL: hours not clamped to 30'; end if;
  w := api.ml_write_serve_hours(now() - interval '20 minutes', 'test:v4', jsonb_build_array(
    jsonb_build_object('user_id', ub, 'blurb_id', cards[3], 'hours', 5)));                          -- same key again: ignored
  if (w ->> 'written')::int <> 0 then raise exception 'FAIL: duplicate key written twice'; end if;
  insert into core.ml_serve_hours (user_id, blurb_id, batch_at, hours, model_version) values (ub, cards[4], now() - interval '3 days', 1, 'old');
  perform api.ml_write_serve_hours(now() - interval '10 minutes', 'test:v5', jsonb_build_array(
    jsonb_build_object('user_id', ub, 'blurb_id', cards[5], 'hours', 1)));
  if exists (select 1 from core.ml_serve_hours where batch_at < now() - interval '2 days') then raise exception 'FAIL: batch older than two days kept'; end if;

  w := api.ml_serve_status();
  if (w ->> 'ml_serve_pct')::int <> 100 or (w ->> 'readers_with_batch')::int < 2 or (w -> 'model_versions') is null then
    raise exception 'FAIL: status %', w;
  end if;

  -- ---- 8. deleting a reader removes the rows ---------------------------------------------------------------------------
  usr := gen_random_uuid();
  insert into auth.users (id, email) values (usr, 'mlsv-tmp@example.com');
  perform api.ml_write_serve_hours(now() - interval '5 minutes', 'test:v6', jsonb_build_array(
    jsonb_build_object('user_id', usr, 'blurb_id', cards[1], 'hours', 1)));
  delete from auth.users where id = usr;
  if exists (select 1 from core.ml_serve_hours where user_id = usr) then raise exception 'FAIL: rows survive the reader'; end if;

  raise exception 'ALL ML_SERVE_HOURS CHECKS PASSED (test data rolled back on purpose)';
end $$;
