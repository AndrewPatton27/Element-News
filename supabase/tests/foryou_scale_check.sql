-- For you at scale (20261121000000_foryou_scale.sql): bounded candidate set, candidate-only source keys, bounded
-- seen penalty, anti-join seen test. Checks: setting and range guard; with fewer window cards than the cut the full
-- For you scroll is identical to an unlimited cut (v5 and v3); with a small cut the scroll still has no repeats and
-- the same first page; a hidden source stays hidden (source keys of the candidates); seen cards stay out of the
-- unseen part; the macro_focus wrappers are intact. Test rows are rolled back on purpose (the closing error).
do $$
declare
  ua uuid;
  base numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  cats text[] := array['markets', 'world', 'tech', 'policy', 'energy', 'deals'];
  ok boolean;
  a uuid[]; b uuid[]; c uuid[]; p1 uuid[]; seen uuid[]; r jsonb; cur text; i int; sf int;
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  delete from core.ml_pages where user_id = ua;
  delete from core.user_events where user_id = ua;
  delete from core.user_prefs where user_id = ua;
  update core.blurbs set status = 'hidden' where status = 'published';
  update core.ml_models set gate_passed = false where gate_passed;
  update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode');

  -- 1. setting
  if (select value from core.rank_params where key = 'foryou_max_scored') is distinct from 1500 then
    raise exception 'FAIL: foryou_max_scored must default to 1500'; end if;
  ok := false; begin update core.rank_params set value = 0 where key = 'foryou_max_scored'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: foryou_max_scored accepted 0'; end if;

  -- 2. 160 cards over the last 20 days, 6 topics, two sources; the reader viewed 12, read 4, disliked 1
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score)
  select 'fys-' || g, 'summary', 'Scale story ' || g, 'Text ' || g || '.', cats[1 + g % 6], 'published', now(), now() - make_interval(hours => g * 3),
         now() - make_interval(hours => g * 3), 4, base - g * 3 + 16
    from generate_series(1, 160) g;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select id, case when right(dedupe_key, 1) in ('0', '2', '4') then 'SEC' else 'Federal Reserve Board' end,
         'government', 'https://www.sec.gov/fys/' || dedupe_key, 'public_domain', true
    from core.blurbs where dedupe_key like 'fys-%';
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at)
  select ua, b.id, k.kind, case when k.kind = 'dwell' then 9000 end, now() - interval '1 hour'
    from core.blurbs b cross join (values ('view'), ('dwell')) k(kind)
   where b.dedupe_key in ('fys-1','fys-2','fys-3','fys-5','fys-8','fys-9','fys-13','fys-14','fys-20','fys-21','fys-22','fys-30')
     and (k.kind = 'view' or b.dedupe_key in ('fys-2','fys-8','fys-14','fys-22'));
  insert into core.user_events (user_id, blurb_id, kind, created_at)
  select ua, id, 'dislike', now() - interval '1 hour' from core.blurbs where dedupe_key = 'fys-4';
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- 3. identical to an unlimited cut while the window holds fewer cards than the cut (v5, the live mode)
  for i in 1..2 loop
    if i = 2 then update core.rank_params set value = 1e6 where key = 'foryou_max_scored'; end if;
    c := '{}'; cur := null; sf := null;
    for n in 1..30 loop
      r := api.feed_for_you(cur, 20);
      if sf is null and r ? 'seen_from' then sf := cardinality(c) + (r ->> 'seen_from')::int; end if;
      c := c || array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
      cur := r ->> 'next_cursor'; exit when cur is null;
    end loop;
    if i = 1 then a := c; else b := c; end if;
  end loop;
  if a is distinct from b then raise exception 'FAIL: For you must be identical with the default cut (% vs % cards)', cardinality(a), cardinality(b); end if;
  if (select count(distinct x) from unnest(a) x) <> cardinality(a) then raise exception 'FAIL: For you scroll repeated a card'; end if;
  seen := array(select id from core.blurbs where dedupe_key in ('fys-1','fys-2','fys-3','fys-5','fys-8','fys-9','fys-13','fys-14','fys-20','fys-21','fys-22','fys-30'));
  if sf is null or a[1:sf] && seen then raise exception 'FAIL: seen cards must stay out of the unseen part (seen_from %)', sf; end if;
  if a && array(select id from core.blurbs where dedupe_key = 'fys-4') then raise exception 'FAIL: a disliked card came back'; end if;

  -- 4. a small cut: no repeats, same first page (the reader-independent order decides the top here)
  update core.rank_params set value = 40 where key = 'foryou_max_scored';
  c := '{}'; cur := null;
  for n in 1..30 loop
    r := api.feed_for_you(cur, 20);
    c := c || array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
    cur := r ->> 'next_cursor'; exit when cur is null;
  end loop;
  if (select count(distinct x) from unnest(c) x) <> cardinality(c) then raise exception 'FAIL: For you with a small cut repeated a card'; end if;
  if c[1:20] is distinct from a[1:20] then raise exception 'FAIL: a small cut must keep the first page'; end if;
  if cardinality(c) >= cardinality(a) then raise exception 'FAIL: the cut must bound the candidates (% vs % cards)', cardinality(c), cardinality(a); end if;
  update core.rank_params set value = 1500 where key = 'foryou_max_scored';

  -- 5. hidden source: source keys come from the candidates' own sources
  insert into core.user_prefs (user_id, hidden_sources) values (ua, '{sec}');
  r := api.feed_for_you(null, 20);
  if exists (select 1 from jsonb_array_elements(r -> 'items') x join core.blurb_sources s on s.blurb_id = (x ->> 'id')::uuid where s.name = 'SEC') then
    raise exception 'FAIL: a hidden source (SEC) must stay hidden'; end if;
  if jsonb_array_length(r -> 'items') < 10 then raise exception 'FAIL: hidden source left too few cards'; end if;
  delete from core.user_prefs where user_id = ua;

  -- 6. v3 (mode 3, no holdout): identical with an unlimited cut
  update core.rank_params set value = 3 where key = 'foryou_ml_mode';
  update core.rank_params set value = 0 where key = 'v3_holdout_pct';
  p1 := array(select (x ->> 'id')::uuid from jsonb_array_elements(api.feed_for_you(null, 20) -> 'items') x);
  update core.rank_params set value = 1e6 where key = 'foryou_max_scored';
  if p1 is distinct from array(select (x ->> 'id')::uuid from jsonb_array_elements(api.feed_for_you(null, 20) -> 'items') x) then
    raise exception 'FAIL: v3 first page must be identical with the default cut'; end if;
  if (select count(*) from core.ml_pages where user_id = ua and ranker = 'fy-v3') = 0 then raise exception 'FAIL: v3 pages were not served by v7'; end if;

  -- 7. wrappers intact, bodies bounded
  if (select prosrc from pg_proc where oid = 'core.feed_for_you_v5(text,integer)'::regprocedure) not like '%macro_focus_wrapper%'
     or (select prosrc from pg_proc where oid = 'core.feed_for_you_v7(text,integer)'::regprocedure) not like '%macro_focus_wrapper%' then
    raise exception 'FAIL: the macro_focus wrappers must stay in place'; end if;
  if (select prosrc from pg_proc where oid = 'core.feed_for_you_v5_base(text,integer)'::regprocedure) not like '%foryou_max_scored%'
     or (select prosrc from pg_proc where oid = 'core.v3_scores_base(uuid,timestamp with time zone,bigint)'::regprocedure) not like '%foryou_max_scored%' then
    raise exception 'FAIL: the bounded bodies are not installed'; end if;
  if has_function_privilege('authenticated', 'core.feed_for_you_v5_base(text,integer)', 'execute')
     or has_function_privilege('anon', 'core.v3_scores(uuid,timestamp with time zone,bigint)', 'execute') then
    raise exception 'FAIL: core feed functions must stay private'; end if;
  raise exception 'ALL FORYOU SCALE CHECKS PASSED (% cards in the scroll; test rows rolled back on purpose)', cardinality(a);
end $$;
