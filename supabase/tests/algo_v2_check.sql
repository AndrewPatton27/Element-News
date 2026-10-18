-- =============================================================================
-- algo_v2_check.sql: checks for 20261018010000_algo_v2.sql
--   shared personal-affinity helper (For you, search, following feed), stronger "not for me"
--   evidence (readout unchanged), freshness half-life per topic, topic spread, cold start,
--   paging with the new terms, privileges.
--
-- Supabase SQL editor: needs the two test users element-test-a@example.com and
-- element-test-b@example.com (Authentication -> Users -> Add user, "Auto Confirm User").
-- Paste the whole file and run it.
--   expected:     ERROR: ALL ALGO V2 CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- Signed-in users are simulated as in accounts_check.sql (role + request.jwt.claims).
-- =============================================================================

do $$
declare
  ua    uuid;                -- "A": signals (likes / dislikes)
  ub    uuid;                -- "B": brand-new user, no follows, no signals
  base  numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  b     uuid;
  ids   jsonb := '{}';
  c     jsonb;
  i     int;
  n     int;
  pages int;
  t     jsonb;
  h     numeric;
  xv    numeric;
  got   text;
  a0    text;
  r     jsonb;
  cur   text;
  seen  text[];
  ok    boolean;
  d_cold int;
  d_warm int;
  -- l = label, c = topic, o = rank offset in hours, age = hours old
  spec  jsonb := '[
    {"l":"M1","c":"markets","o":10,"age":0.1}, {"l":"M2","c":"markets","o":9,"age":0.1},
    {"l":"M3","c":"markets","o":8,"age":0.1},
    {"l":"W1","c":"world","o":3,"age":0.1},    {"l":"T1","c":"tech","o":2.5,"age":0.1},
    {"l":"P1","c":"policy","o":2,"age":0.1},   {"l":"E1","c":"energy","o":1.5,"age":0.1},
    {"l":"D1","c":"deals","o":1,"age":0.1},
    {"l":"OS","c":"science","o":-42,"age":12}, {"l":"OE","c":"economy","o":-38,"age":12}, {"l":"OT","c":"tech","o":-40,"age":12},
    {"l":"OM","c":"markets","o":-40,"age":12}]';
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  if ua is null or ub is null then
    raise exception 'SETUP: create the users element-test-a@example.com and element-test-b@example.com first';
  end if;
  delete from core.user_events where user_id in (ua, ub);
  delete from core.user_prefs  where user_id in (ua, ub);
  update core.blurbs set status = 'hidden' where status = 'published';   -- real cards out of the way (rolled back)

  -- ---- 1. settings exist with the documented defaults ---------------------------------------
  select string_agg(key || '=' || value::text, ',' order by key) into got from core.rank_params
   where key in ('foryou_negative_scale', 'foryou_cold_step_hours', 'foryou_cold_events', 'following_half_life_hours',
                 'foryou_half_life_markets', 'foryou_half_life_science', 'foryou_half_life_safety', 'foryou_half_life_economy');
  if got is distinct from 'following_half_life_hours=12,foryou_cold_events=5,foryou_cold_step_hours=4,foryou_half_life_economy=8,foryou_half_life_markets=8,foryou_half_life_safety=8,foryou_half_life_science=8,foryou_negative_scale=2' then
    raise exception 'FAIL: rank_params defaults are %', got;
  end if;
  if (select value from core.rank_params where key = 'foryou_category_step_hours') not in (0.75) then
    raise exception 'FAIL: foryou_category_step_hours is not 0.75';
  end if;

  -- ---- 2. privileges: the helpers are private ---------------------------------------------
  foreach got in array array['anon', 'authenticated'] loop
    if has_function_privilege(got, 'core.user_taste(uuid,timestamp with time zone)', 'execute')
       or has_function_privilege(got, 'core.taste_hours(jsonb,text,text,text)', 'execute') then
      raise exception 'FAIL: % can execute the taste helpers', got;
    end if;
  end loop;
  if not (select p.prosecdef and p.proconfig @> array['search_path=""']
            from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'core' and p.proname = 'user_taste') then
    raise exception 'FAIL: core.user_taste must be security definer with an empty search_path';
  end if;

  -- cards (each with its own source so the source-breadth rules stay out of the way)
  for c in select value from jsonb_array_elements(spec) loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('av2-' || (c->>'l'), 'summary', 'AV2 ' || (c->>'l'), c->>'c', now(),
            now() - make_interval(secs => (c->>'age')::numeric * 3600), base + (c->>'o')::numeric)
    returning id into b; ids := ids || jsonb_build_object(c->>'l', b);
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'AV2 source ' || (c->>'l'), 'filing', 'https://www.sec.gov/av2/' || b, 'company_filing', true);
  end loop;

  -- ---- 3. cold start: a brand-new reader gets Trending order with one card per topic first ------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := api.feed_for_you(null, 10);
  if r->'items'->0->>'headline' <> 'AV2 M1' then
    raise exception 'FAIL: cold start must keep the top Trending card first, got %', r->'items'->0->>'headline';
  end if;
  select count(distinct x->>'category') into d_cold
    from jsonb_array_elements(r->'items') with ordinality as q(x, o) where o <= 6;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 0 where key = 'foryou_cold_step_hours';
  perform set_config('role', 'authenticated', true);
  select count(distinct x->>'category') into d_warm
    from jsonb_array_elements(api.feed_for_you(null, 10)->'items') with ordinality as q(x, o) where o <= 6;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 4 where key = 'foryou_cold_step_hours';
  perform set_config('role', 'authenticated', true);
  if d_cold < 5 or d_cold <= d_warm then
    raise exception 'FAIL: cold start breadth: % topics in the first 6 (without the cold step: %), expected >= 5 and more; order %', d_cold, d_warm,
      (select string_agg(x->>'headline', ',' order by o) from jsonb_array_elements(r->'items') with ordinality as q(x, o));
  end if;
  -- following one topic, or the first foryou_cold_events (5) signals, switch the cold spread off:
  -- the order is then exactly the order with foryou_cold_step_hours = 0
  for i in 1 .. 2 loop
    if i = 1 then perform api.set_prefs(array['world'], null);
    else perform api.set_prefs(array[]::text[], null);
         perform api.track((ids->>x.l)::uuid, 'view') from unnest(array['M1','M2','M3','W1','T1']) as x(l);
    end if;
    select string_agg(x->>'id', ',' order by o) into got from jsonb_array_elements(api.feed_for_you(null, 30)->'items') with ordinality as q(x, o);
    perform set_config('role', 'none', true);
    update core.rank_params set value = 0 where key = 'foryou_cold_step_hours';
    perform set_config('role', 'authenticated', true);
    select string_agg(x->>'id', ',' order by o) into a0 from jsonb_array_elements(api.feed_for_you(null, 30)->'items') with ordinality as q(x, o);
    perform set_config('role', 'none', true);
    update core.rank_params set value = 4 where key = 'foryou_cold_step_hours';
    perform set_config('role', 'authenticated', true);
    if got is distinct from a0 then
      raise exception 'FAIL: cold spread still on %', case when i = 1 then 'for a reader who follows a topic' else 'after 5 signals' end;
    end if;
  end loop;
  perform set_config('role', 'none', true);
  delete from core.user_events where user_id = ub;
  perform set_config('role', 'authenticated', true);
  -- ---- 4. freshness by topic (shipped off; switched on here) ------------------------------------
  -- OE (economy) and OS (science) are each the only card of their topic, both 12 h old.
  -- off: OE -38 h above OS -42 h. On (economy 6 h, science 16 h): OE -38 - 12 x (8/6 - 1) = -42,
  -- OS -42 - 12 x (8/16 - 1) = -36 -> OS above OE
  select string_agg(replace(x->>'headline', 'AV2 ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed_for_you(null, 30)->'items') with ordinality as q(x, o)
   where x->>'headline' in ('AV2 OS', 'AV2 OE');
  if got is distinct from 'OE,OS' then raise exception 'FAIL: freshness per topic should be off by default (got %)', got; end if;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 6  where key = 'foryou_half_life_economy';
  update core.rank_params set value = 16 where key = 'foryou_half_life_science';
  perform set_config('role', 'authenticated', true);
  select string_agg(replace(x->>'headline', 'AV2 ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed_for_you(null, 30)->'items') with ordinality as q(x, o)
   where x->>'headline' in ('AV2 OS', 'AV2 OE');
  if got is distinct from 'OS,OE' then raise exception 'FAIL: per-topic freshness order is % (expected OS,OE)', got; end if;
  perform set_config('role', 'none', true);
  update core.rank_params set value = 8 where key in ('foryou_half_life_economy', 'foryou_half_life_science');
  perform set_config('role', 'authenticated', true);
  -- ---- 5. paging with the new terms: every card exactly once ------------------------------------
  seen := '{}'; cur := null; pages := 0;
  loop
    r := api.feed_for_you(cur, 10);
    pages := pages + 1;
    for c in select value from jsonb_array_elements(r->'items') loop
      if (c->>'id') = any (seen) then raise exception 'FAIL: For you paging repeated %', c->>'headline'; end if;
      seen := seen || (c->>'id');
    end loop;
    cur := r->>'next_cursor';
    exit when cur is null or pages > 5;
  end loop;
  if cardinality(seen) <> jsonb_array_length(spec) then
    raise exception 'FAIL: For you paging returned % cards, expected %', cardinality(seen), jsonb_array_length(spec);
  end if;

  -- ---- 6. shared helper: one formula, readout unchanged, "not for me" counts double ------------
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform api.set_prefs(array['policy'], null);
  perform api.track((ids->>'T1')::uuid, 'like');                 -- tech +1
  perform api.track((ids->>'E1')::uuid, 'dislike');              -- energy -1
  perform api.track((ids->>x.l)::uuid, 'dislike') from unnest(array['M1','M2','M3','OM']) as x(l);   -- markets -4 = cap
  r := api.get_prefs() -> 'affinity';
  if (r->>'tech')::numeric <> 1 or (r->>'energy')::numeric <> -1 or (r->>'markets')::numeric <> -4 then
    raise exception 'FAIL: the affinity readout changed: %', r;
  end if;
  perform set_config('role', 'none', true);
  -- search and Following read signals before the transaction's start time (now()); in this one
  -- transaction the events are 'now', so move them a minute back
  update core.user_events set created_at = created_at - interval '1 minute' where user_id = ua;
  t := core.user_taste(ua, now());
  -- positive side: exactly conf x hours from core.user_affinity_dims (the 080000 number)
  select a.conf * a.hours into xv from core.user_affinity_dims(ua, now()) a where a.dim = 'category' and a.key = 'tech';
  if abs((t->'c'->>'tech')::numeric - xv) > 0.0001 then raise exception 'FAIL: tech taste % <> conf x hours %', t->'c'->>'tech', xv; end if;
  -- negative side: x foryou_negative_scale (2), never past the cap (-4)
  select a.conf * a.hours into xv from core.user_affinity_dims(ua, now()) a where a.dim = 'category' and a.key = 'energy';
  if abs((t->'c'->>'energy')::numeric - 2 * xv) > 0.0001 then raise exception 'FAIL: energy taste % <> 2 x %', t->'c'->>'energy', xv; end if;
  if (t->'c'->>'markets')::numeric <> -4 then raise exception 'FAIL: markets taste % not clamped to -4', t->'c'->>'markets'; end if;
  -- one formula: follow + topic + type + source
  h := core.taste_hours(t, 'policy', 'summary', null);
  if abs(h - (2 + coalesce((t->'t'->>'summary')::numeric, 0))) > 0.0001 then
    raise exception 'FAIL: taste_hours for a followed topic is %, expected follow 2 + type %', h, t->'t'->>'summary';
  end if;
  if core.taste_hours(null, 'tech', 'summary', null) <> 0 or core.taste_hours(core.user_taste(null, now()), 'tech', null, null) <> 0 then
    raise exception 'FAIL: an empty taste must give 0 hours';
  end if;
  perform set_config('role', 'authenticated', true);

  -- ---- 7. following feed and search use the same helper; guests unchanged ------------------------
  -- two fresh cards: FA (tech, A liked a tech card) and FB (energy, A disliked an energy card);
  -- FB is slightly more important, so a guest sees FB first and only the personal part can flip it;
  -- their own story type keeps A's card-type taste (all those dislikes) out of this comparison
  perform set_config('role', 'none', true);
  for c in select value from jsonb_array_elements('[{"l":"FA","c":"tech","i":2},{"l":"FB","c":"energy","i":2.2}]'::jsonb) loop
    insert into core.blurbs (dedupe_key, kind, headline, body, category, event_type, as_of, sort_at, rank_score, importance)
    values ('av2-' || (c->>'l'), 'summary', 'AV2 ' || (c->>'l') || ' zebrafish', 'zebrafish', c->>'c', 'av2_test', now(), now() - interval '1 hour', base, (c->>'i')::numeric)
    returning id into b; ids := ids || jsonb_build_object(c->>'l', b);
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'AV2 source ' || (c->>'l'), 'filing', 'https://www.sec.gov/av2/' || b, 'company_filing', true);
  end loop;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select string_agg(replace(x->>'headline', 'AV2 ', ''), ',' order by o) into a0
    from jsonb_array_elements(api.following_feed(array['tech','energy'], array[]::text[], array[]::text[], null, 30)->'items') with ordinality as q(x, o)
   where x->>'headline' like 'AV2 F_ zebrafish';
  if a0 is distinct from 'FB zebrafish,FA zebrafish' then raise exception 'FAIL: guest following feed order is %, expected FB first', a0; end if;
  if api.search('zebrafish', null, 10)->'items'->0->>'headline' <> 'AV2 FB zebrafish' then raise exception 'FAIL: guest search should show FB first'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select string_agg(replace(x->>'headline', 'AV2 ', ''), ',' order by o) into got
    from jsonb_array_elements(api.following_feed(array['tech','energy'], array[]::text[], array[]::text[], null, 30)->'items') with ordinality as q(x, o)
   where x->>'headline' like 'AV2 F_ zebrafish';
  if got is distinct from 'FA zebrafish,FB zebrafish' then
    raise exception 'FAIL: signed-in following feed should put the liked topic first, got %', got;
  end if;
  r := api.search('zebrafish', null, 10);
  if r->'items'->0->>'headline' <> 'AV2 FA zebrafish' then
    raise exception 'FAIL: signed-in search should put the liked topic first, got %', r->'items'->0->>'headline';
  end if;
  -- the following feed still pages without repeats for a signed-in reader
  seen := '{}'; cur := null; pages := 0;
  loop
    r := api.following_feed(array['tech','energy','markets'], array[]::text[], array[]::text[], cur, 10);
    pages := pages + 1;
    for c in select value from jsonb_array_elements(r->'items') loop
      if (c->>'id') = any (seen) then raise exception 'FAIL: following feed paging repeated %', c->>'headline'; end if;
      seen := seen || (c->>'id');
    end loop;
    cur := r->>'next_cursor';
    exit when cur is null or pages > 5;
  end loop;

  -- ---- 8. For you for A: the disliked topic sinks, the liked one rises ---------------------------
  select string_agg(replace(x->>'headline', 'AV2 ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed_for_you(null, 30)->'items') with ordinality as q(x, o)
   where x->>'headline' in ('AV2 W1', 'AV2 OT');
  if got is distinct from 'W1,OT' and got is distinct from 'OT,W1' then raise exception 'FAIL: For you for A lost cards: %', got; end if;
  if exists (select 1 from jsonb_array_elements(api.feed_for_you(null, 30)->'items') x where x->>'headline' in ('AV2 M1', 'AV2 E1')) then
    raise exception 'FAIL: disliked cards shown to A';
  end if;
  perform set_config('role', 'none', true);

  raise exception 'ALL ALGO V2 CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
