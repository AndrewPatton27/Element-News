-- =============================================================================
-- signals_check.sql: checks for 20261017060000_signals.sql (dwell, open_detail, weights)
--
-- Supabase SQL editor: needs the two test users element-test-a@example.com and
-- element-test-b@example.com (Authentication -> Users -> Add user, "Auto Confirm User").
-- Paste the whole file and run it.
--   expected:     ERROR: ALL SIGNAL CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- Signed-in users are simulated as in accounts_check.sql (role + request.jwt.claims).
-- =============================================================================

do $$
declare
  ua    uuid;
  ub    uuid;
  base  numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  b     uuid;
  r     jsonb;
  aff   jsonb;
  got   text;
  ok    boolean;
  n     int;
  i     int;
  -- label, category, rank offset (hours from now)
  spec  jsonb := '[
    {"l":"T1","c":"tech","o":-30},   {"l":"M1","c":"markets","o":-31}, {"l":"E1","c":"energy","o":-32},
    {"l":"D1","c":"deals","o":-33},  {"l":"C1","c":"economy","o":-34}, {"l":"P1","c":"policy","o":-35},
    {"l":"I1","c":"insider","o":-36},{"l":"L1","c":"tech","o":-37},
    {"l":"X","c":"tech","o":2},      {"l":"Y","c":"tech","o":0},       {"l":"Z","c":"energy","o":1},
    {"l":"G1","c":"earnings","o":-50},{"l":"G2","c":"earnings","o":-51},{"l":"G3","c":"earnings","o":-52}]';
  c     jsonb;
  ids   jsonb := '{}';
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  if ua is null or ub is null then
    raise exception 'SETUP: create the users element-test-a@example.com and element-test-b@example.com first';
  end if;
  delete from core.user_events where user_id in (ua, ub);
  delete from core.user_prefs  where user_id in (ua, ub);
  update core.blurbs set status = 'hidden' where status = 'published';
  for c in select value from jsonb_array_elements(spec) loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('sig-' || (c->>'l'), 'summary', 'SIG ' || (c->>'l'), c->>'c', now(), now(), base + (c->>'o')::numeric)
    returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'SEC', 'filing', 'https://www.sec.gov/sig/' || (c->>'l'), 'company_filing', true);
    ids := ids || jsonb_build_object(c->>'l', b);
  end loop;

  -- ---- 1. anon is denied (3-argument track) -------------------------------------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'anon')::text, true);
  ok := false;
  begin perform api.track((ids->>'T1')::uuid, 'dwell', 5000);
  exception when insufficient_privilege then ok := true;
            when others then raise exception 'FAIL: anon reached api.track (%)', sqlerrm;
  end;
  if not ok then raise exception 'FAIL: anon can call api.track'; end if;

  -- ---- 2. user A ------------------------------------------------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- old 2-argument calls still work (positional and named, as PostgREST sends them)
  if api.track((ids->>'I1')::uuid, 'view') ->> 'status' <> 'recorded' then raise exception 'FAIL: 2-arg positional track'; end if;
  if api.track(p_blurb => (ids->>'M1')::uuid, p_kind => 'like') ->> 'status' <> 'recorded' then
    raise exception 'FAIL: 2-arg named track';
  end if;

  -- dwell validation, minimum, dedupe and keep-the-max
  ok := false;
  begin perform api.track((ids->>'C1')::uuid, 'dwell');
  exception when others then ok := sqlerrm = 'invalid_ms'; end;
  if not ok then raise exception 'FAIL: dwell without p_ms accepted'; end if;
  if api.track((ids->>'C1')::uuid, 'dwell', 200)  ->> 'status' <> 'ignored'  then raise exception 'FAIL: 200 ms dwell not ignored'; end if;
  if api.track((ids->>'C1')::uuid, 'dwell', 2000) ->> 'status' <> 'recorded' then raise exception 'FAIL: 2000 ms dwell not recorded'; end if;
  if api.track((ids->>'C1')::uuid, 'dwell', 5000) ->> 'status' <> 'recorded' then raise exception 'FAIL: longer dwell not recorded'; end if;
  if api.track((ids->>'C1')::uuid, 'dwell', 3000) ->> 'status' <> 'ignored'  then raise exception 'FAIL: shorter dwell not ignored'; end if;

  -- T1: one quick look (1 s) = skip -0.15
  perform api.track((ids->>'T1')::uuid, 'dwell', 1000);
  -- M1: liked (above) + quick look: the skip does not count when there is a positive signal -> +1
  perform api.track((ids->>'M1')::uuid, 'dwell', 1000);
  -- E1: opened the in-depth view -> +0.5; a second open within the hour is ignored
  if api.track((ids->>'E1')::uuid, 'open_detail') ->> 'status' <> 'recorded' then raise exception 'FAIL: open_detail not recorded'; end if;
  if api.track((ids->>'E1')::uuid, 'open_detail') ->> 'status' <> 'ignored'  then raise exception 'FAIL: open_detail not deduped'; end if;
  -- D1: like + detail + source + 9 s look = 2.25 -> per-card cap +1.5
  perform api.track((ids->>'D1')::uuid, 'like');
  perform api.track((ids->>'D1')::uuid, 'open_detail');
  perform api.track((ids->>'D1')::uuid, 'open_source');
  perform api.track((ids->>'D1')::uuid, 'dwell', 9000);
  -- P1: dislike + quick look = -1.15 -> per-card cap -1.0
  perform api.track((ids->>'P1')::uuid, 'dislike');
  perform api.track((ids->>'P1')::uuid, 'dwell', 1000);
  -- L1: 20 minutes on screen is stored as 10 minutes
  perform api.track((ids->>'L1')::uuid, 'dwell', 1200000);

  perform set_config('role', 'none', true);
  select count(*), max(dwell_ms) into n, i from core.user_events
   where user_id = ua and blurb_id = (ids->>'C1')::uuid and kind = 'dwell';
  if n <> 1 or i <> 5000 then raise exception 'FAIL: dwell rows for C1: % row(s), max %, expected 1 row with 5000', n, i; end if;
  if (select dwell_ms from core.user_events where user_id = ua and blurb_id = (ids->>'L1')::uuid) <> 600000 then
    raise exception 'FAIL: long dwell not clamped to 600000';
  end if;
  ok := false;
  begin insert into core.user_events (user_id, blurb_id, kind, dwell_ms) values (ua, (ids->>'T1')::uuid, 'view', 5);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: dwell_ms accepted on a view row'; end if;
  perform set_config('role', 'authenticated', true);

  -- affinity readout: tech T1 -0.15 (L1's 10-minute look counts as "walked away" = neutral
  -- since the trending_foryou migration); markets 1; energy 0.5; deals 1.5;
  -- policy -1; economy 0 (5 s look = neutral) and insider 0 (view only) are absent
  aff := api.get_prefs() -> 'affinity';
  if aff is distinct from '{"tech":-0.15,"markets":1.00,"energy":0.50,"deals":1.50,"policy":-1.00}'::jsonb then
    raise exception 'FAIL: affinity for A is %', aff;
  end if;

  -- ---- 3. user B: seen penalty and the category cap ---------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  -- guest order would be X (+2), Z (+1), Y (0)
  perform api.track((ids->>'X')::uuid, 'dwell', 9000);     -- read X: tech +0.25, X -3
  perform api.track((ids->>'Z')::uuid, 'open_detail');     -- read Z: energy +0.5, Z -3
  -- since the trending_foryou migration a read card is -100 h and personal terms count x3:
  -- Y 0+0.75 first; X 2+0.75-100 = -97.25 and Z 1+1.5-100 = -97.5 go to the end
  select string_agg(replace(x->>'headline', 'SIG ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed_for_you(null, 30) -> 'items') with ordinality as t(x, o);
  -- (the breadth rules may slot X and Z between the three earnings cards G1..G3 at the end)
  if got not like 'Y,%'
     or 'X' <> all ((string_to_array(got, ','))[cardinality(string_to_array(got, ',')) - 4 :])
     or 'Z' <> all ((string_to_array(got, ','))[cardinality(string_to_array(got, ',')) - 4 :]) then
    raise exception 'FAIL: seen penalty order for B is %, expected Y first, X and Z in the last five', got;
  end if;

  -- three earnings cards at the card cap (+1.5 each = 4.5) -> category cap 4
  for i in 1 .. 3 loop
    perform api.track((ids->>('G' || i))::uuid, 'like');
    perform api.track((ids->>('G' || i))::uuid, 'open_detail');
    perform api.track((ids->>('G' || i))::uuid, 'open_source');
  end loop;
  if (api.get_prefs() -> 'affinity' ->> 'earnings')::numeric <> 4 then
    raise exception 'FAIL: category cap: earnings = %', api.get_prefs() -> 'affinity' ->> 'earnings';
  end if;

  -- A's signals did not leak into B's readout
  if (api.get_prefs() -> 'affinity') ? 'deals' then raise exception 'FAIL: B sees A''s deals affinity'; end if;

  raise exception 'ALL SIGNAL CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
