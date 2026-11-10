-- Following at scale (20261121000100_following_scale.sql): time window and capped topic-only related tier.
-- Checks: settings and range guards; a direct match inside following_window_days is listed, one older is not (and
-- comes back when the window is widened); a topic-only related card is listed while it is among the
-- following_related_topic_max newest of its topic and not when the cap is lower (0 = none); paging has no repeats;
-- grants unchanged. Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  c_new uuid; c_old uuid; c_t1 uuid; c_t2 uuid; c_t3 uuid;
  r jsonb; ok boolean; seen text[] := '{}'; cur text; i int := 0;
  has_id constant text := 'select exists (select 1 from jsonb_array_elements($1 -> ''items'') x where x ->> ''id'' = $2::text)';
  found boolean;
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  if (select value from core.rank_params where key = 'following_window_days') is distinct from 90
     or (select value from core.rank_params where key = 'following_related_topic_max') is distinct from 100 then
    raise exception 'FAIL: defaults must be following_window_days 90, following_related_topic_max 100'; end if;
  ok := false; begin update core.rank_params set value = 0 where key = 'following_window_days'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: following_window_days accepted 0'; end if;
  ok := false; begin update core.rank_params set value = -1 where key = 'following_related_topic_max'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: following_related_topic_max accepted -1'; end if;

  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance,rank_score) values
   ('https://www.sec.gov/fsc-new','summary','Qorvane Corp reports quarterly results','Revenue rose.','earnings','published','[{"symbol":"QRVN","name":"Qorvane"}]',now(),now(),now()-interval '80 days',6,base-1920),
   ('https://www.sec.gov/fsc-old','summary','Qorvane Corp names a new finance chief','A new officer.','markets','published','[{"symbol":"QRVN","name":"Qorvane"}]',now(),now(),now()-interval '100 days',3,base-2400),
   ('https://www.sec.gov/fsc-t1','summary','Lumetra Inc reports quarterly results','Sales fell.','earnings','published','[{"symbol":"LMTR","name":"Lumetra"}]',now(),now(),now()-interval '1 hour',6,base),
   ('https://www.sec.gov/fsc-t2','summary','Bravolt Inc reports quarterly results','Sales rose.','earnings','published','[{"symbol":"BRVT","name":"Bravolt"}]',now(),now(),now()-interval '2 hours',6,base),
   ('https://www.sec.gov/fsc-t3','summary','Kandor Inc reports quarterly results','Sales flat.','earnings','published','[{"symbol":"KNDR","name":"Kandor"}]',now(),now(),now()-interval '3 hours',6,base);
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'FSC Source','filing','https://www.sec.gov/src/'||md5(dedupe_key),'company_filing',true from core.blurbs where dedupe_key like '%fsc-%';
  select id into c_new from core.blurbs where dedupe_key = 'https://www.sec.gov/fsc-new';
  select id into c_old from core.blurbs where dedupe_key = 'https://www.sec.gov/fsc-old';
  select id into c_t1 from core.blurbs where dedupe_key = 'https://www.sec.gov/fsc-t1';
  select id into c_t2 from core.blurbs where dedupe_key = 'https://www.sec.gov/fsc-t2';
  select id into c_t3 from core.blurbs where dedupe_key = 'https://www.sec.gov/fsc-t3';

  -- follow the ticker QRVN: the 80-day card is direct, the 100-day one is outside the window
  r := api.following_feed('{}', '{}', array['QRVN'], null, 30);
  execute has_id using r, c_new into found; if not found then raise exception 'FAIL: an 80-day direct match must be listed'; end if;
  execute has_id using r, c_old into found; if found then raise exception 'FAIL: a 100-day direct match must be outside the 90-day window'; end if;
  -- the three newest earnings cards are related by topic alone
  execute has_id using r, c_t3 into found; if not found then raise exception 'FAIL: a same-topic card must be related: %', r; end if;
  update core.rank_params set value = 120 where key = 'following_window_days';
  r := api.following_feed('{}', '{}', array['QRVN'], null, 30);
  execute has_id using r, c_old into found; if not found then raise exception 'FAIL: widening the window must bring the 100-day card back'; end if;
  update core.rank_params set value = 90 where key = 'following_window_days';

  -- topic cap 2: only the two newest earnings cards (t1, t2) stay related by topic; t3 drops
  update core.rank_params set value = 2 where key = 'following_related_topic_max';
  r := api.following_feed('{}', '{}', array['QRVN'], null, 30);
  execute has_id using r, c_t1 into found; if not found then raise exception 'FAIL: the newest same-topic card must stay related'; end if;
  execute has_id using r, c_t3 into found; if found then raise exception 'FAIL: the third same-topic card must drop with a cap of 2'; end if;
  update core.rank_params set value = 0 where key = 'following_related_topic_max';
  r := api.following_feed('{}', '{}', array['QRVN'], null, 30);
  execute has_id using r, c_t1 into found; if found then raise exception 'FAIL: a cap of 0 must list no topic-only related cards'; end if;
  update core.rank_params set value = 100 where key = 'following_related_topic_max';

  -- paging over 200 extra earnings cards: no repeats
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  select 'https://www.sec.gov/fsc-x'||g,'summary','Firm '||g||' reports results','Text.','earnings','published',now(),now(),now()-(g||' hours')::interval,4,base-g
    from generate_series(1,200) g;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'FSC Source','filing','https://www.sec.gov/src/'||md5(dedupe_key),'company_filing',true from core.blurbs where dedupe_key like '%fsc-x%';
  r := api.following_feed(array['earnings'], '{}', array['QRVN'], null, 10);
  loop
    seen := seen || array(select x->>'id' from jsonb_array_elements(r->'items') x);
    cur := r->>'next_cursor'; i := i + 1;
    exit when cur is null or i > 60;
    r := api.following_feed(array['earnings'], '{}', array['QRVN'], cur, 10);
  end loop;
  if (select count(distinct x) from unnest(seen) x) <> cardinality(seen) then raise exception 'FAIL: Following paging repeated a card'; end if;
  if not has_function_privilege('anon','api.following_feed(text[],text[],text[],text,int)','execute') then raise exception 'FAIL: anon must keep execute'; end if;
  raise exception 'ALL FOLLOWING SCALE CHECKS PASSED (% cards over % pages; test rows rolled back on purpose)', cardinality(seen), i;
end $$;
